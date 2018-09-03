import { Syntax } from 'esprima';
import { CallExpression, ObjectExpression } from 'estree';

export function objectAstToMap(ast: ObjectExpression): Map<string, any> {
  const map: Map<string, any> = new Map();
  for (const prop of ast.properties) {
    if (prop.key.type === Syntax.Identifier && prop.value && prop.value.type === Syntax.Literal) {
      map.set(prop.key.name, prop.value.value);
    }
  }
  return map;
}

export function callParamsAstToSet(ast: CallExpression): Set<string> {
  const set: Set<string> = new Set();
  for (const arg of ast.arguments) {
    if (arg.type === Syntax.Identifier) set.add(arg.name);
    else if (arg.type === Syntax.Literal && arg.value) set.add(arg.value.toString());
  }
  return set;
}
