import { FuzzySuggestModal, TFile, TFolder, setIcon, type App, type FuzzyMatch, type TAbstractFile } from 'obsidian';

/** A chat offered by the `@` picker, to link to. */
export interface PickedChat {
  id: string;
  title: string;
  /** A Codex chat, marked as the history marks it. */
  codex?: boolean;
}

/** The `@` picker: notes, other files and folders, then chats (`chats`), to link to. */
export class NotePicker extends FuzzySuggestModal<TAbstractFile | PickedChat> {
  private chosen = false;

  constructor(
    app: App,
    private readonly chats: PickedChat[],
    private readonly onPick: (item: TAbstractFile | PickedChat | null) => void,
    /** Whether a note is a memo, shown with the memo icon (see VaultClaudePlugin.isMemo). */
    private readonly isMemo: (file: TFile) => boolean = () => false,
  ) {
    super(app);
    this.setPlaceholder(chats.length > 0 ? 'Mention a note, file or folder, or link a chat' : 'Mention a note, file or folder');
  }

  getItems(): (TAbstractFile | PickedChat)[] {
    return [...this.app.vault.getAllLoadedFiles().filter((item) => item.path !== '/' && (item instanceof TFile || item instanceof TFolder)), ...this.chats];
  }

  getItemText(item: TAbstractFile | PickedChat): string {
    if ('id' in item) return `Chat: ${item.title}`;
    return item instanceof TFolder ? `${item.path}/` : item.path;
  }

  /** Each row with an icon for what it is: a note, a memo, another file, a folder or a chat. */
  renderSuggestion(match: FuzzyMatch<TAbstractFile | PickedChat>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
    const item = match.item;
    const icon =
      'id' in item ? 'message-square'
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

  onChooseItem(item: TAbstractFile | PickedChat): void {
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
