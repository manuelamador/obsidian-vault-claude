import { FuzzySuggestModal, TFile, TFolder, setIcon, type App, type FuzzyMatch, type TAbstractFile } from 'obsidian';
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

/** The `@` picker: notes, other files and folders, then chats (`chats`), to link to, and Zotero's works (`zotero`) once read. */
export class NotePicker extends FuzzySuggestModal<Picked> {
  private chosen = false;
  private zoteroItems: ZoteroItem[] = [];

  constructor(
    app: App,
    private readonly chats: PickedChat[],
    private readonly onPick: (item: Picked | null) => void,
    /** Whether a note is a memo, shown with the memo icon (see VaultClaudePlugin.isMemo). */
    private readonly isMemo: (file: TFile) => boolean = () => false,
    /** Zotero's works, as they are read; none with "Zotero in @" off. Rejected: Zotero is not running. */
    zotero: Promise<ZoteroItem[]> | null = null,
  ) {
    super(app);
    this.setPlaceholder(chats.length > 0 ? 'Mention a note, file or folder, or link a chat' : 'Mention a note, file or folder');
    if (zotero) {
      this.setInstructions([{ command: 'Zotero', purpose: 'reading your libraries…' }]);
      zotero.then(
        (items) => {
          this.zoteroItems = items;
          this.setInstructions([]);
          // The list as typed so far, with the works now among it.
          this.inputEl.dispatchEvent(new Event('input'));
        },
        () => this.setInstructions([{ command: 'Zotero', purpose: 'is not running: start it to list your libraries here' }]),
      );
    }
  }

  getItems(): Picked[] {
    return [...this.app.vault.getAllLoadedFiles().filter((item) => item.path !== '/' && (item instanceof TFile || item instanceof TFolder)), ...this.chats, ...this.zoteroItems];
  }

  getItemText(item: Picked): string {
    if ('library' in item) return `Zotero: ${zoteroLabel(item)} — ${item.title}`;
    if ('id' in item) return `Chat: ${item.title}`;
    return item instanceof TFolder ? `${item.path}/` : item.path;
  }

  /** Each row with an icon for what it is: a note, a memo, another file, a folder or a chat. */
  renderSuggestion(match: FuzzyMatch<Picked>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
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
    const iconEl = el.createSpan({ cls: 'vc-picker-icon' });
    setIcon(iconEl, icon);
    el.prepend(iconEl);
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
