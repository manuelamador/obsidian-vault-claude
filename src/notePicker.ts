import { FuzzySuggestModal, TFile, TFolder, type App, type TAbstractFile } from 'obsidian';

/** A chat offered by the `@` picker, to link to. */
export interface PickedChat {
  id: string;
  title: string;
}

/** The `@` picker: notes, other files and folders, then chats (`chats`), to link to. */
export class NotePicker extends FuzzySuggestModal<TAbstractFile | PickedChat> {
  private chosen = false;

  constructor(
    app: App,
    private readonly chats: PickedChat[],
    private readonly onPick: (item: TAbstractFile | PickedChat | null) => void,
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
