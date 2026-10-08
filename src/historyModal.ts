import { Keymap, Modal, Platform, SuggestModal, setIcon, type App } from 'obsidian';
import { eachInParallel, formatDate, type HistoryItem } from './history';
import { folderUp, folderView, notesByChat, readFolderQuery, type FolderRow } from './chatFolders';
import { NOTE_CHAT_ICONS, chatsByNote, type NoteChats, type NoteGroup } from './noteChats';
import { escapeRegExp } from './pathFilter';

export interface HistoryActions {
  /** Opens a chat: here, or, with `newTab`, in a new Claude tab. */
  pick(item: HistoryItem, newTab: boolean): void;
  /** Returns whether the chat is pinned afterwards. */
  togglePin(item: HistoryItem): boolean;
  rename(item: HistoryItem, title: string): void;
  /** Deletes the chat's saved session; resolves to whether it was deleted. */
  remove(item: HistoryItem): Promise<boolean>;
  /** Prompt and reply text of a chat, for searching. */
  searchText(item: HistoryItem): Promise<string>;
  /** Stops the tasks a chat is running in the background. */
  stopTasks(item: HistoryItem): void;
  /** The notes chats are linked to: those that changed each note, those it was sent to, and those that mentioned it. */
  noteLinks(): { changed: NoteChats; sent: NoteChats; mentioned: NoteChats };
  /** Opens a note. */
  openNote(path: string): void;
  /** The project folder `folder` is (its note's path), if it is one. */
  projectOf(folder: string): string | null;
  /** The name of chat `item`'s project, as shown on its row and searched, if it has one. */
  projectName?(item: HistoryItem): string | null;
  /** Create project, with folder `folder` chosen. */
  createProject(folder: string): void;
  /** Links the chat on screen to `item`; absent where it cannot be (the scratch chat). */
  link?(item: HistoryItem): void;
  /** Whether `item` is the chat on screen, or one it links to already: not offered to link. */
  isLinked?(item: HistoryItem): boolean;
}

/** A row: a chat; or, in the notes view (see NOTES_PREFIX), a note, a chat under it, or the rest of its chats folded. */
type Match =
  | {
      kind: 'chat';
      item: HistoryItem;
      /** Text around the first hit, for a match in the chat's content rather than its title. */
      snippet?: string;
      /** Under a note in the notes view: how the chat is linked to it. */
      why?: NoteGroup['chats'][number]['why'];
    }
  | { kind: 'note' | 'more'; note: NoteGroup }
  /** `here`: the folder gone into, first under it. */
  | { kind: 'folder'; folder: FolderRow; here?: boolean };

/** The history's views: all chats, chats by note, chats by folder. */
type HistoryView = 'chats' | 'notes' | 'folders';

/** A query that starts with this lists notes with their chats beneath them, not chats; Tab types it or takes it away. */
const NOTES_PREFIX = 'with:';
/** A query that starts with this lists folders, and the chats in the folder gone into (see readFolderQuery). */
const FOLDERS_PREFIX = 'in:';
/** The chats shown under a note before "+N more". */
const NOTE_CHATS_SHOWN = 3;
/** The most rows the history draws (Obsidian's own limit is 100). */
const ROW_LIMIT = 2000;

/** Shorter queries match titles only; reading every transcript for one or two letters is wasted work. */
const MIN_CONTENT_QUERY = 3;
const SNIPPET_RADIUS = 60;

/**
 * Where `needle` (lower case) first is in a chat's text, as an offset into its text as it is: its
 * lowercase form serves while it is as long, and where a character lowercases to two (İ) the text is
 * searched itself, case aside.
 */
