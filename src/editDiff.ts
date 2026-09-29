import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { MarkdownView, Notice, TFile, setIcon, type App, type PaneType } from 'obsidian';
import type { ContentBlock } from './chatText';
import { rowToolResult } from './history';
import { addFoldToggle } from './foldToggle';
import { lineDiff } from './wordDiff';

/**
 * A line of an edit's diff; `no` is its line number in the file, when known, and `at`, for a
 * removed line, the line of the edited file where it was removed.
 */
export interface EditLine {
  kind: 'same' | 'del' | 'ins' | 'gap';
  text: string;
  no?: number;
  at?: number;
}

/**
 * Where a row of a diff points in the file: its own text and line number, or, for a removed line
 * (whose text is gone), the next line kept after it in its hunk, else the one before it.
 */
export function lineTarget(lines: EditLine[], i: number): { text: string; hint?: number } {
  const line = lines[i];
  if (line.kind !== 'del') return { text: line.text, hint: line.no };
  const kept = (j: number) => lines[j].kind === 'same' || lines[j].kind === 'ins';
  for (let j = i + 1; j < lines.length && lines[j].kind !== 'gap'; j += 1) {
    if (kept(j)) return { text: lines[j].text, hint: lines[j].no ?? line.at };
  }
  for (let j = i - 1; j >= 0 && lines[j].kind !== 'gap'; j -= 1) {
    if (kept(j)) return { text: lines[j].text, hint: lines[j].no ?? line.at };
  }
  return { text: '', hint: line.at };
}

/**
 * The line of `file` (its text now) that a diff row points at, from 1: the occurrence of `text`
 * nearest `hint`, the number the edit recorded, which later edits may have moved; `hint` itself
 * when the text is blank or no longer in the file; null when neither gives a line.
 */
export function locateLine(file: string, text: string, hint?: number): number | null {
  const lines = file.split('\n');
  if (text.trim()) {
    let best: number | null = null;
    lines.forEach((candidate, i) => {
      if (candidate !== text) return;
      if (best === null || (hint !== undefined && Math.abs(i + 1 - hint) < Math.abs(best - hint))) best = i + 1;
    });
    if (best !== null) return best;
  }
  return hint !== undefined ? Math.min(Math.max(1, hint), lines.length) : null;
}

/**
 * Opens a changed file at a line of its diff: where that line's text is now (see locateLine), as
 * later edits may have moved it; `newTab` as Keymap.isModEvent gives it. Notes open at the line;
 * other files open as a click on their name would.
 */
export async function openFileAtLine(app: App, path: string, text: string, hint: number | undefined, newTab: PaneType | boolean): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    new Notice(`${path} is no longer in the vault.`);
    return;
  }
  if (file.extension !== 'md') {
    await app.workspace.openLinkText(path, '', newTab);
    return;
  }
  const line = locateLine(await app.vault.cachedRead(file), text, hint);
  const leaf = app.workspace.getLeaf(newTab);
  await leaf.openFile(file, { active: true, ...(line !== null ? { eState: { line: line - 1 } } : {}) });
  const view = leaf.view;
  if (line === null || !(view instanceof MarkdownView) || view.getMode() !== 'source') return;
  const at = { line: line - 1, ch: 0 };
  view.editor.setCursor(at);
  view.editor.scrollIntoView({ from: at, to: at }, true);
}

/** Opens a changed file at a diff row: the row's text (see lineTarget) and the line number recorded. */
type OpenDiffLine = (path: string, text: string, hint: number | undefined, evt: MouseEvent) => void;

export interface EditDiff {
  /** The file as Claude named it. */
  file: string;
  lines: EditLine[];
  added: number;
  removed: number;
  /** A new file, written by Write. */
  created: boolean;
  /**
   * Reported for a shell command: what changed in the vault while it ran, whatever changed it.
   * Claude Code cannot tell a command's own changes from another chat's or program's made meanwhile,
   * so such a change is shown with the command's but does not link the note to the chat.
   */
  fromShell?: boolean;
}

interface PatchHunk {
  oldStart: number;
  oldLines?: number;
  newStart: number;
  lines: string[];
}

/** Tools whose calls change a file. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
/** Most lines drawn for one edit; the rest are counted. */
const MAX_LINES = 400;
/** Rows shown, as drawn (a long line wraps onto several), before the rest is folded behind "Show all". */
const FOLDED_ROWS = 12;
/** Characters per row assumed when the card is not laid out yet and cannot be measured. */
const ROW_CHARS = 80;

/**
 * The change an Edit, MultiEdit or Write call made: from the patch in its structured result when
 * the live session gives one (with line numbers and context lines), else from its input, as for a
 * chat opened from history, whose saved messages carry no structured results.
 */
