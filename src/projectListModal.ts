/**
 * A project's chats and notes, listed whole in a window of their own from its Connections map: two
 * tabs, Chats (newest first, each with its last prompt) and Notes (by folder, then those in the
 * project's folder no chat used), filtered by what is typed.
 */
import { App, Keymap, Modal, setIcon } from 'obsidian';
import { eachInParallel, formatDate } from './history';
import { shortLabel } from './connections';

/** What the window lists. */
export interface ProjectListing {
  name: string;
  /** The project's chats, newest first: how many notes each used. */
  chats: { id: string; title: string; updatedAt: number; codex: boolean; notes: number }[];
  /** The notes its chats used, and by how many of them. */
  notes: { path: string; chats: number }[];
  /** The notes in the project's folder no chat of it used. */
  unused: string[];
}

/** What its rows do. */
export interface ProjectListActions {
  /** Chat `id`'s last prompt, as shown in the chat; null when there is none. */
  lastPrompt(id: string): Promise<string | null>;
  /** Opens chat `id` in the panel, or (`newTab`) in a panel tab of its own. */
  openChat(id: string, newTab: boolean): void;
  openNote(path: string, newTab: boolean): void;
  /** Centres the Connections map on note `path`. */
  showNote(path: string): void;
}

type Tab = 'chats' | 'notes';

/** A row the keys can pick: its element and what choosing it does (`mod`, with ⌘). */
interface Row {
  el: HTMLElement;
  run(mod: boolean): void;
}

/** How long a last prompt is shown on its row. */
const PROMPT_CHARS = 160;

export class ProjectListModal extends Modal {
  private tab: Tab = 'chats';
  private rows: Row[] = [];
  private selected = 0;
  private readonly prompts = new Map<string, string | null>();
  /** Each chat's row's prompt line, filled in once its prompt is read. */
  private readonly promptEls = new Map<string, HTMLElement>();
  private inputEl!: HTMLInputElement;
  private tabEls!: Record<Tab, HTMLElement>;
  private listEl!: HTMLElement;
  private closed = false;

  constructor(
    app: App,
    private readonly listing: ProjectListing,
    private readonly actions: ProjectListActions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, listing } = this;
    this.modalEl.addClass('vc-project-list-modal');
    this.titleEl.setText(listing.name);
    this.inputEl = contentEl.createEl('input', { type: 'search', cls: 'vc-project-list-filter', attr: { placeholder: 'Filter…' } });
    const tabs = contentEl.createDiv({ cls: 'vc-project-list-tabs' });
    const tab = (which: Tab, text: string) => {
      const el = tabs.createEl('button', { cls: 'vc-project-list-tab', text });
      el.addEventListener('click', () => this.show(which));
      return el;
    };
    this.tabEls = {
      chats: tab('chats', `Chats (${listing.chats.length})`),
      notes: tab('notes', `Notes (${listing.notes.length + listing.unused.length})`),
    };
    this.listEl = contentEl.createDiv({ cls: 'vc-project-list' });
    this.inputEl.addEventListener('input', () => this.draw());
    this.inputEl.addEventListener('keydown', (evt) => this.key(evt));
    this.show('chats');
    this.inputEl.focus();
    void this.readPrompts();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  /** Reads the chats' last prompts, a few at a time, each shown on its row as it comes. */
  private async readPrompts(): Promise<void> {
    await eachInParallel(this.listing.chats, async (chat) => {
      if (this.closed) return;
      const prompt = await this.actions.lastPrompt(chat.id).catch(() => null);
      this.prompts.set(chat.id, prompt);
      const el = this.promptEls.get(chat.id);
      if (el && prompt) el.setText(shortLabel(prompt.replace(/\s+/g, ' ').trim(), PROMPT_CHARS));
    });
    // A filter typed meanwhile searches the prompts too.
    if (!this.closed && this.inputEl.value.trim() && this.tab === 'chats') this.draw();
  }

  private show(tab: Tab): void {
    this.tab = tab;
    for (const [which, el] of Object.entries(this.tabEls)) el.toggleClass('is-active', which === tab);
    this.draw();
  }

