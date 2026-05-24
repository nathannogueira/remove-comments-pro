import * as vscode from 'vscode';
import { FLAG_INLINE, FLAG_BLOCK, ENCODING_SENTINEL } from './constants';
import { readProp, checkString, escapeRegex, intRange } from './utils';

type CommentToken = [string, string?, string?, string?];
type StringToken  = [string, string?];

interface ZoneSection {
  start: string;
  stop: string;
  languageId: string;
}

interface ZoneSplit {
  defaultLanguageId: string;
  sections: ZoneSection[];
}

export interface RetainRule {
  regex?: string;
  flags?: string;
}

export type StringCaptureCB = (start: vscode.Position, end: vscode.Position) => void;

export interface EditBuilder {
  delete(location: vscode.Range): void;
}

export class CommentProcessor {
  commentTokens: CommentToken[] = [];
  stringTokens: StringToken[]   = [];
  handleInline: boolean;
  handleBlock: boolean;
  matchPrefix: string | undefined;
  isSupported       = true;
  lineCommentRE: RegExp | undefined;
  useIndentMode     = false;
  detectRegexLiteral = false;
  activeIndent: string | undefined;
  isContinuationLine  = false;
  prevWasCommentLine  = false;
  retainCurrentLine   = false;
  allowNesting  = false;
  nestingDepth  = 0;
  zoneSplit: ZoneSplit | undefined;
  preserveJsdoc: boolean;
  retainPatterns: RetainRule[];
  onStringFound: StringCaptureCB;
  blockEndMatch: RegExpExecArray | undefined;
  activeLangId: string;
  trimBlankBefore = 0;
  trimBlankAfter  = 0;
  useC99Mode      = false;
  lastNonSpaceChar = ' ';

  constructor(
    langId: string,
    flagMask: number,
    matchPrefix: string | undefined,
    preserveJsdoc: boolean,
    retainPatterns: RetainRule[],
    onStringFound: StringCaptureCB
  ) {
    this.handleInline = (flagMask & FLAG_INLINE) !== 0;
    this.handleBlock  = (flagMask & FLAG_BLOCK)  !== 0;
    this.matchPrefix   = matchPrefix;
    this.preserveJsdoc = preserveJsdoc;
    this.retainPatterns = retainPatterns;
    this.onStringFound  = onStringFound;
    this.activeLangId   = langId;
    this.applyLanguageRules(langId);
  }

  extractIndent(text: string): string {
    return text.replace(/(^[ \t]*).*/, '$1');
  }

  matchesCommentLine(text: string): boolean {
    if (this.lineCommentRE === undefined) { return false; }
    if (text.length === 0) { return false; }
    this.isContinuationLine = false;
    if (this.useIndentMode && this.prevWasCommentLine) {
      const lineIndent = this.extractIndent(text);
      if (this.activeIndent !== undefined && lineIndent.startsWith(this.activeIndent) && lineIndent.length > this.activeIndent.length) {
        this.isContinuationLine = true;
        return true;
      }
    }
    this.lineCommentRE.lastIndex = 0;
    const result = this.lineCommentRE.test(text);
    if (result) { this.activeIndent = this.extractIndent(text); }
    return result;
  }

  scanBlockEnd(text: string, closeRE: RegExp): boolean {
    let result: RegExpExecArray | null;
    while ((result = closeRE.exec(text)) !== null) {
      if (this.allowNesting && result[1]) {
        this.nestingDepth++;
        continue;
      }
      if (result[2] !== undefined) {
        this.nestingDepth--;
        if (this.nestingDepth === 0) {
          this.allowNesting  = false;
          this.blockEndMatch = result;
          return true;
        }
      }
    }
    return false;
  }

