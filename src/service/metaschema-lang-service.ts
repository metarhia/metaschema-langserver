import { parseScript, Syntax } from 'esprima';
import {
  CallExpression,
  Expression,
  ObjectExpression,
  Pattern,
  SimpleCallExpression,
} from 'estree';
import { EventEmitter } from 'events';
import * as path from 'path';
import { CompletionItem, Diagnostic, Position, Range } from 'vscode-languageserver';
import { Logger } from '../logging';
import { InMemoryFileSystem } from '../memfs';
import { path2uri } from '../util';
import { objectAstToMap } from './ast-utils';
import { decoratorValidator } from './decorators';
import { DiagnosticError } from './diagnostic-errors';
import {
  AnyValidator,
  DomainDefinition,
  EntityDefinition,
  EntityDefinitionKind,
  entityDefinitionKinds,
} from './entities';

export interface CustomPosition extends Position {
  lastIndex?: number;
}

export interface AbsolutePosition {
  start: number;
  end: number;
}

export interface LanguageService {
  updateFile(filePath: string): boolean;

  getCompletionsAtPosition(fileName: string, line: number, character: number): CompletionItem[];
}

export type EntityMap = Map<EntityDefinitionKind, Map<string, EntityDefinition>>;
export class MetaschemaLangService extends EventEmitter implements LanguageService {
  private entities: EntityMap;

  private entityHandlers: Map<EntityDefinitionKind, (filePath: string) => boolean>;

  constructor(private fs: InMemoryFileSystem, private logger: Logger) {
    super();
    this.entities = new Map();
    this.entityHandlers = new Map();
    entityDefinitionKinds.forEach(kind => this.entities.set(kind, new Map()));
    this.setupItemHandlers();
  }

  /**
   * Adds/Updates filePath version in the Service
   * @param filePath uri of full file path
   */
  public updateFile(filePath: string): boolean {
    const kind = filePathToEntityKind(filePath);
    return this.entityHandlers.get(kind)!(filePath);
  }

  public positionToOffset(filePath: string, position: Position): number | null {
    const file = this.fs.readFile(filePath);
    if (!file) return null;
    return positionToAbsoluteOffset(file, position);
  }

  public getCompletionsAtPosition(fileName: string, rangeOffset: number): CompletionItem[] {
    return [];
  }

  private setupItemHandlers() {
    this.entityHandlers.set(EntityDefinitionKind.Category, this.categoryHandler.bind(this));
    this.entityHandlers.set(EntityDefinitionKind.Domains, this.domainsHandler.bind(this));
    this.entityHandlers.set(
      EntityDefinitionKind.StructureField,
      this.structureFieldLoader.bind(this)
    );
    this.entityHandlers.set(
      EntityDefinitionKind.DatabaseField,
      this.databaseFieldLoader.bind(this)
    );
    // ignored for now
    this.entityHandlers.set(EntityDefinitionKind.DomainField, () => false);
  }

  private categoryHandler(filePath: string): boolean {
    let ast = readParseTolerant(this.fs, filePath);
    if (!ast) return false;
    // ignore CallExpression for now, remove this later
    if (ast.type === Syntax.CallExpression) {
      const arg = ast.arguments[0];
      if (arg && arg.type === Syntax.ObjectExpression) {
        ast = arg;
      } else {
        return false;
      }
    }
    const categories = this.entities.get(EntityDefinitionKind.Category)!;
    const name = path.basename(filePath);
    const category = new EntityDefinition(name, ast);
    categories.set(name, category);
    for (const prop of ast.properties) {
      if (prop.key.type !== Syntax.Identifier || !prop.value) continue;
      const name = prop.key.name;
      if (prop.value.type === Syntax.ObjectExpression) {
        category.fields.set(name, objectAstToMap(prop.value));
      } else if (prop.value.type === Syntax.CallExpression) {
        // TODO(lundibundi): transform decorated value into a Category property
        // category.decoratorated = decoratorValidator(prop.value);
      }
    }
    return true;
  }

  private domainsHandler(filePath: string): boolean {
    const ast = readParseTolerant(this.fs, filePath);
    if (!ast || ast.type !== Syntax.ObjectExpression || ast.properties.length === 0) return false;
    return this.metaschemaLoader(
      ast,
      EntityDefinitionKind.Domains,
      (name, ast, fields) => new DomainDefinition(name, ast, fields)
    );
  }

  private metaschemaLoader(
    ast: ObjectExpression,
    kind: EntityDefinitionKind,
    entityFactory?: ((...args: any[]) => EntityDefinition | null),
    astHandler?: ((ast: Expression | Pattern) => EntityDefinition | null)
  ): boolean {
    const entities = this.entities.get(kind)!;
    for (const prop of ast.properties) {
      if (prop.key.type !== Syntax.Identifier || !prop.value) continue;
      let entity = null;
      if (astHandler !== undefined) {
        entity = astHandler(prop.value);
      } else {
        let fields = new Map();
        let validator = null;
        if (prop.value.type === Syntax.ObjectExpression) {
          fields = objectAstToMap(prop.value);
          validator = domainValidator();
        } else if (prop.value.type === Syntax.CallExpression) {
          validator = decoratorValidator(prop.value);
        } else {
          continue;
        }
        entity =
          entityFactory === undefined
            ? new EntityDefinition(prop.key.name, prop.value, fields, validator)
            : entityFactory(prop.key.name, prop.value, fields, validator);
      }
      if (entity !== null) entities.set(entity.name, entity);
    }
    return true;
  }

