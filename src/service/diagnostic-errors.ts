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
