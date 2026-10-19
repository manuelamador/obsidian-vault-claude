import { FuzzySuggestModal, TFile, TFolder, prepareSimpleSearch, setIcon, type App, type FuzzyMatch, type TAbstractFile } from 'obsidian';
import { zoteroLabel, type ZoteroItem } from './zotero';

/** A chat offered by the `@` picker, to link to. */
export interface PickedChat {
  id: string;
  title: string;
  /** A Codex chat, marked as the history marks it. */
  codex?: boolean;
}

/** What the `@` picker offers: a note, file or folder, a chat to link to, or a Zotero work. */
export type Picked = TAbstractFile | PickedChat | ZoteroItem;

/** The picker's tabs: the vault's notes, files and folders; chats to link; Zotero's works. */
export type PickerTab = 'files' | 'chats' | 'zotero';

const TAB_NAMES: Record<PickerTab, string> = { files: 'Files', chats: 'Chats', zotero: 'Zotero' };
const PLACEHOLDERS: Record<PickerTab, string> = {
  files: 'Mention a note, memo, file or folder',
  chats: 'Link a chat',
  zotero: 'Mention a Zotero work: author, title or year',
};

/**
 * The `@` picker, in tabs (Tab and Shift+Tab move between them): the vault's notes, files and
 * folders, matched as Obsidian's quick switcher matches; chats to link to (`chats`); and Zotero's
 * works (`zotero`), once read. Chats and works are matched by words: each typed word in the title,
 * the authors or the year.
 */
export class NotePicker extends FuzzySuggestModal<Picked> {
  private chosen = false;
  private zoteroItems: ZoteroItem[] = [];
  private tab: PickerTab = 'files';
  private readonly tabEls = new Map<PickerTab, HTMLElement>();

  constructor(
    app: App,
    private readonly chats: PickedChat[],
    private readonly onPick: (item: Picked | null) => void,
    /** Whether a note is a memo, shown with the memo icon (see VaultClaudePlugin.isMemo). */
    private readonly isMemo: (file: TFile) => boolean = () => false,
    /** Zotero's works, as they are read; none with "Zotero in @" off (no Zotero tab). Rejected: Zotero is not running. */
    zotero: Promise<ZoteroItem[]> | null = null,
  ) {
    super(app);
    const tabs: PickerTab[] = ['files', ...(chats.length > 0 ? (['chats'] as const) : []), ...(zotero ? (['zotero'] as const) : [])];
    if (tabs.length > 1) {
      const bar = this.modalEl.createDiv({ cls: 'vc-picker-tabs', attr: { role: 'tablist' } });
      for (const tab of tabs) {
        // Out of the focus order: Tab moves between tabs (below) while the typing stays in the input.
        const el = bar.createEl('button', { cls: 'vc-picker-tab', text: TAB_NAMES[tab], attr: { role: 'tab', tabindex: '-1' } });
        // A click on a tab keeps the input focused, for typing on.
        el.addEventListener('mousedown', (evt) => evt.preventDefault());
        el.addEventListener('click', () => this.showTab(tab));
        this.tabEls.set(tab, el);
      }
      this.modalEl.prepend(bar);
      const step = (by: number) => {
        this.showTab(tabs[(tabs.indexOf(this.tab) + by + tabs.length) % tabs.length]);
        return false;
      };
      this.scope.register([], 'Tab', () => step(1));
      this.scope.register(['Shift'], 'Tab', () => step(-1));
    }
    this.showTab('files', false);
    if (zotero) {
      zotero.then(
        (items) => {
          this.zoteroItems = items;
          this.zoteroStatus = null;
          if (this.tab === 'zotero') this.showTab('zotero');
        },
        () => {
          this.zoteroStatus = 'is not running: start it to list your libraries here';
          if (this.tab === 'zotero') this.showTab('zotero');
        },
      );
    }
  }

  /** Opened with the input focused, for typing at once (the tabs before it would otherwise take the focus). */
  onOpen(): void {
    super.onOpen();
    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  /** What the Zotero tab says while its works are not listed: being read, or Zotero not running. */
  private zoteroStatus: string | null = 'reading your libraries…';

  /** Shows tab `tab`: its items, its placeholder, its line about Zotero; `refresh` lists them for what is typed. */
  private showTab(tab: PickerTab, refresh = true): void {
    this.tab = tab;
    for (const [each, el] of this.tabEls) {
      el.toggleClass('is-active', each === tab);
      el.setAttr('aria-selected', String(each === tab));
    }
    this.setPlaceholder(PLACEHOLDERS[tab]);
    this.setInstructions(tab === 'zotero' && this.zoteroStatus ? [{ command: 'Zotero', purpose: this.zoteroStatus }] : []);
    if (refresh) this.inputEl.dispatchEvent(new Event('input'));
  }

  getItems(): Picked[] {
    if (this.tab === 'chats') return this.chats;
    if (this.tab === 'zotero') return this.zoteroItems;
    // Not what Settings → Files and links → Excluded files hides from Obsidian's own search and quick switcher.
    const excluded = (path: string) => (this.app.metadataCache as unknown as { isUserIgnored?: (path: string) => boolean }).isUserIgnored?.(path) === true;
    return this.app.vault.getAllLoadedFiles().filter((item) => item.path !== '/' && (item instanceof TFile || item instanceof TFolder) && !excluded(item.path));
  }

  getItemText(item: Picked): string {
    // A group's work with its group, which typing the group's name finds too.
    if ('library' in item) return `${zoteroLabel(item)} — ${item.title}${item.library.kind === 'group' && item.library.name ? ` · ${item.library.name}` : ''}`;
    if ('id' in item) return item.title;
    return item instanceof TFolder ? `${item.path}/` : item.path;
  }

  /** Chats and works by words (each typed word somewhere in the row), best first; files as Obsidian matches them. */
  getSuggestions(query: string): FuzzyMatch<Picked>[] {
    if (this.tab === 'files') return super.getSuggestions(query);
    const items = this.getItems();
    if (!query.trim()) return items.map((item) => ({ item, match: { score: 0, matches: [] } }));
    const search = prepareSimpleSearch(query);
    return items
      .flatMap((item) => {
        const match = search(this.getItemText(item));
        return match ? [{ item, match }] : [];
      })
      .sort((a, b) => b.match.score - a.match.score);
  }

  /** Each row with an icon for what it is (a note, a memo, another file, a folder, a chat, a work) beside its text. */
  renderSuggestion(match: FuzzyMatch<Picked>, el: HTMLElement): void {
    const item = match.item;
    const icon =
      'library' in item ? 'book-open'
      : 'id' in item ? 'message-square'
      : item instanceof TFolder ? 'folder'
      : !(item instanceof TFile) ? 'file'
      : item.extension !== 'md' ? 'file'
      : this.isMemo(item) ? 'sticky-note'
      : 'file-text';
    el.addClass('vc-picker-row');
    setIcon(el.createSpan({ cls: 'vc-picker-icon' }), icon);
    // The text as Obsidian draws it, its matches highlighted, kept together in one element.
    super.renderSuggestion(match, el.createDiv({ cls: 'vc-picker-text' }));
    if ('id' in item && item.codex) el.createSpan({ cls: 'vc-engine-badge', text: 'Codex' });
  }

  onChooseItem(item: Picked): void {
    this.chosen = true;
    this.onPick(item);
  }

  onClose(): void {
    // SuggestModal closes before it reports the choice, so wait a tick before treating this as a cancel.
    window.setTimeout(() => {
      if (!this.chosen) this.onPick(null);
    }, 0);
  }
}
