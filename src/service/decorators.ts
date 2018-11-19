import { Syntax } from 'esprima';
import { CallExpression, Expression } from 'estree';
import { callParamsAstToSet } from './ast-utils';
import { AnyValidator } from './entities';

export const enum Decorator {
  // Value decorators
  Flags = 'Flags',
  Enum = 'Enum',
  List = 'List',

  // Relation decorators
  Many = 'Many',
  Master = 'Master',
  Include = 'Include',

  // Index decorators
  Unique = 'Unique',
  Index = 'Index',

  // Entity decorators
  Dictionary = 'Dictionary',
  System = 'System',
  Log = 'Log',
  Local = 'Local',
  History = 'History',
  View = 'View',
  Memory = 'Memory',

  // Validate
  Validate = 'Validate',
}

export const valueDecorators = new Set([Decorator.Enum, Decorator.Flags]);
export function isValueDecorator(decorator: Decorator) {
  return valueDecorators.has(decorator);
}

export const relationDecorators = new Set([
  Decorator.Many, Decorator.Master, Decorator.Include,
]);
export function isRelationDecorator(decorator: Decorator) {
  return relationDecorators.has(decorator);
}

export const indexDecorators = new Set([Decorator.Unique, Decorator.Index]);
export function isIndexDecorator(decorator: Decorator) {
  return indexDecorators.has(decorator);
}

export const entityDecorators = new Set([
  Decorator.Dictionary, Decorator.System, Decorator.Log,
  Decorator.Local, Decorator.History, Decorator.View,
  Decorator.Memory,
]);
export function isEntityDecorator(decorator: Decorator) {
  return entityDecorators.has(decorator);
}

export function isCategoryDecorator(decorator: Decorator) {
  return (
    isRelationDecorator(decorator) || isIndexDecorator(decorator) || isEntityDecorator(decorator)
  );
}

export function isValidateDecorator(decorator: Decorator) {
  return decorator === Decorator.Validate;
}

export function decoratorValidator(decAst: CallExpression): AnyValidator | null {
  // anything other than Identifier is not supported
  if (decAst.callee.type !== Syntax.Identifier) return null;
  const decoratorName = decAst.callee.name;
  if (decoratorName === Decorator.Enum) {
    const args = callParamsAstToSet(decAst);
    return (expr: Expression): boolean =>
      expr.type === Syntax.Literal && expr.value != null && args.has(expr.value.toString());
  }
  if (isCategoryDecorator(decoratorName as Decorator)) {
    return (expr: Expression): boolean =>
      // this only verifies the usage, not correctness
      // (it will not check that the category is valid)
      expr.type === Syntax.Literal && expr.value !== null && expr.value !== undefined;
  }
  if (isValidateDecorator(decoratorName as Decorator)) {
    if (decAst.arguments.length === 0 ||
        decAst.arguments[0].type !== Syntax.ArrowFunctionExpression) {
      return null;
    }
    const arrowFuncRange = decAst.arguments[0].range;
    // TODO(lundibundi): extract and eval the function and use it to validate the data
  }
  return null;
}
