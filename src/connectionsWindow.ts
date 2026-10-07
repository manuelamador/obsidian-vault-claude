// The Connections window: one dialog, three tabs. Chat: the chat's map, its project bar and search,
// and its links. Project: what its project sends with it, and the project's map. All projects: every
// project, to manage. Each tab is drawn from panes (see Pane) when shown; a pane's actions may switch
// tabs, and closing it closes the window.
import { Modal, setIcon, type App } from 'obsidian';

export type ConnectionsTab = 'chat' | 'project' | 'all';

/**
 * Part of a tab: drawn into the element the window gives it (`contentEl`), as a dialog would be, by
 * its onOpen; `close` closes the window. Its own dialogs (pickers, confirmations) open above it.
 */
export abstract class Pane {
  contentEl!: HTMLElement;
  modalEl!: HTMLElement;
  private window: Modal | null = null;

  constructor(readonly app: App) {}

  /** Draws the pane into `el`, part of `window`. */
  mount(el: HTMLElement, window: Modal): void {
    this.contentEl = el;
    // Its own: the classes a pane drawn as a dialog put on its frame do not change the window's.
    this.modalEl = createDiv();
    this.window = window;
    this.onOpen();
  }

  /** A pane has no title of its own: the window has one. */
  setTitle(_title: string): void {}

  close(): void {
    this.window?.close();
  }

  abstract onOpen(): void;

  onClose(): void {}
}

/** The panes of a tab, read when it is shown; or why it has none (a chat with no project). */
export type TabPanes = Pane[] | { empty: string; action?: { label: string; tab: ConnectionsTab } };

const TABS: [ConnectionsTab, string, string][] = [
  ['chat', 'Chat', 'message-square'],
  ['project', 'Project', 'folder-kanban'],
  ['all', 'All projects', 'library'],
];

export class ConnectionsWindow extends Modal {
  private panes: Pane[] = [];
  private tab: ConnectionsTab;
  private readonly tabButtons = new Map<ConnectionsTab, HTMLElement>();
  private body!: HTMLElement;
  /** The latest tab asked for: a slower one that was asked for before gives way. */
  private showing = 0;

  constructor(
    app: App,
    private readonly title: string,
    private readonly build: (tab: ConnectionsTab) => Promise<TabPanes>,
    first: ConnectionsTab,
    /** Tabs not offered (Chat, with no chat on screen). */
    private readonly hidden: ConnectionsTab[] = [],
    private readonly closed: () => void = () => undefined,
  ) {
    super(app);
    this.tab = first;
  }

  onOpen(): void {
    this.modalEl.addClass('vc-map-modal', 'vc-connections');
    this.setTitle(this.title);
    const tabs = this.contentEl.createDiv({ cls: 'vc-connections-tabs' });
    for (const [tab, label, icon] of TABS) {
      if (this.hidden.includes(tab)) continue;
      const button = tabs.createEl('button', { cls: 'vc-connections-tab' });
      setIcon(button.createSpan({ cls: 'vc-project-group-icon' }), icon);
      button.appendText(label);
      button.addEventListener('click', () => void this.show(tab));
      this.tabButtons.set(tab, button);
    }
    this.body = this.contentEl.createDiv({ cls: 'vc-connections-body' });
    void this.show(this.tab);
  }

  /** Shows tab `tab`, its panes drawn anew; `back`: with a way back to the tab shown before (come from a map, not the tab's button). */
  async show(tab: ConnectionsTab, back = false): Promise<void> {
    const turn = ++this.showing;
    const from = this.tab;
    this.tab = tab;
    for (const [each, button] of this.tabButtons) button.toggleClass('is-active', each === tab);
    const panes = await this.build(tab);
    if (turn !== this.showing) return;
    this.unmount();
    this.body.empty();
    if (back && from !== tab) {
      const label = TABS.find(([each]) => each === from)?.[1] ?? '';
      const way = this.body.createEl('a', { cls: 'vc-connections-back', text: `← Back to ${label}` });
      way.addEventListener('click', () => void this.show(from));
    }
    if (!Array.isArray(panes)) {
      this.body.createDiv({ cls: 'vc-project-empty', text: panes.empty });
      const { action } = panes;
      if (action) this.body.createEl('button', { cls: 'mod-cta', text: action.label }).addEventListener('click', () => void this.show(action.tab));
      return;
    }
    this.panes = panes;
    for (const pane of panes) pane.mount(this.body.createDiv({ cls: 'vc-connections-pane' }), this);
  }

  private unmount(): void {
    for (const pane of this.panes) pane.onClose();
    this.panes = [];
  }

  onClose(): void {
    this.showing += 1;
    this.unmount();
    this.contentEl.empty();
    this.closed();
  }
}
