// The dialog that makes a todo (see todos.ts): its text, suggested from what it is made from, and an
// optional due date.
import { Modal, type App } from 'obsidian';
import { isTaskDate } from './todos';

export class TodoModal extends Modal {
  constructor(
    app: App,
    private readonly suggested: string,
    /** Where it goes, for the dialog to say. */
    private readonly where: string,
    private readonly onSave: (text: string, due?: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Make a todo');
    this.contentEl.createDiv({ cls: 'setting-item-description', text: `Added to ${this.where}.` });
    const text = this.contentEl.createEl('input', { type: 'text', cls: 'vc-todo-input' });
    text.value = this.suggested;
    const dueRow = this.contentEl.createDiv({ cls: 'vc-todo-due' });
    dueRow.createSpan({ text: 'Due (optional)' });
    const due = dueRow.createEl('input', { type: 'date' });
    const save = () => {
      const value = text.value.trim();
      if (!value) return;
      this.onSave(value, isTaskDate(due.value) ? due.value : undefined);
      this.close();
    };
    for (const input of [text, due]) {
      input.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' && !evt.isComposing) {
          evt.preventDefault();
          save();
        }
      });
    }
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Add', cls: 'mod-cta' }).addEventListener('click', save);
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    window.setTimeout(() => text.select(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
