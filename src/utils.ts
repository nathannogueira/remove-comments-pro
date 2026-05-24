import * as vscode from 'vscode';

export const readProp = <T>(obj: Record<string, unknown>, key: string, fallback?: T): T | undefined =>
  obj.hasOwnProperty(key) ? (obj[key] as T) : fallback;

export const loadConfig = (): vscode.WorkspaceConfiguration =>
  vscode.workspace.getConfiguration('remove-comments', null);

export const checkString = (val: unknown): val is string => typeof val === 'string';

export const escapeRegex = (str: string): string =>
  str.replace(/[[\]*|(){}\\.?^$+]/g, m => `\\${m}`);

export const intRange = (start: number, end: number): number[] =>
  [...Array(end - start).keys()].map(k => k + start);

export const locateOpenDocument = (uri: vscode.Uri): vscode.TextDocument | undefined => {
  for (const document of vscode.workspace.textDocuments) {
    if (document.isClosed) { continue; }
    if (document.uri.scheme !== 'file') { continue; }
    if (document.uri.fsPath === uri.fsPath) { return document; }
  }
  return undefined;
};
