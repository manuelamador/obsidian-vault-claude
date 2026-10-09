// The links of a chat, under its map in Connections (see ChatView.linksPane): the chats it links
// to, each of which may be included (its digest goes with the next message, once), and the chats that
// link to it, which send it nothing. What would go is shown before it goes, with its size.
import { FuzzySuggestModal, setIcon, type App } from 'obsidian';
import { estimateTokens, formatTokens } from './contextSize';
import { errorText } from './log';

/** A link as the list under the map shows it. */
export interface LinkRow {
  id: string;
  title: string;
  /** When the chat was last active, as shown. */
  when: string;
  /** `to`: this chat links to it; `from`: it links to this chat. */
  direction: 'to' | 'from';
  /** Linked in the message being typed: recorded once it is sent. */
  pending: boolean;
  include: boolean;
  sent: boolean;
  /** It changed since its digest went. */
  updated: boolean;
  /** Its summary is used in place of its digest. */
  summarised: boolean;
}

export interface LinksHost {
  rows(): LinkRow[];
  /** What would go of chat `id`: its digest, or its summary. */
  digest(id: string): Promise<string>;
  setInclude(id: string, on: boolean): void;
  sendAgain(id: string): void;
  unlink(id: string): void;
  open(id: string): void;
  summarise(id: string, signal: AbortSignal): Promise<void>;
  forgetSummary(id: string): void;
  /** Chooses a chat to link to, in the history window (see ChatView.openHistory); the list is drawn again once it is linked. */
  chooseChat(): void;
}

/** Picks a chat, for what `placeholder` says. */
export class ChatPicker extends FuzzySuggestModal<{ id: string; title: string }> {
  constructor(app: App, private readonly chats: { id: string; title: string }[], private readonly chosen: (chat: { id: string; title: string }) => void, placeholder: string) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): { id: string; title: string }[] {
    return this.chats;
  }

  getItemText(chat: { id: string; title: string }): string {
    return chat.title;
  }

  onChooseItem(chat: { id: string; title: string }): void {
    this.chosen(chat);
  }
}

/** The chat's links, drawn under its map in the Connections pane (see ConnectionsView); Link a chat… chooses one in the history window. */
export class LinksList {
  private contentEl!: HTMLElement;

  /** The summaries being written, by chat: kept across redraws, so a row drawn again shows its summary under way rather than offering another. */
  private readonly running = new Map<string, AbortController>();
  /** Why a chat's summary failed, by chat, shown in its row until it is asked for again. */
  private readonly failed = new Map<string, string>();

  constructor(private readonly host: LinksHost) {}

  /** Draws the links into `el`. */
  mount(el: HTMLElement): void {
    this.contentEl = el;
    this.draw();
  }

  /** Draws the links again, in place, after they changed; a summary being written goes on. */
  redraw(): void {
    this.draw();
  }

  private draw(): void {
    const { contentEl, host } = this;
    contentEl.empty();
    contentEl.createDiv({
      cls: 'vc-project-label',
      text: 'A link connects this chat to one other chat, so you can jump between them; both show it. It sends nothing unless you tick Include, which sends a short digest of that chat once, with your next message.',
    });
    const rows = host.rows();
    const to = rows.filter((row) => row.direction === 'to');
    const from = rows.filter((row) => row.direction === 'from');
    if (to.length > 0) contentEl.createDiv({ cls: 'vc-project-label', text: 'This chat links to' });
    for (const row of to) this.drawTo(row);
    if (from.length > 0) contentEl.createDiv({ cls: 'vc-project-label', text: 'Linking to this chat' });
    for (const row of from) {
      const box = contentEl.createDiv({ cls: 'vc-project-section' });
      this.head(box, row);
    }
    const foot = contentEl.createDiv({ cls: 'vc-project-foot' });
    foot.createEl('button', { text: 'Link a chat…' }).addEventListener('click', () => host.chooseChat());
  }

