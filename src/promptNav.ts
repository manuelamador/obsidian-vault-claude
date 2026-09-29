import { Platform, setIcon } from 'obsidian';
import { promptSummary, type ListedEarlier } from './earlierTurns';

/** Space left above a message scrolled to, clear of the bar over the top edge. */
const JUMP_MARGIN = 40;
/** The message being read is the last one whose top is above this line, measured from the top edge. */
const ANCHOR = JUMP_MARGIN + 8;
/** Steps this close together go on from the last one's target, not from a scroll still under way. */
const REPEAT_MS = 700;

const KEY = Platform.isMacOS ? '⌥' : 'Alt+';

/**
 * Moving between the messages you sent in a long chat:
 * - a bar over the top of the messages showing the message being answered, once it has scrolled
 *   out of view; a click goes back to it, its arrows go to the previous and next message, and its
 *   list button opens a card listing every message;
 * - `step`, for the panel's ⌥↑ / ⌥↓ keys and the commands, and `openList`, for the list command.
 */
export class PromptNav {
  private readonly bar: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly listButton: HTMLElement;
  private readonly list: HTMLElement;
  private items: { el: HTMLElement; bubble?: HTMLElement; show?: () => Promise<HTMLElement | null> }[] = [];
  private selected = -1;
  private shown: HTMLElement | null = null;
  private hovering = false;
  private target: { index: number; at: number } | null = null;
  private frame = 0;

  /** `earlier`: your messages not drawn yet in a long chat, oldest first; listed before the drawn ones. */
  constructor(
    parent: HTMLElement,
    private readonly scroller: HTMLElement,
    private readonly earlier: () => ListedEarlier[] = () => [],
  ) {
    this.bar = parent.createDiv({ cls: 'vc-question-bar' });
    this.bar.hide();
    const back = this.bar.createDiv({ cls: 'vc-question-bar-main', attr: { role: 'button', tabindex: '0', 'aria-label': 'Scroll to this message' } });
    setIcon(back.createSpan({ cls: 'vc-question-bar-icon' }), 'corner-left-up');
    this.textEl = back.createSpan({ cls: 'vc-question-bar-text' });
    back.addEventListener('click', () => this.shown && this.jumpTo(this.shown));
    back.addEventListener('keydown', (evt) => {
      if ((evt.key === 'Enter' || evt.key === ' ') && this.shown) {
        evt.preventDefault();
        this.jumpTo(this.shown);
      }
    });
    const button = (icon: string, label: string, onClick: () => void) => {
      const el = this.bar.createEl('button', { cls: 'clickable-icon vc-question-bar-step', attr: { 'aria-label': label } });
      setIcon(el, icon);
      el.addEventListener('click', onClick);
      return el;
    };
    this.listButton = button('list', 'All your messages', () => (this.list.isShown() ? this.closeList() : this.openList()));
    button('chevron-up', `Previous message (${KEY}↑)`, () => this.step(-1));
    button('chevron-down', `Next message (${KEY}↓)`, () => this.step(1));
    // The bar stays while the pointer is on it, so its arrows can be pressed again after a jump.
    this.bar.addEventListener('mouseenter', () => (this.hovering = true));
    this.bar.addEventListener('mouseleave', () => {
      this.hovering = false;
      this.schedule();
    });

    this.list = parent.createDiv({ cls: 'vc-message-list', attr: { role: 'listbox', tabindex: '-1', 'aria-label': 'Your messages' } });
    this.list.hide();
    this.list.addEventListener('keydown', (evt) => this.onListKey(evt));
  }