  private structureFieldLoader(filePath: string): boolean {
    const ast = readParseTolerant(this.fs, filePath);
    if (!ast || ast.type !== Syntax.ObjectExpression || ast.properties.length === 0) return false;
    return this.metaschemaLoader(ast, EntityDefinitionKind.StructureField);
  }

  private databaseFieldLoader(filePath: string): boolean {
    const ast = readParseTolerant(this.fs, filePath);
    if (!ast || ast.type !== Syntax.ObjectExpression || ast.properties.length === 0) return false;
    return this.metaschemaLoader(ast, EntityDefinitionKind.DatabaseField);
  }

  private emitDiagnostic(
    filePath: string,
    absolutePosition: AbsolutePosition,
    err: DiagnosticError
  ): void {
    let range = this.absoluteRangeToLineRange(filePath, absolutePosition);
    if (!range) {
      this.logger.warn('Cannot generate range for diagnostic, defaulting to {0, 0}');
      range = { start: 0, end: 0 };
    }
    const uri = path2uri(filePath);
    const diagnostic: Diagnostic = { range, ...err };
    this.emit('diagnostic', uri, diagnostic);
  }

  private absoluteRangeToLineRange(filePath: string, position: AbsolutePosition): Range | null {
    const file = this.fs.readFile(filePath);
    if (!file) return null;
    const start = absoluteOffsetToPosition(file, position.start);
    if (!start) return null;
    const end = absoluteOffsetToPosition(file, position.end, start.lastIndex);
    if (!end) return null;
    return { start, end };
  }
}

function absoluteOffsetToPosition(
  file: string,
  offset: number,
  startIndex: number = 0
): CustomPosition | null {
  let line = 0;
  let lineOffset = 0;
  let i = startIndex;
  for (; i < file.length && offset > 0; ++i) {
    const skipCount = isEOL(file, i);
    if (skipCount > 0) {
      i += skipCount - 1;
      line++;
      lineOffset = 0;
    } else {
      offset--;
      lineOffset++;
    }
  }
  if (offset > 0) return null;
  else return { line, character: lineOffset, lastIndex: i };
}

function positionToAbsoluteOffset(file: string, position: Position): number | null {
  let line = position.line;
  let offset = 0;
  for (let i = 0; i < file.length && line > 0; ++i) {
    const skipCount = isEOL(file, i);
    if (skipCount > 0) {
      i -= skipCount - 1;
      line--;
    } else {
      offset++;
    }
  }
  if (line > 0) return null;
  else return offset + position.character;
}

function isEOL(str: string, index: number) {
  // as per LanguageServer EOL === ['\n', '\r\n', '\r'];
  if (str[index] === '\n') return 1;
  if (str[index] === '\r') {
    if (str.length > index + 1 && str[index + 1] === '\n') return 2;
    return 1;
  }
  return 0;
}

function filePathToEntityKind(filePath: string): EntityDefinitionKind {
  const kind = path.basename(filePath);
  if (entityDefinitionKinds.has(kind as EntityDefinitionKind)) return kind as EntityDefinitionKind;
  return EntityDefinitionKind.Category;
  /*
  if (isDomainsFile(filePath)) return EntityDefinitionKind.Domains;
  if (isStructureFieldFile(filePath)) return EntityDefinitionKind.StructureField;
  if (isDatabaseFieldFile(filePath)) return EntityDefinitionKind.DatabaseField;
  if (isDatabaseFieldFile(filePath)) return EntityDefinitionKind.DatabaseField;
  if (isDomainFile(filePath)) return EntityDefinitionKind.DomainField;
  if (isSchemaFile(filePath)) {
    return filePath.includes('metaschema') ?
      EntityDefinitionKind.Structure :
      EntityDefinitionKind.Category;
  }
  */
}

function domainValidator(): AnyValidator {
  return (expr: Expression, fields: Map<string, any>): boolean => {
    if (expr.type !== Syntax.Literal || !expr.value) return false;
    const domain = fields.get('type');
    // no domain, just return ok
    if (!domain) return true;
    // TODO(lundibundi) refactor ValueValidator, need domain from LangService
    return true;
  };
}

function entityFromDecorator(decAst: CallExpression): EntityDefinition {
  throw new Error('unimplemented');
}

function readParseTolerant(
  fs: InMemoryFileSystem,
  filePath: string
): ObjectExpression | SimpleCallExpression | null {
  const file = fs.readFile(filePath);
  if (!file) return null;
  try {
    const ast = parseScript(`(${file})`, { tolerant: true, range: true });
    const exprBody = ast.body[0];
    if (exprBody && exprBody.type === Syntax.ExpressionStatement) {
      const expr = exprBody.expression;
      if (expr.type === Syntax.ObjectExpression || expr.type === Syntax.CallExpression) {
        return expr;
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}