  /** A link's title (opening its chat) and what it is. */
  private head(box: HTMLElement, row: LinkRow): HTMLElement {
    const top = box.createDiv({ cls: 'vc-project-section-head' });
    setIcon(top.createSpan({ cls: 'vc-project-group-icon' }), row.direction === 'to' ? 'link' : 'corner-down-right');
    const name = top.createEl('a', { text: row.title, attr: { 'aria-label': 'Open this chat' } });
    name.addEventListener('click', () => {
      this.host.open(row.id);
    });
    top.createSpan({ cls: 'vc-project-size', text: row.pending ? `${row.when} · in your message, linked when it is sent` : row.when });
    return top;
  }

  /** A chat this one links to: Include, what goes and its size, Send again, a summary in place of the digest, Unlink. */
  private drawTo(row: LinkRow): void {
    const { host } = this;
    const box = this.contentEl.createDiv({ cls: 'vc-project-section' });
    const top = this.head(box, row);
    const unlink = top.createSpan({ cls: 'clickable-icon', attr: { 'aria-label': 'Unlink' } });
    setIcon(unlink, 'x');
    unlink.addEventListener('click', () => {
      host.unlink(row.id);
      this.draw();
    });
    const line = box.createDiv({ cls: 'vc-link-line' });
    const toggle = line.createEl('label', { cls: 'vc-project-toggle' });
    const include = toggle.createEl('input', { type: 'checkbox' });
    include.checked = row.include;
    toggle.appendText('Include');
    include.addEventListener('change', () => {
      host.setInclude(row.id, include.checked);
      this.draw();
    });
    const status = line.createSpan({ cls: 'vc-project-status' });
    if (row.include && row.sent) {
      status.appendText(row.updated ? 'Went with this chat; the chat changed since · ' : 'Went with this chat · ');
      status.createEl('a', { text: 'Send again' }).addEventListener('click', () => {
        host.sendAgain(row.id);
        this.draw();
      });
    } else if (row.include) {
      status.setText('Goes with your next message…');
      void host.digest(row.id).then((digest) => status.setText(`Goes with your next message: about ${formatTokens(estimateTokens(digest.length))} tokens.`));
    }
    const fold = box.createEl('details', { cls: 'vc-project-connections' });
    // Unfolded while its summary is written, or failed, so that what came of it shows.
    fold.open = this.running.has(row.id) || this.failed.has(row.id);
    fold.createEl('summary', { text: row.summarised ? 'What goes: its summary' : 'What goes: its digest' });
    const body = fold.createEl('pre', { cls: 'vc-link-digest' });
    fold.addEventListener('toggle', () => {
      if (fold.open && !body.textContent) void host.digest(row.id).then((digest) => body.setText(digest));
    });
    const actions = fold.createDiv({ cls: 'vc-project-foot' });
    const working = actions.createSpan({ cls: 'vc-project-status vc-pick-up-status' });
    if (row.summarised) {
      actions.createEl('button', { text: 'Use its digest instead' }).addEventListener('click', () => {
        host.forgetSummary(row.id);
        this.draw();
      });
      return;
    }
    const summarise = actions.createEl('button', { text: 'Summarise first' });
    summarise.setAttr('aria-label', 'Ask the model for small jobs for a summary of this chat, sent in place of its digest');
    if (this.running.has(row.id)) {
      summarise.disabled = true;
      working.createSpan({ cls: 'vc-pick-up-wheel', attr: { 'aria-hidden': 'true' } });
      working.createSpan({ text: 'Summarising…' });
    } else {
      const failure = this.failed.get(row.id);
      if (failure) working.setText(`No summary: ${failure}.`);
    }
    summarise.addEventListener('click', () => void this.summarise(row.id));
  }

  /** Has the model summarise chat `id` (once at a time), drawing the list again as it starts and when it ends. */
  private async summarise(id: string): Promise<void> {
    if (this.running.has(id)) return;
    const controller = new AbortController();
    this.running.set(id, controller);
    this.failed.delete(id);
    this.draw();
    try {
      await this.host.summarise(id, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) this.failed.set(id, errorText(error));
    } finally {
      this.running.delete(id);
    }
    if (!controller.signal.aborted) this.draw();
  }

  onClose(): void {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    this.failed.clear();
    this.contentEl.empty();
  }
}
