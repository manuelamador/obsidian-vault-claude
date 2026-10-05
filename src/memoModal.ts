// The form for saving passages of a chat as a memo: a new memo, with its title, description, why you
// keep it, tags and related notes, or a memo already saved, to add the passages (and any tags and
// notes) to. Each passage can be given a label for how it contributed to the idea, and a comment.
// Claude suggests a title and description from the passages as the form opens; what you type is
// never overwritten. Saved with no title, before the suggestion or without one, the memo is a
// bookmark (see quickMemoTitle).
import { Modal, SuggestModal, TFile, setIcon, type App } from 'obsidian';
import { CONTRIBUTIONS, MEMO_KINDS, cleanTags, type Contribution, type MemoPassage, type SavedPassage } from './memos';
import { errorText, log } from './log';
import { NotePicker } from './notePicker';

/**
 * What the form was filled in with: the memo to add to (null for a new one), a new memo's title (empty
 * for a bookmark), description and why, the tags, the related notes kept (as wikilinks), and the
 * passages with any labels and comments given.
 */
export interface MemoChoice {
  memo: TFile | null;
  title: string;
  description: string;
  why: string;
  tags: string[];
  notes: string[];
  passages: MemoPassage[];
}

/** Asks for a title and description for the passages; null when there is none. */
type MemoSuggester = (signal: AbortSignal) => Promise<{ title: string; description: string } | null>;

/** What the form needs from the panel besides the passages. */
export interface MemoFormHost {
  /** The memos to add to, in the order offered: about the note in front, then this chat's, then the rest by date. */
  memos: TFile[];
  /** The related notes suggested for the passages, as wikilinks: the attached note first. */
  notes: string[];
  /** A note as a wikilink, for one added by hand. */
  noteLink(file: TFile): string;
  /** Why a new memo cannot take `title` (a note of that name exists), or null. */
  titleProblem(title: string): string | null;
  /** How many of the passages memo `memo` holds already (see passagesAlreadyIn). */
  alreadyIn(memo: TFile, passages: MemoPassage[]): Promise<number>;
  /** Opens memo `memo`. */
  open(memo: TFile): void;
  suggest?: MemoSuggester;
}

