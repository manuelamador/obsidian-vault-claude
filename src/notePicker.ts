import { FuzzySuggestModal, TFile, TFolder, type App, type TAbstractFile } from 'obsidian';

/**
 * The `@` picker: notes, other files and folders; with `notesOnly`, notes alone (a memo's related
 * notes). `onPick` is given null when it closes with nothing chosen.
 */
export class NotePicker extends FuzzySuggestModal<TAbstractFile> {
  private chosen = false;

  constructor(
    app: App,
    private readonly onPick: (item: TAbstractFile | null) => void,
    private readonly notesOnly = false,
  ) {
    super(app);
    this.setPlaceholder(notesOnly ? 'Add a related note' : 'Mention a note, file or folder');
  }

  getItems(): TAbstractFile[] {
    if (this.notesOnly) return this.app.vault.getMarkdownFiles();
    return this.app.vault.getAllLoadedFiles().filter((item) => item.path !== '/' && (item instanceof TFile || item instanceof TFolder));
  }

  getItemText(item: TAbstractFile): string {
    return item instanceof TFolder ? `${item.path}/` : item.path;
  }

  onChooseItem(item: TAbstractFile): void {
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
