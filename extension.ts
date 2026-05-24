import * as vscode from 'vscode';
import { FLAG_INLINE, FLAG_BLOCK } from './src/constants';
import { loadConfig, readProp, locateOpenDocument } from './src/utils';
import { CommentProcessor, RetainRule, EditBuilder } from './src/processor';

class PreviewEditBuilder implements EditBuilder {
  private _ranges: vscode.Range[] = [];
  delete(range: vscode.Range): void { this._ranges.push(range); }
  get ranges(): vscode.Range[] { return this._ranges; }
}

function applyDeletions(document: vscode.TextDocument, ranges: vscode.Range[]): string {
  const sorted = [...ranges].sort((a, b) =>
    document.offsetAt(b.start) - document.offsetAt(a.start)
  );
  let result = document.getText();
  for (const range of sorted) {
    const s = document.offsetAt(range.start);
    const e = document.offsetAt(range.end);
    result = result.slice(0, s) + result.slice(e);
  }
  return result;
}

export function activate(context: vscode.ExtensionContext): void {
  let captureStrings       = false;
  let capturedStringRanges: [vscode.Position, vscode.Position][] = [];

  const previewContents = new Map<string, string>();
  const previewEmitter  = new vscode.EventEmitter<vscode.Uri>();
  const previewProvider = vscode.workspace.registerTextDocumentContentProvider('remove-comments-preview', {
    onDidChange: previewEmitter.event,
    provideTextDocumentContent(uri: vscode.Uri): string {
      return previewContents.get(uri.toString()) ?? '';
    }
  });
  context.subscriptions.push(previewProvider);
  context.subscriptions.push(previewEmitter);

  const workspaceChannel = vscode.window.createOutputChannel('Remove Comments Pro Workspace');
  context.subscriptions.push(workspaceChannel);

  function buildRetainList(docLangId: string): RetainRule[] {
    const list: RetainRule[] = [];
    const config = loadConfig();
    if (config.get<boolean>('bypassRetainRules') ?? false) { return list; }
    const retainCfg = config.get<Record<string, unknown> | false>('retain');
    if (retainCfg === false || !retainCfg) { return list; }

    function collectPatterns(regexes: unknown): void {
      if (regexes === false || typeof regexes !== 'object' || !regexes) { return; }
      for (const key of Object.keys(regexes as object)) {
        const entry = (regexes as Record<string, unknown>)[key];
        if (entry === false) { continue; }
        list.push(entry as RetainRule);
      }
    }

    for (const key of Object.keys(retainCfg)) {
      const regexes = retainCfg[key];
      for (const segment of key.split(',')) {
        if (segment === 'all' || segment === docLangId) { collectPatterns(regexes); }
      }
    }
    return list;
  }

  function buildProcessor(
    docLangId: string,
    flagMask: number,
    matchPrefix?: string,
    onStringFound?: (s: vscode.Position, e: vscode.Position) => void
  ): CommentProcessor {
    const config = loadConfig();
    const jsdocProtected = !(config.get<boolean>('treatJsdocAsComment') ?? false);
    const proc = new CommentProcessor(
      docLangId, flagMask, matchPrefix,
      jsdocProtected, buildRetainList(docLangId),
      onStringFound ?? (() => { /* no-op */ })
    );
    proc.configureBlankTrim(
      config.get<number>('trimBlankLines.above') ?? 0,
      config.get<number>('trimBlankLines.below') ?? 0
    );
    proc.applyC99Mode(config.get<boolean>('enableC99') ?? false);
    return proc;
  }

  function resetFlags(): void {
    captureStrings       = false;
    capturedStringRanges = [];
  }

  function executeStrip(
    editor: vscode.TextEditor,
    edit: vscode.TextEditorEdit,
    flagMask: number,
    matchPrefix?: string
  ): void {
    const docLangId = editor.document.languageId;

    let onStringFound: (s: vscode.Position, e: vscode.Position) => void = () => { /* no-op */ };
    if (captureStrings) {
      onStringFound = (s, e) => { capturedStringRanges.push([s, e]); };
    }

    const proc = buildProcessor(docLangId, flagMask, matchPrefix, onStringFound);
    if (!proc.isSupported) {
      vscode.window.showInformationMessage(`Remove Comments Pro: unsupported language (${docLangId})`);
      resetFlags();
      return;
    }
    proc.stripComments(editor, edit);

    if (capturedStringRanges.length > 0) { persistCapturedStrings(editor); }
    resetFlags();
  }

  async function executeStripWithConfirm(
    editor: vscode.TextEditor,
    flagMask: number,
    matchPrefix?: string
  ): Promise<void> {
    const docLangId = editor.document.languageId;
    const proc = buildProcessor(docLangId, flagMask, matchPrefix);
    if (!proc.isSupported) {
      vscode.window.showInformationMessage(`Remove Comments Pro: unsupported language (${docLangId})`);
      resetFlags();
      return;
    }

    const fakeEdit = new PreviewEditBuilder();
    proc.stripComments(editor, fakeEdit);

    if (fakeEdit.ranges.length === 0) {
      vscode.window.showInformationMessage('Remove Comments Pro: no comments found.');
      resetFlags();
      return;
    }

    const previewText = applyDeletions(editor.document, fakeEdit.ranges);
    const basename    = editor.document.uri.path.replace(/^.*\//, '');
    const previewUri  = vscode.Uri.parse(`remove-comments-preview://preview/${encodeURIComponent(basename)}`);
    previewContents.set(previewUri.toString(), previewText);

    await vscode.commands.executeCommand('vscode.diff',
      editor.document.uri,
      previewUri,
      `Preview: Remove Comments Pro ← ${basename}`
    );

    const choice = await vscode.window.showInformationMessage(
      `Remove Comments Pro: ${fakeEdit.ranges.length} comment region(s) found. Apply removal?`,
      'Apply', 'Cancel'
    );

    resetFlags();

    if (choice !== 'Apply') { return; }

    const wsEdit = new vscode.WorkspaceEdit();
    for (const range of fakeEdit.ranges) { wsEdit.delete(editor.document.uri, range); }
    await vscode.workspace.applyEdit(wsEdit);
  }

  function persistCapturedStrings(editor: vscode.TextEditor): void {
    const cfg             = loadConfig();
    const outputFilePath  = cfg.get<string>('stringCapture.outputPath');
    const multilineJoiner = cfg.get<string>('stringCapture.lineGlue') ?? '@@@@';
    if (!outputFilePath) {
      vscode.window.showErrorMessage('Setting remove-comments.stringCapture.outputPath is not defined');
      return;
    }
    const outputFileUri = vscode.Uri.file(outputFilePath);
    const outputDoc     = locateOpenDocument(outputFileUri);
    if (!outputDoc) {
      vscode.window.showErrorMessage(`Please open and keep this file in a tab: ${outputFileUri.fsPath}`, 'Open file')
        .then(result => { if (result) { vscode.commands.executeCommand('vscode.open', outputFileUri); } });
      return;
    }
    const srcBasename = editor.document.uri.path.replace(/^.*\//, '');
    const lineBreakRE = /\r?\n/g;
    let outputContent = '';
    for (const [start, end] of capturedStringRanges) {
      let text = editor.document.getText(new vscode.Range(start, end));
      text = text.replace(lineBreakRE, multilineJoiner);
      outputContent += `${srcBasename}::${start.line + 1}:${start.character + 1} ${text}\n`;
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.insert(outputFileUri, new vscode.Position(outputDoc.lineCount - 1, 0), outputContent);
    vscode.workspace.applyEdit(workspaceEdit);
  }

  async function showPreview(editor: vscode.TextEditor, flagMask: number, title: string): Promise<void> {
    const proc = buildProcessor(editor.document.languageId, flagMask);
    if (!proc.isSupported) {
      vscode.window.showInformationMessage(`Remove Comments Pro: unsupported language (${editor.document.languageId})`);
      return;
    }
    const fakeEdit = new PreviewEditBuilder();
    proc.stripComments(editor, fakeEdit);
    const previewText = applyDeletions(editor.document, fakeEdit.ranges);
    const basename    = editor.document.uri.path.replace(/^.*\//, '');
    const previewUri  = vscode.Uri.parse(`remove-comments-preview://preview/${encodeURIComponent(basename)}`);
    previewContents.set(previewUri.toString(), previewText);
    await vscode.commands.executeCommand('vscode.diff',
      editor.document.uri,
      previewUri,
      `Preview: ${title} ← ${basename}`
    );
  }

  async function buildExcludePattern(): Promise<string> {
    const segments = new Set<string>([
      '**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**',
      '**/.next/**',       '**/.git/**',   '**/coverage/**',
      '**/.nuxt/**',       '**/.output/**','**/.cache/**',
      '**/.parcel-cache/**','**/tmp/**',   '**/.turbo/**',
    ]);

    const ignoreFileNames = ['.gitignore', '.dockerignore', '.ignore'];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const name of ignoreFileNames) {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name));
          const text  = Buffer.from(bytes).toString('utf8');
          for (let line of text.split(/\r?\n/)) {
            line = line.trim();
            if (!line || line.startsWith('#') || line.startsWith('!')) { continue; }
            if (line.startsWith('/')) { line = line.slice(1); }
            const isDir = line.endsWith('/');
            if (isDir) { line = line.slice(0, -1); }
            if (!line) { continue; }
            segments.add(`**/${line}/**`);
            if (!isDir) { segments.add(`**/${line}`); }
          }
        } catch { /* file not present */ }
      }
    }

    return `{${[...segments].join(',')}}`;
  }

  async function executeWorkspaceStrip(flagMask: number): Promise<void> {
    const excludePattern = await buildExcludePattern();
    const files = await vscode.workspace.findFiles('**/*', excludePattern);
    if (files.length === 0) {
      vscode.window.showInformationMessage('Remove Comments Pro: no files found in workspace.');
      return;
    }

    const wsEdit      = new vscode.WorkspaceEdit();
    let totalRegions  = 0;
    let totalFiles    = 0;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Remove Comments Pro: scanning workspace…',
      cancellable: true
    }, async (progress, token) => {
      for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) { break; }
        const uri = files[i];
        progress.report({ message: uri.path.replace(/^.*\//, ''), increment: 100 / files.length });
        try {
          const doc  = await vscode.workspace.openTextDocument(uri);
          const proc = buildProcessor(doc.languageId, flagMask);
          if (!proc.isSupported) { continue; }
          const fakeEdit = new PreviewEditBuilder();
          proc.stripDocument(doc, fakeEdit);
          if (fakeEdit.ranges.length > 0) {
            for (const range of fakeEdit.ranges) { wsEdit.delete(uri, range); }
            totalRegions += fakeEdit.ranges.length;
            totalFiles++;
          }
        } catch { /* skip binary/unreadable files */ }
      }
    });

    if (totalRegions === 0) {
      vscode.window.showInformationMessage('Remove Comments Pro: no comments found in workspace.');
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `Remove Comments Pro: ${totalRegions} comment region(s) in ${totalFiles} file(s). Apply removal?`,
      'Apply', 'Cancel'
    );
    if (choice !== 'Apply') { return; }

    await vscode.workspace.applyEdit(wsEdit);
    vscode.window.showInformationMessage(
      `Remove Comments Pro: removed ${totalRegions} region(s) from ${totalFiles} file(s).`
    );
  }

  async function previewWorkspaceStrip(flagMask: number): Promise<void> {
    const excludePattern = await buildExcludePattern();
    const files = await vscode.workspace.findFiles('**/*', excludePattern);
    if (files.length === 0) {
      vscode.window.showInformationMessage('Remove Comments Pro: no files found in workspace.');
      return;
    }

    workspaceChannel.clear();
    workspaceChannel.appendLine('Remove Comments Pro — Workspace Preview');
    workspaceChannel.appendLine('='.repeat(50));
    let totalRegions = 0;
    let totalFiles   = 0;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Remove Comments Pro: previewing workspace…',
      cancellable: true
    }, async (progress, token) => {
      for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) { break; }
        const uri = files[i];
        progress.report({ message: uri.path.replace(/^.*\//, ''), increment: 100 / files.length });
        try {
          const doc  = await vscode.workspace.openTextDocument(uri);
          const proc = buildProcessor(doc.languageId, flagMask);
          if (!proc.isSupported) { continue; }
          const fakeEdit = new PreviewEditBuilder();
          proc.stripDocument(doc, fakeEdit);
          if (fakeEdit.ranges.length > 0) {
            workspaceChannel.appendLine(`${uri.fsPath}  (${fakeEdit.ranges.length} region(s))`);
            totalRegions += fakeEdit.ranges.length;
            totalFiles++;
          }
        } catch { /* skip binary/unreadable files */ }
      }
    });

    workspaceChannel.appendLine('='.repeat(50));
    workspaceChannel.appendLine(`Total: ${totalRegions} region(s) across ${totalFiles} file(s)`);
    workspaceChannel.show(true);
  }

  // --- Current file commands ---

  context.subscriptions.push(vscode.commands.registerTextEditorCommand(
    'remove-comments.removeAllComments',
    async (editor, edit) => {
      if (loadConfig().get<boolean>('previewBeforeApply') ?? true) {
        await executeStripWithConfirm(editor, FLAG_INLINE | FLAG_BLOCK);
      } else {
        executeStrip(editor, edit, FLAG_INLINE | FLAG_BLOCK);
      }
    }
  ));

  context.subscriptions.push(vscode.commands.registerTextEditorCommand(
    'remove-comments.removeAllCommentsWithPrefix',
    async (editor, _edit, args) => {
      let matchPrefix: string | undefined;
      if (args) {
        matchPrefix = readProp(args as Record<string, unknown>, 'prefix') as string | undefined;
      } else {
        matchPrefix = await vscode.window.showInputBox({ title: 'Comment Prefix Filter' });
      }
      if (!matchPrefix) { return; }
      if (loadConfig().get<boolean>('previewBeforeApply') ?? true) {
        await executeStripWithConfirm(editor, FLAG_INLINE | FLAG_BLOCK, matchPrefix);
      } else {
        editor.edit(eb => { executeStrip(editor, eb, FLAG_INLINE | FLAG_BLOCK, matchPrefix); });
      }
    }
  ));

  context.subscriptions.push(vscode.commands.registerTextEditorCommand(
    'remove-comments.removeSingleLineComments',
    async (editor, edit) => {
      if (loadConfig().get<boolean>('previewBeforeApply') ?? true) {
        await executeStripWithConfirm(editor, FLAG_INLINE);
      } else {
        executeStrip(editor, edit, FLAG_INLINE);
      }
    }
  ));

  context.subscriptions.push(vscode.commands.registerTextEditorCommand(
    'remove-comments.removeMultilineComments',
    async (editor, edit) => {
      if (loadConfig().get<boolean>('previewBeforeApply') ?? true) {
        await executeStripWithConfirm(editor, FLAG_BLOCK);
      } else {
        executeStrip(editor, edit, FLAG_BLOCK);
      }
    }
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'remove-comments.markJSDocStringAsComment',
    () => {
      const cfg = loadConfig();
      cfg.update('treatJsdocAsComment', !(cfg.get<boolean>('treatJsdocAsComment') ?? false), vscode.ConfigurationTarget.Global);
    }
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'remove-comments.ignoreKeepCommentSetting',
    () => {
      const cfg = loadConfig();
      cfg.update('bypassRetainRules', !(cfg.get<boolean>('bypassRetainRules') ?? false), vscode.ConfigurationTarget.Global);
    }
  ));

  context.subscriptions.push(vscode.commands.registerTextEditorCommand(
    'remove-comments.extractStrings',
    (editor, edit) => { captureStrings = true; executeStrip(editor, edit, 0); }
  ));

  // --- Preview commands (current file) ---

  context.subscriptions.push(vscode.commands.registerTextEditorCommand(
    'remove-comments.previewAllComments',
    (editor) => { showPreview(editor, FLAG_INLINE | FLAG_BLOCK, 'Remove All Comments'); }
  ));

  context.subscriptions.push(vscode.commands.registerTextEditorCommand(
    'remove-comments.previewSingleLineComments',
    (editor) => { showPreview(editor, FLAG_INLINE, 'Remove All Single Line Comments'); }
  ));

  context.subscriptions.push(vscode.commands.registerTextEditorCommand(
    'remove-comments.previewMultilineComments',
    (editor) => { showPreview(editor, FLAG_BLOCK, 'Remove All Multiline Comments'); }
  ));

  // --- Workspace commands ---

  context.subscriptions.push(vscode.commands.registerCommand(
    'remove-comments.removeAllCommentsWorkspace',
    () => { executeWorkspaceStrip(FLAG_INLINE | FLAG_BLOCK); }
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'remove-comments.previewAllCommentsWorkspace',
    () => { previewWorkspaceStrip(FLAG_INLINE | FLAG_BLOCK); }
  ));
}

export function deactivate(): void {}
