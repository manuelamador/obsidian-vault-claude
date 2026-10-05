// A long chat opened from the history draws only its last turns. The turns before them are cut
// here (historyParts) and kept, not drawn (EarlierDrawing), until they are needed: scrolling up to
// them, Show all, find stepping back into them, or the list of your messages going to one. Until
// then they are searched and listed from here. Kept free of `obsidian` imports.
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { bubbleOf, messageSearchText, shownText, startsTurn, type ContentBlock } from './chatText';
import { oneLine } from './toolSummary';

/**
 * Where a transcript can be cut: the indices of your prompts (see startsTurn) at which no tool call
 * is waiting for its result, so that a call and its result never fall in different parts. A call
 * that never got a result (an interrupted one) does not hold back the cuts after it.
 */
export function turnStarts(transcript: SessionMessage[]): number[] {
  const blocksOf = (message: SessionMessage): ContentBlock[] => {
    const content = (message.message as { content?: unknown } | null)?.content;
    return Array.isArray(content) ? (content as ContentBlock[]) : [];
  };
  const answered = new Set<string>();
  for (const message of transcript) {
    for (const block of blocksOf(message)) if (block.type === 'tool_result' && block.tool_use_id) answered.add(block.tool_use_id);
  }
  const waiting = new Set<string>();
  const starts: number[] = [];
  transcript.forEach((message, i) => {
    if (message.parent_tool_use_id !== null) return;
    if (waiting.size === 0 && startsTurn(message)) starts.push(i);
    for (const block of blocksOf(message)) {
      if (block.type === 'tool_use' && block.id && answered.has(block.id)) waiting.add(block.id);
      else if (block.type === 'tool_result' && block.tool_use_id) waiting.delete(block.tool_use_id);
    }
  });
  return starts;
}

/**
 * A transcript cut for drawing: `tail`, its last `tailTurns` turns, drawn at once, and `earlier`,
 * the turns before them, newest first.
 */
export function historyParts(transcript: SessionMessage[], tailTurns: number): { tail: SessionMessage[]; earlier: SessionMessage[][] } {
  const starts = turnStarts(transcript);
  const cut = starts.length > tailTurns ? starts[starts.length - tailTurns] : 0;
  if (cut === 0) return { tail: transcript, earlier: [] };
  // The first turn runs from the top: anything before your first prompt goes with it.
  const bounds = [0, ...starts.slice(1).filter((i) => i < cut), cut];
  const earlier = bounds.slice(0, -1).map((from, k) => transcript.slice(from, bounds[k + 1]));
  return { tail: transcript.slice(cut), earlier: earlier.reverse() };
}

/** A message on one line, at most `max` characters: its text, or the names of its attachments when it has none. */
export function promptSummary(text: string, chips: { label: string }[], max: number): string {
  const line = oneLine(text, max);
  if (line) return line;
  return chips.length > 0 ? chips.map((chip) => chip.label).join(', ') : 'Attachment';
}

/** A message of yours in the part of a long chat not drawn yet: its line in the list of your messages, and a way to draw the chat back to it. */
export interface ListedEarlier {
  summary: string;
  /** Draws the chat back to the message and gives its bubble; null when the chat changed meanwhile. */
  show(): Promise<HTMLElement | null>;
}

/** The part of a long chat above the drawn messages that is not drawn yet, as find sees it. */
export interface FindEarlier {
  /** Matches of `needle` (lower case) not drawn yet. */
  count(needle: string): number;
  /** Draws the chat back to the newest earlier turn with a match; false when none has one or the chat changed. */
  drawTo(needle: string): Promise<boolean>;
}

/** What an EarlierDrawing needs from the panel. */
interface EarlierHost {
  /** The element that scrolls the chat. */
  scroller: HTMLElement;
  /** Draws one turn into `holder`, which sits where the turn goes; a message it cannot draw it leaves out. */
  drawTurn(turn: SessionMessage[], holder: HTMLElement): void;
  /** Whether a dialog or menu is open over the window: nothing is drawn meanwhile, or it would follow the pointer with a lag. */
  held(): boolean;
  /** The drawing caught up with what was asked; `done` when every turn is drawn and the line is gone. */
  caughtUp(done: boolean): void;
  /** In place of the idle-time wait (see slot), for tests: resolves to the milliseconds to draw for. */
  slot?(wanted: () => boolean): Promise<number>;
}

/** Turns are drawn in the idle time between frames, for at most this long at a time (a turn is never split)… */
const SLICE_MS = 25;
/** …or, where idle time cannot be asked for, with this pause before each stretch. */
const PAUSE_MS = 10;
/** How often to look again while a dialog or menu holds the drawing back. */
const HELD_MS = 200;