function matchAt(read: { text: string; lower: string }, needle: string): number {
  if (read.lower.length === read.text.length) return read.lower.indexOf(needle);
  return read.text.search(new RegExp(escapeRegExp(needle), 'iu'));
}

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + length + SNIPPET_RADIUS);
  const middle = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${middle}${end < text.length ? '…' : ''}`;
}

/** Previous chats: pinned first, then newest; the query matches titles, then prompts and replies. */
export class HistoryModal extends SuggestModal<Match> {
  /**
   * The listed chats' texts by id, for searching inside chats, each with its lowercase form made once
   * rather than at every key typed; read in the background from the moment the history opens.
   */
  private readonly texts = new Map<string, { text: string; lower: string }>();
  /** Closed: the texts not read yet are left unread. */
  private dismissed = false;
  /** The reading of the texts not read yet, while it runs (see readTexts). */
  private reading: Promise<void> | null = null;
  private items: HistoryItem[] = [];
  /** The chats to show: at once, those listed before; else once `listing` has listed them. */
  private readonly listed: Promise<void>;
  /** Notes in the notes view shown with all their chats. */
  private readonly expanded = new Set<string>();
  /** Which view the hint line names the keys of (see showKeys). */
  private keysFor: HistoryView | null = null;

  /**
   * `shown`: the chats as listed before, shown at once, or null; `listing`: the chats listed now,
   * which replace them if anything changed (null: keep them).
   */
  constructor(
    app: App,
    shown: HistoryItem[] | null,
    listing: Promise<HistoryItem[] | null>,
    private readonly actions: HistoryActions,
  ) {
    super(app);
    this.setPlaceholder('Search previous chats: titles, projects, prompts and replies');
    this.emptyStateText = 'No matching chats.';
    // Every chat, and in the notes view every note, rather than Obsidian's first 100 rows.
    this.limit = ROW_LIMIT;
    this.showKeys('chats');
    this.scope.register([], 'Tab', () => {
      this.switchView();
      return false;
    });
    // ⌘↵ reaches the row picked as Enter does (see selectSuggestion), which Obsidian leaves unbound.
    this.scope.register(['Mod'], 'Enter', (evt) => {
      (this as unknown as { chooser?: { useSelectedItem?(evt: KeyboardEvent): void } }).chooser?.useSelectedItem?.(evt);
      return false;
    });
    // In the folders view, ⌫ just after a folder's `/` goes up a folder.
    this.scope.register([], 'Backspace', () => {
      const query = this.inputEl.value;
      if (viewOf(query) !== 'folders' || !query.endsWith('/') || this.inputEl.selectionStart !== query.length) return true;
      this.inputEl.value = `${FOLDERS_PREFIX}${folderUp(query.slice(FOLDERS_PREFIX.length))}`;
      this.refresh();
      return false;
    });
    if (shown) {
      this.items = shown;
      this.listed = Promise.resolve();
      void listing.then((items) => {
        if (!items || rowsKey(items) === rowsKey(this.items)) return;
        this.items = items;
        this.refresh();
      });
    } else {
      this.listed = listing.then((items) => void (this.items = items ?? []));
    }
    // Read before the first search needs them, so that it usually finds them in.
    void this.listed.then(() => this.readTexts());
  }

  onClose(): void {
    super.onClose();
    this.dismissed = true;
  }

  async getSuggestions(query: string): Promise<Match[]> {
    await this.listed;
    const view = viewOf(query);
    this.showKeys(view);
    if (view === 'notes') return this.noteRows(query.slice(NOTES_PREFIX.length));
    if (view === 'folders') return this.folderRows(query.slice(FOLDERS_PREFIX.length));
    const needle = query.trim().toLowerCase();
    const ordered = [...this.items].sort(
      (a, b) =>
        Number(b.scratch ?? false) - Number(a.scratch ?? false) ||
        Number(b.pinned ?? false) - Number(a.pinned ?? false) ||
        b.updatedAt - a.updatedAt,
    );
    if (!needle) return ordered.map((item) => ({ kind: 'chat', item }));
    // Titles first, then the chats of the projects whose names hold it.
    const inProject = (item: HistoryItem) => this.actions.projectName?.(item)?.toLowerCase().includes(needle) ?? false;
    const titled = ordered.filter((item) => item.title.toLowerCase().includes(needle));
    const byTitle: Match[] = [...titled, ...ordered.filter((item) => !titled.includes(item) && inProject(item))].map((item) => ({ kind: 'chat', item }));
    if (needle.length < MIN_CONTENT_QUERY) return byTitle;
    // Titles at once, with the chats whose text is read so far; once the rest is in, the search runs again.
    if (this.items.some((item) => !this.texts.has(item.id))) {
      void this.readTexts().then(() => {
        if (this.inputEl.value === query) this.refresh();
      });
    }
    const texts = this.texts;
    const inTitle = new Set(byTitle.map((match) => (match.kind === 'chat' ? match.item : null)));
    const byContent: Match[] = [];
    for (const item of ordered) {
      if (inTitle.has(item)) continue;
      const read = texts.get(item.id);
      const at = read ? matchAt(read, needle) : -1;
      if (read && at !== -1) byContent.push({ kind: 'chat', item, snippet: snippetAround(read.text, at, needle.length) });
    }
    return [...byTitle, ...byContent];
  }

  /** Goes to the next view, chats → by note → by folder: types its prefix before the query in place of the last's (a folder gone into is left). */
  private switchView(): void {
    const query = this.inputEl.value;
    const view = viewOf(query);
    if (view === 'chats') this.inputEl.value = `${NOTES_PREFIX}${query}`;
    else if (view === 'notes') this.inputEl.value = `${FOLDERS_PREFIX}${query.slice(NOTES_PREFIX.length).trimStart()}`;
    else this.inputEl.value = readFolderQuery(query.slice(FOLDERS_PREFIX.length)).words.join(' ');
    this.refresh();
  }

  /**
   * The hint line under the list: its keys for the list of chats, or for the notes view (`notes`),
   * where ⌘↵ opens a note. The Tab hint is a button as well, which switches views as Tab does.
   */
  private showKeys(view: HistoryView): void {
    if (this.keysFor === view) return;
    this.keysFor = view;
    const mod = Platform.isMacOS ? '⌘' : 'ctrl';
    this.setInstructions(
      view === 'notes'
        ? [
            { command: '↵', purpose: "open a chat, or show a note's chats" },
            { command: `${mod} ↵`, purpose: 'in a new tab, or open the note' },
            { command: 'tab', purpose: 'chats by folder' },
          ]
        : view === 'folders'
          ? [
              { command: '↵', purpose: 'open a chat, or go into a folder' },
              { command: '⌫', purpose: 'up a folder' },
              { command: 'tab', purpose: 'all chats' },
            ]
          : [
              { command: '↵', purpose: 'open' },
              { command: `${mod} ↵`, purpose: 'in a new tab' },
              { command: 'tab', purpose: 'chats by note' },
            ],
    );
    // Obsidian draws each hint as a .prompt-instruction with its key in a .prompt-instruction-command.
    const tab = [...this.modalEl.querySelectorAll<HTMLElement>('.prompt-instruction')].find(
      (el) => el.querySelector('.prompt-instruction-command')?.textContent === 'tab',
    );
    if (!tab) return;
    tab.addClass('vc-history-switch');
    tab.setAttr('role', 'button');
    tab.addEventListener('click', () => {
      this.switchView();
      this.inputEl.focus();
    });
  }

  /** The notes view: notes whose path contains `term`, the most recent first, each with its chats beneath it. */
  private noteRows(term: string): Match[] {
    const { changed, sent, mentioned } = this.actions.noteLinks();
    return chatsByNote(changed, sent, mentioned, this.items, term).flatMap((note) => {
      const chats = this.expanded.has(note.path) ? note.chats : note.chats.slice(0, NOTE_CHATS_SHOWN);
      const rows: Match[] = [{ kind: 'note', note }, ...chats.map(({ item, why }) => ({ kind: 'chat' as const, item, why }))];
      if (chats.length < note.chats.length) rows.push({ kind: 'more', note });
      return rows;
    });
  }

  /**
   * The folders view: the folders in the one gone into, then its chats (see folderView). Under a
   * folder gone into, a first row names it, with Create project from it.
   */
  private folderRows(rest: string): Match[] {
    const { folder, words } = readFolderQuery(rest);
    const { changed, sent, mentioned } = this.actions.noteLinks();
    const byId = new Map(this.items.filter((item) => !item.scratch).map((item) => [item.id, item]));
    const notes = notesByChat(changed, sent, mentioned);
    const { folders, chats } = folderView(notes, byId, folder, words);
    const rows: Match[] = [];
    // The folder gone into counts, and makes a project of, all its chats, whatever words are typed.
    if (folder) rows.push({ kind: 'folder', folder: { path: folder, chats: words.length > 0 ? folderView(notes, byId, folder, []).chats : chats, latest: 0 }, here: true });
    rows.push(...folders.map((row) => ({ kind: 'folder' as const, folder: row })));
    rows.push(...chats.flatMap((id) => {
      const item = byId.get(id);
      return item ? [{ kind: 'chat' as const, item }] : [];
    }));
    return rows;
  }

  /** Reads the texts of the listed chats not read yet, a few at a time; one reading at a time, which a second request shares. */
  private readTexts(): Promise<void> {
    this.reading ??= eachInParallel(
      this.items.filter((item) => !this.texts.has(item.id)),
      async (item) => {
        if (this.dismissed) return;
        // Nothing read (a chat with no text) is searched as empty.
        const text = (await this.actions.searchText(item).catch(() => '')) ?? '';
        if (!this.dismissed) this.texts.set(item.id, { text, lower: text.toLowerCase() });
      },
    ).finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  renderSuggestion(match: Match, el: HTMLElement): void {
    if (match.kind === 'folder') {
      this.renderFolder(match, el);
      return;
    }
    if (match.kind !== 'chat') {
      this.renderNote(match, el);
      return;
    }
    const { item } = match;
    el.addClass('vc-history-item');
    el.toggleClass('vc-history-nested', match.why !== undefined);
    // A session started outside the panel, which opens as a copy, reads muted.
    el.toggleClass('is-outside', !item.fromPanel && !item.scratch);
    const body = el.createDiv({ cls: 'vc-history-body' });
    const title = body.createDiv({ cls: 'vc-history-title' });
    if (item.scratch) setIcon(title.createSpan({ cls: 'vc-history-pin' }), 'eraser');
    else if (item.pinned) setIcon(title.createSpan({ cls: 'vc-history-pin' }), 'pin');
    title.appendText(item.title);
    const meta = body.createDiv({ cls: 'vc-muted' });
    // Open and In the background say where a chat is; the rest say it is doing something.
    if (item.status) {
      const quiet = item.status === 'Open' || item.status === 'In the background';
      meta.createSpan({ cls: `vc-history-status${quiet ? ' is-quiet' : ''}`, text: `${quiet ? '○' : '●'} ${item.status} · ` });
    }
    if (item.scratch) meta.appendText(item.updatedAt ? `${formatDate(item.updatedAt)} · starts over when idle` : 'not used yet · starts over when idle');
    else meta.appendText(`${formatDate(item.updatedAt)}${origin(item)}`);
    const project = item.scratch ? null : (this.actions.projectName?.(item) ?? null);
    if (project) {
      meta.appendText(' · ');
      setIcon(meta.createSpan({ cls: 'vc-history-why' }), 'folder-kanban');
      meta.appendText(project);
    }
    if (match.why) {
      meta.appendText(' · ');
      setIcon(meta.createSpan({ cls: 'vc-history-why' }), NOTE_CHAT_ICONS[match.why]);
      meta.appendText(match.why);
    }
    if (match.snippet) body.createDiv({ cls: 'vc-history-snippet', text: match.snippet });
    // Under a note, a chat only opens: its buttons are in the list of chats, and the notes view stays light.
    if (match.why) return;

    const buttons = el.createDiv({ cls: 'vc-history-actions' });
    if (item.tasksRunning) {
      this.addButton(buttons, 'square', 'Stop its background tasks', () => {
        this.actions.stopTasks(item);
        item.tasksRunning = false;
        this.refresh();
      });
    }
    // Offered unless the chat on screen links to it already, or is it.
    const { link, isLinked } = this.actions;
    if (link && !item.scratch && !(isLinked?.(item) ?? false)) {
      this.addButton(buttons, 'link', 'Link the chat on screen to this one', () => {
        link(item);
        this.refresh();
      });
    }
    // The scratch chat is always first and always called Scratch: nothing to pin or rename.
    if (!item.scratch) {
      this.addButton(buttons, item.pinned ? 'pin-off' : 'pin', item.pinned ? 'Unpin' : 'Pin to the top', () => {
        item.pinned = this.actions.togglePin(item);
        this.refresh();
      });
    }
    // Outside sessions keep their own title; a panel copy is made on the first message.
    if (item.fromPanel && !item.scratch) {
      this.addButton(buttons, 'pencil', 'Rename', () => {
        new RenameModal(this.app, item.title, (newTitle) => {
          item.title = newTitle;
          this.actions.rename(item, newTitle);
          this.refresh();
        }).open();
      });
    }
    this.addButton(buttons, 'trash-2', item.scratch ? 'Clear' : 'Delete', () => {
      const removed = () =>
        void this.actions.remove(item).then((deleted) => {
          if (!deleted) return;
          this.items = this.items.filter((other) => other !== item);
          this.refresh();
        });
      if (item.scratch) {
        new ConfirmModal(this.app, 'Clear scratch chat', 'The scratch chat starts over: its conversation is deleted from this computer. This cannot be undone.', 'Clear', removed).open();
      } else {
        confirmDelete(this.app, item.title, item.fromPanel, removed);
      }
    });
  }

  /**
   * A folder in the folders view, with the folder holding it and how many chats worked on notes in
   * it; or, first under a folder gone into, that folder, with ⌫ to leave it. A folder that is a
   * project says so and opens its note; another offers to make it one.
   */
  private renderFolder(match: Extract<Match, { kind: 'folder' }>, el: HTMLElement): void {
    const { folder } = match;
    const here = match.here === true;
    el.addClass('vc-history-item', 'vc-history-note');
    el.toggleClass('vc-history-here', here);
    const body = el.createDiv({ cls: 'vc-history-body' });
    const slash = folder.path.lastIndexOf('/');
    const title = body.createDiv({ cls: 'vc-history-title' });
    const project = this.actions.projectOf(folder.path);
    setIcon(title.createSpan({ cls: 'vc-history-pin' }), project ? 'folder-kanban' : here ? 'folder-open' : 'folder');
    if (here) {
      // The path as a breadcrumb: each part goes back up to it, the vault to the top.
      const parts = folder.path.split('/');
      const crumb = (label: string, path: string | null) => {
        const el = title.createEl(path === null ? 'span' : 'a', { cls: 'vc-history-crumb', text: label });
        if (path === null) return;
        el.addEventListener('mousedown', (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
        });
        el.addEventListener('click', (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          this.inputEl.value = `${FOLDERS_PREFIX}${path ? `${path}/` : ''}`;
          this.refresh();
          this.inputEl.focus();
        });
      };
      crumb('Vault', '');
      parts.forEach((part, i) => {
        title.appendText(' › ');
        crumb(part, i === parts.length - 1 ? null : parts.slice(0, i + 1).join('/'));
      });
    } else title.appendText(folder.path.slice(slash + 1));
    const count = `${project ? 'project · ' : ''}${folder.chats.length} ${folder.chats.length === 1 ? 'chat' : 'chats'}`;
    body.createDiv({ cls: 'vc-muted', text: here ? `${count} · ⌫ goes up` : slash > 0 ? `${folder.path.slice(0, slash)} · ${count}` : count });
    const buttons = el.createDiv({ cls: 'vc-history-actions' });
    if (project) {
      this.addButton(buttons, 'folder-kanban', 'Open its project note', () => {
        this.close();
        this.actions.openNote(project);
      });
    } else {
      this.addButton(buttons, 'folder-plus', 'Make this folder a project', () => {
        this.close();
        this.actions.createProject(folder.path);
      });
    }
  }

  /** A note in the notes view, with its folder and how many chats it has; or the rest of its chats, folded. */
  private renderNote(match: Extract<Match, { kind: 'note' | 'more' }>, el: HTMLElement): void {
    const { note } = match;
    el.addClass('vc-history-item', match.kind === 'note' ? 'vc-history-note' : 'vc-history-nested');
    const body = el.createDiv({ cls: 'vc-history-body' });
    if (match.kind === 'more') {
      body.createDiv({ cls: 'vc-muted', text: `+${note.chats.length - NOTE_CHATS_SHOWN} more` });
      return;
    }
    const slash = note.path.lastIndexOf('/');
    const title = body.createDiv({ cls: 'vc-history-title' });
    setIcon(title.createSpan({ cls: 'vc-history-pin' }), 'file-text');
    title.appendText(note.path.slice(slash + 1).replace(/\.md$/, ''));
    const count = `${note.chats.length} ${note.chats.length === 1 ? 'chat' : 'chats'}`;
    body.createDiv({ cls: 'vc-muted', text: slash > 0 ? `${note.path.slice(0, slash)} · ${count}` : count });
  }

  /**
   * A chat opens (see onChooseSuggestion); a note, or its "+N more", shows all its chats and the
   * history stays open, with the selection on the note's first chat, or the first of those just shown;
   * except that ⌘↵ or ⌘-click on a note opens the note.
   */
  selectSuggestion(match: Match, evt: MouseEvent | KeyboardEvent): void {
    if (match.kind === 'chat') {
      super.selectSuggestion(match, evt);
    } else if (match.kind === 'folder') {
      // Into the folder; the folder gone into, already here, stays.
      if (match.here) return;
      this.inputEl.value = `${FOLDERS_PREFIX}${match.folder.path}/`;
      this.refresh();
    } else if (match.kind === 'note' && Keymap.isModEvent(evt)) {
      this.close();
      this.actions.openNote(match.note.path);
    } else {
      const { path } = match.note;
      this.expanded.add(path);
      void this.getSuggestions(this.inputEl.value).then((rows) => {
        const note = rows.findIndex((row) => row.kind === 'note' && row.note.path === path);
        this.showRows(rows, note + (match.kind === 'note' ? 1 : 1 + NOTE_CHATS_SHOWN));
      });
    }
  }

  /**
   * Draws `rows` with row `selected` picked, through Obsidian's list of suggestions (not in its API);
   * where that is missing, the query runs again and the first row is picked.
   */
  private showRows(rows: Match[], selected: number): void {
    const chooser = (this as unknown as { chooser?: { setSuggestions?(rows: Match[]): void; setSelectedItem?(index: number, evt?: Event): void } }).chooser;
    if (!chooser?.setSuggestions || !chooser.setSelectedItem || rows.length === 0) {
      this.refresh();
      return;
    }
    chooser.setSuggestions(rows.slice(0, this.limit));
    chooser.setSelectedItem(Math.max(0, Math.min(selected, rows.length - 1)));
    // Obsidian scrolls to a row picked with the keys only.
    this.resultContainerEl.querySelector('.suggestion-item.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  /** A chat opens here; with ⌘ (⌘↵, ⌘-click) or a middle click, in a new tab, as a link does in a note. */
  onChooseSuggestion(match: Match, evt: MouseEvent | KeyboardEvent): void {
    if (match.kind === 'chat') this.actions.pick(match.item, Keymap.isModEvent(evt) !== false);
  }

  private addButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const button = parent.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
    setIcon(button, icon);
    // Kept from reaching the row, where a click opens the chat.
    button.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    });
    button.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      onClick();
    });
  }

  /** Re-runs the current query, so the list shows new titles and pin order. */
  private refresh(): void {
    this.inputEl.dispatchEvent(new Event('input'));
  }
}

/** The view a query asks for, by its prefix (NOTES_PREFIX, FOLDERS_PREFIX), in any case. */
function viewOf(query: string): HistoryView {
  const lower = query.toLowerCase();
  return lower.startsWith(NOTES_PREFIX) ? 'notes' : lower.startsWith(FOLDERS_PREFIX) ? 'folders' : 'chats';
}

/** Where a chat comes from, after its date: started outside the panel (and how often copied), or a copy of one. */
function origin(item: HistoryItem): string {
  if (item.copied) return ' · copy of a chat from outside the panel';
  if (item.fromPanel) return '';
  const copies = item.copies?.length ?? 0;
  return ` · outside the panel, opens as a copy${copies === 0 ? '' : copies === 1 ? ' · copied once' : ` · copied ${copies} times`}`;
}

/** What the history shows of its rows, to tell whether a new listing changed any of them. */
function rowsKey(items: HistoryItem[]): string {
  return JSON.stringify(
    items.map((item) => [item.id, item.title, item.updatedAt, item.fromPanel, item.status, item.pinned, item.tasksRunning, item.scratch, item.copied, item.copies?.length]),
  );
}

/** Asks before chat `title` is deleted; `fromPanel`: started in the panel, not in Claude Code elsewhere. */
export function confirmDelete(app: App, title: string, fromPanel: boolean, onConfirm: () => void): void {
  const outside = fromPanel ? '' : ' It was started outside the panel, so it also disappears from Claude Code there.';
  new ConfirmModal(app, 'Delete chat', `“${title}” and its saved conversation will be deleted from this computer.${outside} This cannot be undone.`, 'Delete', onConfirm).open();
}

/** A yes/no dialog; `onConfirm` runs only when the confirming button is clicked. */
/** Asks to choose one of `choices`, each a button; Cancel does nothing. */
export class ChoiceModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly message: string,
    private readonly choices: [string, () => void][],
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('p', { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    this.choices.forEach(([label, run], i) => {
      buttons.createEl('button', { text: label, cls: i === 0 ? 'mod-cta' : '' }).addEventListener('click', () => {
        this.close();
        run();
      });
    });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('p', { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: this.confirmText, cls: 'mod-warning' }).addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** A one-field dialog for a chat's title. */
export class RenameModal extends Modal {
  constructor(
    app: App,
    private readonly current: string,
    private readonly onSave: (title: string) => void,
    private readonly heading = 'Rename chat',
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'vc-rename-input' });
    input.value = this.current;
    const save = () => {
      const title = input.value.trim();
      if (title) this.onSave(title);
      this.close();
    };
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && !evt.isComposing) {
        evt.preventDefault();
        save();
      }
    });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Save', cls: 'mod-cta' }).addEventListener('click', save);
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    window.setTimeout(() => input.select(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
