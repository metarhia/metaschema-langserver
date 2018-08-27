import { parseScript, Syntax } from 'esprima';
import {
  CallExpression,
  Expression,
  ObjectExpression,
  Pattern,
  SimpleCallExpression,
} from 'estree';
import * as path from 'path';
import { CompletionItem } from 'vscode-languageserver';
import { Logger } from './logging';
import { InMemoryFileSystem } from './memfs';

export interface LanguageService {
  updateFile(filePath: string): boolean;

  getCompletionsAtPosition(fileName: string, line: number, character: number): CompletionItem[];
}

const enum EntityDefinitionKind {
  Domains = 'domains',
  Category = 'Category',
  DatabaseEntity = 'Database',
  DomainField = 'DomainField',
  CategoryField = 'CategoryField',
  DatabaseField = 'DatabaseField',
}
const entityDefinitionKinds = [
  EntityDefinitionKind.Domains, EntityDefinitionKind.Category,
  EntityDefinitionKind.DatabaseEntity, EntityDefinitionKind.DomainField,
  EntityDefinitionKind.CategoryField, EntityDefinitionKind.DatabaseField,
];

type ValueValidator = (expr: Expression, fields: Map<string, any>) => boolean;
class EntityDefinition {
  public name: string;

  public fields: Map<string, any>;

  public validator: ValueValidator | null;

  public ast: ObjectExpression | CallExpression | null = null;

  constructor(name: string,
              fields: Map<string, any> = new Map(),
              validator: ValueValidator | null = null) {
    this.name = name;
    this.fields = fields;
    this.validator = validator;
  }
}

class DomainDefinition extends EntityDefinition {

  private static stringToValueValidator: Map<string, ValueValidator> = new Map([
    // general string-with-length validator
    ['string', (val: Expression, fields: Map<string, any>) => {
      return val.type === Syntax.Literal &&
        typeof val.value === 'string' &&
        (!fields.has('length') || val.value.length < fields.get('length'));
    }],
  ]);

  constructor(name: string, fields: Map<string, any> = new Map()) {
    super(name, fields, DomainDefinition.stringToValueValidator.get(fields.get('type')));
  }
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
    if (!handler) {
      const kind = filePath.includes('globalstorage') ?
        EntityDefinitionKind.DatabaseEntity : EntityDefinitionKind.Category;
      handler = this.entityHandlers.get(kind)!;
    }
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
    this.entityHandlers.set(EntityDefinitionKind.CategoryField,
      this.categoryFieldLoader.bind(this));
    this.entityHandlers.set(EntityDefinitionKind.DatabaseField,
      this.databaseFieldLoader.bind(this));
    // ignored for now
    this.entityHandlers.set(EntityDefinitionKind.DomainField, () => false);
    this.entityHandlers.set(EntityDefinitionKind.DatabaseEntity, () => false);
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
      (name, fields) => new DomainDefinition(name, fields)
    );
  }

  private metaschemaLoader(
    ast: ObjectExpression,
    kind: EntityDefinitionKind,
    entityFactory: ((...args: any[]) => EntityDefinition | null) | null = null,
    astHandler: ((ast: Expression | Pattern) => EntityDefinition | null) | null | null = null
  ): boolean {
    const entities = this.entities.get(kind)!;
    for (const prop of ast.properties) {
      if (prop.key.type !== Syntax.Identifier || !prop.value) continue;
      let entity = null;
      if (astHandler !== null) {
        entity = astHandler(prop.value);
      } else {
        let fields = new Map();
        let validator = null;
        if (prop.value.type === Syntax.ObjectExpression) {
          fields = objectAstToMap(prop.value);
        } else if (prop.value.type === Syntax.CallExpression) {
          validator = decoratorValidator(prop.value);
        }
        entity = entityFactory === null ?
          new EntityDefinition(prop.key.name, fields, validator) :
          entityFactory(prop.key.name, fields, validator);
      }
      if (entity !== null) entities.set(entity.name, entity);
    }
    return true;
  }

  private categoryFieldLoader(filePath: string): boolean {
    const ast = readParseTolerant(this.fs, filePath);
    if (!ast || ast.type !== Syntax.ObjectExpression || ast.properties.length === 0) return false;
    return this.metaschemaLoader(ast, EntityDefinitionKind.CategoryField);
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
  if (isCategoryFieldFile(filePath)) return EntityDefinitionKind.CategoryField;
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

function decoratorValidator(decAst: CallExpression): ValueValidator | null {
  if (decAst.callee.type !== Syntax.Identifier) return null;
  // only Enum is supported now
  switch (decAst.callee.name) {
    case 'Enum': {
      const args = callParamsAstToSet(decAst);
      return (expr: Expression): boolean =>
        expr.type === Syntax.Literal &&
        expr.value !== null &&
        expr.value !== undefined &&
        args.has(expr.value.toString());
    }
  }
  return null;
}

function objectAstToMap(ast: ObjectExpression): Map<string, any> {
  const map: Map<string, any> = new Map();
  for (const prop of ast.properties) {
    if (prop.key.type === Syntax.Identifier && prop.value && prop.value.type === Syntax.Literal) {
      map.set(prop.key.name, prop.value.value);
    }
  }
  return map;
}

function callParamsAstToSet(ast: CallExpression): Set<string> {
  const set: Set<string> = new Set();
  for (const arg of ast.arguments) {
    if (arg.type === Syntax.Identifier) set.add(arg.name);
    else if (arg.type === Syntax.Literal && arg.value) set.add(arg.value.toString());
  }
  return set;
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
