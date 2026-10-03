// The form for saving passages of a chat as a memo: a new memo, with its title, description and
// tags, or a memo already saved, to add the passages (and any tags) to. Claude suggests a title and
// description from the passages as the form opens; what you type is never overwritten. Saved with
// no title, before the suggestion or without one, the memo is a bookmark (see quickMemoTitle).
import { Modal, type App, type TFile } from 'obsidian';
import { MEMO_KINDS, cleanTags, type MemoPassage } from './memos';
import { errorText, log } from './log';

/** What the form was filled in with: the memo to add to (null for a new one), a new memo's title (empty for a bookmark) and description, and the tags. */
export interface MemoChoice {
  memo: TFile | null;
  title: string;
  description: string;
  tags: string[];
}

/** Asks for a title and description for the passages; null when there is none. */
type MemoSuggester = (signal: AbortSignal) => Promise<{ title: string; description: string } | null>;

/** Longest stretch of a passage shown in the form; the note gets the whole of it. */
const PREVIEW_CHARS = 400;

export class MemoModal extends Modal {
  /** The suggestion being asked for; aborted when it is not wanted any more. */
  private suggesting = new AbortController();

  constructor(
    app: App,
    private readonly passages: MemoPassage[],
    /** The memos saved so far, newest first. */
    private readonly memos: TFile[],
    /** Why a new memo cannot take `title` (a note of that name exists), or null. */
    private readonly titleProblem: (title: string) => string | null,
    private readonly done: (choice: MemoChoice) => void,
    private readonly suggest?: MemoSuggester,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText('Save a memo');
    contentEl.addClass('vc-memo-form');
    const target = contentEl.createDiv({ cls: 'vc-memo-field' });
    target.createEl('label', { text: 'Add to' });
    const select = target.createEl('select', { cls: 'dropdown' });
    select.createEl('option', { text: 'A new memo', attr: { value: '' } });
    for (const memo of this.memos) select.createEl('option', { text: memo.basename, attr: { value: memo.path } });
    const fresh = contentEl.createDiv();
    const titleField = fresh.createDiv({ cls: 'vc-memo-field' });
    titleField.createEl('label', { text: 'Title' });
    const title = titleField.createEl('input', { attr: { type: 'text', placeholder: 'None: saved as a bookmark, titled by its first words' } });
    const descriptionField = fresh.createDiv({ cls: 'vc-memo-field' });
    descriptionField.createEl('label', { text: 'Description' });
    const description = descriptionField.createEl('textarea', { attr: { rows: '3' } });
    const status = fresh.createDiv({ cls: 'vc-memo-status' });
    // Tags: the usual kinds as toggles, and any others typed.
    const tagsField = contentEl.createDiv({ cls: 'vc-memo-field' });
    tagsField.createEl('label', { text: 'Tags' });
    const kinds = tagsField.createDiv({ cls: 'vc-memo-kinds' });
    const picked = new Set<string>();
    for (const kind of MEMO_KINDS) {
      const button = kinds.createEl('button', { cls: 'vc-memo-kind', text: kind, attr: { 'aria-pressed': 'false' } });
      button.addEventListener('click', () => {
        if (picked.has(kind)) picked.delete(kind);
        else picked.add(kind);
        button.toggleClass('is-on', picked.has(kind));
        button.setAttr('aria-pressed', String(picked.has(kind)));
      });
    }
    const otherTags = tagsField.createEl('input', { attr: { type: 'text', placeholder: 'Other tags, separated by commas' } });
    const passages = contentEl.createDiv({ cls: 'vc-memo-passages' });
    passages.createDiv({ cls: 'vc-memo-passages-title', text: this.passages.length === 1 ? 'Passage' : `${this.passages.length} passages, in order` });
    for (const passage of this.passages) {
      const item = passages.createDiv({ cls: 'vc-memo-passage' });
      item.createDiv({ cls: 'vc-memo-role', text: passage.role === 'you' ? 'You' : 'Claude' });
      const text = passage.text.trim();
      item.createDiv({ cls: 'vc-memo-excerpt', text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text });
    }
    const problem = contentEl.createDiv({ cls: 'vc-memo-problem' });
    problem.hide();
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const again = this.suggest ? buttons.createEl('button', { text: 'Suggest again' }) : null;
    const save = buttons.createEl('button', { cls: 'mod-cta', text: 'Save' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const chosen = () => this.memos.find((memo) => memo.path === select.value) ?? null;
    select.addEventListener('change', () => {
      const adding = chosen() !== null;
      fresh.toggle(!adding);
      problem.hide();
      // Adding to a memo already saved needs no title or description: a suggestion on its way is let go,
      // and asked for again on going back to a new memo.
      if (adding) {
        this.suggesting.abort();
        this.suggesting = new AbortController();
        status.setText('');
      } else if (!title.value.trim()) void askClaude();
    });

    // A suggestion fills a field only while it is empty or holds the last suggestion: never what was typed.
    const filled = { title: '', description: '' };
    const fillable = (field: HTMLInputElement | HTMLTextAreaElement, last: string) => !field.value.trim() || field.value === last;
    const askClaude = async () => {
      if (!this.suggest) return;
      const signal = this.suggesting.signal;
      status.setText('Claude is suggesting a title and description…');
      if (again) again.disabled = true;
      try {
        const suggestion = await this.suggest(signal);
        if (signal.aborted) return;
        if (!suggestion) {
          status.setText('No suggestion came back.');
          return;
        }
        if (suggestion.title && fillable(title, filled.title)) title.value = filled.title = suggestion.title;
        if (suggestion.description && fillable(description, filled.description)) description.value = filled.description = suggestion.description;
        status.setText('Suggested by Claude: edit as you like.');
      } catch (error) {
        if (signal.aborted) return;
        log('suggesting a memo failed', error);
        status.setText(`No suggestion: ${errorText(error)}`);
      } finally {
        if (again) again.disabled = false;
      }
    };
    again?.addEventListener('click', () => void askClaude());

    const submit = () => {
      const memo = chosen();
      // No title: a bookmark, titled by the passage's first words (see ChatView.saveMemo).
      const why = memo || !title.value.trim() ? null : this.titleProblem(title.value.trim());
      if (why) {
        problem.setText(why);
        problem.show();
        return;
      }
      const tags = cleanTags([...picked, ...otherTags.value.split(',')]);
      this.close();
      this.done({ memo, title: title.value.trim(), description: description.value.trim(), tags });
    };
    save.addEventListener('click', submit);
    title.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' || evt.isComposing) return;
      evt.preventDefault();
      submit();
    });
    window.setTimeout(() => title.focus(), 0);
    void askClaude();
  }

  onClose(): void {
    // A suggestion still on its way is not wanted any more.
    this.suggesting.abort();
    this.contentEl.empty();
  }
}