export function editDiff(name: string, input: Record<string, unknown>, structured?: unknown): EditDiff | null {
  const file = typeof input.file_path === 'string' ? input.file_path : null;
  if (!file || !EDIT_TOOLS.has(name)) return null;
  const result = (structured ?? {}) as { structuredPatch?: PatchHunk[]; type?: string; staged?: boolean };
  // Held for review instead of written: the file is unchanged.
  if (result.staged) return null;
  const patch = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
  const lines: EditLine[] = [];
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  const pair = (before: unknown, after: unknown) => {
    if (lines.length > 0) lines.push({ kind: 'gap', text: '' });
    for (const part of lineDiff(str(before), str(after))) lines.push({ kind: part.type, text: part.text });
  };

  if (patch.length > 0) {
    lines.push(...patchLines(patch));
  } else if (name === 'Write') {
    // An update with no patch changed nothing, or was too large to diff.
    if (result.type === 'update') return null;
    const content = str(input.content).replace(/\n$/, '');
    content.split('\n').forEach((text, i) => lines.push({ kind: 'ins', text, no: i + 1 }));
  } else if (name === 'Edit') {
    pair(input.old_string, input.new_string);
  } else if (Array.isArray(input.edits)) {
    for (const edit of input.edits as Record<string, unknown>[]) pair(edit.old_string, edit.new_string);
  }

  const added = lines.filter((line) => line.kind === 'ins').length;
  const removed = lines.filter((line) => line.kind === 'del').length;
  if (added + removed === 0) return null;
  return { file, lines, added, removed, created: name === 'Write' && result.type !== 'update' && patch.length === 0 };
}

/** The changes a tool call made to files: an edit tool's (see editDiff), or a shell command's (see bashEditDiffs). */
export function toolDiffs(name: string, input: Record<string, unknown>, structured?: unknown): EditDiff[] {
  if (name === 'Bash') return bashEditDiffs(structured);
  const diff = editDiff(name, input, structured);
  return diff ? [diff] : [];
}

/**
 * The changes a chat's tool calls made, in order (see toolDiffs): from its messages' calls and their
 * results, with `structured` giving a call's structured result where one is known. Failed calls
 * change nothing.
 */
function messageDiffs(messages: { type?: string; content?: unknown }[], structured: (toolUseId: string) => unknown): EditDiff[] {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const diffs: EditDiff[] = [];
  for (const { type, content } of messages) {
    if (!Array.isArray(content)) continue;
    for (const block of content as ContentBlock[]) {
      if (type === 'assistant' && block.type === 'tool_use' && block.id && block.name) {
        calls.set(block.id, { name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      } else if (type === 'user' && block.type === 'tool_result' && block.tool_use_id && block.is_error !== true) {
        const call = calls.get(block.tool_use_id);
        if (call) diffs.push(...toolDiffs(call.name, call.input, structured(block.tool_use_id)));
      }
    }
  }
  return diffs;
}

/**
 * The files a saved chat's own edits changed (not those reported for a shell command, see
 * EditDiff.fromShell), each once, in the order first changed, with `edits`, the structured results
 * by tool_use_id. A subagent's own calls are left out, as the panel leaves them out when drawing.
 */
export function savedChangedFiles(transcript: SessionMessage[], edits: Map<string, unknown>): string[] {
  const own = transcript.filter((message) => message.parent_tool_use_id === null).map((message) => ({ type: message.type, content: (message.message as { content?: unknown } | null)?.content }));
  return [...new Set(messageDiffs(own, (id) => edits.get(id)).flatMap((diff) => (diff.fromShell ? [] : [diff.file])))];
}

/**
 * The changes an agent made, from its transcript: the JSON lines of the file its task names as its
 * output. Only rows with a tool call or result are parsed; its text and thinking are skipped unread.
 */
export function agentDiffs(transcript: string): EditDiff[] {
  const rows = transcript.split('\n').flatMap((line) => {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) return [];
    try {
      return [JSON.parse(line) as { type?: string; message?: { content?: unknown }; toolUseResult?: unknown }];
    } catch {
      return [];
    }
  });
  const structured = new Map(rows.map((row) => rowToolResult(row, false)).filter((entry): entry is [string, unknown] => entry !== null));
  return messageDiffs(
    rows.map((row) => ({ type: row.type, content: row.message?.content })),
    (id) => structured.get(id),
  );
}

/**
 * The files a Bash command changed, from the `bashEditDiff` Claude Code adds to its structured
 * result (absent from the SDK's type definitions): each file with its patch.
 */
export function bashEditDiffs(structured: unknown): EditDiff[] {
  const files = (structured as { bashEditDiff?: { files?: { filePath?: unknown; hunks?: unknown }[] } } | null | undefined)?.bashEditDiff?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => {
    if (typeof file.filePath !== 'string' || !Array.isArray(file.hunks)) return [];
    const hunks = file.hunks as PatchHunk[];
    const lines = patchLines(hunks);
    const added = lines.filter((line) => line.kind === 'ins').length;
    const removed = lines.filter((line) => line.kind === 'del').length;
    if (added + removed === 0) return [];
    return [{ file: file.filePath, lines, added, removed, created: hunks.every((hunk) => hunk.oldLines === 0), fromShell: true }];
  });
}