/** A message of yours in a turn not drawn yet: `nth` of its turn's bubbles. */
interface EarlierPrompt {
  turn: SessionMessage[];
  nth: number;
  summary: string;
}

/**
 * A long chat's earlier turns, kept undrawn and drawn on demand above the drawn ones, newest first:
 * the line that says how many are above (with Show all), the requests to draw more, the turns' text
 * for find and your messages in them for the list, and each drawn turn's bubbles for the list to go
 * to. Turns are drawn in the time the window has to spare, and what you are looking at stays put:
 * the distance to the bottom is kept.
 */
export class EarlierDrawing implements FindEarlier {
  /** The line above the drawn turns: how many are above, and Show all. */
  private readonly line: HTMLElement;
  private readonly countEl: HTMLElement;
  /** The turns not drawn yet, newest first. */
  private readonly turns: SessionMessage[][];
  /** Each turn's searchable text in lower case, aligned with `turns`; built on the first search. */
  private texts: string[] | null = null;
  /** Your messages in the turns not drawn, oldest first (see listed); built when first asked for. */
  private prompts: EarlierPrompt[] | null = null;
  private readonly bubbles = new WeakMap<SessionMessage[], HTMLElement[]>();
  /** Turns drawn so far, and how many to have drawn when the drawing under way stops. */
  private drawn = 0;
  private target = 0;
  /** Requests waiting for `drawn` to reach their own target (see draw). */
  private waiters: { target: number; resolve: () => void }[] = [];
  private running = false;
  /** Another chat is on screen: nothing more is drawn, and requests are answered false. */
  private stopped = false;

