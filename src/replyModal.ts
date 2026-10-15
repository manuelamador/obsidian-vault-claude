// The dialog for "Reply with Claude" on an email card: what the reply should say, in your words, for
// Claude to write as a Gmail draft in the message's thread.
import { Modal, type App } from 'obsidian';

export class ReplyModal extends Modal {
  constructor(
    app: App,
    /** The message replied to, as the dialog names it. */
    private readonly about: string,
    private readonly onReply: (instructions: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Reply with Claude');
    this.contentEl.createDiv({ cls: 'setting-item-description', text: `To ${this.about}. Claude writes the reply as a Gmail draft in the thread, for you to send from Gmail.` });
    const input = this.contentEl.createEl('textarea', { cls: 'vc-reply-input', attr: { rows: '5', placeholder: 'What should the reply say? e.g. "Yes to Thursday at 2, and ask for the slides beforehand."' } });
    const reply = () => {
      const instructions = input.value.trim();
      if (!instructions) return;
      this.onReply(instructions);
      this.close();
    };
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey) && !evt.isComposing) {
        evt.preventDefault();
        reply();
      }
    });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Draft the reply', cls: 'mod-cta' }).addEventListener('click', reply);
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