/** A unified-diff patch as lines numbered in the file: removed lines by the old file, the rest by the new. */
function patchLines(patch: PatchHunk[]): EditLine[] {
  const lines: EditLine[] = [];
  patch.forEach((hunk, i) => {
    if (i > 0) lines.push({ kind: 'gap', text: '' });
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const raw of hunk.lines) {
      const text = raw.slice(1);
      if (raw.startsWith('-')) lines.push({ kind: 'del', text, no: oldNo++, at: newNo });
      else if (raw.startsWith('+')) lines.push({ kind: 'ins', text, no: newNo++ });
      else if (raw.startsWith(' ')) {
        lines.push({ kind: 'same', text, no: newNo++ });
        oldNo += 1;
      }
      // A line starting with "\" marks a missing newline at the end of the file.
    }
  });
  return lines;
}

/**
 * The files Claude changed in one reply, in one card: a line per file with the lines added and
 * removed over all its edits. A click on the line opens the file's diffs, in the order they were
 * made; a click on the name opens the file, and a click on a line of a diff opens the file there.
 */
export class ChangesCard {
  readonly el: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly addedEl: HTMLElement;
  private readonly removedEl: HTMLElement;
  private readonly list: HTMLElement;
  private readonly files = new Map<string, ChangedFile>();

  constructor(
    parent: HTMLElement,
    private readonly openLine?: OpenDiffLine,
  ) {
    this.el = parent.createDiv({ cls: 'vc-changes' });
    const header = this.el.createDiv({ cls: 'vc-changes-header' });
    setIcon(header.createSpan({ cls: 'vc-changes-chevron' }), 'chevron-right');
    setIcon(header.createSpan({ cls: 'vc-edit-icon' }), 'files');
    this.titleEl = header.createSpan({ cls: 'vc-changes-title' });
    this.addedEl = header.createSpan({ cls: 'vc-edit-added' });
    this.removedEl = header.createSpan({ cls: 'vc-edit-removed' });
    header.addEventListener('click', () => this.fold(!this.el.hasClass('is-folded')));
    this.list = this.el.createDiv({ cls: 'vc-changes-list' });
  }

  /** The notes in the vault this reply created, by their vault paths. */
  createdNotes(): string[] {
    return [...this.files.values()].flatMap((file) => (file.created && !file.fromShell && file.vaultPath?.endsWith('.md') ? [file.vaultPath] : []));
  }

  /** Shows the header alone, as when the reply is done, or with the list of files. */
  fold(folded: boolean): void {
    this.el.toggleClass('is-folded', folded);
  }

  add(diff: EditDiff, vaultPath: string | undefined): void {
    let file = this.files.get(diff.file);
    if (!file) {
      file = new ChangedFile(this.list, diff, vaultPath, this.openLine);
      this.files.set(diff.file, file);
    }
    file.add(diff);
    const files = [...this.files.values()];
    this.titleEl.setText(`${files.length} ${files.length === 1 ? 'file' : 'files'} changed`);
    showCounts(
      this.addedEl,
      this.removedEl,
      files.reduce((sum, each) => sum + each.added, 0),
      files.reduce((sum, each) => sum + each.removed, 0),
    );
  }
}

function showCounts(addedEl: HTMLElement, removedEl: HTMLElement, added: number, removed: number): void {
  addedEl.setText(added > 0 ? `+${added}` : '');
  removedEl.setText(removed > 0 ? `−${removed}` : '');
}

/** One file's line in a ChangesCard, and its diffs once opened. */
class ChangedFile {
  added = 0;
  removed = 0;
  /** Its first change in the reply created it. */
  readonly created: boolean;
  /** That change was reported for a shell command (see EditDiff.fromShell). */
  readonly fromShell: boolean;
  private readonly diffs: EditDiff[] = [];
  private readonly addedEl: HTMLElement;
  private readonly removedEl: HTMLElement;
  private readonly diffEl: HTMLElement;

