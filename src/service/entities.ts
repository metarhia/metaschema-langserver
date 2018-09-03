import { Syntax } from 'esprima';
import { CallExpression, Expression, ObjectExpression } from 'estree';

export const enum EntityDefinitionKind {
  Domains = 'domains',
  Category = 'Category',
  Structure = 'Structure',
  DomainField = 'Domain',
  StructureField = 'StructureField',
  DatabaseField = 'DatabaseField',
}
export const entityDefinitionKinds = new Set([
  EntityDefinitionKind.Domains, EntityDefinitionKind.Category,
  EntityDefinitionKind.DomainField, EntityDefinitionKind.StructureField,
  EntityDefinitionKind.DatabaseField,
]);

// TODO(lundibundi): change ValueValidator to return [boolean, errorString]
export type ValueValidator = (expr: Expression, fields: Map<string, any>) => boolean;
export type AST = ObjectExpression | CallExpression;

export class EntityDefinition {
  public name: string;

  public fields: Map<string, any>;

  public validator: ValueValidator | null;

  public ast?: AST;

  constructor(name: string,
              ast?: AST,
              fields: Map<string, any> = new Map(),
              validator: ValueValidator | null = null) {
    this.name = name;
    this.ast = ast;
    this.fields = fields;
    this.validator = validator;
  }
}

export class DomainDefinition extends EntityDefinition {

  private static stringToValueValidator: Map<string, ValueValidator> = new Map([
    // general string-with-length validator
    ['string', (val: Expression, fields: Map<string, any>) => {
      return val.type === Syntax.Literal &&
        typeof val.value === 'string' &&
        (!fields.has('length') || val.value.length < fields.get('length'));
    }],
  ]);

  constructor(name: string, ast?: AST, fields: Map<string, any> = new Map()) {
    super(name, ast, fields, DomainDefinition.stringToValueValidator.get(fields.get('type')));
  }
}
