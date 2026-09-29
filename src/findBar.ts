import { setIcon } from 'obsidian';
import type { FindEarlier } from './earlierTurns';

/** Ranges of every case-insensitive occurrence of `query` in the shown text under `root`. */
export function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  if (!needle) return ranges;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // Collapsed tool groups and notices are hidden with display: none, and cannot be scrolled to;
    // lines about the chat rather than in it are marked data-no-find.
    if (!node.parentElement || node.parentElement.closest('[style*="display: none"], [data-no-find]')) continue;
    const text = (node.textContent ?? '').toLowerCase();
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = doc.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

type HighlightConstructor = new (...ranges: Range[]) => object;

/**
 * Find in chat: a bar above the messages. Matches are marked with the CSS Custom Highlight API,
 * which leaves the rendered messages untouched, and the current one is scrolled into view. In a
 * long chat, the matches in the turns not drawn yet are counted too, all of them before the drawn
 * ones. Stepping back past the first drawn match (Shift+Enter) draws the chat back to the next one;
 * stepping on past the last goes round the drawn ones only, so that Enter never draws the chat.
 */
export class FindBar {
  private readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private ranges: Range[] = [];
  private index = -1;
  /** Matches in the turns not drawn yet. */
  private hidden = 0;
  /** Counts closes, new queries and steps: a step still drawing the chat back gives way to any of them. */
  private generation = 0;

  constructor(
    parent: HTMLElement,
    before: HTMLElement,
    private readonly root: HTMLElement,
    private readonly earlier?: FindEarlier,
  ) {
    this.el = createDiv({ cls: 'vc-find' });
    parent.insertBefore(this.el, before);
    this.el.hide();
    this.input = this.el.createEl('input', { type: 'text', cls: 'vc-find-input', attr: { placeholder: 'Find in chat', 'aria-label': 'Find in chat' } });
    this.countEl = this.el.createSpan({ cls: 'vc-find-count' });
    const button = (icon: string, label: string, onClick: () => void) => {
      const el = this.el.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
      setIcon(el, icon);
      el.addEventListener('click', onClick);
    };
    button('chevron-up', 'Previous match (Shift+Enter)', () => void this.step(-1));
    button('chevron-down', 'Next match (Enter)', () => void this.step(1));
    button('x', 'Close (Esc)', () => this.close());
    this.input.addEventListener('input', () => {
      this.generation += 1;
      this.search(true);
    });
    this.input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && !evt.isComposing) {
        evt.preventDefault();
        void this.step(evt.shiftKey ? -1 : 1);
      } else if (evt.key === 'Escape') {
        // Marked as used, so the panel's Esc-stops-Claude handler leaves it alone.
        evt.preventDefault();
        this.close();
      }
    });
  }

  isOpen(): boolean {
    return this.el.isShown();
  }

  open(): void {
    this.el.show();
    this.input.focus();
    this.input.select();
    if (this.input.value) this.search(false);
  }

  close(): void {
    this.generation += 1;
    this.el.hide();
    this.ranges = [];
    this.index = -1;
    this.hidden = 0;
    this.paint();
  }

  /** The number of matches, the 1-based position of the current one, and how many are not drawn yet, for tests. */
  state(): { count: number; current: number; hidden: number } {
    return { count: this.hidden + this.ranges.length, current: this.index < 0 ? 0 : this.hidden + this.index + 1, hidden: this.hidden };
  }

  /** Brings the count up to date after more of the chat was drawn, staying on the current match. */
  refresh(): void {
    if (!this.isOpen() || !this.input.value) return;
    const current = this.ranges[this.index];
    this.measure();
    const at = current ? this.ranges.findIndex((range) => range.startContainer === current.startContainer && range.startOffset === current.startOffset) : -1;
    this.index = at >= 0 ? at : this.ranges.length > 0 ? Math.max(0, Math.min(this.index, this.ranges.length - 1)) : -1;
    this.paint();
  }

  private measure(): void {
    this.ranges = findRanges(this.root, this.input.value);
    this.hidden = this.earlier?.count(this.input.value.toLowerCase()) ?? 0;
  }

  /**
   * Recomputes the matches (the chat may have grown); `restart` goes back to the first drawn one,
   * as does a current match that is gone or was never set. `reveal`: scroll to it, unless a step
   * is about to move on.
   */
  private search(restart: boolean, reveal = true): void {
    this.measure();
    if (restart || this.index < 0 || this.index >= this.ranges.length) this.index = this.ranges.length > 0 ? 0 : -1;
    this.paint();
    if (reveal) this.reveal();
  }

  /**
   * The previous or next match. Back from the first drawn match, or on from nothing drawn, goes
   * into the turns not drawn yet, which are drawn as far as the next match; otherwise the drawn
   * matches go round. With no current match yet, the first step lands on the first or last one.
   */
  private async step(delta: number): Promise<void> {
    this.generation += 1;
    const unset = this.index < 0;
    this.search(false, false);
    if (this.hidden > 0 && (this.ranges.length === 0 || (delta < 0 && this.index <= 0))) {
      if (await this.bringEarlier()) return;
    }
    if (this.ranges.length === 0) return;
    this.index = unset ? (delta > 0 ? 0 : this.ranges.length - 1) : (this.index + delta + this.ranges.length) % this.ranges.length;
    this.paint();
    this.reveal();
  }

  /** Draws the chat back to the newest match not drawn yet and makes it the current one. */
  private async bringEarlier(): Promise<boolean> {
    const needle = this.input.value.toLowerCase();
    const generation = this.generation;
    this.countEl.setText('…');
    while (this.earlier && this.hidden > 0) {
      const before = this.ranges.length;
      const drawn = await this.earlier.drawTo(needle);
      // Closed, a new query, or another step while the chat was drawn: that one has the bar now.
      if (generation !== this.generation || !this.isOpen()) return true;
      if (!drawn) break;
      this.measure();
      const added = this.ranges.length - before;
      if (added > 0) {
        // The drawn turns went in above the drawn matches, so their matches come first; the newest is the last of them.
        this.index = added - 1;
        this.paint();
        this.reveal();
        return true;
      }
    }
    this.paint();
    return false;
  }

  private paint(): void {
    const total = this.hidden + this.ranges.length;
    const at = this.index < 0 ? '–' : String(this.hidden + this.index + 1);
    this.countEl.setText(this.input.value ? (total > 0 ? `${at}/${total}` : 'No matches') : '');
    // One set of highlight names for the whole app: the find bar last used wins.
    const registry = (globalThis as { CSS?: { highlights?: Map<string, object> } }).CSS?.highlights;
    const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
    if (!registry || !Highlight) return;
    registry.delete('vc-find');
    registry.delete('vc-find-current');
    const current = this.ranges[this.index];
    if (!current) return;
    registry.set('vc-find', new Highlight(...this.ranges));
    registry.set('vc-find-current', new Highlight(current));
  }

  private reveal(): void {
    const range = this.ranges[this.index];
    const el = range?.startContainer.parentElement;
    if (!range || !el) return;
    // A match inside folded text (a long message): unfolded through its own control first.
    (el.closest('.is-collapsed')?.querySelector('[data-expand]') as HTMLElement | null)?.click();
    // Centred on the match itself, not on its element: a long message is one element holding many matches.
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
    if (rect && rect.height > 0) {
      const box = this.root.getBoundingClientRect();
      this.root.scrollTop += rect.top - box.top - (box.height - rect.height) / 2;
    } else {
      el.scrollIntoView?.({ block: 'center' });
    }
  }
}
