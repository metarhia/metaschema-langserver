import {
  CallExpression,
  Expression,
  ObjectExpression,
  parseScript,
  Pattern,
  SimpleCallExpression,
  Syntax,
} from 'esprima';
import * as path from 'path';
import { CompletionItem } from 'vscode-languageserver';
import { Logger } from '../logging';
import { InMemoryFileSystem } from '../memfs';
import { objectAstToMap } from './ast-utils';
import { decoratorValidator } from './decorators';
import {
  DomainDefinition,
  EntityDefinition,
  EntityDefinitionKind,
  entityDefinitionKinds,
} from './entities';

export interface LanguageService {
  updateFile(filePath: string): boolean;

  getCompletionsAtPosition(fileName: string, line: number, character: number): CompletionItem[];
}

export class MetaschemaLangService implements LanguageService {

  private entities: Map<EntityDefinitionKind, Map<string, EntityDefinition>>;

  private entityHandlers: Map<EntityDefinitionKind, (filePath: string) => boolean>;

  constructor(private fs: InMemoryFileSystem, private logger: Logger) {
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
    const name: string = path.basename(filePath);
    let handler = this.entityHandlers.get(name as EntityDefinitionKind);
    // Category handler by default, later on must be modified to take into account
    //
    if (!handler) handler = this.entityHandlers.get(EntityDefinitionKind.Category)!;
    return handler(filePath);
  }

  public getCompletionsAtPosition(fileName: string,
                                  line: number,
                                  character: number): CompletionItem[] {
    return [];
  }

  private setupItemHandlers() {
    this.entityHandlers.set(EntityDefinitionKind.Category, this.categoryHandler.bind(this));
    this.entityHandlers.set(EntityDefinitionKind.Domains, this.domainsHandler.bind(this));
    this.entityHandlers.set(EntityDefinitionKind.StructureField,
      this.StructureFieldLoader.bind(this));
    this.entityHandlers.set(EntityDefinitionKind.DatabaseField,
      this.databaseFieldLoader.bind(this));
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
    const category = new EntityDefinition(name);
    category.ast = ast;
    categories.set(name, category);
    for (const prop of ast.properties) {
      if (prop.key.type !== Syntax.Identifier || !prop.value) continue;
      if (prop.value.type === Syntax.ObjectExpression) {
        category.fields.set(prop.key.name, objectAstToMap(prop.value));
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
        } else if (prop.value.type === Syntax.CallExpression) {
          validator = decoratorValidator(prop.value);
        } else {
          continue;
        }
        entity = entityFactory === undefined ?
          new EntityDefinition(prop.key.name, prop.value, fields, validator) :
          entityFactory(prop.key.name, prop.value, fields, validator);
      }
      if (entity !== null) entities.set(entity.name, entity);
    }
    return true;
  }

  private StructureFieldLoader(filePath: string): boolean {
    const ast = readParseTolerant(this.fs, filePath);
    if (!ast || ast.type !== Syntax.ObjectExpression || ast.properties.length === 0) return false;
    return this.metaschemaLoader(ast, EntityDefinitionKind.StructureField);
  }

  private databaseFieldLoader(filePath: string): boolean {
    const ast = readParseTolerant(this.fs, filePath);
    if (!ast || ast.type !== Syntax.ObjectExpression || ast.properties.length === 0) return false;
    return this.metaschemaLoader(ast, EntityDefinitionKind.DatabaseField);
  }
}

// Not needed for now, we can just check filename directly
/*
function filePathToEntityKind(filePath: string): EntityDefinitionKind {
  if (isDomainsFile(filePath)) return EntityDefinitionKind.Domains;
  if (isStructureFieldFile(filePath)) return EntityDefinitionKind.StructureField;
  if (isDatabaseFieldFile(filePath)) return EntityDefinitionKind.DatabaseField;
  if (isDatabaseFieldFile(filePath)) return EntityDefinitionKind.DatabaseField;
  // TODO: check with PR and update this
  if (isDomainFile(filePath)) return EntityDefinitionKind.DomainField;
  if (isSchemaFile(filePath)) {
    // TODO: better way of checking this
    return filePath.includes('globalstorage') ?
      EntityDefinitionKind.DatabaseEntity :
      EntityDefinitionKind.Category;
  }
}
*/

function entityFromDecorator(decAst: CallExpression): EntityDefinition {
  throw new Error('unimplemented');
}

function readParseTolerant(fs: InMemoryFileSystem, filePath: string):
  ObjectExpression | SimpleCallExpression | null {
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
