// Tabs on the right margin of the panel, one for each chat that finished out of sight (in the panel's
// background): the newest at the top. A new tab shows itself open for a moment, then closes to its
// edge. A tab opens its chat; hovered, it widens to the left to show the chat's name and what
// happened, with × to take the tab away. A chat shown again loses its tab.
import { setIcon } from 'obsidian';

/** A finish out of sight: the chat, its name, how it ended, and the start of its last reply. */
export interface DoneTab {
  id: string;
  title: string;
  outcome: 'done' | 'error';
  text: string;
}

/** The most tabs kept: past it the oldest goes (the history still marks its chat as having a new reply). */
const MAX_TABS = 20;
/** How much of the last reply a tab shows. */
const TAB_TEXT_CHARS = 140;
/** The most tabs shown, each its own; past it, or past the room the panel has, the rest are behind a "+N" tab. */
const MAX_SHOWN = 5;
/** A tab's height and the gap under it, and the panel's height the tabs keep clear of (see .vc-done-tabs). */
const TAB_PITCH = 38;
const TABS_MARGIN = 80;
/** How long a new tab stays open before it closes to its edge. */
const SHOWN_MS = 3000;

export class DoneTabs {
  private readonly el: HTMLElement;
  private tabs: DoneTab[] = [];
  /** The tab just added, shown open until SHOWN_MS have passed. */
  private fresh: string | null = null;
  private freshTimer = 0;

  constructor(parent: HTMLElement, private readonly open: (tab: DoneTab) => void) {
    this.el = parent.createDiv({ cls: 'vc-done-tabs' });
    this.draw();
  }

  /** A chat finished out of sight: its tab, at the top; one it had already is replaced. */
  add(tab: DoneTab): void {
    this.tabs = [tab, ...this.tabs.filter((each) => each.id !== tab.id)].slice(0, MAX_TABS);
    this.fresh = tab.id;
    window.clearTimeout(this.freshTimer);
    this.freshTimer = window.setTimeout(() => {
      this.fresh = null;
      this.el.querySelector('.vc-done-tab.is-fresh')?.removeClass('is-fresh');
    }, SHOWN_MS);
    this.draw();
  }

  /** Chat `id` is seen: its tab goes. */
  remove(id: string): void {
    if (!this.tabs.some((each) => each.id === id)) return;
    this.tabs = this.tabs.filter((each) => each.id !== id);
    this.draw();
  }

  /** Chat `id` renamed: its tab says so. */
  rename(id: string, title: string): void {
    const tab = this.tabs.find((each) => each.id === id);
    if (!tab) return;
    tab.title = title;
    this.draw();
  }

  private draw(): void {
    this.el.empty();
    this.el.toggle(this.tabs.length > 0);
    // As many as the panel has room for, at most MAX_SHOWN; the rest behind one "+N" tab.
    const room = this.el.parentElement?.clientHeight ? Math.floor((this.el.parentElement.clientHeight - TABS_MARGIN) / TAB_PITCH) : MAX_SHOWN;
    const shown = this.tabs.length <= Math.min(MAX_SHOWN, room) ? this.tabs.length : Math.max(1, Math.min(MAX_SHOWN, room) - 1);
    for (const tab of this.tabs.slice(0, shown)) {
      const el = this.el.createDiv({ cls: `vc-done-tab is-${tab.outcome}${tab.id === this.fresh ? ' is-fresh' : ''}`, attr: { role: 'button', tabindex: '0', 'aria-label': `${whatOf(tab)} in “${tab.title}”: click to open it` } });
      el.createDiv({ cls: 'vc-done-tab-mark' });
      const body = el.createDiv({ cls: 'vc-done-tab-body' });
      body.createDiv({ cls: 'vc-done-tab-title', text: tab.title });
      body.createDiv({ cls: 'vc-done-tab-what', text: whatOf(tab) });
      const text = tab.text.replace(/\s+/g, ' ').trim();
      if (text) body.createDiv({ cls: 'vc-done-tab-text', text: text.length > TAB_TEXT_CHARS ? `${text.slice(0, TAB_TEXT_CHARS)}…` : text });
      this.closeButton(el, tab);
      this.opens(el, tab);
    }
    const rest = this.tabs.slice(shown);
    if (rest.length === 0) return;
    // Opened on hover, as a tab is: a row for each, to open or take away.
    const more = this.el.createDiv({ cls: 'vc-done-tab vc-done-more', attr: { 'aria-label': `${rest.length} more chats finished` } });
    more.createDiv({ cls: 'vc-done-tab-mark', text: `+${rest.length}` });
    const list = more.createDiv({ cls: 'vc-done-tab-body' });
    list.createDiv({ cls: 'vc-done-tab-what', text: `${rest.length} more finished` });
    for (const tab of rest) {
      const row = list.createDiv({ cls: `vc-done-more-row is-${tab.outcome}`, attr: { role: 'button', tabindex: '0', 'aria-label': `${whatOf(tab)}: click to open it` } });
      row.createDiv({ cls: 'vc-done-tab-title', text: tab.title });
      this.closeButton(row, tab);
      this.opens(row, tab);
    }
  }

  /** × on `el`: takes `tab` away. */
  private closeButton(el: HTMLElement, tab: DoneTab): void {
    const close = el.createEl('button', { cls: 'clickable-icon vc-done-tab-close', attr: { 'aria-label': 'Remove this notification' } });
    setIcon(close, 'x');
    close.addEventListener('click', (evt) => {
      evt.stopPropagation();
      this.remove(tab.id);
    });
  }

  /** A click on `el`, or Enter or Space, opens `tab`'s chat. */
  private opens(el: HTMLElement, tab: DoneTab): void {
    const go = () => {
      this.remove(tab.id);
      this.open(tab);
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        go();
      }
    });
  }
}

/** How a tab's chat ended, in words. */
function whatOf(tab: DoneTab): string {
  return tab.outcome === 'done' ? 'Claude finished' : 'Claude stopped with an error';
}