  shouldRetain(doc: vscode.TextDocument, span: vscode.Range, openCharPos: number): boolean {
    let text = '';
    if (span.start.line === span.end.line) {
      text += doc.lineAt(span.start.line).text.substring(span.start.character, span.end.character);
    } else {
      text += doc.lineAt(span.start.line).text.substring(span.start.character);
      for (let lineNr = span.start.line + 1; lineNr < span.end.line; ++lineNr) {
        text += '\t';
        text += doc.lineAt(lineNr).text;
      }
      text += '\t';
      text += doc.lineAt(span.end.line).text.substring(0, span.end.character);
    }
    if (this.matchPrefix) { return !text.startsWith(this.matchPrefix); }
    if (openCharPos === 0 && this.isEncodingDeclaration(text)) { return true; }
    for (const keepRegex of this.retainPatterns) {
      const regex = readProp(keepRegex as Record<string, unknown>, 'regex');
      if (!checkString(regex) || regex.length === 0) { continue; }
      if (new RegExp(regex, readProp(keepRegex as Record<string, unknown>, 'flags') as string | undefined).test(text)) {
        return true;
      }
    }
    return false;
  }

  *iterateZones(doc: vscode.TextDocument, selections: vscode.Selection[]): Generator<[vscode.Selection, string]> {
    let sectionBreaks: Array<{ offset: number; languageId: string | undefined }> = [];
    if (this.zoneSplit !== undefined) {
      const zs = this.zoneSplit;
      sectionBreaks = [{ offset: 0, languageId: zs.defaultLanguageId }];
      const text = doc.getText();
      let offset = 0;
      while (true) {
        type SectionAcc = { offset: number | undefined; result: RegExpExecArray | undefined; config: ZoneSection | undefined; startRE: RegExp | undefined };
        const section = zs.sections.reduce<SectionAcc>((acc, config) => {
          const startRE = new RegExp(config.start, 'g');
          startRE.lastIndex = offset;
          const result = startRE.exec(text);
          if (result === null) { return acc; }
          if (acc.offset === undefined || result.index < acc.offset) {
            return { offset: result.index, result, config, startRE };
          }
          return acc;
        }, { offset: undefined, result: undefined, config: undefined, startRE: undefined });
        if (section.offset === undefined || !section.result || !section.config || !section.startRE) { break; }
        let languageId = section.config.languageId.replace(/\$\{(\d+):\?([^:]+):([^}]+)\}/g, (_m, p1, p2, p3) =>
          section.result![Number(p1)] !== undefined ? p2 : p3
        );
        offset = section.startRE.lastIndex;
        section.startRE.lastIndex = 0;
        languageId = section.result[0].replace(section.startRE, languageId);
        if (section.offset > sectionBreaks[sectionBreaks.length - 1].offset) {
          sectionBreaks.push({ offset: section.offset, languageId });
        } else {
          sectionBreaks[sectionBreaks.length - 1].languageId = languageId;
        }
        const stopRE = new RegExp(section.config.stop, 'g');
        stopRE.lastIndex = offset;
        const stopResult = stopRE.exec(text);
        if (stopResult !== null) {
          sectionBreaks.push({ offset: stopResult.index, languageId: zs.defaultLanguageId });
          offset = stopRE.lastIndex;
        }
      }
      if (sectionBreaks[sectionBreaks.length - 1].offset !== text.length) {
        sectionBreaks.push({ offset: text.length, languageId: undefined });
      }
    }
    for (const selection of selections) {
      if (selection.isEmpty) { continue; }
      if (this.zoneSplit === undefined) {
        yield [selection, this.activeLangId];
        continue;
      }
      const selStartOffset = doc.offsetAt(selection.start);
      const selEndOffset   = doc.offsetAt(selection.end);
      for (let sectionNr = 1; sectionNr < sectionBreaks.length; ++sectionNr) {
        const languageId         = sectionBreaks[sectionNr - 1].languageId;
        const sectionStartOffset = sectionBreaks[sectionNr - 1].offset;
        const sectionEndOffset   = sectionBreaks[sectionNr].offset;
        if (!languageId) { continue; }
        if (sectionEndOffset <= selStartOffset || selEndOffset <= sectionStartOffset) { continue; }
        yield [
          new vscode.Selection(
            doc.positionAt(Math.max(selStartOffset, sectionStartOffset)),
            doc.positionAt(Math.min(selEndOffset, sectionEndOffset))
          ),
          languageId
        ];
      }
    }
  }

  isEncodingDeclaration(text: string): boolean {
    text = text.trim();
    return text.startsWith(ENCODING_SENTINEL) && text.endsWith(ENCODING_SENTINEL);
  }

  configureBlankTrim(before: number, after: number): void {
    this.trimBlankBefore = before;
    this.trimBlankAfter  = after;
  }

  applyC99Mode(flag: boolean): void {
    this.useC99Mode = flag;
  }

  stripDocument(document: vscode.TextDocument, editBuilder: EditBuilder): void {
    const endPos = document.positionAt(document.getText().length);
    this.process(document, [new vscode.Selection(new vscode.Position(0, 0), endPos)], editBuilder);
  }

  stripComments(editor: vscode.TextEditor, editBuilder: EditBuilder): void {
    if (!editor) { return; }
    let selections = [...editor.selections];
    if (selections.length === 1 && selections[0].isEmpty) {
      selections = [new vscode.Selection(new vscode.Position(0, 0), editor.document.positionAt(editor.document.getText().length))];
    }
    this.process(editor.document, selections, editBuilder);
  }

  private process(document: vscode.TextDocument, selections: vscode.Selection[], editBuilder: EditBuilder): void {
    let inBlockComment     = false;
    let blockCommentLangId: string | undefined;
    let deleteQueue: vscode.Range[] = [];
    let closeRE  = new RegExp('_');
    let deleteFrom: vscode.Position | undefined;
    let commentTextFrom: vscode.Position | undefined;

    for (const [selection, languageId] of this.iterateZones(document, selections)) {
      if (inBlockComment) {
        if (languageId !== blockCommentLangId) { continue; }
      } else {
        blockCommentLangId = undefined;
        deleteQueue        = [];
        closeRE            = new RegExp('_');
        deleteFrom         = undefined;
        commentTextFrom    = undefined;
      }
      if (selection.isEmpty) { continue; }
      this.applyLanguageRules(languageId);
      const startLine = selection.start.line;
      const endLine   = selection.end.line;
      let inStringLiteral = false;
      let openCharPos     = -1;
      this.prevWasCommentLine = false;
      this.activeIndent       = undefined;
      this.retainCurrentLine  = false;
      this.lastNonSpaceChar   = ' ';

      nextLine:
      for (let lineNr = startLine; lineNr <= endLine; ++lineNr) {
        const line = document.lineAt(lineNr);
        let text = line.text;
        if (lineNr === 0 && text.startsWith('#!')) { continue nextLine; }
        let charStartIdx = 0;
        if (lineNr === endLine) {
          text = text.substring(0, selection.end.character);
          if (text === '') { continue nextLine; }
        }
        if (lineNr === startLine) { charStartIdx = selection.start.character; }

        if (inStringLiteral || inBlockComment) {
          closeRE.lastIndex = 0;
          if (inStringLiteral) {
            const result = closeRE.exec(text);
            if (result === null) { continue nextLine; }
            this.onStringFound(deleteFrom!, new vscode.Position(lineNr, closeRE.lastIndex));
          } else {
            if (!this.scanBlockEnd(text, closeRE)) { continue nextLine; }
            if (this.handleBlock && !this.shouldRetain(document, new vscode.Range(commentTextFrom!, new vscode.Position(lineNr, this.blockEndMatch!.index)), openCharPos)) {
              deleteQueue.push(new vscode.Range(deleteFrom!, new vscode.Position(deleteFrom!.line, document.lineAt(deleteFrom!.line).text.length)));
              if (deleteFrom!.line + 1 !== lineNr) {
                deleteQueue.push(new vscode.Range(new vscode.Position(deleteFrom!.line + 1, 0), new vscode.Position(lineNr, 0)));
              }
              deleteQueue.push(new vscode.Range(new vscode.Position(lineNr, 0), new vscode.Position(lineNr, closeRE.lastIndex)));
            }
          }
          deleteFrom         = undefined;
          commentTextFrom    = undefined;
          openCharPos        = -1;
          inBlockComment     = false;
          blockCommentLangId = undefined;
          inStringLiteral    = false;
          charStartIdx       = closeRE.lastIndex;
        } else {
          if (this.matchesCommentLine(text)) {
            if (!this.isContinuationLine) {
              this.retainCurrentLine = this.shouldRetain(document, new vscode.Range(new vscode.Position(lineNr, this.lineCommentRE!.lastIndex), new vscode.Position(lineNr, text.length)), 0);
            }
            if (this.handleInline && !this.retainCurrentLine) {
              deleteQueue.push(new vscode.Range(new vscode.Position(lineNr, charStartIdx), new vscode.Position(lineNr, text.length)));
            }
            this.prevWasCommentLine = true;
            continue nextLine;
          }
        }
        this.prevWasCommentLine = false;
        this.activeIndent       = undefined;
        this.retainCurrentLine  = false;

        nextChar:
        for (let charIdx = charStartIdx; charIdx < text.length; ++charIdx) {
          for (const strDelim of this.stringTokens) {
            if (text.startsWith(strDelim[0], charIdx)) {
              if (strDelim[0] === '/**' && text.startsWith('/***', charIdx)) { break; }
              deleteFrom = new vscode.Position(lineNr, charIdx);
              if (strDelim[1] === '\n') {
                this.onStringFound(deleteFrom, new vscode.Position(lineNr, text.length));
                continue nextLine;
              }
              charIdx += strDelim[0].length;
              const stringCloseSeq = strDelim[1] ? strDelim[1] : strDelim[0];
              this.lastNonSpaceChar = stringCloseSeq.charAt(stringCloseSeq.length - 1);
              closeRE = new RegExp(`(\\\\.|.)*?${escapeRegex(stringCloseSeq)}`, 'y');
              closeRE.lastIndex = charIdx;
              const result = closeRE.exec(text);
              if (result) {
                this.onStringFound(deleteFrom, new vscode.Position(lineNr, closeRE.lastIndex));
                charIdx = closeRE.lastIndex - 1;
                continue nextChar;
              }
              inStringLiteral = true;
              continue nextLine;
            }
          }
          for (const commDelim of this.commentTokens) {
            if (text.startsWith(commDelim[0], charIdx)) {
              openCharPos     = charIdx;
              commentTextFrom = new vscode.Position(lineNr, charIdx + commDelim[0].length);
              let pos = charIdx;
              while (pos > 0 && text.charAt(pos - 1) <= ' ') { pos--; }
              deleteFrom = new vscode.Position(lineNr, pos);
              charIdx   += commDelim[0].length;
              if (commDelim[1] === undefined && commDelim[3] === undefined) {
                if (this.handleInline && !this.shouldRetain(document, new vscode.Range(commentTextFrom, new vscode.Position(lineNr, text.length)), openCharPos)) {
                  deleteQueue.push(new vscode.Range(deleteFrom, new vscode.Position(lineNr, text.length)));
                }
                continue nextLine;
              }
              let openDelim  = commDelim[0];
              let closeDelim = commDelim[1]!;
              if (commDelim[2]) {
                this.allowNesting = true;
                openDelim  = commDelim[1]!;
                closeDelim = commDelim[2];
              }
              if (commDelim[3]) {
                openDelim  = commDelim[0];
                closeDelim = commDelim[3];
                closeRE = new RegExp(`(${escapeRegex(openDelim)})|(${closeDelim})`, 'g');
              } else {
                closeRE = new RegExp(`(${escapeRegex(openDelim)})|(${escapeRegex(closeDelim)})`, 'g');
              }
              closeRE.lastIndex = charIdx;
              this.nestingDepth = 1;
              if (this.scanBlockEnd(text, closeRE)) {
                if (this.handleInline && !this.shouldRetain(document, new vscode.Range(commentTextFrom, new vscode.Position(lineNr, this.blockEndMatch!.index)), openCharPos)) {
                  deleteQueue.push(new vscode.Range(deleteFrom, new vscode.Position(lineNr, closeRE.lastIndex)));
                }
                charIdx = closeRE.lastIndex - 1;
                continue nextChar;
              }
              inBlockComment     = true;
              blockCommentLangId = languageId;
              continue nextLine;
            }
          }
          if (this.detectRegexLiteral) {
            const currentChar = text.charAt(charIdx);
            if (currentChar === '/' && (languageId === 'javascriptreact' || languageId === 'typescriptreact') && charIdx > 0 && text.charAt(charIdx - 1) === '<') {
              this.lastNonSpaceChar = ' ';
              continue nextChar;
            }
            if (currentChar === '/' && ('=,:;<>!+-*/%([{'.indexOf(this.lastNonSpaceChar) >= 0 || (charIdx >= 7 && text.slice(charIdx - 7, charIdx) === 'return '))) {
              charIdx += 1;
              closeRE = new RegExp(`(\\\\.|.)*?/`, 'y');
              closeRE.lastIndex = charIdx;
              const result = closeRE.exec(text);
              if (!result) {
                vscode.window.showInformationMessage(`Remove Comments Pro: regex literal at Line ${lineNr + 1}, Col ${charIdx} is not closed on this line.`);
                return;
              }
              this.lastNonSpaceChar = ' ';
              charIdx = closeRE.lastIndex - 1;
              continue nextChar;
            }
            if (currentChar > ' ') { this.lastNonSpaceChar = currentChar; }
          }
        }
      }

      if (inBlockComment) { continue; }

      const blankLineRE  = new RegExp('^\\s*$');
      const multiBlockLines = new Set<number>();
      const pendingDeletes  = new Map<number, vscode.Range>();

      const queueBlankDeletes = (lineNrs: number[], startLn: number, lastLn: number): void => {
        for (const lineNrDel of lineNrs) {
          if (lineNrDel < startLn || lineNrDel > lastLn || pendingDeletes.has(lineNrDel)) { break; }
          const ln = document.lineAt(lineNrDel);
          if (!blankLineRE.test(ln.text)) { break; }
          pendingDeletes.set(lineNrDel, ln.rangeIncludingLineBreak);
        }
      };

      while (deleteQueue.length > 0) {
        const rangesThisLine = [deleteQueue.shift()!];
        const lineNr = rangesThisLine[0].start.line;
        while (deleteQueue.length > 0 && deleteQueue[0].start.line === lineNr) {
          rangesThisLine.push(deleteQueue.shift()!);
        }
        if (rangesThisLine[0].end.line !== lineNr) {
          editBuilder.delete(rangesThisLine[0]);
          intRange(rangesThisLine[0].start.line, rangesThisLine[0].end.line).forEach(v => multiBlockLines.add(v));
          continue;
        }
        const ln = document.lineAt(lineNr);
        if (blankLineRE.test(rangesThisLine.reduceRight((t, r) => t.substring(0, r.start.character) + t.substring(r.end.character), ln.text))) {
          editBuilder.delete(ln.rangeIncludingLineBreak);
          let lastLine = endLine;
          if (selection.end.character === 0) { lastLine -= 1; }
          queueBlankDeletes(intRange(lineNr - this.trimBlankBefore, lineNr).reverse(), startLine, lastLine);
          queueBlankDeletes(intRange(lineNr + 1, lineNr + this.trimBlankAfter + 1), startLine, lastLine);
          continue;
        }
        rangesThisLine.forEach(r => { editBuilder.delete(r); });
      }
      multiBlockLines.forEach(k => pendingDeletes.delete(k));
      for (const r of pendingDeletes.values()) { editBuilder.delete(r); }
    }
  }

  applyLanguageRules(langId: string): boolean {
    this.isSupported        = true;
    this.detectRegexLiteral = false;
    this.commentTokens      = [];
    this.stringTokens       = [];

    langId = langId.toLowerCase();
    switch (langId) {

      case 'unknown':
        break;

      case 'python':
      case 'toml':
        this.stringTokens.push(["'''"]);
      case 'lmps':
        this.stringTokens.push(['"""']);
      case 'yaml':
        this.stringTokens.push(["'"]);
      case 'uiua':
      case 'r':
        this.stringTokens.push(['"']);
        this.commentTokens.push(['#']);
        if (langId === 'lmps') {
          this.commentTokens = [];
          this.commentTokens.push(['#', undefined, undefined, '(?<!&)$']);
        }
        break;

      case 'javascriptreact':
      case 'typescriptreact':
        this.commentTokens.push(['{/*', '*/}']);
      case 'javascript':
      case 'typescript':
        if (this.preserveJsdoc) { this.stringTokens.push(['/**', '*/']); }
        this.stringTokens.push(['`']);
        this.detectRegexLiteral = true;
      case 'dart':
      case 'haxe':
        this.stringTokens.push(["'"]);
      case 'cpp':
      case 'csharp':
      case 'objective-c':
      case 'objective-cpp':
      case 'go':
        if (langId === 'go') { this.stringTokens.push(['`']); }
      case 'java':
      case 'kotlin':
      case 'scala':
      case 'shaderlab':
      case 'solidity':
      case 'swift':
      case 'verilog':
      case 'systemverilog':
      case 'jsonc':
        this.commentTokens.push(['/*', '*/']);
        this.commentTokens.push(['//']);
        this.stringTokens.push(['"']);
        break;

      case 'c':
        this.commentTokens.push(['/*', '*/']);
        if (this.useC99Mode) { this.commentTokens.push(['//']); }
        this.stringTokens.push(['"']);
        break;

      case 'shellscript':
        this.lineCommentRE = new RegExp('^[ \\t]*#', 'g');
        break;

      case 'rust':
        this.commentTokens.push(['/*', '/*', '*/']);
        this.commentTokens.push(['//']);
        this.stringTokens.push(['"']);
        break;

      case 'racket':
        this.commentTokens.push(['#|', '#|', '|#']);
        this.commentTokens.push(['#!']);
        this.commentTokens.push([';']);
        this.stringTokens.push(['"']);
        break;

      case 'scheme':
        this.commentTokens.push(['#|', '#|', '|#']);
        this.commentTokens.push(['#!', '!#']);
        this.commentTokens.push([';']);
        this.stringTokens.push(['"']);
        break;

      case 'elixir':
        this.stringTokens.push(['@moduledoc """', '"""']);
        this.stringTokens.push(['@doc """', '"""']);
        this.stringTokens.push(['"']);
        this.commentTokens.push(['#']);
        break;

      case 'graphql':
        this.stringTokens.push(['"""']);
        this.stringTokens.push(['"']);
        this.commentTokens.push(['#']);
        break;

      case 'julia':
        this.commentTokens.push(['#=', '=#']);
        this.commentTokens.push(['#']);
        this.stringTokens.push(['"']);
        break;

      case 'clojure':
        this.stringTokens.push(["'"]);
      case 'lisp':
        this.stringTokens.push(['"']);
        this.commentTokens.push([';']);
        break;

      case 'erlang':
        this.commentTokens.push(['%']);
        this.stringTokens.push(['"']);
        break;

      case 'latex':
        this.lineCommentRE = new RegExp('^%', 'g');
        break;

      case 'dockerfile':
        this.lineCommentRE = new RegExp('^#(?!\\s*(syntax|escape)\\s*=)', 'ig');
        break;

      case 'groovy':
        this.stringTokens.push(['"""']);
        this.stringTokens.push(["'''"]);
        this.commentTokens.push(['/*', '*/']);
      case 'al':
        this.stringTokens.push(['"']);
        this.stringTokens.push(["'"]);
        this.commentTokens.push(['//']);
        break;

      case 'lua':
        this.commentTokens.push(['--[[', ']]']);
        this.commentTokens.push(['--']);
        this.stringTokens.push(['"']);
        this.stringTokens.push(["'"]);
        break;

      case 'vhdl':
        this.commentTokens.push(['/*', '*/']);
      case 'ada':
      case 'haskell':
        this.stringTokens.push(['"']);
        this.commentTokens.push(['--']);
        break;

      case 'sql':
        this.stringTokens.push(['"']);
      case 'plsql':
      case 'spark':
        this.stringTokens.push(["'"]);
        this.commentTokens.push(['--']);
        this.commentTokens.push(['/*', '*/']);
        break;

      case 'fsharp':
        this.commentTokens.push(['//']);
        this.commentTokens.push(['(*', '*)']);
        this.stringTokens.push(['"']);
        this.stringTokens.push(['"""']);
        break;

      case 'pascal':
      case 'objectpascal':
        this.commentTokens.push(['//']);
        this.commentTokens.push(['(*', '*)']);
        this.commentTokens.push(['{', '}']);
        this.stringTokens.push(["'"]);
        break;

      case 'makefile':
      case 'ini':
      case 'properties':
        this.lineCommentRE = new RegExp('^\\s*#', 'g');
        break;

      case 'coffeescript':
        this.commentTokens.push(['###', '###']);
        this.commentTokens.push(['#']);
        this.stringTokens.push(['"']);
        break;

      case 'cfml':
        this.commentTokens.push(['//']);
        this.commentTokens.push(['/*', '*/']);
        break;

      case 'less':
      case 'scss':
      case 'stylus':
        this.commentTokens.push(['//']);
      case 'css':
      case 'tailwindcss':
        this.stringTokens.push(['"']);
        this.stringTokens.push(["'"]);
        this.commentTokens.push(['/*', '*/']);
        break;

      case 'sass':
        this.lineCommentRE  = new RegExp('^(//|/\\*)', 'g');
        this.useIndentMode  = true;
        this.commentTokens.push(['//']);
        this.commentTokens.push(['/*', '*/']);
        break;

      case 'svelte':
      case 'html':
        this.zoneSplit = {
          defaultLanguageId: 'html',
          sections: [
            { start: '<style[^>/]*>',  stop: '</style>',  languageId: 'css'        },
            { start: '<script[^>]*>',  stop: '</script>', languageId: 'javascript' }
          ]
        };
        if (langId === 'svelte') {
          this.zoneSplit.sections.unshift({ start: '<script[^>]* lang="ts"[^>]*>', stop: '</script>', languageId: 'typescript' });
        }
      case 'xml':
        this.commentTokens.push(['<!--', '-->']);
        break;

      case 'terraform':
        this.commentTokens.push(['#']);
        this.commentTokens.push(['//']);
        this.commentTokens.push(['/*', '*/']);
        break;

      case 'acucobol':
      case 'opencobol':
      case 'bitlang-cobol':
      case 'cobol':
        this.lineCommentRE = new RegExp('^......[*/]', 'g');
        break;

      case 'powershell':
        this.commentTokens.push(['<#', '#>']);
        this.commentTokens.push(['#']);
        this.stringTokens.push(['"']);
        this.stringTokens.push(["'"]);
        break;

      case 'perl':
        this.stringTokens.push(["'"]);
      case 'ruby':
        this.commentTokens.push(['#']);
        this.commentTokens.push(['=begin', '=cut']);
        this.stringTokens.push(['"']);
        break;

      case 'perl6':
        this.stringTokens.push(['"']);
        this.stringTokens.push(["'"]);
        this.stringTokens.push(['｢', '｣']);
        this.stringTokens.push(['“', '”']);
        this.commentTokens.push(['#`(', '(', ')']);
        this.commentTokens.push(['#`{', '{', '}']);
        this.commentTokens.push(['#`[', '[', ']']);
        this.commentTokens.push(['#`<', '<', '>']);
        this.commentTokens.push(['#']);
        this.commentTokens.push(['=begin', '=cut']);
        break;

      case 'blade':
        this.commentTokens.push(['{{--', '--}}']);
        this.commentTokens.push(['/*', '*/']);
        this.commentTokens.push(['//']);
        this.commentTokens.push(['#']);
        this.stringTokens.push(["'"]);
        break;

      case 'php':
        this.zoneSplit = {
          defaultLanguageId: 'unknown',
          sections: [{ start: '<\\?php', stop: '\\?>', languageId: 'php' }]
        };
        this.commentTokens.push(['/*', '*/']);
        this.commentTokens.push(['//']);
        this.commentTokens.push(['#']);
        this.stringTokens.push(["'"]);
        break;

      case 'vb':
        this.commentTokens.push(["'"]);
        this.stringTokens.push(['"']);
        break;

      case 'zig':
        this.commentTokens.push(['//']);
        this.stringTokens.push(['"']);
        this.stringTokens.push(["'"]);
        this.stringTokens.push(['\\\\', '\n']);
        break;

      case 'jade':
      case 'pug':
        this.lineCommentRE = new RegExp('^[ \\t]*(//|//-)$', 'g');
        this.useIndentMode = true;
        this.commentTokens.push(['//']);
        this.commentTokens.push(['//-']);
        this.stringTokens.push(['"']);
        this.stringTokens.push(["'"]);
        break;

      case 'vue':
        this.zoneSplit = {
          defaultLanguageId: 'html',
          sections: [
            { start: '<template.*?( lang="([^"]+)")?.*?>',  stop: '</template>', languageId: '${2:?$2:html}' },
            { start: '<script[^>]*>',                        stop: '</script>',   languageId: 'javascript'    },
            { start: '<style.*?( lang="([^"]+)")?.*?>',     stop: '</style>',    languageId: '${2:?$2:css}'  }
          ]
        };
        break;

      default:
        this.isSupported = false;
        break;
    }
    return this.isSupported;
  }
}