  constructor(
    parent: HTMLElement,
    first: EditDiff,
    readonly vaultPath: string | undefined,
    private readonly openLine?: OpenDiffLine,
  ) {
    this.created = first.created;
    this.fromShell = first.fromShell === true;
    const el = parent.createDiv({ cls: 'vc-changes-file' });
    const row = el.createDiv({ cls: 'vc-changes-row' });
    setIcon(row.createSpan({ cls: 'vc-changes-chevron' }), 'chevron-right');
    setIcon(row.createSpan({ cls: 'vc-edit-icon' }), first.created ? 'file-plus' : 'file-pen');
    const name = row.createSpan({ cls: 'vc-edit-file', text: vaultPath ?? first.file });
    if (vaultPath) {
      name.addClass('vc-file-link');
      name.dataset.path = vaultPath;
    }
    this.addedEl = row.createSpan({ cls: 'vc-edit-added' });
    this.removedEl = row.createSpan({ cls: 'vc-edit-removed' });
    this.diffEl = el.createDiv({ cls: 'vc-changes-diff' });
    this.diffEl.hide();
    row.addEventListener('click', (evt) => {
      // The name is a link to the file, which the panel opens.
      if ((evt.target as HTMLElement).closest('.vc-file-link')) return;
      const open = !this.diffEl.isShown();
      el.toggleClass('is-open', open);
      if (open) {
        this.diffEl.show();
        this.draw();
      } else {
        this.diffEl.hide();
      }
    });
  }

  add(diff: EditDiff): void {
    this.diffs.push(diff);
    this.added += diff.added;
    this.removed += diff.removed;
    showCounts(this.addedEl, this.removedEl, this.added, this.removed);
    if (this.diffEl.isShown()) this.draw();
  }

  /** The file's edits in order, with a gap between them. */
  private draw(): void {
    this.diffEl.empty();
    const lines: EditLine[] = [];
    for (const diff of this.diffs) {
      if (lines.length > 0) lines.push({ kind: 'gap', text: '' });
      lines.push(...diff.lines);
    }
    const { vaultPath, openLine } = this;
    renderDiffLines(this.diffEl, lines, vaultPath && openLine ? (text, hint, evt) => openLine(vaultPath, text, hint, evt) : undefined);
  }
}

/**
 * Draws diff lines into `box`, folded behind "Show all" when taller than a few rows as drawn (a
 * long line wraps onto several). A box not laid out yet has no height, so its rows are then
 * estimated from the line lengths. With `open`, a click on a row (not ending a text selection)
 * opens the file there.
 */
function renderDiffLines(box: HTMLElement, lines: EditLine[], open?: (text: string, hint: number | undefined, evt: MouseEvent) => void): void {
  const body = box.createDiv({ cls: 'vc-edit-body' });
  const numbered = lines.some((line) => line.no !== undefined);
  lines.slice(0, MAX_LINES).forEach((line, i) => {
    if (line.kind === 'gap') {
      body.createDiv({ cls: 'vc-edit-gap', text: '⋯' });
      return;
    }
    const row = body.createDiv({ cls: `vc-edit-line is-${line.kind}`, attr: { 'data-i': String(i) } });
    if (numbered) row.createSpan({ cls: 'vc-edit-no', text: line.no !== undefined ? String(line.no) : '' });
    row.createSpan({ cls: 'vc-edit-sign', text: line.kind === 'del' ? '−' : line.kind === 'ins' ? '+' : '' });
    row.createSpan({ cls: 'vc-edit-text', text: line.text });
  });
  if (open) {
    body.addClass('is-linked');
    body.addEventListener('click', (evt) => {
      const row = (evt.target as HTMLElement).closest<HTMLElement>('.vc-edit-line');
      if (!row?.dataset.i || row.ownerDocument.getSelection()?.isCollapsed === false) return;
      const target = lineTarget(lines, Number(row.dataset.i));
      open(target.text, target.hint, evt);
    });
  }
  if (lines.length > MAX_LINES) body.createDiv({ cls: 'vc-edit-gap', text: `${lines.length - MAX_LINES} more lines` });

  box.addClass('is-collapsed');
  const rows = lines.slice(0, MAX_LINES).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.text.length / ROW_CHARS)), 0);
  const tall = body.clientHeight > 0 ? body.scrollHeight > body.clientHeight + 1 : rows > FOLDED_ROWS;
  if (!tall) {
    box.removeClass('is-collapsed');
    return;
  }
  addFoldToggle(box, 'vc-edit-toggle', `Show all (${lines.filter((line) => line.kind !== 'gap').length} lines)`);
}
