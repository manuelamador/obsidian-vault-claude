// A side chat: a question asked beside the chat on screen, in a pane over its messages, that does not
// change it. Its session is a fork of the chat (or, by the setting, a fresh one given only the quote),
// runs in Plan mode so it only reads, and is deleted when the side chat closes unless it is kept.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { Component, setIcon } from 'obsidian';
import { withQuote } from './chatText';
import type { ClaudeSession, PermissionRequest, SessionHandlers } from './session';

/** What a side chat needs from the panel. */
export interface SideChatHost {
  /**
   * Starts the side chat's session `id`, with these handlers: a new one, or with `own` that session
   * again (after its process failed); null when it cannot (no Claude Code, say).
   */
  startSession(handlers: SessionHandlers, id: string, own: boolean): Promise<ClaudeSession | null>;
  /** Draws reply Markdown into `el`, as the chat draws its replies, its components owned by `component`. */
  renderMarkdown(markdown: string, el: HTMLElement, component: Component): void;
  /** Deletes the side chat's own session, a copy made for it, when it is closed or started over. */
  deleteSession(id: string): void;
  /** Keeps the side chat's session as a chat of its own: in the history at once, with `unsent` in its input. */
  keep(id: string, unsent: string): void;
  /** Opens a kept session in a new tab, once its process has ended. */
  openKept(id: string): void;
  /** Whether ⌘↩ (Ctrl+Enter) sends rather than ↩, as in the chat's input. */
  sendWithModifier(): boolean;
}

/** Why a side chat's request to act is refused. */
const READ_ONLY = 'A side chat only reads: it does not change the vault or the chat it was opened from.';

/** One session of a side chat, from its start until it ends. */
interface Run {
  session: ClaudeSession | null;
  /** Its session id, chosen before it starts, so it can be deleted even if closed at once. */
  id: string;
  /** Claude Code has started it under that id, so its file exists and it can be kept or resumed. */
  started: boolean;
  /**
   * What becomes of its session once its process has ended, so that nothing still writes to the
   * file: deleted (the side chat was closed or started over), or, kept as a chat of its own, opened.
   */
  then: 'delete' | 'keep' | null;
}

export class SideChat {
  readonly el: HTMLElement;
  private readonly messages: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly status: HTMLElement;
  /** The session answering, or the last one if it failed; a new question resumes that one. */
  private run: Run | null = null;
  /** The reply streaming in, drawn as plain text until its message is complete. */
  private live: HTMLElement | null = null;
  private busy = false;
  /** Owns the components of the replies' Markdown; replaced whenever they are cleared. */
  private component = new Component();
  /** Counts the side chat's ends, so a session that finishes starting after one is not used. */
  private ends = 0;

  constructor(
    parent: HTMLElement,
    private readonly host: SideChatHost,
  ) {
    this.el = parent.createDiv({ cls: 'vc-side-chat' });
    this.el.hide();
    const header = this.el.createDiv({ cls: 'vc-side-chat-header' });
    header.createSpan({ cls: 'vc-side-chat-title', text: 'Side chat' });
    const button = (icon: string, label: string, onClick: () => void) => {
      const el = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
      setIcon(el, icon);
      el.addEventListener('click', onClick);
    };
    button('trash-2', 'Start over', () => this.startOver());
    button('copy-plus', 'Keep as a chat, in a new tab', () => this.keep());
    button('x', 'Close (Esc)', () => this.close());
    this.messages = this.el.createDiv({ cls: 'vc-side-chat-messages' });
    this.status = this.el.createDiv({ cls: 'vc-side-chat-status vc-muted' });
    this.input = this.el.createEl('textarea', { cls: 'vc-side-chat-input', attr: { rows: '2', placeholder: 'Ask about this chat…' } });
    this.el.addEventListener('keydown', (evt) => this.onKey(evt));
    this.component.load();
  }

  isOpen(): boolean {
    return this.el.isShown();
  }

