import { Modal, Notice, Platform, type App, type Editor, type EditorPosition, type MarkdownFileInfo, type TFile } from 'obsidian';
import { cleanReplacement, inlineEditPrompt } from './inlineEditPrompt';
import { errorText, log } from './log';
import { wordDiff } from './wordDiff';

export interface InlineEditTarget {
  editor: Editor;
  file: TFile;
  /** What holds the editor: a note's tab, a canvas card, a hover preview. */
  owner: MarkdownFileInfo;
  from: EditorPosition;
  to: EditorPosition;
  /** The selected text; empty when writing at the cursor. */
  original: string;
  before: string;
  after: string;
}

/** Runs one edit request; `onText` receives the answer so far as it streams. */
export type InlineEditRunner = (system: string, prompt: string, onText: (text: string) => void, signal: AbortSignal) => Promise<string>;

/**
 * "Edit selection with Claude": an instruction, Claude's answer streamed and then shown as a
 * word diff, and Accept, which replaces the text through the editor so undo reverts it.
 */
export class InlineEditModal extends Modal {
  private instructionEl!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private resultEl!: HTMLElement;
  private runButton!: HTMLButtonElement;
  private acceptButton!: HTMLButtonElement;
  private controller: AbortController | null = null;
  private replacement: string | null = null;

  constructor(
    app: App,
    private readonly target: InlineEditTarget,
    private readonly system: string,
    private readonly run: InlineEditRunner,
  ) {
    super(app);
  }

  onOpen(): void {
    const { target } = this;
    const insert = target.original === '';
    this.titleEl.setText(insert ? 'Write at the cursor with Claude' : 'Edit selection with Claude');
    this.modalEl.addClass('vc-inline-modal');
    const first = target.from.line + 1;
    const last = target.to.line + 1;
    const lines = insert || first === last ? `line ${first}` : `lines ${first}–${last}`;
    this.contentEl.createDiv({ cls: 'vc-muted', text: `${target.file.basename}, ${lines}` });
    this.instructionEl = this.contentEl.createEl('textarea', {
      cls: 'vc-inline-instruction',
      attr: {
        rows: '2',
        placeholder: insert
          ? 'What to write here, e.g. "a one-sentence summary of the section above"'
          : 'What to change, e.g. "tighten this", "fix the LaTeX", "make it a [!proposition] callout"',
      },
    });
    this.instructionEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && !evt.shiftKey && !evt.metaKey && !evt.ctrlKey && !evt.isComposing) {
        evt.preventDefault();
        void this.runEdit();
      }
    });
    this.statusEl = this.contentEl.createDiv({ cls: 'vc-inline-status vc-muted' });
    this.resultEl = this.contentEl.createDiv({ cls: 'vc-inline-result' });
    this.resultEl.hide();

    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    this.runButton = buttons.createEl('button', { text: 'Run' });
    this.runButton.addEventListener('click', () => void this.runEdit());
    this.acceptButton = buttons.createEl('button', { text: 'Accept', cls: 'mod-cta' });
    this.acceptButton.disabled = true;
    this.acceptButton.addEventListener('click', () => this.accept());
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    this.scope.register(['Mod'], 'Enter', () => {
      this.accept();
      return false;
    });
    window.setTimeout(() => this.instructionEl.focus(), 0);
  }

  onClose(): void {
    this.controller?.abort();
    this.controller = null;
    this.contentEl.empty();
  }

  private async runEdit(): Promise<void> {
    const instruction = this.instructionEl.value.trim();
    if (!instruction) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.replacement = null;
    this.acceptButton.disabled = true;
    this.statusEl.setText('Claude is writing…');
    this.resultEl.empty();
    this.resultEl.show();
    const live = this.resultEl.createDiv({ cls: 'vc-inline-live' });
    const started = Date.now();
    const prompt = inlineEditPrompt({ ...this.target, path: this.target.file.path }, instruction);
    try {
      const answer = await this.run(this.system, prompt, (text) => live.setText(text), controller.signal);
      if (controller !== this.controller) return;
      const replacement = cleanReplacement(answer, this.target.original);
      if (!replacement.trim()) throw new Error('Claude returned no text.');
      this.replacement = replacement;
      this.renderDiff(replacement);
      const accept = Platform.isMacOS ? '⌘↩' : 'Ctrl+Enter';
      const undo = Platform.isMacOS ? '⌘Z' : 'Ctrl+Z';
      this.statusEl.setText(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s. Accept (${accept}) puts it in the note; ${undo} there undoes it.`);
      this.acceptButton.disabled = false;
    } catch (error) {
      if (controller !== this.controller || controller.signal.aborted) return;
      log('inline edit failed', error);
      this.statusEl.setText(`Failed: ${errorText(error)}`);
    } finally {
      if (controller === this.controller) this.runButton.setText('Run again');
    }
  }

  private renderDiff(replacement: string): void {
    this.resultEl.empty();
    const el = this.resultEl.createDiv({ cls: 'vc-inline-diff' });
    if (!this.target.original) {
      el.createSpan({ cls: 'vc-wdiff-ins', text: replacement });
      return;
    }
    for (const part of wordDiff(this.target.original, replacement)) {
      if (part.type === 'same') el.appendText(part.text);
      else el.createSpan({ cls: part.type === 'del' ? 'vc-wdiff-del' : 'vc-wdiff-ins', text: part.text });
    }
  }

  /**
   * Replaces the selection (or inserts at the cursor), unless the note changed there while
   * Claude was working: the selected text and the text just around it must be as they were.
   */
  private accept(): void {
    if (this.replacement === null) return;
    const { editor, file, owner, from, to, original, before, after } = this.target;
    const near = 200;
    // What holds the editor still shows the note the edit was asked for, wherever it is (a tab, a
    // canvas card, a hover preview): one turned to another note with the same text around the
    // selection must not take it.
    if (owner.editor !== editor || owner.file?.path !== file.path) {
      new Notice('The note is no longer open where the edit was asked for; nothing was replaced.');
      return;
    }
    try {
      const text = editor.getValue();
      const start = editor.posToOffset(from);
      const end = editor.posToOffset(to);
      const unchanged =
        editor.getRange(from, to) === original &&
        text.slice(Math.max(0, start - near), start) === before.slice(-near) &&
        text.slice(end, end + near) === after.slice(0, near);
      if (!unchanged) {
        new Notice('That part of the note changed while Claude was working; nothing was replaced.');
        return;
      }
      editor.replaceRange(this.replacement, from, to);
    } catch (error) {
      log('inline edit: replacing failed', error);
      new Notice('Could not put the text in the note; is it still open?');
      return;
    }
    this.close();
  }
}
