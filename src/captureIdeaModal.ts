// The form for capturing an idea from passages of a chat: a new idea, with its title and what
// emerged in your own words, or an idea already captured, to add the passages to.
import { Modal, type App, type TFile } from 'obsidian';
import type { IdeaExcerpt } from './ideas';

/** What the form was filled in with: the idea to add to (null for a new one), and a new idea's title and description. */
export interface IdeaChoice {
  idea: TFile | null;
  title: string;
  description: string;
}

/** Longest stretch of a passage shown in the form; the note gets the whole of it. */
const PREVIEW_CHARS = 400;

export class CaptureIdeaModal extends Modal {
  constructor(
    app: App,
    private readonly excerpts: IdeaExcerpt[],
    /** The ideas captured so far, newest first. */
    private readonly ideas: TFile[],
    /** Why a new idea cannot take `title` (a note of that name exists), or null. */
    private readonly titleProblem: (title: string) => string | null,
    private readonly done: (choice: IdeaChoice) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText('Capture an idea');
    contentEl.addClass('vc-idea-form');
    const target = contentEl.createDiv({ cls: 'vc-idea-field' });
    target.createEl('label', { text: 'Add to' });
    const select = target.createEl('select', { cls: 'dropdown' });
    select.createEl('option', { text: 'A new idea', attr: { value: '' } });
    for (const idea of this.ideas) select.createEl('option', { text: idea.basename, attr: { value: idea.path } });
    const fresh = contentEl.createDiv();
    const titleField = fresh.createDiv({ cls: 'vc-idea-field' });
    titleField.createEl('label', { text: 'Idea' });
    const title = titleField.createEl('input', { attr: { type: 'text', placeholder: 'Repayment timing may change equilibrium selection' } });
    const descriptionField = fresh.createDiv({ cls: 'vc-idea-field' });
    descriptionField.createEl('label', { text: 'What emerged' });
    const description = descriptionField.createEl('textarea', { attr: { rows: '3', placeholder: 'In your own words; optional' } });
    const passages = contentEl.createDiv({ cls: 'vc-idea-passages' });
    passages.createDiv({ cls: 'vc-idea-passages-title', text: this.excerpts.length === 1 ? 'Passage' : `${this.excerpts.length} passages, in order` });
    for (const excerpt of this.excerpts) {
      const item = passages.createDiv({ cls: 'vc-idea-passage' });
      item.createDiv({ cls: 'vc-idea-role', text: excerpt.role === 'you' ? 'You' : 'Claude' });
      const text = excerpt.text.trim();
      item.createDiv({ cls: 'vc-idea-excerpt', text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text });
    }
    const problem = contentEl.createDiv({ cls: 'vc-idea-problem' });
    problem.hide();
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const save = buttons.createEl('button', { cls: 'mod-cta', text: 'Save' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const chosen = () => this.ideas.find((idea) => idea.path === select.value) ?? null;
    select.addEventListener('change', () => {
      fresh.toggle(chosen() === null);
      problem.hide();
    });
    const submit = () => {
      const idea = chosen();
      const why = idea ? null : title.value.trim() ? this.titleProblem(title.value.trim()) : 'Give the idea a title.';
      if (why) {
        problem.setText(why);
        problem.show();
        return;
      }
      this.close();
      this.done({ idea, title: title.value.trim(), description: description.value.trim() });
    };
    save.addEventListener('click', submit);
    title.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' || evt.isComposing) return;
      evt.preventDefault();
      submit();
    });
    window.setTimeout(() => title.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