  /** Opens the side chat, with `quote` (text selected in the chat) quoted in its input to ask about. */
  open(quote?: string): void {
    this.el.show();
    // Whole: a side chat given only what is asked knows no more of the selection than this.
    if (quote) this.input.value = withQuote(this.input.value, quote, Infinity);
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  /** Closes it: its session ends and its copy of the chat is deleted. */
  close(): void {
    this.end('delete');
    this.clear();
    this.input.value = '';
    this.el.hide();
  }

  /** Empties it and ends its session, deleting its copy; the next question starts a new one. */
  private startOver(): void {
    this.end('delete');
    this.clear();
    this.input.focus();
  }

  /** Keeps its session as a chat of its own, opened in a new tab once its process has ended, and closes the side chat. */
  private keep(): void {
    if (!this.run?.started) {
      this.showStatus('There is nothing to keep yet.');
      return;
    }
    // What was typed and not sent goes with the conversation, to the kept chat's input.
    this.host.keep(this.run.id, this.input.value);
    this.end('keep');
    this.clear();
    this.input.value = '';
    this.el.hide();
  }

  /** Takes the questions and replies away, unloading what their Markdown loaded. */
  private clear(): void {
    this.messages.empty();
    this.component.unload();
    this.component = new Component();
    this.component.load();
  }

  /** Ends the session, and then deletes or keeps it (see Run.then). */
  private end(then: 'delete' | 'keep'): void {
    const run = this.run;
    this.run = null;
    this.ends += 1;
    this.live = null;
    this.setBusy(false);
    this.showStatus('');
    if (!run) return;
    run.then = then;
    if (run.session) run.session.close();
    else this.finish(run);
  }

  /** Deletes an ended run's session, or opens it where it was kept, as it was told to. */
  private finish(run: Run): void {
    if (run.then === 'delete') this.host.deleteSession(run.id);
    else if (run.then === 'keep') this.host.openKept(run.id);
  }

  private onKey(evt: KeyboardEvent): void {
    // An Esc or Enter that ends an IME composition belongs to it.
    if (evt.isComposing) return;
    if (evt.key === 'Escape') {
      // Marked as used, so the panel's Esc-stops-Claude handler leaves it alone.
      evt.preventDefault();
      this.close();
      return;
    }
    if (evt.target !== this.input || evt.key !== 'Enter' || evt.shiftKey) return;
    const modifier = evt.metaKey || evt.ctrlKey;
    if (this.host.sendWithModifier() !== modifier) return;
    evt.preventDefault();
    void this.send();
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim();
    // Busy from here on, so a second question waits for this one's session.
    if (!text || this.busy) return;
    const bubble = this.messages.createDiv({ cls: 'vc-side-chat-question' });
    this.host.renderMarkdown(text, bubble, this.component);
    this.input.value = '';
    this.setBusy(true);
    this.scrollToEnd();
    const session = this.run?.session ?? (await this.startRun());
    if (session) {
      session.send(text);
    } else if (bubble.isConnected) {
      // It could not start: the question goes back to the input.
      bubble.remove();
      this.input.value = text;
      this.setBusy(false);
      this.showStatus('');
    }
  }

  /**
   * Starts a session: the last one again if it failed after starting, else a new one, and then
   * what a failed one may have left is deleted. Null when it cannot start, or when the side chat
   * was closed or started over meanwhile.
   */
  private async startRun(): Promise<ClaudeSession | null> {
    const last = this.run;
    const own = last?.started === true;
    const run: Run = { session: null, id: own && last ? last.id : randomUUID(), started: own, then: null };
    const ends = this.ends;
    run.session = await this.host.startSession(this.handlers(run), run.id, own);
    if (!run.session) return null;
    if (ends !== this.ends) {
      // Never sent anything, so no process started and nothing was written; its id is let go.
      this.host.deleteSession(run.id);
      return null;
    }
    if (last && !own) this.host.deleteSession(last.id);
    this.run = run;
    return run.session;
  }

  /** Handlers for `run`; once the side chat has moved on from it, they only finish it off. */
  private handlers(run: Run): SessionHandlers {
    const current = () => this.run === run;
    return {
      onMessage: (message) => {
        if (message.type === 'system' && message.subtype === 'init') run.started = true;
        else if (current()) this.onMessage(message);
      },
      onPermission: async (_request: PermissionRequest) => ({ behavior: 'deny', message: READ_ONLY }),
      onEnd: (error) => {
        run.session = null;
        this.finish(run);
        if (!current()) return;
        this.live = null;
        this.setBusy(false);
        if (error) this.showStatus(`The side chat stopped: ${error.message}`);
      },
    };
  }

  private onMessage(message: SDKMessage): void {
    if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
      const event = message.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        this.live ??= this.messages.createDiv({ cls: 'vc-side-chat-reply vc-text is-live' });
        this.live.appendText(event.delta.text);
        this.scrollToEnd();
      }
    } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      const text = message.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n\n')
        .trim();
      const tool = message.message.content.find((block) => block.type === 'tool_use');
      if (text) {
        const el = this.live ?? this.messages.createDiv({ cls: 'vc-side-chat-reply vc-text' });
        el.empty();
        el.removeClass('is-live');
        this.host.renderMarkdown(text, el, this.component);
      } else {
        this.live?.remove();
      }
      this.live = null;
      if (tool) this.showStatus(`Looking: ${tool.name}…`);
      this.scrollToEnd();
    } else if (message.type === 'result') {
      this.setBusy(false);
      this.showStatus(message.subtype === 'success' ? '' : 'The side chat could not answer.');
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.el.toggleClass('is-busy', busy);
    if (busy) this.showStatus('Thinking…');
  }

  private showStatus(text: string): void {
    this.status.setText(text);
    this.status.toggle(text.length > 0);
  }

  private scrollToEnd(): void {
    this.messages.scrollTop = this.messages.scrollHeight;
  }
}