  private key(evt: KeyboardEvent): void {
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
      evt.preventDefault();
      this.select(this.selected + (evt.key === 'ArrowDown' ? 1 : -1));
    } else if (evt.key === 'Enter') {
      evt.preventDefault();
      this.rows[this.selected]?.run(Keymap.isModEvent(evt) !== false);
    } else if (evt.key === 'Tab') {
      evt.preventDefault();
      this.show(this.tab === 'chats' ? 'notes' : 'chats');
    }
  }

  private select(index: number): void {
    if (this.rows.length === 0) return;
    this.rows[this.selected]?.el.removeClass('is-selected');
    this.selected = Math.max(0, Math.min(index, this.rows.length - 1));
    const row = this.rows[this.selected];
    row.el.addClass('is-selected');
    row.el.scrollIntoView({ block: 'nearest' });
  }

  private draw(): void {
    this.listEl.empty();
    this.rows = [];
    this.promptEls.clear();
    const words = this.inputEl.value.toLowerCase().split(/\s+/).filter(Boolean);
    const holds = (text: string) => words.every((word) => text.toLowerCase().includes(word));
    if (this.tab === 'chats') this.drawChats(holds);
    else this.drawNotes(holds);
    if (this.rows.length === 0) this.listEl.createDiv({ cls: 'vc-project-empty', text: words.length > 0 ? 'Nothing matches.' : this.tab === 'chats' ? 'No chats in this project.' : 'No notes.' });
    this.selected = 0;
    this.select(0);
  }

  /** Adds a row that the keys and the pointer pick. */
  private row(cls: string, run: (mod: boolean) => void): HTMLElement {
    const el = this.listEl.createDiv({ cls: `vc-project-list-row ${cls}` });
    const index = this.rows.length;
    this.rows.push({ el, run });
    el.addEventListener('click', (evt) => run(Keymap.isModEvent(evt) !== false));
    el.addEventListener('mousemove', () => {
      if (this.selected !== index) this.select(index);
    });
    return el;
  }

  private drawChats(holds: (text: string) => boolean): void {
    for (const chat of this.listing.chats) {
      const prompt = this.prompts.get(chat.id) ?? null;
      if (!holds(`${chat.title} ${prompt ?? ''}`)) continue;
      const el = this.row('', (mod) => {
        this.close();
        this.actions.openChat(chat.id, mod);
      });
      const title = el.createDiv({ cls: 'vc-history-title' });
      setIcon(title.createSpan({ cls: 'vc-history-pin' }), 'message-square');
      title.appendText(chat.title);
      if (chat.codex) title.createSpan({ cls: 'vc-engine-badge', text: 'Codex' });
      el.createDiv({ cls: 'vc-muted', text: `${formatDate(chat.updatedAt)} · ${chat.notes} note${chat.notes === 1 ? '' : 's'}` });
      const line = el.createDiv({ cls: 'vc-project-list-prompt', text: prompt ? shortLabel(prompt.replace(/\s+/g, ' ').trim(), PROMPT_CHARS) : '' });
      this.promptEls.set(chat.id, line);
    }
  }

  private drawNotes(holds: (text: string) => boolean): void {
    const group = (heading: string, paths: { path: string; chats: number | null }[]) => {
      const shown = paths.filter(({ path }) => holds(path)).sort((a, b) => a.path.localeCompare(b.path));
      if (shown.length === 0) return;
      this.listEl.createDiv({ cls: 'vc-project-list-heading', text: heading });
      let folder: string | null = null;
      for (const { path, chats } of shown) {
        const slash = path.lastIndexOf('/');
        const here = slash > 0 ? path.slice(0, slash) : '';
        if (here !== folder) {
          folder = here;
          this.listEl.createDiv({ cls: 'vc-project-list-folder', text: here || 'Top of the vault' });
        }
        const el = this.row('is-note', (mod) => {
          this.close();
          this.actions.openNote(path, mod);
        });
        const title = el.createDiv({ cls: 'vc-history-title' });
        setIcon(title.createSpan({ cls: 'vc-history-pin' }), 'file-text');
        title.appendText(path.slice(slash + 1).replace(/\.md$/, ''));
        if (chats !== null) title.createSpan({ cls: 'vc-muted', text: ` · ${chats} chat${chats === 1 ? '' : 's'}` });
        const map = el.createEl('button', { cls: 'clickable-icon vc-project-list-map', attr: { 'aria-label': 'Show it in Connections' } });
        setIcon(map, 'waypoints');
        map.addEventListener('click', (evt) => {
          evt.stopPropagation();
          this.close();
          this.actions.showNote(path);
        });
      }
    };
    group('Used by its chats', this.listing.notes);
    group('Not used by any chat', this.listing.unused.map((path) => ({ path, chats: null })));
  }
}