  /**
   * `turns`: newest first, as historyParts gives them. The line is added to the end of `parent`,
   * so it goes in before the chat's last turns are drawn after it.
   */
  constructor(
    turns: SessionMessage[][],
    parent: HTMLElement,
    private readonly host: EarlierHost,
  ) {
    this.turns = [...turns];
    const doc = parent.ownerDocument;
    const line = parent.appendChild(doc.createElement('div'));
    line.className = 'vc-muted vc-earlier';
    // A line about the chat, not in it: find leaves it out.
    line.setAttribute('data-no-find', '');
    this.line = line;
    this.countEl = line.appendChild(doc.createElement('span'));
    // Built once and only its count updated, so the button keeps keyboard focus as turns are drawn.
    const all = line.appendChild(doc.createElement('span'));
    all.className = 'vc-earlier-link';
    all.textContent = 'Show all';
    all.setAttribute('role', 'button');
    all.tabIndex = 0;
    const showAll = () => void this.draw(this.turns.length);
    all.addEventListener('click', showAll);
    all.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      evt.preventDefault();
      showAll();
    });
    this.updateCount();
  }

  /** No drawing under way. */
  get idle(): boolean {
    return this.drawn >= this.target;
  }

  /** Stops for good, as another chat is on screen; requests waiting are answered false. */
  stop(): void {
    this.stopped = true;
    this.target = this.drawn;
    this.answer(true);
  }

  /**
   * Draws `count` more turns. Resolves as soon as those are in, to whether this chat is still on
   * screen. A request while a drawing is under way extends it, and is answered when its own turns
   * are in, not when the drawing ends.
   */
  async draw(count: number): Promise<boolean> {
    if (count <= 0) return !this.stopped;
    // Nothing can be drawn: saying otherwise would send find round again for a match that never comes.
    if (!this.wanted()) return false;
    const target = this.drawn + Math.min(count, this.turns.length);
    this.target = Math.max(this.target, target);
    const reached = new Promise<void>((resolve) => this.waiters.push({ target, resolve }));
    if (!this.running) void this.run();
    await reached;
    return !this.stopped;
  }

  /** Occurrences of `needle` (lower case) in the prompts and replies not drawn yet, for find. */
  count(needle: string): number {
    if (!needle) return 0;
    let count = 0;
    for (const text of this.searchTexts()) {
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1;
    }
    return count;
  }

  /** Draws back to the newest turn containing `needle` (lower case), for find; false when none does or the chat changed. */
  async drawTo(needle: string): Promise<boolean> {
    const count = needle ? this.searchTexts().findIndex((text) => text.includes(needle)) + 1 : 0;
    return count > 0 && (await this.draw(count));
  }

  /** Draws back to the turn holding the message `uuid` (a link to a passage); false when none does or the chat changed. */
  async drawToMessage(uuid: string): Promise<boolean> {
    const count = this.turns.findIndex((turn) => turn.some((message) => message.uuid === uuid)) + 1;
    return count > 0 && (await this.draw(count));
  }

  /** Your messages in the turns not drawn, oldest first, for the list of your messages: going to one draws back to it. */
  listed(): ListedEarlier[] {
    this.prompts ??= [...this.turns].reverse().flatMap((turn) => {
      const bubbles = turn.map((message) => bubbleOf(message)).filter((bubble) => bubble !== null);
      return bubbles.map((bubble, nth) => ({ turn, nth, summary: promptSummary(bubble.text, bubble.chips, 240) }));
    });
    return this.prompts.map((prompt) => ({
      summary: prompt.summary,
      show: async () => ((await this.draw(this.turns.indexOf(prompt.turn) + 1)) ? (this.bubbles.get(prompt.turn)?.[prompt.nth] ?? null) : null),
    }));
  }

  private wanted(): boolean {
    return !this.stopped && this.line.isConnected;
  }

  private searchTexts(): string[] {
    // A reply as it reads drawn (see shownText): find searches what is drawn, and counts no match it cannot show.
    const text = (message: (typeof this.turns)[number][number]) => (message.type === 'assistant' ? shownText(messageSearchText(message)) : messageSearchText(message));
    this.texts ??= this.turns.map((turn) => turn.map(text).filter(Boolean).join('\n').toLowerCase());
    return this.texts;
  }

  private updateCount(): void {
    const count = this.turns.length;
    this.countEl.textContent = `Scroll up for ${count} earlier ${count === 1 ? 'exchange' : 'exchanges'} · `;
  }

  /** Answers the requests whose turns are in; `all` answers the rest too (the drawing stopped). */
  private answer(all = false): void {
    const waiting = this.waiters;
    this.waiters = all ? [] : waiting.filter((waiter) => waiter.target > this.drawn);
    for (const waiter of waiting) if (!this.waiters.includes(waiter)) waiter.resolve();
  }

  /**
   * Waits for time to draw in and says how long it is: the idle time before the next frame, up to
   * SLICE_MS (at least one turn is drawn whatever it says); nothing while the host is held by a
   * dialog; `wanted` ends the wait when the drawing is dropped.
   */
  private async slot(wanted: () => boolean): Promise<number> {
    if (this.host.slot) return this.host.slot(wanted);
    const win = this.line.ownerDocument.defaultView;
    for (;;) {
      const idle = await new Promise<number>((resolve) => {
        // A window with no idle time for a second (a busy or hidden one) gets a full stretch.
        if (typeof win?.requestIdleCallback === 'function') win.requestIdleCallback((deadline) => resolve(deadline.didTimeout ? SLICE_MS : deadline.timeRemaining()), { timeout: 1000 });
        else setTimeout(() => resolve(SLICE_MS), PAUSE_MS);
      });
      if (!wanted() || !this.host.held()) return Math.min(SLICE_MS, idle);
      await new Promise((resolve) => setTimeout(resolve, HELD_MS));
    }
  }

  /**
   * Draws turns until `target` is met, a stretch at a time. After catching up, the count follows
   * and the host is told, which may ask for more (a view still at the top): the same drawing goes on.
   */
  private async run(): Promise<void> {
    const wanted = () => this.wanted();
    this.running = true;
    try {
      while (this.drawn < this.target && wanted()) {
        const budget = await this.slot(wanted);
        if (!wanted()) break;
        const scroller = this.host.scroller;
        const fromBottom = scroller.scrollHeight - scroller.scrollTop;
        const sliceStart = performance.now();
        do {
          const turn = this.takeTurn();
          if (!turn) break;
          this.drawn += 1;
          this.drawTurn(turn);
        } while (this.drawn < this.target && this.turns.length > 0 && performance.now() - sliceStart < budget);
        scroller.scrollTop = scroller.scrollHeight - fromBottom;
        if (this.turns.length === 0) this.target = this.drawn;
        this.answer();
        if (this.drawn < this.target) continue;
        const done = this.turns.length === 0;
        if (done) this.line.remove();
        else this.updateCount();
        this.host.caughtUp(done);
      }
    } finally {
      this.running = false;
      // Stopped, the chat's messages cleared, or a failure: nothing more is drawn.
      if (this.drawn < this.target) {
        this.target = this.drawn;
        if (!this.line.isConnected) this.stopped = true;
      }
      this.answer(true);
    }
  }

  /** Takes the newest turn not drawn yet, out of the search text and the list too. */
  private takeTurn(): SessionMessage[] | undefined {
    this.texts?.shift();
    const turn = this.turns.shift();
    // Its messages are the last of the list, which is oldest first.
    if (turn) while (this.prompts?.at(-1)?.turn === turn) this.prompts.pop();
    return turn;
  }

  /** One turn, above the drawn ones. */
  private drawTurn(turn: SessionMessage[]): void {
    const holder = this.line.ownerDocument.createElement('div');
    this.line.after(holder);
    this.host.drawTurn(turn, holder);
    this.bubbles.set(turn, [...holder.querySelectorAll<HTMLElement>('.vc-user')]);
    holder.replaceWith(...Array.from(holder.childNodes));
  }
}
