import { Syntax } from 'esprima';
import { CallExpression, Expression, ObjectExpression } from 'estree';
import { EntityMap } from './metaschema-lang-service';
import { createError, DiagnosticError } from './diagnostic-errors';

export const enum EntityDefinitionKind {
  Domains = 'domains',
  Category = 'Category',
  Form = 'Form',
  DomainField = 'Domain',
  StructureField = 'StructureField',
  DatabaseField = 'DatabaseField',
}
export const entityDefinitionKinds = new Set([
  EntityDefinitionKind.Domains,
  EntityDefinitionKind.Category,
  EntityDefinitionKind.Form,
  EntityDefinitionKind.DomainField,
  EntityDefinitionKind.DatabaseField,
  EntityDefinitionKind.StructureField,
]);

export type AnyValidator =
  (expr: Expression, fields: Map<string, any>, entities: EntityMap) => DiagnosticError[];
export type AST = ObjectExpression | CallExpression;

export type EntityFields = Map<string, any>;
export class EntityDefinition {
  public name: string;

  public fields: EntityFields;

  public validator: AnyValidator | null;

  public ast?: AST;

  constructor(name: string,
              ast?: AST,
              fields: Map<string, any> = new Map(),
              validator: AnyValidator | null = null) {
    this.name = name;
    this.ast = ast;
    this.fields = fields;
    this.validator = validator;
  }
}

export class DomainDefinition extends EntityDefinition {

  private static typeToValidator: Map<string, AnyValidator> = new Map([
    ['string', (val: Expression, fields: Map<string, any>, entities: EntityMap) => {
      if (val.type !== Syntax.Literal) {
        return [createError('Type must be string')];
      }
      if (typeof val.value !== 'string') {
        return [];
      }
      if (fields.get('length') !== undefined && val.value.length > fields.get('length')) {
        return [];
      }
      return [];
    }],
    ['number', (val: Expression, fields: Map<string, any>, entities: EntityMap) => {
      return [];
    }],
    ['bigint', (val: Expression, fields: Map<string, any>, entities: EntityMap) => {
      return [];
    }],
    ['boolean', (val: Expression, fields: Map<string, any>, entities: EntityMap) => {
      return [];
    }],
    ['object', (val: Expression, fields: Map<string, any>, entities: EntityMap) => {
      return [];
    }],
    ['function', (val: Expression, fields: Map<string, any>, entities: EntityMap) => {
      return [];
    }],
    ['symbol', (val: Expression, fields: Map<string, any>, entities: EntityMap) => {
      return [];
    }],
  ]);

  constructor(name: string, ast?: AST, fields: Map<string, any> = new Map()) {
    super(name, ast, fields, DomainDefinition.typeToValidator.get(fields.get('type')));
  }
}
