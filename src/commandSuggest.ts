import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';

/** Slash-command suggestions above the chat input, while a `/` word is typed at its start. */
export class CommandSuggest {
  private readonly el: HTMLElement;
  private suggestions: SlashCommand[] = [];
  private suggestIndex = 0;

  constructor(
    parent: HTMLElement,
    private readonly inputEl: HTMLTextAreaElement,
    private readonly commands: () => SlashCommand[],
  ) {
    this.el = parent.createDiv({ cls: 'vc-suggest' });
    this.el.hide();
  }

  /** ↑/↓, Enter/Tab and Esc while the list is shown; returns whether the key was used. */
  handleKey(evt: KeyboardEvent): boolean {
    if (this.suggestions.length === 0 || evt.isComposing) return false;
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
      evt.preventDefault();
      this.move(evt.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (evt.key === 'Enter' || evt.key === 'Tab') {
      evt.preventDefault();
      this.accept(this.suggestions[this.suggestIndex]);
      return true;
    }
    if (evt.key === 'Escape') {
      evt.preventDefault();
      this.hide();
      return true;
    }
    return false;
  }

  /** Lists the commands matching a `/` word at the start of the input, while the caret is in it. */
  update(): void {
    const value = this.inputEl.value;
    const caret = this.inputEl.selectionStart ?? value.length;
    const token = value.match(/^\/(\S*)/);
    const commands = this.commands();
    if (!token || caret > token[0].length || commands.length === 0) {
      this.hide();
      return;
    }
    const query = token[1].toLowerCase();
    const byName = (a: SlashCommand, b: SlashCommand) => a.name.localeCompare(b.name);
    const starts = commands.filter((command) => command.name.toLowerCase().startsWith(query)).sort(byName);
    const contains = commands
      .filter((command) => !command.name.toLowerCase().startsWith(query) && command.name.toLowerCase().includes(query))
      .sort(byName);
    const matches = [...starts, ...contains];
    if (matches.length === 0 || (matches.length === 1 && matches[0].name.toLowerCase() === query)) {
      this.hide();
      return;
    }
    this.suggestions = matches;
    this.suggestIndex = 0;
    this.render();
  }

  private render(): void {
    const el = this.el;
    el.empty();
    this.suggestions.forEach((command, index) => {
      const item = el.createDiv({ cls: 'vc-suggest-item' });
      item.toggleClass('is-selected', index === this.suggestIndex);
      const head = item.createDiv({ cls: 'vc-suggest-head' });
      head.createSpan({ cls: 'vc-suggest-name', text: `/${command.name}` });
      if (command.argumentHint) head.createSpan({ cls: 'vc-suggest-hint', text: command.argumentHint });
      if (command.description) item.createDiv({ cls: 'vc-suggest-desc', text: command.description });
      // mousedown, not click: a click would land after the input's blur has closed the list.
      item.addEventListener('mousedown', (evt) => {
        evt.preventDefault();
        this.accept(command);
      });
    });
    el.show();
    this.scrollIntoView();
  }

  private move(delta: number): void {
    const count = this.suggestions.length;
    this.suggestIndex = (this.suggestIndex + delta + count) % count;
    Array.from(this.el.children).forEach((child, index) => child.toggleClass('is-selected', index === this.suggestIndex));
    this.scrollIntoView();
  }

  private scrollIntoView(): void {
    (this.el.children[this.suggestIndex] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Replaces the `/` word with the command and a space, keeping anything typed after it. */
  private accept(command: SlashCommand): void {
    const value = this.inputEl.value;
    const token = value.match(/^\/\S*/)?.[0] ?? '';
    const rest = value.slice(token.length).replace(/^ /, '');
    const inserted = `/${command.name} `;
    this.inputEl.value = inserted + rest;
    this.inputEl.setSelectionRange(inserted.length, inserted.length);
    this.hide();
    this.inputEl.focus();
  }

  hide(): void {
    this.suggestions = [];
    this.el.empty();
    this.el.hide();
  }
}
