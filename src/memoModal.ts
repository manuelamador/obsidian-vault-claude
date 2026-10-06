// The form for saving passages of a chat as a memo: a new memo each time, with its title, a
// description, why you keep it, tags, and the memos and notes it links to. Claude suggests a title
// and description from the passages as the form opens; what you type is never overwritten. Saved
// with no title, before the suggestion or without one, the memo is a bookmark (see quickMemoTitle).
import { Modal, SuggestModal, setIcon, type App, type TFile } from 'obsidian';
import { MEMO_KINDS, cleanTags, type LinkedMemo, type MemoPassage, type SavedPassage } from './memos';
import { errorText, log } from './log';

/**
 * What the form was filled in with: the title (empty for a bookmark), description and why, the
 * tags, and the memos and notes linked (as wikilinks).
 */
export interface MemoChoice {
  title: string;
  description: string;
  why: string;
  tags: string[];
  notes: string[];
}

/** Asks for a title and description for the passages; null when there is none. */
type MemoSuggester = (signal: AbortSignal) => Promise<{ title: string; description: string } | null>;

/** What the form needs from the panel besides the passages. */
export interface MemoFormHost {
  /** The memos offered to link first: this chat's and those about the note in front, then the rest by date; archived ones last. */
  memos: TFile[];
  /** Whether a memo is archived: still offered, labelled so. */
  archived(memo: TFile): boolean;
  /** The vault's other notes, offered after the memos. */
  notes(): TFile[];
  /** The links suggested for the passages, as wikilinks: the attached note first. */
  links: string[];
  /** A note as a wikilink. */
  noteLink(file: TFile): string;
  /** Why a new memo cannot take `title` (a note of that name exists), or null. */
  titleProblem(title: string): string | null;
  suggest?: MemoSuggester;
}

/** Longest stretch of a passage shown in the form; the note gets the whole of it. */
const PREVIEW_CHARS = 400;

/** The most notes listed in the link picker at once; typing narrows them. */
const MAX_LINK_CHOICES = 100;

export class MemoModal extends Modal {
  /** The suggestion being asked for; aborted when it is not wanted any more. */
  private suggesting = new AbortController();