/** Longest stretch of a passage shown in the form; the note gets the whole of it. */
const PREVIEW_CHARS = 400;

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

    // Where the passages go: a new memo, or one picked from a search of those saved.
    let memo: TFile | null = null;
    const target = contentEl.createDiv({ cls: 'vc-memo-field' });
    target.createEl('label', { text: 'Add to' });
    const pick = target.createEl('button', { cls: 'vc-memo-target' });
    const showTarget = () => pick.setText(memo ? memo.basename : 'A new memo');
    showTarget();

    const fresh = contentEl.createDiv();
    const titleField = fresh.createDiv({ cls: 'vc-memo-field' });
    titleField.createEl('label', { text: 'Title' });
    const title = titleField.createEl('input', { attr: { type: 'text', placeholder: 'None: saved as a bookmark, titled by its first words' } });
    const descriptionField = fresh.createDiv({ cls: 'vc-memo-field' });
    descriptionField.createEl('label', { text: 'Description' });
    const description = descriptionField.createEl('textarea', { attr: { rows: '3' } });
    const status = fresh.createDiv({ cls: 'vc-memo-status' });
    const whyField = fresh.createDiv({ cls: 'vc-memo-field' });
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

    // Related notes: those suggested, each removable, and any added from the vault.
    const notesField = contentEl.createDiv({ cls: 'vc-memo-field' });
    notesField.createEl('label', { text: 'Related notes' });
    const chips = notesField.createDiv({ cls: 'vc-memo-notes' });
    const notes = [...this.host.notes];
    const drawNotes = () => {
      chips.empty();
      for (const note of notes) {
        const chip = chips.createDiv({ cls: 'vc-memo-note' });
        chip.createSpan({ text: note.replace(/^\[\[|\]\]$/g, '') });
        const remove = chip.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Leave this note out' } });
        setIcon(remove, 'x');
        remove.addEventListener('click', () => {
          notes.splice(notes.indexOf(note), 1);
          drawNotes();
        });
      }
      const add = chips.createEl('button', { cls: 'vc-memo-add-note', text: 'Add a note…' });
      add.addEventListener('click', () =>
        new NotePicker(
          this.app,
          (file) => {
            if (!(file instanceof TFile)) return;
            const link = this.host.noteLink(file);
            if (!notes.includes(link)) notes.push(link);
            drawNotes();
          },
          true,
        ).open(),
      );
    };
    drawNotes();

    // The passages, each with a label and a comment of yours behind "Label…".
    const passages = this.passages.map((passage) => ({ ...passage }));
    const list = contentEl.createDiv({ cls: 'vc-memo-passages' });
    list.createDiv({ cls: 'vc-memo-passages-title', text: passages.length === 1 ? 'Passage' : `${passages.length} passages, in order` });
    for (const passage of passages) {
      const item = list.createDiv({ cls: 'vc-memo-passage' });
      const head = item.createDiv({ cls: 'vc-memo-role' });
      head.createSpan({ text: [passage.role === 'you' ? 'You' : 'Claude', passage.written].filter(Boolean).join(' · ') });
      const labelLink = head.createEl('a', { cls: 'vc-memo-label-link', text: 'Label…', href: '#' });
      const text = passage.text.trim();
      item.createDiv({ cls: 'vc-memo-excerpt', text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text });
      const labelling = item.createDiv({ cls: 'vc-memo-labelling' });
      labelling.hide();
      const select = labelling.createEl('select', { cls: 'dropdown' });
      select.createEl('option', { text: 'No label', attr: { value: '' } });
      for (const label of CONTRIBUTIONS) select.createEl('option', { text: label, attr: { value: label } });
      const comment = labelling.createEl('input', { attr: { type: 'text', placeholder: 'A comment of yours (optional)' } });
      select.addEventListener('change', () => {
        passage.label = (select.value || undefined) as Contribution | undefined;
        labelLink.setText(passage.label ?? 'Label…');
      });
      comment.addEventListener('input', () => (passage.comment = comment.value.trim() || undefined));
      labelLink.addEventListener('click', (evt) => {
        evt.preventDefault();
        labelling.toggle(!labelling.isShown());
        if (labelling.isShown()) select.focus();
      });
    }

    const problem = contentEl.createDiv({ cls: 'vc-memo-problem' });
    problem.hide();
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const again = this.host.suggest ? buttons.createEl('button', { text: 'Suggest again' }) : null;
    const save = buttons.createEl('button', { cls: 'mod-cta', text: 'Save' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());

    // The same passage of the same message, in the memo chosen already: said once, then added if saved again.
    let duplicatesSeen = false;
    // One save at a time: a check on its way is let go when the form closes or the memo chosen changes.
    let saving = 0;
    pick.addEventListener('click', () =>
      new MemoPicker(this.app, this.host.memos, (chosen) => {
        memo = chosen;
        duplicatesSeen = false;
        saving += 1;
        save.disabled = false;
        showTarget();
        fresh.toggle(!memo);
        problem.hide();
        // Adding to a memo already saved needs no title or description: a suggestion on its way is let go,
        // and asked for again on going back to a new memo.
        if (memo) {
          this.suggesting.abort();
          this.suggesting = new AbortController();
          status.setText('');
        } else if (!title.value.trim()) void askClaude();
      }).open(),
    );

    // A suggestion fills a field only while it is empty or holds the last suggestion: never what was typed.
    const filled = { title: '', description: '' };
    const fillable = (field: HTMLInputElement | HTMLTextAreaElement, last: string) => !field.value.trim() || field.value === last;
    // Only the latest request fills the form or gives back the button: an older one, let go or
    // overtaken, answers into nothing.
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

    const submit = async () => {
      if (save.disabled) return;
      // No title: a bookmark, titled by the passage's first words (see ChatView.saveMemo).
      const titleProblem = memo || !title.value.trim() ? null : this.host.titleProblem(title.value.trim());
      if (titleProblem) {
        problem.setText(titleProblem);
        problem.show();
        return;
      }
      const chosen = memo;
      const choice: MemoChoice = {
        memo: chosen,
        title: title.value.trim(),
        description: description.value.trim(),
        why: why.value.trim(),
        tags: cleanTags([...picked, ...otherTags.value.split(',')]),
        notes: [...notes],
        passages: passages.map((passage) => ({ ...passage })),
      };
      if (chosen && !duplicatesSeen) {
        const mine = (saving += 1);
        save.disabled = true;
        let count: number;
        try {
          count = await this.host.alreadyIn(chosen, choice.passages);
        } catch (error) {
          if (mine !== saving || this.closed) return;
          log('checking a memo for the passages failed', error);
          save.disabled = false;
          duplicatesSeen = true;
          problem.setText(`Could not check whether that memo holds these passages already: ${errorText(error)}. Save again to add them anyway.`);
          problem.show();
          return;
        }
        // Closed, or another memo chosen, while it was checked: this save is not wanted any more.
        if (mine !== saving || this.closed) return;
        save.disabled = false;
        if (count > 0) {
          duplicatesSeen = true;
          problem.empty();
          problem.appendText(count === passages.length ? 'This is already in that memo. ' : `${count} of these passages are already in that memo. `);
          problem.createEl('a', { text: 'Open it', href: '#' }).addEventListener('click', (evt) => {
            evt.preventDefault();
            this.close();
            this.host.open(chosen);
          });
          problem.appendText(' · or save again to add anyway.');
          problem.show();
          return;
        }
      }
      save.disabled = true;
      this.close();
      this.done(choice);
    };
    save.addEventListener('click', () => void submit());
    title.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' || evt.isComposing) return;
      evt.preventDefault();
      void submit();
    });
    window.setTimeout(() => title.focus(), 0);
    void askClaude();
  }

  /** Closed: a save still being checked is not made. */
  private closed = false;

  onClose(): void {
    this.closed = true;
    // A suggestion still on its way is not wanted any more.
    this.suggesting.abort();
    this.contentEl.empty();
  }
}

/** The memo to add passages to, searched by name; first, "A new memo" (null). */
class MemoPicker extends SuggestModal<TFile | null> {
  constructor(
    app: App,
    private readonly memos: TFile[],
    private readonly chosen: (memo: TFile | null) => void,
  ) {
    super(app);
    this.setPlaceholder('Add to a memo: type to search');
  }

  getSuggestions(query: string): (TFile | null)[] {
    const needle = query.trim().toLowerCase();
    return needle ? this.memos.filter((memo) => memo.basename.toLowerCase().includes(needle)) : [null, ...this.memos];
  }

  renderSuggestion(memo: TFile | null, el: HTMLElement): void {
    el.createDiv({ text: memo ? memo.basename : 'A new memo' });
  }

  onChooseSuggestion(memo: TFile | null): void {
    this.chosen(memo);
  }
}

/** What Continue from this memo can take along: the memo's Why and Next, its passages, and its related notes. */
export interface MemoParts {
  why: string;
  next: string;
  passages: SavedPassage[];
  notes: string[];
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
    const box = (parent: HTMLElement, label: string, detail: string, cls = 'vc-memo-choice') => {
      const row = parent.createEl('label', { cls });
      const input = row.createEl('input', { attr: { type: 'checkbox' } });
      input.checked = true;
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
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
