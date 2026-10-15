// Pick up where you left off, shown: Claude's suggestions as a list, each row opening in place to its
// next step, what it is about (the notes it touched, the memos from it) and what made it a candidate;
// a chat opens as it is, or with the suggested step added to its input, or is set aside until you
// work on it again. Suggest again asks anew.
import { Component, Modal, setIcon, type App } from 'obsidian';
import { errorText, log } from './log';
import { DAY_MS, REMINDER_DAYS, SHOWN_OLDER, SHOWN_RECENT, SKIP_DAYS, type Candidate, type Suggestion } from './pickUp';

/** What a chat is about, from the plugin's records: the notes it touched, and the memos saved from it. */
export interface ChatDetails {
  notes: { path: string; name: string; folder: string; tags: string[]; how: string }[];
  memos: { path: string; name: string; tags: string[]; status: string }[];
}

/** What the list needs from the plugin. */
export interface PickUpHost {
  /**
   * The suggestions, with the chats they were chosen from, and when they were made: today's kept
   * ones unless `fresh`, which asks anew. Null when Claude Code cannot run.
   */
  load(signal: AbortSignal, fresh: boolean): Promise<{ suggestions: Suggestion[]; note: string; candidates: Candidate[]; at: number } | null>;
  /** What chat `id` is about (see ChatDetails). */
  details(id: string): ChatDetails;
  /** Opens chat `id`; `step`, added to its input after anything already there. */
  open(id: string, step: string | null): Promise<void>;
  /**
   * Draws `markdown` (Claude's or yours) into `el`, filtered as replies are (see renderSafely), its
   * links and file names opening their notes (after `leaving`) and showing their previews.
   */
  renderMarkdown(markdown: string, el: HTMLElement, component: Component, leaving: () => void, parent: unknown): void;
  /** Opens note or memo `path`. */
  openNote?(path: string): void;
  /** Shows note `path`'s preview, as hovering a link does (with the key the setting asks for). */
  previewNote?(path: string, event: MouseEvent | KeyboardEvent, target: HTMLElement, parent: unknown): void;
  /** Chat `id` never to be suggested again (until the reset command). */
  hide(id: string): void;
  /** Chat `id` left out for SKIP_DAYS, then suggested again if it still looks left open. */
  skip(id: string): void;
  /** How many chats are never to be suggested. */
  ignoredCount(): number;
  /** Whether chat `id` is not to be listed now: left out, or kept as a reminder. */
  leftOut(id: string): boolean;
  /** Lets every chat never to be suggested be suggested again. */
  clearIgnored(): void;
  /** Keeps `suggestion` to be shown the next times the list is opened (see REMINDER_DAYS). */
  remindLater(suggestion: Suggestion): void;
  /** Stops reminding of chat `id`. */
  forget(id: string): void;
  /** The reminders asked for before `before`, as chats with their suggestions and the days they have left. */
  reminders(before: number): { chat: Candidate; suggestion: Suggestion; left: number }[];
}

/** How long "Reminder set" shows before a row in its place comes in, and how long a row takes to go. */
const SAID_MS = 1400;
const LEAVE_MS = 300;

/** A folder as the list shows it: its path, or "Vault root". */
function folderText(folder: string): string {
  return folder === '/' ? 'Vault root' : `${folder}/`;
}

