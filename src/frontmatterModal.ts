// Suggest frontmatter updates, as a dialog (see frontmatterSuggest.ts): what Claude will read and any
// guidance; then each property proposed, its current and proposed value and why, to edit, tick and
// apply. Nothing is written before Apply.
import { Modal, Notice, type App } from 'obsidian';
import { errorText, log } from './log';
import { readEdited, valueText, type FieldSuggestion } from './frontmatterSuggest';

export interface FrontmatterHost {
  /** The note's name, and what Claude reads besides it. */
  name: string;
  neighbours: number;
  chats: number;
  /** The note's properties now. */
  current: Record<string, unknown>;
  /** The guidance last given for notes in this folder, kept for next time. */
  guidance: string;
  suggest(guidance: string, signal: AbortSignal): Promise<FieldSuggestion[]>;
  /** Writes the values accepted (and stamps `updated` when the note has it). */
  apply(values: Record<string, unknown>): Promise<void>;
}

export class FrontmatterModal extends Modal {
  private abort: AbortController | null = null;
  private guidance: string;

  constructor(app: App, private readonly host: FrontmatterHost) {
    super(app);
    this.guidance = host.guidance;
  }

  onOpen(): void {
    this.modalEl.addClass('vc-project-modal');
    this.setTitle(`Suggest properties: ${this.host.name}`);
    this.ask();
  }

  private ask(): void {
    const { contentEl, host } = this;
    contentEl.empty();
    const notes = `${host.neighbours} note${host.neighbours === 1 ? '' : 's'} beside it`;
    const chats = `${host.chats} chat${host.chats === 1 ? '' : 's'} that worked on them`;
    contentEl.createDiv({ cls: 'vc-project-label', text: `Claude reads this note, the properties of ${notes} and the titles of ${chats}, and proposes new values for its properties. Nothing is written until you apply them.` });
    const guidance = contentEl.createEl('textarea', { cls: 'vc-project-text', attr: { rows: '3', placeholder: 'Optional: anything Claude should know, such as “status in at most 80 characters” or “next lists what is left to do”. Kept for notes in this folder.' } });
    guidance.value = this.guidance;
    guidance.addEventListener('input', () => (this.guidance = guidance.value));
    const foot = contentEl.createDiv({ cls: 'vc-project-foot' });
    const status = foot.createDiv({ cls: 'vc-project-status vc-pick-up-status' });
    const button = foot.createEl('button', { cls: 'mod-cta', text: 'Suggest' });
    button.addEventListener('click', async () => {
      button.disabled = true;
      status.empty();
      status.createSpan({ cls: 'vc-pick-up-wheel', attr: { 'aria-hidden': 'true' } });
      status.createSpan({ text: 'Claude is reading…' });
      this.abort = new AbortController();
      const signal = this.abort.signal;
      try {
        const fields = await host.suggest(this.guidance, signal);
        if (!signal.aborted) this.review(fields);
      } catch (error) {
        if (signal.aborted) return;
        status.setText(`No suggestions: ${errorText(error)}.`);
        button.disabled = false;
      }
    });
    window.setTimeout(() => guidance.focus(), 0);
  }

  private review(fields: FieldSuggestion[]): void {
    const { contentEl, host } = this;
    contentEl.empty();
    if (fields.length === 0) {
      contentEl.createDiv({ cls: 'vc-project-status', text: 'Claude proposes no changes: the properties match the note.' });
      contentEl.createDiv({ cls: 'vc-project-foot' }).createEl('button', { text: 'Back' }).addEventListener('click', () => this.ask());
      return;
    }
    const rows = fields.map((field) => {
      const row = contentEl.createDiv({ cls: 'vc-project-proposal' });
      const top = row.createDiv({ cls: 'vc-project-proposal-head' });
      const box = top.createEl('input', { type: 'checkbox' });
      box.checked = true;
      top.createSpan({ cls: 'vc-project-kind', text: field.key });
      const isNew = !(field.key in host.current);
      if (isNew) top.createSpan({ cls: 'vc-project-size', text: 'new property' });
      const count = top.createSpan({ cls: 'vc-project-size vc-frontmatter-count' });
      if (!isNew) {
        const was = row.createDiv({ cls: 'vc-frontmatter-was' });
        was.createSpan({ cls: 'vc-project-kind', text: 'Now: ' });
        was.appendText(valueText(host.current[field.key]) || '(empty)');
      }
      const text = row.createEl('textarea', { cls: 'vc-project-text' });
      text.value = valueText(field.value);
      text.rows = Math.min(6, Math.max(1, text.value.split('\n').length, Math.ceil(text.value.length / 80)));
      if (field.reason) row.createDiv({ cls: 'vc-project-suggest', text: field.reason });
      // Text values show their length, for notes whose properties have limits.
      const counted = () => count.setText(typeof field.value === 'string' ? `${text.value.trim().length} characters` : '');
      text.addEventListener('input', () => {
        counted();
        update();
      });
      counted();
      box.addEventListener('change', () => update());
      return { field, box, text };
    });
    const foot = contentEl.createDiv({ cls: 'vc-project-foot' });
    foot.createEl('button', { text: 'Ask again' }).addEventListener('click', () => this.ask());
    const apply = foot.createEl('button', { cls: 'mod-cta' });
    const update = () => {
      const n = rows.filter((row) => row.box.checked).length;
      apply.setText(n === 0 ? 'Apply' : `Apply ${n}`);
      apply.disabled = n === 0;
    };
    update();
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      const values = Object.fromEntries(rows.filter((row) => row.box.checked).map((row) => [row.field.key, readEdited(row.text.value, row.field.value)]));
      try {
        await host.apply(values);
        this.close();
      } catch (error) {
        // Not written: the dialog stays, to try again.
        log('applying properties failed', error);
        new Notice(`The properties were not updated: ${errorText(error)}`);
        update();
      }
    });
  }

  onClose(): void {
    this.abort?.abort();
    this.contentEl.empty();
  }
}