  constructor(
    app: App,
    private readonly passages: MemoPassage[],
    private readonly host: MemoFormHost,
    private readonly done: (choice: MemoChoice) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText('Save a memo');
    contentEl.addClass('vc-memo-form');

    const titleField = contentEl.createDiv({ cls: 'vc-memo-field' });
    titleField.createEl('label', { text: 'Title' });
    const title = titleField.createEl('input', { attr: { type: 'text', placeholder: 'None: saved as a bookmark, titled by its first words' } });
    const descriptionField = contentEl.createDiv({ cls: 'vc-memo-field' });
    descriptionField.createEl('label', { text: 'Description' });
    const description = descriptionField.createEl('textarea', { attr: { rows: '3' } });
    const status = contentEl.createDiv({ cls: 'vc-memo-status' });
    const whyField = contentEl.createDiv({ cls: 'vc-memo-field' });
    whyField.createEl('label', { text: 'Why I’m keeping this' });
    const why = whyField.createEl('textarea', { attr: { rows: '2', placeholder: 'Optional: what it might do for you' } });

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

    // Links: to other memos and to notes, those suggested each removable, and any added.
    const linksField = contentEl.createDiv({ cls: 'vc-memo-field' });
    linksField.createEl('label', { text: 'Related memos and notes' });
    const chips = linksField.createDiv({ cls: 'vc-memo-notes' });
    const links = [...this.host.links];
    const drawLinks = () => {
      chips.empty();
      for (const link of links) {
        const chip = chips.createDiv({ cls: 'vc-memo-note' });
        chip.createSpan({ text: link.replace(/^\[\[|\]\]$/g, '') });
        const remove = chip.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Leave this link out' } });
        setIcon(remove, 'x');
        remove.addEventListener('click', () => {
          links.splice(links.indexOf(link), 1);
          drawLinks();
        });
      }
      const add = chips.createEl('button', { cls: 'vc-memo-add-note', text: 'Link a memo or note…' });
      add.addEventListener('click', () =>
        new LinkPicker(this.app, this.host, (file) => {
          const link = this.host.noteLink(file);
          if (!links.includes(link)) links.push(link);
          drawLinks();
        }).open(),
      );
    };
    drawLinks();

    // The passages, as they will be saved.
    const list = contentEl.createDiv({ cls: 'vc-memo-passages' });
    list.createDiv({ cls: 'vc-memo-passages-title', text: this.passages.length === 1 ? 'Passage' : `${this.passages.length} passages, in order` });
    for (const passage of this.passages) {
      const item = list.createDiv({ cls: 'vc-memo-passage' });
      item.createDiv({ cls: 'vc-memo-role', text: [passage.role === 'you' ? 'You' : 'Claude', passage.written].filter(Boolean).join(' · ') });
      const text = passage.text.trim();
      item.createDiv({ cls: 'vc-memo-excerpt', text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text });
    }

    const problem = contentEl.createDiv({ cls: 'vc-memo-problem' });
    problem.hide();
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const again = this.host.suggest ? buttons.createEl('button', { text: 'Suggest again' }) : null;
    const save = buttons.createEl('button', { cls: 'mod-cta', text: 'Save' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());

    // A suggestion fills a field only while it is empty or holds the last suggestion: never what was typed.
    const filled = { title: '', description: '' };
    const fillable = (field: HTMLInputElement | HTMLTextAreaElement, last: string) => !field.value.trim() || field.value === last;
    // Only the latest request fills the form or gives back the button: an older one answers into nothing.
    let asked = 0;
    const askClaude = async () => {
      if (!this.host.suggest) return;
      const ask = (asked += 1);
      const signal = this.suggesting.signal;
      status.setText('Claude is suggesting a title and description…');
      if (again) again.disabled = true;
      try {
        const suggestion = await this.host.suggest(signal);
        if (signal.aborted || ask !== asked) return;
        if (!suggestion) {
          status.setText('No suggestion came back.');
          return;
        }
        if (suggestion.title && fillable(title, filled.title)) title.value = filled.title = suggestion.title;
        if (suggestion.description && fillable(description, filled.description)) description.value = filled.description = suggestion.description;
        status.setText('Suggested by Claude: edit as you like.');
      } catch (error) {
        if (signal.aborted || ask !== asked) return;
        log('suggesting a memo failed', error);
        status.setText(`No suggestion: ${errorText(error)}`);
      } finally {
        if (again && ask === asked) again.disabled = false;
      }
    };
    again?.addEventListener('click', () => void askClaude());

    const submit = () => {
      if (save.disabled) return;
      // No title: a bookmark, titled by the passage's first words (see ChatView.saveMemo).
      const titleProblem = title.value.trim() ? this.host.titleProblem(title.value.trim()) : null;
      if (titleProblem) {
        problem.setText(titleProblem);
        problem.show();
        return;
      }
      save.disabled = true;
      this.close();
      this.done({
        title: title.value.trim(),
        description: description.value.trim(),
        why: why.value.trim(),
        tags: cleanTags([...picked, ...otherTags.value.split(',')]),
        notes: [...links],
      });
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

/**
 * A memo or note to link, searched by name: the memos first (see MemoFormHost.memos), archived ones
 * labelled, then the vault's other notes.
 */
class LinkPicker extends SuggestModal<TFile> {
  constructor(
    app: App,
    private readonly host: MemoFormHost,
    private readonly chosen: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder('Link a memo or note: type to search');
  }

  getSuggestions(query: string): TFile[] {
    const needle = query.trim().toLowerCase();
    const memos = new Set(this.host.memos.map((memo) => memo.path));
    const all = [...this.host.memos, ...this.host.notes().filter((note) => !memos.has(note.path))];
    const found = needle ? all.filter((file) => file.path.toLowerCase().includes(needle)) : all;
    return found.slice(0, MAX_LINK_CHOICES);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    const line = el.createDiv({ cls: 'vc-memo-pick', text: file.basename });
    if (this.host.memos.includes(file)) line.createSpan({ cls: 'vc-memo-tag', text: this.host.archived(file) ? 'Archived memo' : 'Memo' });
  }

  onChooseSuggestion(file: TFile): void {
    this.chosen(file);
  }
}

/** What Continue from this memo can take along: the memo's Why and Next, its passages, its related notes, and the memos it links to. */
export interface MemoParts {
  why: string;
  next: string;
  passages: SavedPassage[];
  notes: string[];
  linked: LinkedMemo[];
}

/**
 * Continue from a memo: you tick what goes into the new chat's draft (all, to begin with), then the
 * chat opens with it in its input. Nothing is sent.
 */
export class ContinueMemoModal extends Modal {
  constructor(
    app: App,
    private readonly name: string,
    private readonly parts: MemoParts,
    private readonly start: (chosen: MemoParts) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(`Continue from “${this.name}”`);
    contentEl.addClass('vc-memo-form');
    contentEl.createDiv({ cls: 'vc-memo-status', text: 'A new chat opens with what you tick in its input, for you to add your question. Nothing is sent.' });
    const box = (parent: HTMLElement, label: string, detail: string, ticked = true) => {
      const row = parent.createEl('label', { cls: 'vc-memo-choice' });
      const input = row.createEl('input', { attr: { type: 'checkbox' } });
      input.checked = ticked;
      const text = row.createDiv();
      text.createDiv({ cls: 'vc-memo-role', text: label });
      if (detail) text.createDiv({ cls: 'vc-memo-excerpt', text: detail.length > PREVIEW_CHARS ? `${detail.slice(0, PREVIEW_CHARS - 1)}…` : detail });
      return input;
    };
    const why = this.parts.why ? box(contentEl, 'Why', this.parts.why) : null;
    const next = this.parts.next ? box(contentEl, 'Next', this.parts.next) : null;
    const list = contentEl.createDiv({ cls: 'vc-memo-passages' });
    if (this.parts.passages.length === 0) list.createDiv({ cls: 'vc-memo-passages-title', text: 'No passages in this memo.' });
    const passages = this.parts.passages.map((passage) => ({ passage, input: box(list, passage.header, passage.text) }));
    const notes = this.parts.notes.map((note) => ({ note, input: box(contentEl, `Related note: ${note.replace(/^\[\[|\]\]$/g, '')}`, '') }));
    // Linked memos: not ticked to begin with; ticked, their Why and passages go along.
    const linked = this.parts.linked.map((memo) => ({
      memo,
      input: box(contentEl, `Linked memo: ${memo.name}`, [memo.why, ...memo.passages.map((passage) => passage.text)].filter(Boolean).join('\n\n'), false),
    }));
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const go = buttons.createEl('button', { cls: 'mod-cta', text: 'Start the chat' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    go.addEventListener('click', () => {
      this.close();
      this.start({
        why: why?.checked ? this.parts.why : '',
        next: next?.checked ? this.parts.next : '',
        passages: passages.filter((item) => item.input.checked).map((item) => item.passage),
        notes: notes.filter((item) => item.input.checked).map((item) => item.note),
        linked: linked.filter((item) => item.input.checked).map((item) => item.memo),
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