  /** Updates on the next frame, so a burst of scroll events costs one pass. */
  schedule(): void {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  destroy(): void {
    this.closeList();
    if (this.frame) window.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  update(): void {
    const bubbles = this.bubbles();
    const top = this.scroller.getBoundingClientRect().top;
    const current = bubbles[this.currentIndex(bubbles, top)];
    // Hidden while any of the message itself is still in view, unless the pointer is on the bar or
    // its list is open.
    if (current && (this.hovering || this.list.isShown() || current.getBoundingClientRect().bottom <= top)) {
      if (current !== this.shown) {
        this.shown = current;
        this.textEl.setText(bubbleSummary(current, 300));
      }
      this.bar.show();
    } else {
      this.shown = null;
      this.hovering = false;
      this.bar.hide();
    }
  }

  /**
   * Goes to the previous (-1) or next (1) message you sent. Partway through a reply, the previous
   * one is its own message; past the last message is the end of the chat, before the first the top.
   */
  step(delta: -1 | 1): void {
    const bubbles = this.bubbles();
    let index: number;
    if (this.target && Date.now() - this.target.at < REPEAT_MS) {
      index = this.target.index + delta;
    } else {
      const top = this.scroller.getBoundingClientRect().top;
      const at = this.currentIndex(bubbles, top);
      const pastStart = at >= 0 && bubbles[at].getBoundingClientRect().top < top;
      index = delta < 0 ? (pastStart ? at : at - 1) : at + 1;
    }
    index = Math.max(-1, Math.min(bubbles.length, index));
    this.target = { index, at: Date.now() };
    if (index < 0) this.scrollTo(0);
    else if (index >= bubbles.length) this.scrollTo(this.scroller.scrollHeight);
    else this.jumpTo(bubbles[index]);
  }

  /**
   * The card listing every message you sent, the one being read marked; ↑/↓ and Enter, or a click,
   * go to one. In a long chat the messages not drawn yet come first; going to one draws the chat back to it.
   */
  openList(): void {
    const bubbles = this.bubbles();
    const earlier = this.earlier();
    if (bubbles.length + earlier.length === 0) return;
    const at = earlier.length + this.currentIndex(bubbles, this.scroller.getBoundingClientRect().top);
    this.list.empty();
    const entries = [
      ...earlier.map((entry) => ({ summary: entry.summary, show: entry.show })),
      ...bubbles.map((bubble) => ({ summary: bubbleSummary(bubble, 240), bubble })),
    ];
    this.items = entries.map((entry, i) => {
      const el = this.list.createDiv({ cls: 'vc-message-list-item', attr: { role: 'option' } });
      el.createSpan({ cls: 'vc-message-list-number', text: String(i + 1) });
      el.createSpan({ cls: 'vc-message-list-text', text: entry.summary });
      el.toggleClass('is-current', i === at);
      el.addEventListener('mousemove', () => this.select(i, false));
      el.addEventListener('click', () => this.choose(i));
      return { el, bubble: 'bubble' in entry ? entry.bubble : undefined, show: 'show' in entry ? entry.show : undefined };
    });
    this.list.style.top = `${this.bar.isShown() ? this.bar.offsetHeight + 4 : 8}px`;
    this.list.show();
    this.select(Math.max(0, at), true);
    this.list.focus();
    this.list.ownerDocument.addEventListener('mousedown', this.onOutside, true);
  }

  closeList(): void {
    if (!this.list.isShown()) return;
    this.list.hide();
    this.list.empty();
    this.items = [];
    this.list.ownerDocument.removeEventListener('mousedown', this.onOutside, true);
    this.schedule();
  }

  /** The text in the bar, for tests; empty while hidden. */
  shownText(): string {
    return this.bar.isShown() ? (this.textEl.textContent ?? '') : '';
  }

  private readonly onOutside = (evt: MouseEvent): void => {
    const target = evt.target as Node;
    if (!this.list.contains(target) && !this.listButton.contains(target)) this.closeList();
  };

  private onListKey(evt: KeyboardEvent): void {
    const last = this.items.length - 1;
    const moves: Record<string, number> = { ArrowUp: this.selected - 1, ArrowDown: this.selected + 1, Home: 0, End: last };
    if (evt.key in moves) this.select(Math.max(0, Math.min(last, moves[evt.key])), true);
    else if (evt.key === 'Enter') this.choose(this.selected);
    // Marked as used, so the panel's Esc-stops-Claude handler leaves it alone.
    else if (evt.key === 'Escape') this.closeList();
    else return;
    evt.preventDefault();
    evt.stopPropagation();
  }

  private select(index: number, reveal: boolean): void {
    this.items[this.selected]?.el.removeClass('is-selected');
    this.selected = index;
    const item = this.items[index]?.el;
    item?.addClass('is-selected');
    if (reveal) item?.scrollIntoView?.({ block: 'nearest' });
  }

  private choose(index: number): void {
    const item = this.items[index];
    this.closeList();
    if (item?.bubble) this.jumpTo(item.bubble);
    else void item?.show?.().then((bubble) => bubble && this.jumpTo(bubble));
  }

  private bubbles(): HTMLElement[] {
    return [...this.scroller.querySelectorAll<HTMLElement>('.vc-user')];
  }

  private currentIndex(bubbles: HTMLElement[], top: number): number {
    let at = -1;
    for (let i = 0; i < bubbles.length; i++) {
      if (bubbles[i].getBoundingClientRect().top >= top + ANCHOR) break;
      at = i;
    }
    return at;
  }

  private jumpTo(bubble: HTMLElement): void {
    const offset = bubble.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - JUMP_MARGIN;
    this.scrollTo(this.scroller.scrollTop + offset);
  }

  private scrollTo(top: number): void {
    if (typeof this.scroller.scrollTo === 'function') this.scroller.scrollTo({ top, behavior: 'smooth' });
    else this.scroller.scrollTop = top;
  }
}

/** A drawn message on one line (see promptSummary). */
function bubbleSummary(bubble: HTMLElement, max: number): string {
  const chips = [...bubble.querySelectorAll('.vc-user-attachments > *')].map((el) => ({ label: el.textContent?.trim() ?? '' })).filter((chip) => chip.label);
  return promptSummary(bubble.querySelector('.vc-user-text')?.textContent ?? '', chips, max);
}