/** How long ago, in words: "today", "3 days ago", "2 months ago". */
function ago(at: number, now: number): string {
  const days = Math.round((now - at) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 45) return `${days} days ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

export class PickUpModal extends Modal {
  /** The request on its way, if one is: closing, or asking again, lets it go. */
  private loading: AbortController | null = null;
  /** What the drawn excerpts belong to, unloaded when the list closes; each details' own, unloaded when they are drawn again or closed. */
  private readonly component = new Component();
  private readonly drawnFor = new Map<HTMLElement, Component>();
  private status!: HTMLElement;
  /** The note name the pointer is over, for a preview when ⌘ is pressed there. */
  private over: { path: string; el: HTMLElement } | null = null;
  /** The fades on their way, cleared when the list closes. */
  private readonly timers = new Set<number>();
  /** The pane of the row clicked, beside the list; and the row it shows. */
  private detail!: HTMLElement;
  private detailRow: HTMLElement | null = null;
  private foot!: HTMLElement;
  /** The reminders asked for before, shown first; asking again leaves them. */
  private reminders!: HTMLElement;
  private list!: HTMLElement;
  /** The chats reminded of, left out of the suggestions below them. */
  private reminded = new Set<string>();
  /** Suggestions ranked after those shown, by group: the next takes the place of one set aside. */
  private spares = new Map<string, { chat: Candidate; suggestion: Suggestion }[]>();
  private again!: HTMLButtonElement;

  constructor(
    app: App,
    private readonly host: PickUpHost,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.component.load();
    this.component.registerDomEvent(contentEl.ownerDocument, 'keydown', (evt) => {
      if (this.over?.el.isConnected && (evt.key === 'Meta' || evt.key === 'Control')) this.host.previewNote?.(this.over.path, evt, this.over.el, this);
    });
    this.titleEl.setText('Pick up where you left off');
    contentEl.addClass('vc-pick-up');
    // The list on the left; a row clicked, its details in a pane on the right, the window widened for it.
    const main = contentEl.createDiv({ cls: 'vc-pick-up-main' });
    this.detail = contentEl.createDiv({ cls: 'vc-pick-up-detail' });
    this.detail.hide();
    const bar = main.createDiv({ cls: 'vc-pick-up-bar' });
    this.status = bar.createDiv({ cls: 'vc-memo-status vc-pick-up-status' });
    this.again = bar.createEl('button', { text: 'Suggest again', attr: { 'aria-label': 'Ask Claude again: a fresh look, with other older chats' } });
    this.again.addEventListener('click', () => this.ask(true));
    this.reminders = main.createDiv({ cls: 'vc-pick-up-list' });
    const kept = this.host.reminders(Date.now());
    if (kept.length > 0) {
      this.reminders.createDiv({ cls: 'vc-memo-passages-title', text: 'You asked to be reminded (click the clock to stop)' });
      for (const { chat, suggestion, left } of kept) {
        this.reminded.add(chat.id);
        this.drawRow(this.reminders, chat, suggestion, Date.now(), undefined, left);
      }
    }
    this.list = main.createDiv({ cls: 'vc-pick-up-list' });
    // At the foot: the chats left out, to let back in.
    this.foot = main.createDiv({ cls: 'vc-pick-up-foot vc-muted' });
    this.drawFoot();
    this.ask();
  }

  /** Asks for suggestions (today's, unless `fresh`); the list on screen stays until the new one is in. */
  private ask(fresh = false): void {
    this.loading?.abort();
    const loading = new AbortController();
    this.loading = loading;
    // Not offered while Claude is at it: it comes back with the answer.
    this.again.hide();
    this.say(this.list.childElementCount > 0 ? 'Asking Claude again…' : 'Claude is looking at your recent chats, and some older ones that look unfinished…', true);
    void this.host
      .load(loading.signal, fresh)
      .then((result) => {
        if (loading.signal.aborted) return;
        if (!result) this.say('Claude Code could not be started: see the plugin settings.');
        else this.draw(result);
      })
      .catch((error: unknown) => {
        if (loading.signal.aborted) return;
        log('suggesting chats to pick up failed', error);
        this.say(`No suggestions: ${errorText(error)}`);
      })
      .finally(() => {
        if (this.loading === loading) this.again.show();
      });
  }

  /** The foot: how many chats are left out, with a link to let them back in; nothing when there are none. */
  private drawFoot(): void {
    this.foot.empty();
    const count = this.host.ignoredCount();
    this.foot.toggle(count > 0);
    if (count === 0) return;
    this.foot.appendText(`${count} chat${count === 1 ? ' is' : 's are'} never suggested. `);
    this.foot.createSpan({ cls: 'vc-welcome-link', text: 'Clear ignored chats' }).addEventListener('click', () => {
      this.host.clearIgnored();
      this.foot.empty();
      this.foot.appendText('They can be suggested again. ');
      this.foot.createSpan({ cls: 'vc-welcome-link', text: 'Suggest again' }).addEventListener('click', () => {
        this.foot.hide();
        this.ask(true);
      });
    });
  }

  /** The status line; `working`, with a turning wheel beside it while Claude is at it. */
  private say(text: string, working = false): void {
    this.status.empty();
    if (working) this.status.createSpan({ cls: 'vc-pick-up-wheel', attr: { 'aria-hidden': 'true' } });
    this.status.createSpan({ text });
    this.status.toggleClass('is-working', working);
  }

  private draw(result: { suggestions: Suggestion[]; note: string; candidates: Candidate[]; at: number }): void {
    const now = Date.now();
    // Kept from earlier today: said, with when.
    const when = now - result.at > 60_000 ? ` at ${new Date(result.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (Suggest again for a fresh look)` : '';
    const byId = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));
    this.closeDetail();
    this.list.empty();
    // Not those set aside or reminded of, here or while the request ran.
    result = { ...result, suggestions: result.suggestions.filter((suggestion) => !this.reminded.has(suggestion.id) && !this.host.leftOut(suggestion.id)) };
    if (result.suggestions.length === 0) {
      this.say(result.note || 'Nothing looks left open.');
      return;
    }
    this.say(`Suggested by Claude${when}, from short excerpts of the chats. Click one for more; nothing is sent until you send it.`);
    const groups: [string, Suggestion[]][] = [
      ['Recent', result.suggestions.filter((suggestion) => !byId.get(suggestion.id)?.older)],
      ['From further back', result.suggestions.filter((suggestion) => byId.get(suggestion.id)?.older)],
    ];
    this.spares.clear();
    for (const [heading, suggestions] of groups) {
      const ranked = suggestions.flatMap((suggestion) => {
        const chat = byId.get(suggestion.id);
        return chat ? [{ chat, suggestion }] : [];
      });
      if (ranked.length === 0) continue;
      const shown = heading === 'Recent' ? SHOWN_RECENT : SHOWN_OLDER;
      this.spares.set(heading, ranked.slice(shown));
      this.list.createDiv({ cls: 'vc-memo-passages-title', text: heading });
      for (const { chat, suggestion } of ranked.slice(0, shown)) this.drawRow(this.list, chat, suggestion, now, heading);
    }
  }

  /**
   * Row `row` set aside (to be reminded of, or not this one), seen to go: `said` (a reminder set)
   * shown in its place for a moment; then it fades, and the next spare of its group comes in where it
   * was. With none left, it goes, or `said` stays in its place.
   */
  private replace(row: HTMLElement, group: string | undefined, said?: string): void {
    // Once only: a second click while it goes takes no second spare.
    if (row.hasClass('is-leaving') || row.hasClass('is-said')) return;
    // Its details go with it.
    if (this.detailRow === row) this.closeDetail();
    const next = group ? this.spares.get(group)?.shift() : undefined;
    const leave = () => {
      row.addClass('is-leaving');
      this.later(() => {
        if (!next) {
          if (!said) {
            const list = row.parentElement;
            row.remove();
            // A heading with nothing left under it goes too.
            if (list && !list.querySelector('.vc-pick-up-card')) list.empty();
          } else row.removeClass('is-leaving');
          return;
        }
        const holder = createDiv();
        this.drawRow(holder, next.chat, next.suggestion, Date.now(), group);
        (holder.firstElementChild as HTMLElement | null)?.addClass('is-arriving');
        row.replaceWith(...Array.from(holder.childNodes));
      }, LEAVE_MS);
    };
    if (!said) {
      leave();
      return;
    }
    row.empty();
    row.removeClass('is-open');
    row.addClass('is-said');
    setIcon(row.createSpan({ cls: 'vc-pick-up-said-icon' }), 'alarm-clock');
    row.createSpan({ text: said });
    // Read first; then, if another takes its place, it goes.
    if (next) {
      this.later(() => {
        row.removeClass('is-said');
        leave();
      }, SAID_MS);
    }
  }

  /** Runs `run` after `ms`, unless the list closes first. */
  private later(run: () => void, ms: number): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }

  /**
   * A row: the chat's title, age, folder and why, and a clock to be reminded of it later; clicked, it
   * opens to the rest (one open at a time). `group`: whose spares replace it when it is set aside.
   */
  private drawRow(parent: HTMLElement, chat: Candidate, suggestion: Suggestion, now: number, group?: string, left?: number): void {
    const row = parent.createDiv({ cls: 'vc-pick-up-card' });
    row.dataset.group = group ?? '';
    // A reminder: its days left said, and it fades as they run out.
    const reminder = left !== undefined;
    if (reminder) {
      row.addClass('is-reminder');
      row.style.setProperty('--vc-reminder-fade', String(0.55 + 0.45 * (left / (REMINDER_DAYS - 1))));
    }
    const summary = row.createDiv({ cls: 'vc-pick-up-summary', attr: { role: 'button', tabindex: '0', 'aria-expanded': 'false' } });
    const head = summary.createDiv({ cls: 'vc-pick-up-head' });
    const chevron = head.createSpan({ cls: 'vc-pick-up-chevron' });
    setIcon(chevron, 'chevron-right');
    head.createSpan({ cls: 'vc-pick-up-title', text: chat.title });
    head.createSpan({ cls: 'vc-pick-up-age', text: ago(chat.updatedAt, now) });
    if (reminder) head.createSpan({ cls: 'vc-pick-up-left', text: left === 0 ? 'Last reminder' : `${left} day${left === 1 ? '' : 's'} left` });
    const later = head.createEl('button', {
      cls: `clickable-icon vc-pick-up-later${reminder ? ' is-on' : ''}`,
      attr: { 'aria-label': reminder ? 'Reminder on: click to stop reminding me' : 'Remind me later: shown first the next times you open this list' },
    });
    // Lit when on: the same clock, so that a click on it plainly turns it off.
    setIcon(later, 'alarm-clock');
    later.addEventListener('click', (evt) => {
      evt.stopPropagation();
      if (reminder) {
        this.host.forget(chat.id);
        this.reminded.delete(chat.id);
        this.replace(row, undefined);
        return;
      }
      this.host.remindLater(suggestion);
      this.reminded.add(chat.id);
      this.replace(row, group, `Reminder set: “${chat.title}” comes first the next times you open this list.`);
    });
    // Skip for now: another in its place, this one left out for a week. Not on a reminder, whose
    // clock already stops it.
    const skip = reminder ? null : head.createEl('button', { cls: 'clickable-icon vc-pick-up-later', attr: { 'aria-label': `Skip for now: another in its place; this one can come up again after ${SKIP_DAYS} days` } });
    if (skip) setIcon(skip, 'refresh-cw');
    skip?.addEventListener('click', (evt) => {
      evt.stopPropagation();
      this.host.skip(chat.id);
      this.reminded.delete(chat.id);
      this.replace(row, group);
    });
    // Never: not suggested again, any reminder of it gone.
    const away = head.createEl('button', { cls: 'clickable-icon vc-pick-up-later', attr: { 'aria-label': 'Never suggest this chat (the command “show ignored chats again” undoes it)' } });
    // Hidden, not deleted: the chat stays in the history.
    setIcon(away, 'eye-off');
    away.addEventListener('click', (evt) => {
      evt.stopPropagation();
      this.host.hide(chat.id);
      this.drawFoot();
      this.reminded.delete(chat.id);
      this.replace(row, group);
    });
    // Where the chat worked: the folder of the first note it touched, if any.
    const first = this.host.details(chat.id).notes[0];
    if (first) summary.createDiv({ cls: 'vc-pick-up-path', text: folderText(first.folder) });
    // A reminder compact: its title and folder; its why is in its details.
    if (!reminder) summary.createDiv({ cls: 'vc-pick-up-why', text: suggestion.why });
    const body = row.createDiv({ cls: 'vc-pick-up-body' });
    body.hide();
    const toggle = () => {
      // A row on its way out opens nothing.
      if (row.hasClass('is-leaving') || row.hasClass('is-said')) return;
      // Its details beside the list; where the window is too narrow for two panes, under the row instead.
      if (!this.narrow()) {
        if (this.detailRow === row) this.closeDetail();
        else this.showDetail(row, chat, suggestion, now);
        return;
      }
      const opening = !body.isShown();
      for (const other of Array.from(this.contentEl.querySelectorAll<HTMLElement>('.vc-pick-up-card.is-open'))) {
        if (other === row) continue;
        other.removeClass('is-open');
        other.querySelector<HTMLElement>('.vc-pick-up-body')?.hide();
        other.querySelector('.vc-pick-up-summary')?.setAttr('aria-expanded', 'false');
      }
      if (opening && body.childElementCount === 0) this.drawBody(body, chat, suggestion, row);
      body.toggle(opening);
      row.toggleClass('is-open', opening);
      summary.setAttr('aria-expanded', String(opening));
    };
    summary.addEventListener('click', toggle);
    summary.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      evt.preventDefault();
      toggle();
    });
  }

  /** The component of what is drawn in `body` (a details pane, or a row opened), new each time it is drawn. */
  private drawn(body: HTMLElement): Component {
    this.drawnFor.get(body)?.unload();
    const child = this.component.addChild(new Component());
    this.drawnFor.set(body, child);
    return child;
  }

  /** Whether the window is too narrow for the list and a pane beside it (a phone, a small window). */
  private narrow(): boolean {
    return (this.contentEl.ownerDocument.defaultView?.innerWidth ?? 1200) < 900;
  }

  /** Row `row`'s details in the pane beside the list, as a note reads: the chat's title, then the rest. */
  private showDetail(row: HTMLElement, chat: Candidate, suggestion: Suggestion, now: number): void {
    this.detailRow?.removeClass('is-open');
    this.detailRow = row;
    row.addClass('is-open');
    this.modalEl.addClass('vc-pick-up-wide');
    // The window itself does not scroll in two panes (each pane does): back to its top, the status line in view.
    this.contentEl.scrollTop = 0;
    this.modalEl.scrollTop = 0;
    // The row clicked still in view in the list, which now scrolls by itself.
    row.scrollIntoView({ block: 'nearest' });
    this.detail.empty();
    this.detail.show();
    const head = this.detail.createDiv({ cls: 'vc-pick-up-detail-head' });
    head.createDiv({ cls: 'vc-pick-up-detail-title', text: chat.title });
    const close = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Close the details' } });
    setIcon(close, 'x');
    close.addEventListener('click', () => this.closeDetail());
    this.detail.createDiv({ cls: 'vc-pick-up-age', text: `Last worked on ${ago(chat.updatedAt, now)}` });
    this.detail.createDiv({ cls: 'vc-pick-up-why', text: suggestion.why });
    this.drawBody(this.detail, chat, suggestion, row);
    this.detail.scrollTop = 0;
  }

  /** The pane beside the list closed, the window narrowed back. */
  private closeDetail(): void {
    this.drawnFor.get(this.detail)?.unload();
    this.drawnFor.delete(this.detail);
    this.detailRow?.removeClass('is-open');
    this.detailRow = null;
    this.detail.hide();
    this.detail.empty();
    this.modalEl.removeClass('vc-pick-up-wide');
  }

  /** A row opened: the next step, its buttons, and what the chat is about. */
  private drawBody(body: HTMLElement, chat: Candidate, suggestion: Suggestion, row: HTMLElement): void {
    // A reminder's why, left off its compact row, opened under it (the side pane says it already).
    if (row.hasClass('is-reminder') && body !== this.detail) body.createDiv({ cls: 'vc-pick-up-why', text: suggestion.why });
    const next = body.createDiv({ cls: 'vc-pick-up-next' });
    next.createSpan({ cls: 'vc-pick-up-label', text: 'Next: ' });
    next.appendText(suggestion.next);
    const buttons = body.createDiv({ cls: 'vc-pick-up-buttons' });
    // Picked up: no more reminding of it.
    const go = (step: string | null) => {
      this.host.forget(chat.id);
      this.close();
      void this.host.open(chat.id, step);
    };
    buttons.createEl('button', { cls: 'mod-cta', text: 'Use suggested step' }).addEventListener('click', () => go(suggestion.next));
    buttons.createEl('button', { text: 'Open chat' }).addEventListener('click', () => go(null));
    // Reminding, skipping and hiding are the row's icons.

    const details = this.host.details(chat.id);
    const section = (title: string) => {
      const el = body.createDiv({ cls: 'vc-pick-up-section' });
      el.createDiv({ cls: 'vc-pick-up-label', text: title });
      return el;
    };
    const link = (parent: HTMLElement, text: string, path: string) => {
      const el = parent.createSpan({ cls: 'vc-pick-up-link', text });
      if (this.host.openNote) {
        el.addClass('vc-welcome-link');
        el.setAttr('aria-label', 'Open the note (⌘ while over it: a preview)');
        el.addEventListener('click', () => {
          this.close();
          this.host.openNote?.(path);
        });
        el.addEventListener('mouseover', (event) => this.host.previewNote?.(path, event, el, this));
        // ⌘ pressed while over it: its preview too.
        el.addEventListener('mouseenter', () => (this.over = { path, el }));
        el.addEventListener('mouseleave', () => (this.over = null));
      }
    };
    // Tags as small pills, on a line of their own.
    const tags = (parent: HTMLElement, list: string[], first?: string) => {
      if (list.length === 0 && !first) return;
      const row = parent.createDiv({ cls: 'vc-pick-up-tags' });
      if (first) row.createSpan({ cls: 'vc-pick-up-tag is-status', text: first });
      for (const tag of list) row.createSpan({ cls: 'vc-pick-up-tag', text: `#${tag}` });
    };
    if (details.notes.length > 0) {
      const notes = section('Notes it touched');
      for (const note of details.notes) {
        const item = notes.createDiv({ cls: 'vc-pick-up-item' });
        const name = item.createDiv();
        link(name, note.name, note.path);
        name.createSpan({ cls: 'vc-pick-up-meta', text: ` · ${note.how}` });
        item.createDiv({ cls: 'vc-pick-up-path', text: folderText(note.folder) });
        tags(item, note.tags);
      }
    }
    if (details.memos.length > 0) {
      const memos = section('Memos from it');
      for (const memo of details.memos) {
        const item = memos.createDiv({ cls: 'vc-pick-up-item' });
        link(item.createDiv(), memo.name, memo.path);
        const folder = memo.path.includes('/') ? memo.path.slice(0, memo.path.lastIndexOf('/') + 1) : '';
        item.createDiv({ cls: 'vc-pick-up-path', text: folder || 'Vault root' });
        tags(item, memo.tags, memo.status || undefined);
      }
    }
    // A reminder's chat was not looked at again: no clues or exchanges to show.
    if (chat.clues.length > 0) {
      const clues = section('What made it a candidate');
      for (const clue of chat.clues) clues.createDiv({ cls: 'vc-pick-up-item', text: clue });
    }
    if (chat.exchanges.length > 0) {
      const exchanges = section('Its last exchanges, as Claude saw them');
      for (const exchange of chat.exchanges) {
        const item = exchanges.createDiv({ cls: `vc-pick-up-item vc-pick-up-exchange is-${exchange.who === 'You' ? 'you' : 'claude'}` });
        item.createDiv({ cls: 'vc-pick-up-who', text: exchange.who });
        this.host.renderMarkdown(exchange.text, item.createDiv({ cls: 'vc-pick-up-said' }), this.drawn(body), () => this.close(), this);
      }
    }
  }

  onClose(): void {
    this.component.unload();
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.loading?.abort();
    this.contentEl.empty();
  }
}
