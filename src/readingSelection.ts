// The active note's context and the line numbers of a selection made in reading view.
import type { MarkdownView, TFile } from 'obsidian';
import { log } from './log';

/** The active note and what is selected in it; `fromLine` 0 means the lines are not known. */
export interface NoteContext {
  file: TFile;
  selection: string;
  fromLine: number;
  toLine: number;
  /** Selected in reading view: the rendered text, and the lines of the blocks it is in. */
  reading: boolean;
}

/**
 * Note lines (1-based) of the rendered blocks a reading-view selection touches. The preview
 * renderer's sections are not in Obsidian's typings, so the result is checked against the note's
 * source (it must contain the selection's longest word) and dropped rather than guessed.
 */
export function readingLines(view: MarkdownView, range: Range, text: string): { fromLine: number; toLine: number } | null {
  type Section = { el?: HTMLElement; lineStart?: number; lineEnd?: number };
  const sections = (view.previewMode as unknown as { renderer?: { sections?: Section[] } }).renderer?.sections;
  if (!Array.isArray(sections)) return null;
  const hit = sections.filter(
    (section) => section.el && typeof section.lineStart === 'number' && typeof section.lineEnd === 'number' && range.intersectsNode(section.el),
  );
  if (hit.length === 0) return null;
  const start = Math.min(...hit.map((section) => section.lineStart as number));
  const end = Math.max(...hit.map((section) => section.lineEnd as number));
  const word = (text.match(/[\p{L}\p{N}]{4,}/gu) ?? []).sort((a, b) => b.length - a.length)[0]?.toLowerCase();
  const lines = view.getViewData().split('\n');
  // Section lines count from 0; the other offset is tried in case that changes.
  for (const offset of [1, 0]) {
    const fromLine = start + offset;
    const toLine = end + offset;
    const source = lines.slice(fromLine - 1, toLine).join('\n').toLowerCase();
    if (!word || source.includes(word)) return { fromLine, toLine };
  }
  return null;
}

/**
 * The last line of the block a widget stands for. Live Preview draws a callout, table or quote as
 * one widget, and a position inside it maps to where the widget begins, so the block's own lines
 * are followed from there: display math to its closing $$, a callout or quote while its lines are
 * prefixed, a table while its lines hold a pipe, anything else on its own.
 */
export function blockEnd(lines: string[], fromLine: number): number {
  const first = lines[fromLine - 1] ?? '';
  // Display math: from its opening $$ to the line that closes it, unless it closes on its own line.
  const fence = first.trim();
  if (fence.startsWith('$$') && !(fence.length > 2 && fence.endsWith('$$'))) {
    for (let line = fromLine + 1; line <= lines.length; line++) {
      if (lines[line - 1].trim().endsWith('$$')) return line;
    }
    return fromLine;
  }
  const partOfBlock = first.trimStart().startsWith('>')
    ? (line: string) => line.trimStart().startsWith('>')
    : first.includes('|')
      ? (line: string) => line.includes('|')
      : null;
  if (!partOfBlock) return fromLine;
  let end = fromLine;
  while (end < lines.length && partOfBlock(lines[end])) end += 1;
  return end;
}

/** CodeMirror's own position lookup, which Obsidian does not put in its typings. */
interface EditorWithCm {
  cm?: { posAtDOM(node: Node, offset?: number): number; state?: { doc?: { lineAt(pos: number): { number: number } } } };
}

/**
 * The text selected inside an editing view's rendered widget, with its lines. Live Preview draws a
 * callout, table, embed or equation as a widget whose text the editor does not hold, so
 * `editor.getSelection()` is empty for it; the selection is mapped back through CodeMirror's
 * position lookup instead. Null when nothing is selected there or the lookup is unavailable.
 */
export function widgetSelection(view: MarkdownView, source: string): { text: string; fromLine: number; toLine: number } | null {
  const doc = view.contentEl.ownerDocument;
  const selection = doc.getSelection();
  const anchor = selection?.anchorNode;
  const focus = selection?.focusNode;
  if (!selection || selection.isCollapsed || !anchor || !focus || !view.contentEl.contains(anchor)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const { cm } = view.editor as unknown as EditorWithCm;
  const lineAt = cm?.state?.doc?.lineAt;
  if (!cm?.posAtDOM || !lineAt) return null;
  let start: number;
  let end: number;
  try {
    start = cm.state!.doc!.lineAt(cm.posAtDOM(anchor, selection.anchorOffset)).number;
    end = cm.state!.doc!.lineAt(cm.posAtDOM(focus, selection.focusOffset)).number;
  } catch (error) {
    log('mapping a selection in a rendered widget failed', error);
    return null;
  }
  const lines = source.split('\n');
  const fromLine = Math.min(start, end);
  // Both ends inside one widget land on the line it begins at; the block it stands for is its range.
  const toLine = Math.max(start, end, blockEnd(lines, fromLine));
  return { text, fromLine, toLine };
}
