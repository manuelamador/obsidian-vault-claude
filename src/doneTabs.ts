// Tabs on the right margin of the panel, one for each chat that finished out of sight (in the panel's
// background): the newest at the top. A tab opens its chat; hovered, it widens to the left to show the
// chat's name and what happened, with × to take the tab away. A chat shown again loses its tab.
import { setIcon } from 'obsidian';

/** A finish out of sight: the chat, its name, how it ended, and the start of its last reply. */
export interface DoneTab {
  id: string;
  title: string;
  outcome: 'done' | 'error';
  text: string;
}

/** The most tabs kept: past it the oldest goes (the history still marks its chat as having a new reply). */
const MAX_TABS = 10;
/** How much of the last reply a tab shows. */
const TAB_TEXT_CHARS = 140;

export class DoneTabs {
  private readonly el: HTMLElement;
  private tabs: DoneTab[] = [];

  constructor(parent: HTMLElement, private readonly open: (tab: DoneTab) => void) {
    this.el = parent.createDiv({ cls: 'vc-done-tabs' });
    this.draw();
  }

  /** A chat finished out of sight: its tab, at the top; one it had already is replaced. */
  add(tab: DoneTab): void {
    this.tabs = [tab, ...this.tabs.filter((each) => each.id !== tab.id)].slice(0, MAX_TABS);
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
    for (const tab of this.tabs) {
      const what = tab.outcome === 'done' ? 'Claude finished' : 'Claude stopped with an error';
      const el = this.el.createDiv({ cls: `vc-done-tab is-${tab.outcome}`, attr: { role: 'button', tabindex: '0', 'aria-label': `${what} in “${tab.title}”: click to open it` } });
      el.createDiv({ cls: 'vc-done-tab-mark' });
      const body = el.createDiv({ cls: 'vc-done-tab-body' });
      body.createDiv({ cls: 'vc-done-tab-title', text: tab.title });
      body.createDiv({ cls: 'vc-done-tab-what', text: what });
      const text = tab.text.replace(/\s+/g, ' ').trim();
      if (text) body.createDiv({ cls: 'vc-done-tab-text', text: text.length > TAB_TEXT_CHARS ? `${text.slice(0, TAB_TEXT_CHARS)}…` : text });
      const close = el.createEl('button', { cls: 'clickable-icon vc-done-tab-close', attr: { 'aria-label': 'Remove this notification' } });
      setIcon(close, 'x');
      close.addEventListener('click', (evt) => {
        evt.stopPropagation();
        this.remove(tab.id);
      });
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
}
