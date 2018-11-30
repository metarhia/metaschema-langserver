import { Expression } from 'estree';
import { Syntax } from 'esprima';
import { DiagnosticSeverity } from 'vscode-languageserver-types';

export interface DiagnosticError {
  message: string;
  severity: DiagnosticSeverity;
  code?: number | string;
  source?: string;
}

export const createError = (
  message: string,
  severity: DiagnosticSeverity = DiagnosticSeverity.Warning,
): DiagnosticError => ({ message, severity });

export const nonNullUndefinedLiteral = (expr: Expression): DiagnosticError[] => {
  if (expr.type !== Syntax.Literal) {
    return [createError('Type must be a Literal')];
  }
  if (expr.value === null) {
    return [createError('Type must not be null')];
  }
  if (expr.value === undefined) {
    return [createError('Type must not be undefined')];
  }
  return [];
}
