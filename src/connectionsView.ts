// The Connections pane, drawn (see connections.ts): a tab in the main area, among the notes, showing
// the map of the chat in the Claude panel and following it as the panel changes chat; centred on that
// chat (its notes and the chats that share them, or linked with it), on a project (its chats and
// their notes), on a note (its chats and their other notes) or on a folder (the chats that worked on
// its notes, and those notes). Plain SVG. Notes are squares with a
// page glyph, chats circles with a speech bubble, folders arcs behind their notes. A note centres the
// map on it on a click, offers to open it on a right-click, and shows Obsidian's page preview on
// ⌘-hover; a chat opens in the panel on a click (the map then follows it), and a
// right-click offers to open it in the panel, mention it, or link or unlink it; a folder's arc centres
// the map on the folder on a click, and on a right-click lists its chats in the history or offers its
// project (show it, put the chat in it, open its note), or to make it one.
import { ItemView, Menu, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { ProjectPicker } from './projectModals';
import { mailThreadTitle } from './emailMessages';
import { safeGmailUrl } from './emailSafety';
import { folderOf } from './chatFolders';
import { chatAngles, groupDirection, noteRing, placeLabels, polar, ringLayout, shortLabel, type MapChat, type MapNote, type Point, type RingArc } from './connections';
import { previewOnHover } from './hoverPreview';
import { folderChatsQuery, noteChatsQuery, projectChatsQuery } from './historyModal';
import { projectShownName } from './projects';

const SVG = 'http://www.w3.org/2000/svg';
/** What a click on a chat does, said in its tooltip. */
const CHAT_CLICK = 'Click to open it in the panel · right-click to mention or link it';
/** What putting a chat in a project does, said where it is offered. A chat has at most one project. */
const HOME_TIP = "This project's Context then goes with this chat's next message. A chat is in one project at most.";
/** How a note is linked, by weight (see LINK_WEIGHTS). */
const LINK_KINDS: Record<number, string> = { 3: 'edited', 2: 'sent', 1: 'mentioned' };
/** The rings: notes (see noteRing), their labels and the arcs behind them; the other chats CHAT_GAP beyond the notes. */
const ARC_WIDTH = 26;
const CHAT_GAP = 95;
/** The map's size for the smallest notes' ring; it grows with the ring. */
const BASE_RING = 150;
/** How much wider a folder holding others is drawn than the arcs inside it, either side. */
const SPAN_EXTRA = 6;

/** What the maps need from the panel. */
interface MapActions {
  titleOf(id: string): string;
  /** Whether chat `id` is a Codex chat: marked so on the map. */
  isCodex(id: string): boolean;
  openNote(path: string, newTab: boolean): void;
  /** Opens note `path` with Obsidian's local graph of it beside; absent when the core Graph plugin is off. */
  localGraph?: (path: string) => void;
  previewNote(path: string, event: MouseEvent | KeyboardEvent, target: Element, parent: unknown): void;
  openChat(id: string): void;
  /** Whether the chat the map is from links to chat `id`; null when there is none (a project's map with no chat on screen). */
  linked(id: string): boolean | null;
  link(id: string, on: boolean): void;
  /** The project each chat is in, by name, if any. */
  projectOfChat(id: string): string | null;
  /** Adds a link to chat `id` to the message being typed in the panel. */
  mentionChat(id: string): void;
  /** Opens the history at `query`: the chats with a note, in a folder or of a project (see noteChatsQuery). */
  showChats(query: string): void;
  /** Starts a new chat in the panel, in project `path` (its note) from the start (see ChatView.startNewChatIn). */
  newChatIn(path: string): void;
}


export interface ChatMapHost extends MapActions {
  title: string;
  /** The email threads the chat read with the Gmail connector (see VaultClaudePlugin.recordMail), newest first. */
  mail: { subject: string; from?: string; url?: string; at: number }[];
  /** Notes linked to many chats (see hubNotes): drawn, joining no chats. */
  hubs: ReadonlySet<string>;
  notes: MapNote[];
  chats: MapChat[];
  moreNotes: number;
  moreChats: number;
  /** The folders of all its notes, the busiest first. */
  folders: { folder: string; count: number }[];
  /** The home project of the chat the map is centred on: its name, folder and note. */
  project: { name: string; folder: string; path: string } | null;
  /** The home project of the chat on screen (`baseline`), which the map's actions put it in or take it out of. */
  ownProject: { name: string; path: string } | null;
  /** Create project for `folder`; `created` runs once it is made. */
  makeProject(folder: string, created: () => void): void;
  openProjectNote(path: string): void;
  /** Chooses another folder for project `path`; `changed` runs once it is set. */
  changeFolder(path: string, changed: () => void): void;
  /** Project `path`'s map, for the map to be centred on it. */
  projectMap(path: string): Promise<ProjectMapHost>;
  /** Note `path`'s map, for the map to be centred on it. */
  noteMap(path: string): Promise<NoteMapHost>;
  /** Folder `folder`'s map ('' the top of the vault), for the map to be centred on it. */
  folderMap(folder: string): Promise<FolderMapHost>;
  /** A project's Context written anew (see ContextModal); sent again with the chat's next message; renamed; deleted (after asking). `done` runs after. */
  refreshContext(path: string, saved: () => void): void;
  sendAgain(path: string): void;
  renameProject(path: string, done: () => void): void;
  deleteProject(path: string, done: () => void): void;
  /** The chat's links, drawn into `el` (see LinksList), under the map of the chat on screen: `stop` ends what they still run (a summary), `redraw` draws them again in place. */
  drawLinks(el: HTMLElement): { stop(): void; redraw(): void };
  /** The vault's projects, for choosing one to put the chat in. */
  projects(): { path: string; name: string }[];
  /** Makes project `path` the chat's home (null: takes it out). */
  setHome(path: string | null): Promise<void>;
  /** The project whose folder holds `folder` (the deepest), if any: what its notes count toward. */
  projectHolding(folder: string): { path: string; name: string; folder: string } | null;
  /** The map's data again, after something it shows changed; with `all`, every note and chat (see chatMap). */
  reload(all: boolean): Promise<ChatMapHost>;
  /** The chat on screen has no session of its own yet (opened from outside the panel): its map is looked at, and the controls that change it are left out. */
  lookOnly: boolean;
  /** The chat on screen, which links, mentions and its project bar act for. */
  baseline: { id: string; title: string };
  /** Whether it shows every note and chat. */
  all: boolean;
  /** For a chat without a project: the project of a chat it is linked with, and the folder its notes suggest. */
  linkedProject: { path: string; name: string } | null;
  folderSuggestion: { folder: string; count: number; total: number } | null;
}

/** An SVG element of `tag` with `attrs`, added to `parent`. */
function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  parent.appendChild(el);
  return el;
}

/** The map's tooltips, by node: shown when the node is pointed at (see MapDrawing.node). */
const tooltips = new WeakMap<Element, string>();

/**
 * A hover tooltip on `el`, drawn by the map when the node is pointed at (see MapDrawing.showTip):
 * Obsidian shows none for an SVG element, neither SVG's `<title>` nor its `aria-label` (kept for
 * screen readers).
 */
function tooltip(el: Element, text: string): void {
  tooltips.set(el, text);
  el.setAttribute('aria-label', text);
}

/** The path of a ring segment between radii `inner` and `outer`, from angle `start` to `end`. */
function arcPath(start: number, end: number, inner: number, outer: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  const [a, b, c, d] = [polar(start, outer), polar(end, outer), polar(end, inner), polar(start, inner)];
  return `M ${a.x} ${a.y} A ${outer} ${outer} 0 ${large} 1 ${b.x} ${b.y} L ${c.x} ${c.y} A ${inner} ${inner} 0 ${large} 0 ${d.x} ${d.y} Z`;
}

/** A folder's name: its last part; the top of the vault ('') so named. */
function folderName(folder: string): string {
  return folder.slice(folder.lastIndexOf('/') + 1) || 'Top of the vault';
}

/** What a click and a right-click on a folder's arc do, said in its tooltip. */
const ARC_CLICK = 'click to centre the map on it, right-click for more';

/** A note's name: its file name without `.md`. */
function noteName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

/** A box in a map's units: its top-left corner, width and height. */
interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Draws a map in layers: arcs, lines, nodes; pointing at a node lights it and its lines and dims the rest. */
class MapDrawing {
  readonly root: SVGSVGElement;
  readonly arcs: SVGGElement;
  private readonly lines: SVGGElement;
  private readonly nodes: SVGGElement;
  /** Above everything: a pointed-at node's full label, when its own is shortened. */
  private readonly top: SVGGElement;
  /** Each node's shortened label and the full text it stands for. */
  private readonly fullLabels = new Map<SVGGElement, { label: SVGTextElement; full: string }>();
  private readonly ties: { line: SVGLineElement; ends: [string, string] }[] = [];
  private readonly groups = new Map<string, SVGGElement>();
  /** The kinds drawn, for the legend to list only those. */
  readonly drawn = new Set<string>();
  /** Where each node is, by key: what the next map's nodes glide from (see glide). */
  readonly positions = new Map<string, Point>();

  /** The whole map, and the part of it in view (zoomed in, a smaller box within it). */
  private readonly whole: ViewBox;
  private view: ViewBox;

  /** The tooltip of the node pointed at, drawn over the map (see tooltip). */
  private readonly tipEl: HTMLElement;

  constructor(parent: HTMLElement, width: number, height: number) {
    const frame = parent.createDiv({ cls: 'vc-map-frame' });
    this.tipEl = frame.createDiv({ cls: 'vc-map-tip' });
    this.tipEl.hide();
    this.whole = { x: -width / 2, y: -height / 2, w: width, h: height };
    this.view = { ...this.whole };
    this.root = svg(frame, 'svg', { viewBox: `${-width / 2} ${-height / 2} ${width} ${height}`, class: 'vc-map' });
    this.arcs = svg(this.root, 'g');
    this.lines = svg(this.root, 'g');
    this.nodes = svg(this.root, 'g');
    this.top = svg(this.root, 'g', { class: 'vc-map-top' });
    this.zoomable(frame);
  }

  /** Scrolling (or pinching) zooms about the pointer, dragging pans, and buttons zoom in, out and back to the whole map. */
  private zoomable(frame: HTMLElement): void {
    const controls = frame.createDiv({ cls: 'vc-map-zoom' });
    const button = (icon: string, label: string, run: () => void) => {
      const el = controls.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
      setIcon(el, icon);
      el.addEventListener('click', run);
    };
    const centre = () => ({ x: this.view.x + this.view.w / 2, y: this.view.y + this.view.h / 2 });
    button('zoom-in', 'Zoom in', () => this.zoom(1 / 1.4, centre()));
    button('zoom-out', 'Zoom out', () => this.zoom(1.4, centre()));
    button('scan', 'Whole map', () => this.show({ ...this.whole }));
    this.root.addEventListener(
      'wheel',
      (evt) => {
        evt.preventDefault();
        this.zoom(Math.exp(evt.deltaY * (evt.ctrlKey ? 0.01 : 0.002)), this.at(evt));
      },
      { passive: false },
    );
    // A drag pans; a press that does not move stays a click on what is under it.
    let drag: { x: number; y: number; view: ViewBox; moved: boolean; pointer: number } | null = null;
    this.root.addEventListener('pointerdown', (evt) => {
      if (evt.button === 0) drag = { x: evt.clientX, y: evt.clientY, view: { ...this.view }, moved: false, pointer: evt.pointerId };
    });
    this.root.addEventListener('pointermove', (evt) => {
      if (!drag) return;
      const [dx, dy] = [evt.clientX - drag.x, evt.clientY - drag.y];
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        this.root.setPointerCapture(drag.pointer);
        this.root.addClass('is-panning');
      }
      // Map units per screen pixel: the view fits the frame whole (SVG's default preserveAspectRatio,
      // xMidYMid meet), so it is scaled by the tighter of its two sides.
      const box = this.root.getBoundingClientRect();
      const units = Math.max(drag.view.w / box.width, drag.view.h / box.height);
      this.show({ ...drag.view, x: drag.view.x - dx * units, y: drag.view.y - dy * units });
    });
    const end = () => {
      if (drag?.moved) {
        // The click that ends a drag is not a click on a node or arc.
        this.root.addEventListener('click', (evt) => evt.stopPropagation(), { capture: true, once: true });
        window.setTimeout(() => this.root.removeClass('is-panning'));
      }
      drag = null;
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
  }

  /** The point in the map's units under the pointer. */
  private at(evt: MouseEvent): Point {
    const matrix = this.root.getScreenCTM();
    if (!matrix) return { x: this.view.x + this.view.w / 2, y: this.view.y + this.view.h / 2 };
    const point = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }

  /** Zooms by `factor` (below 1, in) keeping `about` where it is; from the whole map to an eighth of it. */
  private zoom(factor: number, about: Point): void {
    const w = Math.min(this.whole.w, Math.max(this.whole.w / 8, this.view.w * factor));
    const k = w / this.view.w;
    this.show({ x: about.x - (about.x - this.view.x) * k, y: about.y - (about.y - this.view.y) * k, w, h: this.view.h * k });
  }

  /** Shows `view`, kept within the whole map. */
  private show(view: ViewBox): void {
    const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
    view.x = clamp(view.x, this.whole.x, this.whole.x + this.whole.w - view.w);
    view.y = clamp(view.y, this.whole.y, this.whole.y + this.whole.h - view.h);
    this.view = view;
    this.root.setAttr('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    this.root.toggleClass('is-zoomed', view.w < this.whole.w);
  }

  /** Records that node `key` is at `at`. */
  place(key: string, at: Point): void {
    this.positions.set(key, at);
  }

  /**
   * Moves the nodes that were on the map before (`from`, where they were) from there to where they are
   * now; what is new fades in.
   */
  glide(from: ReadonlyMap<string, Point>): void {
    if (from.size === 0) return;
    this.root.addClass('is-arriving');
    for (const [key, group] of this.groups) {
      const was = from.get(key);
      const now = this.positions.get(key);
      if (!was || !now || (was.x === now.x && was.y === now.y)) continue;
      group.addClass('is-gliding');
      group.style.transform = `translate(${was.x - now.x}px, ${was.y - now.y}px)`;
    }
    // Once the start is laid out: the nodes move to their places, and the rest fades in.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        this.root.removeClass('is-arriving');
        for (const group of this.groups.values()) group.style.removeProperty('transform');
      }),
    );
  }

  line(from: Point, to: Point, ends: [string, string], kind: string): void {
    this.drawn.add(kind);
    this.ties.push({ line: svg(this.lines, 'line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: `vc-map-line is-${kind}` }), ends });
  }

  /** Draws the nodes keyed `keys`, the lines to chat `me` and those between them in full, the rest faded, until a node is pointed at. */
  focus(me: string, keys: ReadonlySet<string>): void {
    this.root.addClass('is-focus');
    for (const [key, group] of this.groups) if (keys.has(key)) group.addClass('is-mine');
    for (const { line, ends } of this.ties) if (ends.includes(me) || ends.every((end) => keys.has(end))) line.addClass('is-mine');
  }

  /** A node's group, lit with its lines when pointed at. */
  node(key: string, cls: string): SVGGElement {
    const group = svg(this.nodes, 'g', { class: `vc-map-node ${cls}`, tabindex: 0 });
    group.addEventListener('mouseenter', () => {
      this.showTip(group);
      this.light(key);
      this.showFull(group);
    });
    group.addEventListener('mouseleave', () => {
      this.tipEl.hide();
      this.light(null);
      this.showFull(null);
    });
    this.groups.set(key, group);
    return group;
  }

  /** Shows `group`'s tooltip (see tooltip) just above it, over the map, kept within the map's width. */
  private showTip(group: SVGGElement): void {
    const text = tooltips.get(group);
    if (!text) return this.tipEl.hide();
    this.tipEl.setText(text);
    this.tipEl.show();
    const frame = this.tipEl.parentElement?.getBoundingClientRect();
    const node = group.getBoundingClientRect();
    if (!frame) return;
    const width = this.tipEl.offsetWidth;
    const left = Math.min(Math.max(node.left + node.width / 2 - frame.left - width / 2, 4), frame.width - width - 4);
    const top = node.top - frame.top - this.tipEl.offsetHeight - 6;
    this.tipEl.style.left = `${left}px`;
    // No room above (a node at the top): below it instead.
    this.tipEl.style.top = `${top >= 0 ? top : node.bottom - frame.top + 6}px`;
  }

  /** A note: a page with a folded corner. */
  note(key: string, at: Point, kind: string): SVGGElement {
    this.drawn.add(`note-${kind}`);
    const group = this.node(key, `is-note is-${kind}`);
    this.place(key, at);
    svg(group, 'path', { d: `M ${at.x - 6} ${at.y - 7} h 8 l 4 4 v 10 h -12 z`, class: 'vc-map-page' });
    svg(group, 'path', { d: `M ${at.x + 2} ${at.y - 7} v 4 h 4`, class: 'vc-map-fold' });
    return group;
  }

  /** A chat: a circle with a speech bubble, green for a Codex chat (`codex`). */
  chat(key: string, at: Point, r: number, cls: string, codex = false): SVGGElement {
    if (codex) this.drawn.add('codex');
    const group = this.node(key, `is-chat ${cls}${codex ? ' is-codex' : ''}`);
    this.place(key, at);
    svg(group, 'circle', { cx: at.x, cy: at.y, r });
    const s = r / 10;
    svg(group, 'path', { d: `M ${at.x - 5 * s} ${at.y - 4 * s} h ${10 * s} v ${6 * s} h ${-6 * s} l ${-3 * s} ${3 * s} v ${-3 * s} h ${-1 * s} z`, class: 'vc-map-bubble' });
    return group;
  }

  /** A label beside a node, on its outer side; `full`, the text it shortens, shown whole while the node is pointed at. */
  /** `codex`: a Codex chat's label, marked so after its text. */
  label(group: SVGGElement, at: Point, side: 'right' | 'left', text: string, gap = 10, full = text, codex = false): void {
    const label = svg(group, 'text', { x: at.x + (side === 'right' ? gap : -gap), y: at.y + 4, 'text-anchor': side === 'right' ? 'start' : 'end' });
    label.textContent = text;
    if (codex) {
      const mark = svg(label, 'tspan', { class: 'vc-map-engine', dx: '6' });
      mark.textContent = 'Codex';
    }
    if (full !== text) this.fullLabels.set(group, { label, full });
  }

  /** Shows `group`'s full label above the map in place of its shortened one; null puts every label back. */
  private showFull(group: SVGGElement | null): void {
    this.top.empty();
    // Made see-through rather than hidden: a hidden label stops catching the pointer, which leaves
    // the node, which puts the label back, over and over.
    for (const { label } of this.fullLabels.values()) label.style.removeProperty('opacity');
    const entry = group && this.fullLabels.get(group);
    if (!entry) return;
    const whole = this.top.appendChild(entry.label.cloneNode() as SVGTextElement);
    whole.textContent = entry.full;
    // A Codex chat's mark goes with its full label.
    const mark = entry.label.querySelector('.vc-map-engine');
    if (mark) whole.appendChild(mark.cloneNode(true));
    whole.setAttr('class', 'vc-map-label-full');
    entry.label.style.opacity = '0';
  }

  private light(key: string | null): void {
    this.root.toggleClass('is-pointing', key !== null);
    const lit = new Set(key === null ? [] : [key]);
    for (const { line, ends } of this.ties) {
      const on = key !== null && ends.includes(key);
      line.toggleClass('is-lit', on);
      if (on) for (const end of ends) lit.add(end);
    }
    for (const [each, group] of this.groups) group.toggleClass('is-lit', lit.has(each));
  }
}

/** A flat icon button, as in the panel's header, its label shown on hover. */
function iconButton(parent: HTMLElement, icon: string, label: string, run: (evt: MouseEvent) => void): HTMLElement {
  const button = parent.createEl('button', { cls: 'clickable-icon vc-map-icon', attr: { 'aria-label': label } });
  setIcon(button, icon);
  button.addEventListener('click', run);
  return button;
}

/**
 * Makes a note centre the map on it on a click (`centre`), and show Obsidian's preview on ⌘-hover, its
 * path in its tooltip; a right-click opens it, in a new tab too, or its local graph, or lists the chats
 * that worked with it in the history.
 */
function noteNode(group: SVGGElement, path: string, actions: MapActions, parent: unknown, centre: (path: string) => void, hub = false): void {
  tooltip(group, `${path}${hub ? "\nA hub: linked to many chats, so it joins none of them on the map, and counts little toward a chat's project" : ''}\nClick to centre the map on it; right-click to open it`);
  group.toggleClass('is-hub', hub);
  group.addEventListener('click', () => centre(path));
  previewOnHover(group, (evt) => actions.previewNote(path, evt, group, parent));
  group.addEventListener('contextmenu', (evt) => {
    evt.preventDefault();
    noteMenu(path, actions, evt);
  });
}

/** A note's menu: open it, here or in a new tab, its local graph, and the chats that worked with it, in the history. */
function noteMenu(path: string, actions: MapActions, evt: MouseEvent): void {
  const menu = new Menu();
  menu.addItem((item) => item.setTitle('Open note').setIcon('file-text').onClick(() => actions.openNote(path, false)));
  menu.addItem((item) => item.setTitle('Open in a new tab').setIcon('file-plus').onClick(() => actions.openNote(path, true)));
  const { localGraph } = actions;
  if (localGraph) menu.addItem((item) => item.setTitle('Open local graph').setIcon('git-fork').onClick(() => localGraph(path)));
  menu.addItem((item) => item.setTitle('Chats with this note').setIcon('messages-square').onClick(() => actions.showChats(noteChatsQuery(path))));
  menu.showAtMouseEvent(evt);
}

/**
 * Makes a chat open in the panel on a click (the map then follows it), and a right-click offer that,
 * mentioning it in the message being typed, and linking (unlinking) it from the panel's chat.
 */
function chatNode(group: SVGGElement, id: string, actions: MapActions): void {
  group.addEventListener('click', () => actions.openChat(id));
  group.addEventListener('contextmenu', (evt) => {
    evt.preventDefault();
    const linked = actions.linked(id);
    const menu = new Menu();
    const add = (title: string, icon: string, run: () => void) => menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(run));
    add('Open in panel', 'message-square', () => actions.openChat(id));
    add('Mention in your message', 'at-sign', () => actions.mentionChat(id));
    if (linked !== null) {
      // The map is drawn again by the plugin, as for a link made anywhere (see chatLinksChanged).
      add(linked ? 'Unlink' : 'Link', linked ? 'unlink' : 'link', () => actions.link(id, !linked));
    }
    menu.showAtMouseEvent(evt);
  });
}

/** A chat's small badge for being in another project, top right of its circle (its tooltip names the project). */
function projectBadge(group: SVGGElement, at: Point, r: number): void {
  svg(group, 'rect', { x: at.x + r * 0.45, y: at.y - r - 2, width: 7, height: 7, rx: 1.5, class: 'vc-map-badge' });
}

/**
 * Folder arcs behind the notes: tinted for `home` (the folder of the chat's or the map's project),
 * marked for another project's, each labelled inside the ring; `click` acts on one, `menu` on a
 * right-click. `spans`, the
 * folders that hold others (a project's round its subfolders), are drawn wider, behind them, with
 * their labels further in; a group that is a span's own folder has no arc of its own.
 */
function drawArcs(
  drawing: MapDrawing,
  ring: number,
  arcs: RingArc[],
  spans: RingArc[],
  label: (folder: string, outer: string | null) => { text: string; tip: string; cls: string },
  click?: (folder: string, evt: MouseEvent) => void,
  menu?: (folder: string, evt: MouseEvent) => void,
): void {
  const band = (arc: RingArc, extra: number, labelGap: number) => {
    const { text, tip, cls } = label(arc.folder, arc.outer);
    drawing.drawn.add(`arc-${cls}`);
    const group = svg(drawing.arcs, 'g', { class: `vc-map-arc ${cls}` });
    const inner = ring - ARC_WIDTH / 2 - extra;
    svg(group, 'path', { d: arcPath(arc.start, arc.end, inner, ring + ARC_WIDTH / 2 + extra) });
    const at = polar((arc.start + arc.end) / 2, inner - labelGap);
    const name = svg(group, 'text', { x: at.x, y: at.y + 4, 'text-anchor': Math.abs(at.x) < 20 ? 'middle' : at.x > 0 ? 'end' : 'start' });
    name.textContent = text;
    tooltip(group, tip);
    if (click) {
      group.addEventListener('click', (evt) => click(arc.folder, evt));
      group.addClass('is-clickable');
    }
    if (menu) {
      group.addEventListener('contextmenu', (evt) => {
        evt.preventDefault();
        menu(arc.folder, evt);
      });
    }
  };
  for (const span of spans) band(span, SPAN_EXTRA, 26);
  for (const arc of arcs) if (arc.folder !== arc.outer) band(arc, 0, arc.outer === null ? 12 : 12 - SPAN_EXTRA + 2);
}

/** The line under a map: `text`; Show all when some are not shown, or Show fewer when all are. */
function showAll(el: HTMLElement, text: string, all: boolean, set: (all: boolean) => void): void {
  if (!text && !all) return;
  const line = el.createDiv({ cls: 'vc-project-empty', text });
  if (all || text.includes('Not shown')) line.createEl('a', { cls: 'vc-map-show-all', text: all ? 'Show fewer' : 'Show all' }).addEventListener('click', () => set(!all));
}

/** The legend: only the kinds drawn. */
function legend(el: HTMLElement, drawn: Set<string>, items: [string, string, string][]): void {
  const shown = items.filter(([kind]) => drawn.has(kind));
  if (shown.length === 0) return;
  const row = el.createDiv({ cls: 'vc-map-legend' });
  for (const [, cls, label] of shown) {
    const item = row.createSpan({ cls: 'vc-map-legend-item' });
    item.createSpan({ cls: `vc-map-swatch ${cls}` });
    item.appendText(label);
  }
}

/** Everything the legends may name: what was drawn, its swatch, its words. */
const LEGEND: [string, string, string][] = [
  ['edited', 'is-edited', 'edited'],
  ['sent', 'is-sent', 'sent'],
  ['mentioned', 'is-mentioned', 'mentioned only'],
  ['shared', 'is-shared', 'note shared with another chat'],
  ['linked', 'is-linked', 'linked chat'],
  ['arc-is-home', 'is-home', "the project's folder"],
  ['arc-is-other', 'is-other', "another project's folder"],
  ['same', 'is-same', 'chat in this project'],
  ['badge', 'is-badge', 'chat in another project'],
  ['codex', 'is-codex', 'Codex chat'],
];

/** The Connections pane's view type (see ConnectionsView). */
export const CONNECTIONS_VIEW_TYPE = 'vault-claude-connections';

/**
 * The Connections pane: the map of the chat in the Claude panel, following it as the panel changes
 * chat. Its rows stay put: the chat (or project) shown, what can be done with it, the map filling
 * what is left, the legend, and the chat's links. Centred on the panel's chat: its notes
 * round it, grouped by folder under arcs, each folder on the same side from one chat to the next;
 * the chats sharing them, or linked with it, outside. A chat on the map opens in the panel on a click
 * (the map follows); a project's map shows its chats round it, their notes
 * outside, a note's map the same for the chats linked to it, and a folder's map the same for the
 * chats linked to its notes, those notes outside. Nodes on both the map before and the one after
 * glide from one place to the other. Each move to a project, a note or a folder and back is a step
 * in the tab's history, for its ← and →.
 */
/** The heading of the links under the map of chat `title`. */
function linksHeading(title: string): string {
  return `Links of “${shortLabel(title, 50)}”`;
}

export class ConnectionsView extends ItemView {
  /** The map of the panel's chat (null: no chat with connections in the panel). */
  private host: ChatMapHost | null = null;
  /** The map centred on a project, when it is. */
  private project: ProjectMapHost | null = null;
  /** The map of the panel's chat's project: what the chat's own map is drawn on (see drawOwn). */
  private home: ProjectMapHost | null = null;
  /** The map centred on a note, when it is. */
  private note: NoteMapHost | null = null;
  /** The map centred on a folder, when it is. */
  private folder: FolderMapHost | null = null;
  /** The map drawn last: where its nodes were, for the next to glide from. */
  private drawing: MapDrawing | null = null;
  private barEl!: HTMLElement;
  private actionEl!: HTMLElement;
  private mapEl!: HTMLElement;
  private footEl!: HTMLElement;
  private linksEl!: HTMLElement;
  /** The email threads the chat read, listed under its links (see drawMail). */
  private mailEl!: HTMLElement;
  private mailOpen = false;
  /** Whether the links are unfolded, kept from one map to the next. */
  private linksOpen = false;
  /** Each change of map counts: a map read for an earlier one is not drawn. */
  private generation = 0;
  /** Each read of the map shown again counts (see refresh): only the latest is drawn. */
  private reads = 0;
  /** Show all (or Show fewer) asked of a read still under way: a later read, which replaces it, keeps it. */
  private pendingAll: boolean | undefined;

  constructor(
    leaf: WorkspaceLeaf,
    /** Asks for the map of the panel's chat (see follow), once the pane is open. */
    private readonly opened: (view: ConnectionsView) => void,
    /** Rebuild connections from chat files, after asking (see VaultClaudePlugin.confirmRebuildConnections). */
    private readonly rebuild: () => void = () => undefined,
  ) {
    super(leaf);
  }

  /** The tab's ⋯ menu: Rebuild connections, besides Obsidian's own items. */
  onPaneMenu(menu: Menu, source: string): void {
    menu.addItem((item) => item.setTitle('Rebuild connections from chat files…').setIcon('refresh-cw').setSection('action').onClick(() => this.rebuild()));
    super.onPaneMenu(menu, source);
  }

  getViewType(): string {
    return CONNECTIONS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Connections';
  }

  getIcon(): string {
    return 'waypoints';
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vc-map-pane');
    this.barEl = contentEl.createDiv({ cls: 'vc-map-bar' });
    this.actionEl = contentEl.createDiv({ cls: 'vc-map-actions-row' });
    this.mapEl = contentEl.createDiv({ cls: 'vc-map-area' });
    this.footEl = contentEl.createDiv({ cls: 'vc-map-foot' });
    this.linksEl = contentEl.createDiv({ cls: 'vc-map-links' });
    this.mailEl = contentEl.createDiv({ cls: 'vc-map-links vc-map-mail' });
    this.draw();
    this.opened(this);
  }

  async onClose(): Promise<void> {
    // What is still being read for the map is dropped (see move), and nothing is drawn after.
    this.move();
    this.closedPane = true;
    this.host = null;
    this.stopLinks();
    this.contentEl.empty();
  }

  /** Set once the pane has closed: reads finishing after are not drawn. */
  private closedPane = false;

  /**
   * Shows the map of the panel's chat (`host`, or what it resolves to; null, none), or with
   * `atProject`, that project's. Claimed before `host` is read, so that a later call wins over it.
   * A map centred on a note or a folder gives way to it, as one centred on a project does.
   */
  async follow(host: ChatMapHost | null | Promise<ChatMapHost | null>, atProject: string | null = null): Promise<void> {
    const generation = this.move();
    const shown = await Promise.resolve(host).catch(() => null);
    if (generation !== this.generation || this.closedPane) return;
    const project = shown && atProject ? await shown.projectMap(atProject).catch(() => null) : null;
    const home = shown?.project && !atProject ? await shown.projectMap(shown.project.path).catch(() => null) : null;
    host = shown;
    if (generation !== this.generation || this.closedPane) return;
    this.host = host;
    this.project = project;
    this.home = home;
    this.note = null;
    this.folder = null;
    this.draw();
  }

  /** Reads the map shown again and draws it in place: after its data changed. */
  async refresh(all?: boolean): Promise<void> {
    // Not a move: one under way is not cancelled by it (its step is already in the tab's history),
    // and what is read here is dropped if the map moved meanwhile, or if a later read was asked for.
    // The chat's map is read again too when a project, a note or a folder is shown, as what it says
    // of the chat (its project) may have changed.
    const generation = this.generation;
    const read = ++this.reads;
    if (all === undefined) all = this.pendingAll;
    else this.pendingAll = all;
    const { host, project, note, folder } = this;
    const [nextHost, nextProject, nextNote, nextFolder] = await Promise.all([
      host ? host.reload(project || note || folder ? host.all : (all ?? host.all)) : null,
      project ? project.reload(all ?? project.all) : null,
      note ? note.reload(all ?? note.all).catch(() => null) : null,
      folder ? folder.reload(all ?? folder.all).catch(() => null) : null,
    ]);
    if (generation !== this.generation || read !== this.reads) return;
    // The chat's own map, drawn on its project's (see drawOwn): that project's read again too, or
    // read anew when the chat moved to another.
    const base = nextHost ?? host;
    const own = !project && !note && !folder;
    const { home } = this;
    const nextHome =
      own && base?.project
        ? await (home?.path === base.project.path ? home.reload(all ?? home.all) : base.projectMap(base.project.path)).catch(() => null)
        : own
          ? null
          : home;
    if (generation !== this.generation || read !== this.reads) return;
    this.pendingAll = undefined;
    // What the map shows, its functions left out (JSON drops them): unchanged, it is not drawn
    // again, so a node pointed at keeps its tooltip and label rather than being replaced under the
    // pointer by each refresh while a chat works. The links under it are drawn again all the same.
    const key = (map: unknown) => JSON.stringify(map);
    const same = key([host, project, note, folder, home]) === key([nextHost ?? host, nextProject ?? project, nextNote ?? note, nextFolder ?? folder, nextHome]);
    this.home = nextHome;
    if (nextHost) this.host = nextHost;
    if (nextProject) this.project = nextProject;
    if (nextNote) this.note = nextNote;
    if (nextFolder) this.folder = nextFolder;
    if (same) this.links?.redraw();
    else this.draw();
  }

  /**
   * Where the map is centred, as the tab's history keeps it: the panel's chat, a project, a note or a folder. Obsidian asks for it before each move, to put on the tab's ← list.
   */
  getState(): Record<string, unknown> {
    return { centre: this.host?.baseline.id ?? null, project: this.project?.path ?? null, note: this.note?.path ?? null, folder: this.folder?.folder ?? null };
  }

  /**
   * Centres the map where `state` says: a move made here (see go), which then becomes a step in
   * the tab's history, or the tab's ← or → going back to one.
   */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (this.going) result.history = true;
    const place = (state ?? {}) as { centre?: unknown; project?: unknown; note?: unknown; folder?: unknown };
    if (typeof place.project === 'string') await this.showProject(place.project);
    else if (typeof place.note === 'string') await this.showNote(place.note);
    else if (typeof place.folder === 'string') await this.showFolder(place.folder);
    else this.showOwn();
  }

  /** A move made in the pane, under way (see go). */
  private going = false;

  /** Moves the map to `place` as a step in the tab's history, so that its ← comes back here. */
  private async go(place: { centre: string | null; project: string | null; note: string | null; folder: string | null }): Promise<void> {
    if (!this.host) return;
    this.going = true;
    try {
      await this.leaf.setViewState({ type: CONNECTIONS_VIEW_TYPE, state: place });
    } finally {
      this.going = false;
    }
  }

  /** A change of map: what is still being read for the one before (a move, a refresh) is dropped. */
  private move(): number {
    this.pendingAll = undefined;
    return ++this.generation;
  }

  /** The map of the panel's chat again, not as a step of its own (a step back, a project gone). */
  private showOwn(): void {
    if (!this.host) return;
    this.move();
    this.project = null;
    this.note = null;
    this.folder = null;
    this.draw();
    // Its project's map not read yet, or another's: read, and drawn again.
    if (this.host.project && this.home?.path !== this.host.project.path) void this.refresh();
  }

  /** Back to the map of the panel's chat, as a step in the tab's history. */
  private backToChat(): Promise<void> {
    return this.host ? this.go({ centre: this.host.baseline.id, project: null, note: null, folder: null }) : Promise.resolve();
  }

  /** Centres the map on project `path`. */
  private moveToProject(path: string): Promise<void> {
    return this.go({ centre: this.host?.baseline.id ?? null, project: path, note: null, folder: null });
  }

  /** Centres the map on note `path`, as a step in the tab's history. */
  private moveToNote(path: string): Promise<void> {
    return this.go({ centre: this.host?.baseline.id ?? null, project: null, note: path, folder: null });
  }

  /** Centres the map on folder `folder` ('' the top of the vault), as a step in the tab's history. */
  private moveToFolder(folder: string): Promise<void> {
    return this.go({ centre: this.host?.baseline.id ?? null, project: null, note: null, folder });
  }

  /** Centres the map on project `path` (see moveToProject), not as a step of its own. */
  private async showProject(path: string): Promise<void> {
    if (!this.host) return;
    const generation = this.move();
    // Gone since (a step in the tab's history to a project deleted or renamed): the chat's map instead.
    const project = await this.host.projectMap(path).catch(() => null);
    if (generation !== this.generation) return;
    if (!project) return this.showOwn();
    this.project = project;
    this.note = null;
    this.folder = null;
    this.draw();
  }

  /** Centres the map on note `path` (see moveToNote), not as a step of its own. */
  private async showNote(path: string): Promise<void> {
    if (!this.host) return;
    const generation = this.move();
    // Gone since (a step in the tab's history to a note deleted or renamed): the chat's map instead.
    const note = await this.host.noteMap(path).catch(() => null);
    if (generation !== this.generation) return;
    if (!note) return this.showOwn();
    this.project = null;
    this.note = note;
    this.folder = null;
    this.draw();
  }

  /** Centres the map on folder `folder` (see moveToFolder), not as a step of its own. */
  private async showFolder(folder: string): Promise<void> {
    if (!this.host) return;
    const generation = this.move();
    // Gone since (a step in the tab's history to a folder deleted or renamed): the chat's map instead.
    const shown = await this.host.folderMap(folder).catch(() => null);
    if (generation !== this.generation) return;
    if (!shown) return this.showOwn();
    this.project = null;
    this.note = null;
    this.folder = shown;
    this.draw();
  }

  /** The links drawn under the map (see ChatMapHost.drawLinks), and whose chat they are. */
  private links: { stop(): void; redraw(): void; chat: string } | null = null;

  /** Stops what the links drawn under the map still run (a summary), and forgets them. */
  private stopLinks(): void {
    this.links?.stop();
    this.links = null;
    this.linksEl.empty();
  }

  private draw(): void {
    if (this.closedPane) return;
    const previous = this.drawing?.positions ?? new Map<string, Point>();
    this.drawing = null;
    for (const el of [this.barEl, this.actionEl, this.mapEl, this.footEl]) el.empty();
    const { host } = this;
    this.drawMail();
    // The links stay while the map is redrawn for the same chat, drawn again in place: a summary of a
    // linked chat still being written is not stopped by the map changing around it.
    if (this.links && this.links.chat !== host?.baseline.id) this.stopLinks();
    if (!host) {
      this.barEl.createSpan({ cls: 'vc-map-bar-name', text: 'No chat' });
      this.mapEl.createDiv({ cls: 'vc-project-empty', text: 'Open a chat in the Claude panel: its connections show here, and follow it as you change chat.' });
      return;
    }
    if (this.project) this.drawProjectCentre(this.project);
    else if (this.note) this.drawNoteCentre(this.note);
    else if (this.folder) this.drawFolderCentre(this.folder);
    else this.drawOwn();
    // Set by the drawing above, which TypeScript does not follow.
    (this.drawing as MapDrawing | null)?.glide(previous);
    // Kept across redraws, its heading follows a rename of the chat.
    if (this.links) {
      this.linksEl.querySelector('summary')?.setText(linksHeading(host.baseline.title));
      return this.links.redraw();
    }
    if (host.lookOnly) {
      this.linksEl.empty();
      this.linksEl.createDiv({ cls: 'vc-project-empty', text: 'Links between chats can be made once you send this chat a message.' });
      return;
    }
    const links = this.linksEl.createEl('details');
    links.open = this.linksOpen;
    links.createEl('summary', { text: linksHeading(host.baseline.title) });
    links.addEventListener('toggle', () => (this.linksOpen = links.open));
    this.links = { ...host.drawLinks(links.createDiv()), chat: host.baseline.id };
  }


  /** The email threads the chat on the map read, folded under its links, each opening in Gmail; nothing when it read none. */
  private drawMail(): void {
    this.mailEl.empty();
    const mail = this.host && !this.project && !this.note && !this.folder ? this.host.mail : [];
    if (mail.length === 0) return;
    const fold = this.mailEl.createEl('details');
    fold.open = this.mailOpen;
    fold.createEl('summary', { text: `Mail read in this chat (${mail.length})` });
    fold.addEventListener('toggle', () => (this.mailOpen = fold.open));
    const list = fold.createDiv({ cls: 'vc-map-mail-list' });
    for (const thread of mail) {
      const row = list.createDiv({ cls: 'vc-map-mail-row' });
      setIcon(row.createSpan({ cls: 'vc-map-mail-icon' }), 'mail');
      const url = safeGmailUrl(thread.url);
      if (url) row.createEl('a', { text: mailThreadTitle(thread), href: url, cls: 'external-link' });
      else row.createSpan({ text: mailThreadTitle(thread) });
      if (thread.at) row.createSpan({ cls: 'vc-muted', text: new Date(thread.at).toISOString().slice(0, 10) });
    }
  }

  /** The chat's links unfolded under the map, and brought into view (the panel's links chip). */
  openLinks(): void {
    this.linksOpen = true;
    const links = this.linksEl.querySelector('details');
    if (links) links.open = true;
    this.linksEl.scrollIntoView({ block: 'nearest' });
  }

  /** The bar's start away from the panel's chat: back to it. */
  private backButton(): void {
    const { host } = this;
    if (!host) return;
    const back = this.barEl.createEl('button', { cls: 'vc-map-action', attr: { 'aria-label': `Back to “${host.baseline.title}”, the chat in the panel` } });
    setIcon(back.createSpan({ cls: 'vc-project-group-icon' }), 'arrow-left');
    back.appendText('Chat');
    back.addEventListener('click', () => void this.backToChat());
  }

  /** The panel's chat: its name, then its project's bar, and its map. */
  private drawOwn(): void {
    const host = this.host;
    if (!host) return;
    setIcon(this.barEl.createSpan({ cls: 'vc-project-group-icon' }), 'message-square');
    const barName = this.barEl.createSpan({ cls: 'vc-map-bar-name', text: host.title, attr: { title: host.title } });
    if (host.isCodex(host.baseline.id)) barName.createSpan({ cls: 'vc-engine-badge', text: 'Codex' });
    this.drawProjectBar(this.actionEl);
    const { home } = this;
    if (host.project && home?.path === host.project.path) this.drawChatInProject(host, home);
    else this.drawChatMap(host);
  }

  /**
   * A chat in a project: its project's map, with the chat ringed among the project's chats and its
   * own notes in full, the rest faded; the chat's own map when neither has a note yet.
   */
  private drawChatInProject(host: ChatMapHost, home: ProjectMapHost): void {
    const project = host.project;
    if (!project) return;
    if (host.notes.length === 0 && home.notes.length === 0 && host.chats.length === 0) return this.drawEmptyInProject(host, project);
    this.drawProjectMap(home, { id: host.baseline.id, notes: host.notes, chats: host.chats });
  }

  /** A chat's map: the chat in the middle, its notes round it, the chats sharing them outside. */
  private drawChatMap(host: ChatMapHost): void {
    const { mapEl, footEl } = this;
    if (host.notes.length === 0 && host.chats.length === 0) {
      if (host.project) this.drawEmptyInProject(host, host.project);
      else mapEl.createDiv({ cls: 'vc-project-empty', text: 'This chat has worked on no notes yet, and links to no chats.' });
      return;
    }
    const ring = noteRing(host.notes.length);
    const scale = ring / BASE_RING;
    const drawing = new MapDrawing(mapEl, 820 * scale, 620 * scale);
    this.drawing = drawing;
    // A project's folder holds its subfolders' arcs; each folder on its own side (see ringLayout).
    const { angles, arcs, spans } = ringLayout(host.notes.map((note) => note.path), folderOf, 0.8, (path) => host.projectHolding(folderOf(path))?.folder ?? null);
    const placesOfChats = chatAngles(host.chats, angles);
    const centre = { x: 0, y: 0 };
    const noteAt = (path: string) => polar(angles.get(path) ?? 0, ring);
    const chatAt = (id: string) => polar(placesOfChats.get(id) ?? 0, ring + CHAT_GAP);
    const home = host.project?.folder ?? null;
    drawArcs(
      drawing,
      ring,
      arcs,
      spans,
      (folder) => {
        const project = host.projectHolding(folder);
        const own = project !== null && project.folder === home;
        const name = folderName(folder);
        return {
          // Every arc by its folder's name, a project's own folder marked ◆ (its project is named in the tooltip).
          text: project && project.folder === folder ? `◆ ${shortLabel(name, 22)}` : shortLabel(name, 22),
          tip: `${folder || 'Top of the vault'}${project ? ` · in project “${project.name}”` : ''} · ${ARC_CLICK}`,
          cls: own ? 'is-home' : project ? 'is-other' : 'is-plain',
        };
      },
      (folder) => void this.moveToFolder(folder),
      (folder, evt) => this.folderMenu(folder, evt),
    );
    const me = host.baseline.id;
    for (const note of host.notes) drawing.line(centre, noteAt(note.path), [me, note.path], LINK_KINDS[note.weight] ?? 'mentioned');
    for (const chat of host.chats) {
      for (const path of chat.shared) if (angles.has(path)) drawing.line(chatAt(chat.id), noteAt(path), [chat.id, path], 'shared');
      if (chat.linked || chat.linkedFrom) drawing.line(centre, chatAt(chat.id), [me, chat.id], 'linked');
    }
    const noteLabels = new Map(placeLabels(host.notes.map((note) => ({ key: note.path, angle: angles.get(note.path) ?? 0, text: noteName(note.path) })), ring + ARC_WIDTH / 2 + 2, 24).map((label) => [label.key, label]));
    for (const note of host.notes) {
      const at = noteAt(note.path);
      const group = drawing.note(note.path, at, LINK_KINDS[note.weight] ?? 'mentioned');
      const label = noteLabels.get(note.path);
      if (label) drawing.label(group, label.at, label.side, label.text, 2, noteName(note.path));
      noteNode(group, note.path, host, this, (path) => void this.moveToNote(path), host.hubs.has(note.path));
    }
    const chatLabels = new Map(placeLabels(host.chats.map((chat) => ({ key: chat.id, angle: placesOfChats.get(chat.id) ?? 0, text: host.titleOf(chat.id) })), ring + CHAT_GAP, 26).map((label) => [label.key, label]));
    for (const chat of host.chats) {
      const at = chatAt(chat.id);
      const project = host.projectOfChat(chat.id);
      const other = project !== null && project !== host.project?.name;
      // A chat in this chat's project takes the project's colour.
      const same = project !== null && project === host.project?.name;
      if (same) drawing.drawn.add('same');
      const group = drawing.chat(chat.id, at, 10, `${chat.linked ? 'is-linked' : ''}${same ? ' is-same-project' : ''}`, host.isCodex(chat.id));
      if (other) {
        projectBadge(group, at, 10);
        drawing.drawn.add('badge');
      }
      const label = chatLabels.get(chat.id);
      if (label) drawing.label(group, label.at, label.side, label.text, 14, host.titleOf(chat.id), host.isCodex(chat.id));
      const shared = `${chat.shared.length} shared note${chat.shared.length === 1 ? '' : 's'}`;
      tooltip(group, `${host.titleOf(chat.id)}${host.isCodex(chat.id) ? ' · Codex' : ''}${project ? ` · in “${project}”` : ''} · ${shared}${chat.linked ? ' · linked from this chat' : chat.linkedFrom ? ' · links to this chat' : ''}\n${CHAT_CLICK}`);
      chatNode(group, chat.id, host);
    }
    const centreNode = drawing.chat(me, centre, 18, 'is-centre', host.isCodex(me));
    const title = svg(centreNode, 'text', { x: 0, y: 34, 'text-anchor': 'middle' });
    title.textContent = shortLabel(host.title, 40);
    tooltip(centreNode, host.project ? `${host.title} · in “${host.project.name}”` : host.title);
    legend(footEl, drawing.drawn, LEGEND);
    const more = [host.moreNotes > 0 ? `${host.moreNotes} more note${host.moreNotes === 1 ? '' : 's'}` : '', host.moreChats > 0 ? `${host.moreChats} more chat${host.moreChats === 1 ? '' : 's'}` : ''].filter(Boolean);
    showAll(footEl, more.length > 0 ? `Not shown: ${more.join(' and ')}.` : '', host.all, (all) => void this.refresh(all));
  }

  /**
   * A chat in a project with no notes and no chats yet: the chat in the middle, its project's folder
   * an empty arc round it, on the side its notes will take (see groupDirection); a click centres the
   * map on the project, a right-click gives the folder's menu.
   */
  private drawEmptyInProject(host: ChatMapHost, project: { name: string; folder: string; path: string }): void {
    const { mapEl, footEl } = this;
    const drawing = new MapDrawing(mapEl, 820, 620);
    this.drawing = drawing;
    const direction = groupDirection(project.folder);
    drawArcs(
      drawing,
      BASE_RING,
      [{ folder: project.folder, start: direction - 0.3, end: direction + 0.3, outer: null }],
      [],
      (folder) => ({ text: `◆ ${shortLabel(folderName(folder), 22)}`, tip: `${folder || 'Top of the vault'} · in project “${project.name}” · click to show the project, right-click for more`, cls: 'is-home' }),
      () => void this.moveToProject(project.path),
      (folder, evt) => this.folderMenu(folder, evt),
    );
    const me = host.baseline.id;
    const centreNode = drawing.chat(me, { x: 0, y: 0 }, 18, 'is-centre', host.isCodex(me));
    const title = svg(centreNode, 'text', { x: 0, y: 34, 'text-anchor': 'middle' });
    title.textContent = shortLabel(host.title, 40);
    tooltip(centreNode, `${host.title} · in “${project.name}”`);
    footEl.createDiv({ cls: 'vc-project-empty', text: `No notes yet; this chat is in project “${project.name}”.` });
  }

  /**
   * A project's menu: centre on it (when not already), its note, its Context written anew or sent again
   * with the chat's next message (its own project's), another folder, a new name, deletion. Look-only,
   * the first two.
   */
  private projectMenu(path: string, evt: MouseEvent): void {
    const { host } = this;
    if (!host) return;
    const menu = new Menu();
    const add = (title: string, icon: string, run: () => void) => menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(run));
    if (this.project?.path !== path) add('Show the project', 'locate-fixed', () => void this.moveToProject(path));
    add('Open project note', 'file-text', () => host.openProjectNote(path));
    add('New chat in this project', 'square-pen', () => host.newChatIn(path));
    add('Chats in this project', 'messages-square', () => host.showChats(projectChatsQuery(projectShownName({ basename: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '') }))));
    const { localGraph } = host;
    if (localGraph) add('Open local graph', 'git-fork', () => localGraph(path));
    if (host.lookOnly) {
      menu.showAtMouseEvent(evt);
      return;
    }
    add('Refresh context…', 'refresh-cw', () => host.refreshContext(path, () => void this.refresh()));
    if (host.ownProject?.path === path) add('Send its context again', 'send', () => host.sendAgain(path));
    add('Change folder…', 'folder-input', () => host.changeFolder(path, () => void this.refresh()));
    add('Rename…', 'pencil', () => host.renameProject(path, () => void this.refresh()));
    menu.addSeparator();
    add('Delete project…', 'trash-2', () =>
      host.deleteProject(path, () => {
        // Its map gone: back to the panel's chat.
        this.project = null;
        void this.backToChat();
      }),
    );
    menu.showAtMouseEvent(evt);
  }

  /**
   * The chat's project, in `bar`: its name (centring on it) and its Project menu, then Move… (another
   * project, picked) and Take chat out; or, with none, the project holding most of its notes, the
   * project of a chat it is linked with and the folder its notes suggest, each in one click, and Add
   * to a project… for any other.
   */
  private drawProjectBar(bar: HTMLElement): void {
    const { host } = this;
    if (!host) return;
    setIcon(bar.createSpan({ cls: 'vc-project-group-icon' }), 'folder-kanban');
    const act = (label: string, run: () => void, cta = false) => {
      const button = bar.createEl('button', { cls: `vc-map-action${cta ? ' mod-cta' : ''}`, text: label });
      button.addEventListener('click', run);
    };
    const changed = () => void this.refresh();
    // A new chat in the chat's project, from the start (as on the project's map).
    const newChat = (project: { name: string; path: string }) => iconButton(bar, 'square-pen', `New chat in “${project.name}”: its context goes with your first message`, () => host.newChatIn(project.path));
    if (host.lookOnly) {
      if (host.project) {
        const { project } = host;
        const name = bar.createEl('a', { cls: 'vc-map-bar-name', text: project.name, attr: { 'aria-label': 'Show the project’s map' } });
        name.addEventListener('click', () => void this.moveToProject(project.path));
        newChat(project);
      } else bar.createSpan({ cls: 'vc-map-bar-name is-quiet', text: 'No project' });
      bar.createSpan({ cls: 'vc-project-size', text: 'Look only: send this chat a message to put it in a project or link it.' });
      return;
    }
    if (host.project) {
      const { project } = host;
      const name = bar.createEl('a', { cls: 'vc-map-bar-name', text: project.name, attr: { 'aria-label': 'Show the project’s map' } });
      name.addEventListener('click', () => void this.moveToProject(project.path));
      // × beside the name takes the chat out of it, as × on the attached note's chip detaches the note.
      const out = bar.createSpan({ cls: 'vc-map-bar-remove', text: '×', attr: { 'aria-label': `Take this chat out of “${project.name}”` } });
      out.addEventListener('click', () => void host.setHome(null).then(changed));
      iconButton(bar, 'more-horizontal', 'Project actions', (evt) => this.projectMenu(project.path, evt));
      newChat(project);
      iconButton(bar, 'folder-input', 'Move this chat to another project…', () => this.pickProject(host, 'Move this chat to…', project.path, changed));
      return;
    }
    bar.createSpan({ cls: 'vc-map-bar-name is-quiet', text: 'No project' });
    const byNotes = this.projectOfMostNotes();
    if (byNotes) act(`Put in “${byNotes.name}”`, () => void host.setHome(byNotes.path).then(changed), true);
    if (host.linkedProject && host.linkedProject.path !== byNotes?.path) {
      const { linkedProject } = host;
      act(`Put in “${linkedProject.name}”`, () => void host.setHome(linkedProject.path).then(changed), !byNotes);
    }
    if (host.folderSuggestion) {
      const { folder } = host.folderSuggestion;
      act(`Make “${folder}” a project…`, () => host.makeProject(folder, changed));
    }
    act('Add to a project…', () => this.pickProject(host, 'Add this chat to…', null, changed));
  }

  /** The project whose folders hold most of the chat's notes, if any. */
  private projectOfMostNotes(): { path: string; name: string } | null {
    const { host } = this;
    if (!host) return null;
    const counts = new Map<string, { project: { path: string; name: string }; count: number }>();
    for (const { folder, count } of host.folders) {
      const project = host.projectHolding(folder);
      if (!project) continue;
      const entry = counts.get(project.path) ?? { project, count: 0 };
      entry.count += count;
      counts.set(project.path, entry);
    }
    const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    return best ? best.project : null;
  }

  /** Chooses a project from the vault's (see ProjectPicker), but `except`, to put the chat in. */
  private pickProject(host: ChatMapHost, placeholder: string, except: string | null, chosen: () => void): void {
    const projects = host.projects().filter((project) => project.path !== except);
    if (projects.length === 0) {
      new Notice('There is no other project yet.');
      return;
    }
    new ProjectPicker(this.app, projects, placeholder, (project) => void host.setHome(project.path).then(chosen)).open();
  }

  /**
   * What a folder offers, by the project holding it (see projectHolding): this chat's project, its note;
   * another project, putting the chat in it, and its note; a folder in no project, Make it a project; a
   * folder inside a project, nothing of its own (its notes count toward that project).
   */
  private folderActions(folder: string): { label: string; run: () => void }[] {
    const { host } = this;
    if (!host) return [];
    const project = host.projectHolding(folder);
    if (project && project.folder !== folder) return [];
    const show = (path: string) => ({ label: 'Show the project', run: () => void this.moveToProject(path) });
    // Look-only: a project can be looked at, nothing more.
    if (host.lookOnly) return project ? [show(project.path)] : [];
    if (project && project.path === host.ownProject?.path) return [show(project.path), { label: 'Open project note', run: () => host.openProjectNote(project.path) }];
    if (project)
      return [
        show(project.path),
        { label: host.ownProject ? 'Move chat here' : 'Put chat here', run: () => void host.setHome(project.path).then(() => this.refresh()) },
        { label: 'Open project note', run: () => host.openProjectNote(project.path) },
      ];
    if (!folder) return [];
    return [{ label: 'Make it a project…', run: () => host.makeProject(folder, () => void this.refresh()) }];
  }

  /**
   * A folder's menu: its project's actions (see folderActions), then, with `chats`, the chats that
   * worked in it, in the history; shown even when it has no project actions, with that item alone.
   */
  private folderMenu(folder: string, evt: MouseEvent, chats = true): void {
    const { host } = this;
    if (!host) return;
    const holding = host.projectHolding(folder);
    // A folder inside a project acts as the project does.
    const actions = this.folderActions(holding && holding.folder !== folder ? holding.folder : folder);
    if (chats) actions.push({ label: 'Chats in this folder', run: () => host.showChats(folderChatsQuery(folder)) });
    if (actions.length === 0) return;
    const menu = new Menu();
    for (const action of actions) menu.addItem((item) => item.setTitle(action.label).onClick(action.run));
    menu.showAtMouseEvent(evt);
  }

  /**
   * Centred on project `project`: the way back, its name and menu, putting the panel's chat in it or
   * taking it out (named), then its map: the project in the middle, its note previewed on ⌘-hover and
   * opened on a click; its chats round it; their notes outside.
   */
  private drawProjectCentre(project: ProjectMapHost): void {
    const { host } = this;
    if (!host) return;
    this.backButton();
    setIcon(this.barEl.createSpan({ cls: 'vc-project-group-icon' }), 'folder-kanban');
    this.barEl.createSpan({ cls: 'vc-map-bar-name', text: project.name, attr: { title: project.name } });
    iconButton(this.barEl, 'more-horizontal', 'Project actions', (evt) => this.projectMenu(project.path, evt));
    iconButton(this.barEl, 'square-pen', `New chat in “${project.name}”: its context goes with your first message`, () => project.newChatIn(project.path));
    const own = host.ownProject?.path === project.path;
    const chat = `“${shortLabel(host.baseline.title, 32)}”`;
    const chatAction = host.lookOnly ? null : this.actionEl.createEl('button', {
      cls: `vc-map-action${own ? '' : ' mod-cta'}`,
      text: own ? `Take ${chat} out` : host.ownProject ? `Move ${chat} here` : `Put ${chat} here`,
    });
    chatAction?.setAttr('aria-label', own ? `Takes “${host.baseline.title}”, the chat in the panel, out of this project.` : `“${host.baseline.title}”, the chat in the panel. ${HOME_TIP}`);
    chatAction?.addEventListener('click', () => void host.setHome(own ? null : project.path).then(() => this.refresh()));
    this.drawProjectMap(project, null);
  }

  /**
   * A project's map: the project in the middle, its chats round it, their notes outside. With
   * `focus`, a chat's map drawn on its project's: the chat among the others (added when not one of
   * them yet), its notes added too and drawn by how it used them, and the rest faded.
   */
  private drawProjectMap(project: ProjectMapHost, focus: { id: string; notes: MapNote[]; chats: MapChat[] } | null): void {
    const { host, mapEl, footEl } = this;
    if (!host) return;
    const me = focus?.id ?? null;
    const mine = new Map((focus?.notes ?? []).map((note) => [note.path, note.weight]));
    const chats = me && !project.chats.includes(me) ? [me, ...project.chats] : project.chats;
    const notes = [...project.notes, ...[...mine.keys()].filter((path) => !project.notes.includes(path))];
    const links: [string, string, number][] = me ? [...project.links.filter(([id]) => id !== me), ...[...mine].map(([path, weight]): [string, string, number] => [me, path, weight])] : project.links;
    if (chats.length === 0) {
      mapEl.createDiv({ cls: 'vc-project-empty', text: 'No chats have worked on notes in this project yet.' });
      return;
    }
    // With `focus`, the chats sharing its notes or linked with it that are not the project's: outside the notes, as on its own map.
    const outside = (focus?.chats ?? []).filter((chat) => !chats.includes(chat.id));
    const ring = noteRing(notes.length);
    const scale = ring / BASE_RING;
    const drawing = new MapDrawing(mapEl, 820 * scale, (outside.length > 0 ? 620 : 560) * scale);
    this.drawing = drawing;
    // Many chats and notes make many lines: faint until a chat or note is pointed at.
    drawing.root.addClass('is-quiet');
    // Grouped by the folder within the project; notes outside it by their own folder.
    // Folders outside it keyed by their path after a slash, so that none is taken for a subfolder of
    // the same name; notes at the top of the vault, a group of their own ('/'), not the project folder's ('').
    const TOP = '/';
    const within = (path: string) => {
      const folder = folderOf(path);
      if (folder === project.folder) return '';
      if (folder.startsWith(`${project.folder}/`)) return folder.slice(project.folder.length + 1);
      return `/${folder}`;
    };
    const inside = (path: string) => folderOf(path) === project.folder || folderOf(path).startsWith(`${project.folder}/`);
    const { angles, arcs, spans } = ringLayout(notes, within, 0.8, (path) => (inside(path) ? '' : null));
    // The folder a group stands for: the project's own (''), one in it, the top of the vault, one outside.
    const folderOfGroup = (sub: string) => (sub === '' ? project.folder : sub === TOP ? '' : sub.startsWith('/') ? sub.slice(1) : `${project.folder}/${sub}`);
    drawArcs(
      drawing,
      ring,
      arcs,
      spans,
      (sub, outer) => ({
        text: shortLabel(sub === TOP ? 'Top of the vault' : sub.startsWith('/') ? sub.slice(1) : sub || `◆ ${project.folder.slice(project.folder.lastIndexOf('/') + 1)}`, 22),
        // The project's own band (sub '') names its folder; its subfolders, their path; folders outside it, theirs.
        tip: `${folderOfGroup(sub) || 'Top of the vault'} · ${ARC_CLICK}`,
        cls: outer === '' || sub === '' ? 'is-home' : 'is-plain',
      }),
      (sub) => void this.moveToFolder(folderOfGroup(sub)),
      (sub, evt) => this.folderMenu(folderOfGroup(sub), evt),
    );
    // The chats on a small ring round the project, wider when there are many.
    const inner = Math.max(70, chats.length * 7);
    const chatAt = new Map(chats.map((id, i) => [id, polar((2 * Math.PI * i) / chats.length, inner)]));
    const noteAt = (path: string) => polar(angles.get(path) ?? 0, ring);
    for (const [id, path, weight] of links) {
      const from = chatAt.get(id);
      if (from && angles.has(path)) drawing.line(from, noteAt(path), [id, path], LINK_KINDS[weight] ?? 'mentioned');
    }
    const labels = new Map(placeLabels(notes.map((path) => ({ key: path, angle: angles.get(path) ?? 0, text: noteName(path) })), ring + ARC_WIDTH / 2 + 2, 26).map((label) => [label.key, label]));
    for (const path of notes) {
      const weight = mine.get(path);
      const group = drawing.note(path, noteAt(path), weight === undefined ? 'project' : (LINK_KINDS[weight] ?? 'mentioned'));
      const label = labels.get(path);
      if (label) drawing.label(group, label.at, label.side, label.text, 2, noteName(path));
      noteNode(group, path, project, this, (other) => void this.moveToNote(other));
    }
    for (const [id, at] of chatAt) {
      // Every chat here is in the project: its colour. The chat in the panel is marked, larger.
      const open = id === host.baseline.id;
      const group = drawing.chat(id, at, open ? 14 : 11, `is-same-project${open ? ' is-open-chat' : ''}`, project.isCodex(id));
      const touched = links.filter(([chat]) => chat === id).length;
      tooltip(group, `${project.titleOf(id)}${project.isCodex(id) ? ' · Codex' : ''}${open ? ' · the chat in the panel' : ''} · ${touched} note${touched === 1 ? '' : 's'} here${open ? '' : `\n${CHAT_CLICK}`}`);
      // Only the panel's chat is named on the map: the chats sit inside the ring of notes, where their
      // names ran into each other and into the notes'. The others are named in their tooltips.
      if (open) {
        const title = project.titleOf(id);
        drawing.label(group, at, at.x >= 0 ? 'right' : 'left', shortLabel(title, 28), 17, title, project.isCodex(id));
      }
      chatNode(group, id, project);
    }
    if (me) this.drawOutsideChats(drawing, project, me, outside, focus?.chats ?? [], chatAt, angles, ring);
    // The project in the middle: its note, previewed on ⌘-hover, opened on a click. Keyed apart from
    // the project note's own node on the ring, where a chat worked on it.
    const key = `project:${project.path}`;
    const node = drawing.node(key, 'is-project-node');
    drawing.place(key, { x: 0, y: 0 });
    svg(node, 'rect', { x: -16, y: -16, width: 32, height: 32, rx: 7 });
    svg(node, 'path', { d: 'M -8 -6 h 6 l 2 3 h 8 v 9 h -16 z', class: 'vc-map-bubble' });
    const title = svg(node, 'text', { x: 0, y: 32, 'text-anchor': 'middle' });
    title.textContent = shortLabel(project.name, 40);
    tooltip(node, `${project.name}: its note\nClick to open it`);
    node.addEventListener('click', () => project.openBeside(project.path));
    previewOnHover(node, (evt) => project.previewNote(project.path, evt, node, this));
    legend(footEl, drawing.drawn, me ? LEGEND : LEGEND.filter(([kind]) => ['edited', 'sent', 'mentioned', 'codex'].includes(kind)));
    const more = [project.moreChats > 0 ? `${project.moreChats} older chat${project.moreChats === 1 ? '' : 's'}` : '', project.moreNotes > 0 ? `${project.moreNotes} more note${project.moreNotes === 1 ? '' : 's'}` : ''].filter(Boolean);
    const lead = me ? `This chat’s notes in full, the rest of “${project.name}” faded. Point at a chat to see its notes.` : 'Point at a chat to see its notes.';
    showAll(footEl, `${lead}${more.length > 0 ? ` Not shown: ${more.join(' and ')}.` : ''}`, project.all, (all) => void this.refresh(all));
    if (me) drawing.focus(me, new Set([me, ...mine.keys(), ...outside.map((chat) => chat.id), key]));
  }

  /**
   * On a chat's map drawn on its project's (see drawProjectMap): the chats `outside` the project that
   * share the chat's notes or are linked with it, on a ring outside the notes, each line to a note
   * shared, and a line from the chat to each chat linked with it, in the project or not.
   */
  private drawOutsideChats(
    drawing: MapDrawing,
    project: ProjectMapHost,
    me: string,
    outside: MapChat[],
    all: MapChat[],
    inner: ReadonlyMap<string, Point>,
    angles: Map<string, number>,
    ring: number,
  ): void {
    const { host } = this;
    if (!host) return;
    const places = chatAngles(outside, angles);
    const outerAt = new Map(outside.map((chat) => [chat.id, polar(places.get(chat.id) ?? 0, ring + CHAT_GAP)]));
    const meAt = inner.get(me) ?? { x: 0, y: 0 };
    for (const chat of all) {
      const at = outerAt.get(chat.id) ?? inner.get(chat.id);
      if (!at) continue;
      if (outerAt.has(chat.id)) for (const path of chat.shared) if (angles.has(path)) drawing.line(at, polar(angles.get(path) ?? 0, ring), [chat.id, path], 'shared');
      if (chat.linked || chat.linkedFrom) drawing.line(meAt, at, [me, chat.id], 'linked');
    }
    const labels = new Map(placeLabels(outside.map((chat) => ({ key: chat.id, angle: places.get(chat.id) ?? 0, text: project.titleOf(chat.id) })), ring + CHAT_GAP, 26).map((label) => [label.key, label]));
    for (const chat of outside) {
      const at = outerAt.get(chat.id) ?? { x: 0, y: 0 };
      const other = host.projectOfChat(chat.id);
      // One of the project's chats not among those shown (older): the project's colour.
      const same = other === project.name;
      const group = drawing.chat(chat.id, at, 10, `${chat.linked ? 'is-linked' : ''}${same ? ' is-same-project' : ''}`, project.isCodex(chat.id));
      if (other && !same) {
        projectBadge(group, at, 10);
        drawing.drawn.add('badge');
      }
      const label = labels.get(chat.id);
      if (label) drawing.label(group, label.at, label.side, label.text, 14, project.titleOf(chat.id), project.isCodex(chat.id));
      const shared = `${chat.shared.length} shared note${chat.shared.length === 1 ? '' : 's'}`;
      tooltip(group, `${project.titleOf(chat.id)}${project.isCodex(chat.id) ? ' · Codex' : ''}${other ? ` · in “${other}”` : ''} · ${shared}${chat.linked ? ' · linked from this chat' : chat.linkedFrom ? ' · links to this chat' : ''}\n${CHAT_CLICK}`);
      chatNode(group, chat.id, project);
    }
  }

  /**
   * Centred on note `note`: the way back, its name and Open note, then its map: the note in the
   * middle, previewed on ⌘-hover and opened on a click; the chats linked to it round it, each line
   * the strongest of its links; the other notes those chats are linked to outside, by folder.
   */
  private drawNoteCentre(note: NoteMapHost): void {
    const { host, mapEl, footEl } = this;
    if (!host) return;
    this.backButton();
    setIcon(this.barEl.createSpan({ cls: 'vc-project-group-icon' }), 'file-text');
    this.barEl.createSpan({ cls: 'vc-map-bar-name', text: noteName(note.path), attr: { title: note.path } });
    const open = this.barEl.createEl('button', { cls: 'vc-map-action', text: 'Open note' });
    open.addEventListener('click', () => note.openNote(note.path, false));
    const ring = noteRing(note.notes.length);
    const scale = ring / BASE_RING;
    const drawing = new MapDrawing(mapEl, 820 * scale, 560 * scale);
    this.drawing = drawing;
    // Many chats and notes make many lines: faint until a chat or note is pointed at.
    drawing.root.addClass('is-quiet');
    // A project's folder holds its subfolders' arcs; each folder on its own side (see ringLayout).
    const { angles, arcs, spans } = ringLayout(note.notes, folderOf, 0.8, (path) => host.projectHolding(folderOf(path))?.folder ?? null);
    drawArcs(
      drawing,
      ring,
      arcs,
      spans,
      (folder) => {
        const project = host.projectHolding(folder);
        const name = folderName(folder);
        return {
          text: project && project.folder === folder ? `◆ ${shortLabel(name, 22)}` : shortLabel(name, 22),
          tip: `${folder || 'Top of the vault'}${project ? ` · in project “${project.name}”` : ''} · ${ARC_CLICK}`,
          cls: 'is-plain',
        };
      },
      (folder) => void this.moveToFolder(folder),
      (folder, evt) => this.folderMenu(folder, evt),
    );
    // The chats on a small ring round the note, wider when there are many.
    const inner = Math.max(70, note.chats.length * 7);
    const chatAt = new Map(note.chats.map(({ id }, i) => [id, polar((2 * Math.PI * i) / note.chats.length, inner)]));
    const noteAt = (path: string) => polar(angles.get(path) ?? 0, ring);
    const centre = { x: 0, y: 0 };
    for (const { id, weight } of note.chats) drawing.line(centre, chatAt.get(id) ?? centre, [note.path, id], LINK_KINDS[weight] ?? 'mentioned');
    for (const [id, path, weight] of note.links) {
      const from = chatAt.get(id);
      if (from && angles.has(path)) drawing.line(from, noteAt(path), [id, path], LINK_KINDS[weight] ?? 'mentioned');
    }
    const labels = new Map(placeLabels(note.notes.map((path) => ({ key: path, angle: angles.get(path) ?? 0, text: noteName(path) })), ring + ARC_WIDTH / 2 + 2, 26).map((label) => [label.key, label]));
    for (const path of note.notes) {
      const group = drawing.note(path, noteAt(path), 'project');
      const label = labels.get(path);
      if (label) drawing.label(group, label.at, label.side, label.text, 2, noteName(path));
      noteNode(group, path, note, this, (other) => void this.moveToNote(other));
    }
    const kinds: Record<number, string> = { 3: 'edited it', 2: 'was sent it', 1: 'mentioned it' };
    for (const { id, weight } of note.chats) {
      const at = chatAt.get(id) ?? centre;
      // The chat in the panel is marked, larger, and named; the others are named in their tooltips,
      // as on a project's map.
      const isOpen = id === host.baseline.id;
      const group = drawing.chat(id, at, isOpen ? 14 : 11, isOpen ? 'is-open-chat' : '', note.isCodex(id));
      const project = note.projectOfChat(id);
      tooltip(group, `${note.titleOf(id)}${note.isCodex(id) ? ' · Codex' : ''}${project ? ` · in “${project}”` : ''}${isOpen ? ' · the chat in the panel' : ''} · ${kinds[weight] ?? kinds[1]}${isOpen ? '' : `\n${CHAT_CLICK}`}`);
      if (isOpen) {
        const title = note.titleOf(id);
        drawing.label(group, at, at.x >= 0 ? 'right' : 'left', shortLabel(title, 28), 17, title, note.isCodex(id));
      }
      chatNode(group, id, note);
    }
    // The note in the middle: previewed on ⌘-hover, opened on a click, its menu on a right-click.
    // Keyed by its path, so that it glides from where it was on the map before.
    const node = drawing.node(note.path, 'is-note-centre');
    drawing.place(note.path, centre);
    svg(node, 'rect', { x: -16, y: -16, width: 32, height: 32, rx: 7 });
    svg(node, 'path', { d: 'M -6 -8 h 7 l 5 5 v 11 h -12 z', class: 'vc-map-bubble' });
    svg(node, 'path', { d: 'M 1 -8 v 5 h 5', class: 'vc-map-centre-fold' });
    const title = svg(node, 'text', { x: 0, y: 32, 'text-anchor': 'middle' });
    title.textContent = shortLabel(noteName(note.path), 40);
    tooltip(node, `${note.path}\nClick to open it; right-click for more`);
    node.addEventListener('click', () => note.openNote(note.path, false));
    previewOnHover(node, (evt) => note.previewNote(note.path, evt, node, this));
    node.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      noteMenu(note.path, note, evt);
    });
    if (note.chats.length === 0) {
      footEl.createDiv({ cls: 'vc-project-empty', text: 'No chats are linked to this note.' });
      return;
    }
    legend(footEl, drawing.drawn, LEGEND.filter(([kind]) => ['edited', 'sent', 'mentioned', 'codex'].includes(kind)));
    const more = [note.moreChats > 0 ? `${note.moreChats} more chat${note.moreChats === 1 ? '' : 's'}` : '', note.moreNotes > 0 ? `${note.moreNotes} more note${note.moreNotes === 1 ? '' : 's'}` : ''].filter(Boolean);
    showAll(footEl, `Point at a chat to see its notes.${more.length > 0 ? ` Not shown: ${more.join(' and ')}.` : ''}`, note.all, (all) => void this.refresh(all));
  }

  /**
   * Centred on folder `shown`: the way back, its name and, when it is a project's folder or in one, its
   * Project menu; then its map: the folder in the middle; the chats linked to its notes (in it or its
   * subfolders) round it, each line the strongest of its links; those notes outside, by subfolder, a
   * subfolder centring the map on it on a click.
   */
  private drawFolderCentre(shown: FolderMapHost): void {
    const { host, mapEl, footEl } = this;
    if (!host) return;
    const { folder } = shown;
    const path = folder || 'Top of the vault';
    this.backButton();
    setIcon(this.barEl.createSpan({ cls: 'vc-project-group-icon' }), 'folder');
    this.barEl.createSpan({ cls: 'vc-map-bar-name', text: folderName(folder), attr: { title: path } });
    const holding = host.projectHolding(folder);
    if (holding) {
      const menuButton = this.barEl.createEl('button', { cls: 'vc-map-action', attr: { 'aria-label': `In project “${holding.name}”` } });
      menuButton.appendText('Project');
      setIcon(menuButton.createSpan({ cls: 'vc-project-group-icon' }), 'chevron-down');
      menuButton.addEventListener('click', (evt) => this.folderMenu(folder, evt, false));
    }
    const ring = noteRing(shown.notes.length);
    const scale = ring / BASE_RING;
    const drawing = new MapDrawing(mapEl, 820 * scale, 560 * scale);
    this.drawing = drawing;
    // Many chats and notes make many lines: faint until a chat or note is pointed at.
    drawing.root.addClass('is-quiet');
    // Notes by their folder; a subfolder holding folders of its own spans their arcs (see ringLayout),
    // so that it can be clicked as a whole as well as each folder in it.
    const childOf = (note: string): string | null => {
      const own = folderOf(note);
      if (own === folder) return null;
      const first = (folder ? own.slice(folder.length + 1) : own).split('/')[0];
      return folder ? `${folder}/${first}` : first;
    };
    const nested = new Set(shown.notes.flatMap((note) => {
      const child = childOf(note);
      return child !== null && folderOf(note) !== child ? [child] : [];
    }));
    const { angles, arcs, spans } = ringLayout(shown.notes, folderOf, 0.8, (note) => {
      const child = childOf(note);
      return child !== null && nested.has(child) ? child : null;
    });
    drawArcs(
      drawing,
      ring,
      arcs,
      spans,
      (each, outer) => {
        const project = host.projectHolding(each);
        // The folder's own notes by its name; the others by their path from it (or from the subfolder spanning them).
        const from = outer ?? folder;
        const name = each === folder ? folderName(folder) : from ? each.slice(from.length + 1) : each;
        return {
          text: project && project.folder === each ? `◆ ${shortLabel(name, 22)}` : shortLabel(name, 22),
          tip: `${each || 'Top of the vault'}${project ? ` · in project “${project.name}”` : ''} · ${each === folder ? 'its own notes · right-click for more' : ARC_CLICK}`,
          cls: 'is-plain',
        };
      },
      (each) => {
        if (each !== folder) void this.moveToFolder(each);
      },
      (each, evt) => this.folderMenu(each, evt),
    );
    // The chats on a small ring round the folder, wider when there are many.
    const inner = Math.max(70, shown.chats.length * 7);
    const chatAt = new Map(shown.chats.map(({ id }, i) => [id, polar((2 * Math.PI * i) / shown.chats.length, inner)]));
    const noteAt = (note: string) => polar(angles.get(note) ?? 0, ring);
    const centre = { x: 0, y: 0 };
    const key = `folder:${folder}`;
    for (const { id, weight } of shown.chats) drawing.line(centre, chatAt.get(id) ?? centre, [key, id], LINK_KINDS[weight] ?? 'mentioned');
    for (const [id, note, weight] of shown.links) {
      const from = chatAt.get(id);
      if (from && angles.has(note)) drawing.line(from, noteAt(note), [id, note], LINK_KINDS[weight] ?? 'mentioned');
    }
    const labels = new Map(placeLabels(shown.notes.map((note) => ({ key: note, angle: angles.get(note) ?? 0, text: noteName(note) })), ring + ARC_WIDTH / 2 + 2, 26).map((label) => [label.key, label]));
    for (const note of shown.notes) {
      const group = drawing.note(note, noteAt(note), 'project');
      const label = labels.get(note);
      if (label) drawing.label(group, label.at, label.side, label.text, 2, noteName(note));
      noteNode(group, note, shown, this, (other) => void this.moveToNote(other));
    }
    const kinds: Record<number, string> = { 3: 'edited a note here', 2: 'was sent a note here', 1: 'mentioned a note here' };
    for (const { id, weight } of shown.chats) {
      const at = chatAt.get(id) ?? centre;
      // The chat in the panel is marked, larger, and named; the others are named in their tooltips,
      // as on a note's map.
      const isOpen = id === host.baseline.id;
      const group = drawing.chat(id, at, isOpen ? 14 : 11, isOpen ? 'is-open-chat' : '', shown.isCodex(id));
      const project = shown.projectOfChat(id);
      const touched = shown.links.filter(([chat]) => chat === id).length;
      tooltip(group, `${shown.titleOf(id)}${shown.isCodex(id) ? ' · Codex' : ''}${project ? ` · in “${project}”` : ''}${isOpen ? ' · the chat in the panel' : ''} · ${kinds[weight] ?? kinds[1]} · ${touched} note${touched === 1 ? '' : 's'} on the map${isOpen ? '' : `\n${CHAT_CLICK}`}`);
      if (isOpen) {
        const title = shown.titleOf(id);
        drawing.label(group, at, at.x >= 0 ? 'right' : 'left', shortLabel(title, 28), 17, title, shown.isCodex(id));
      }
      chatNode(group, id, shown);
    }
    // The folder in the middle: a folder on a square, outlined where a note's is filled; its menu on a
    // click or a right-click.
    const node = drawing.node(key, 'is-folder-centre');
    drawing.place(key, centre);
    svg(node, 'rect', { x: -16, y: -16, width: 32, height: 32, rx: 7 });
    svg(node, 'path', { d: 'M -9 -7 h 6 l 2 3 h 10 v 11 h -18 z', class: 'vc-map-bubble' });
    const title = svg(node, 'text', { x: 0, y: 32, 'text-anchor': 'middle' });
    title.textContent = shortLabel(folderName(folder), 40);
    tooltip(node, `${path}${holding ? ` · in project “${holding.name}”` : ''}\nClick or right-click for more`);
    node.addEventListener('click', (evt) => this.folderMenu(folder, evt));
    node.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      this.folderMenu(folder, evt);
    });
    if (shown.chats.length === 0) {
      footEl.createDiv({ cls: 'vc-project-empty', text: 'No chats are linked to notes in this folder.' });
      return;
    }
    legend(footEl, drawing.drawn, LEGEND.filter(([kind]) => ['edited', 'sent', 'mentioned', 'codex'].includes(kind)));
    const more = [shown.moreChats > 0 ? `${shown.moreChats} more chat${shown.moreChats === 1 ? '' : 's'}` : '', shown.moreNotes > 0 ? `${shown.moreNotes} more note${shown.moreNotes === 1 ? '' : 's'}` : ''].filter(Boolean);
    showAll(footEl, `Point at a chat to see its notes.${more.length > 0 ? ` Not shown: ${more.join(' and ')}.` : ''}`, shown.all, (all) => void this.refresh(all));
  }
}

export interface ProjectMapHost extends MapActions {
  name: string;
  /** The project note: the node in the middle, previewed on ⌘-hover, opened beside on a click. */
  path: string;
  openBeside(path: string): void;
  /** The project's folder: its notes are grouped by the folders in it. */
  folder: string;
  chats: string[];
  notes: string[];
  /** Which chat worked on which note, and how (see LINK_WEIGHTS). */
  links: [string, string, number][];
  /** Chats in the project not shown. */
  moreChats: number;
  /** Notes not shown. */
  moreNotes: number;
  /** Whether it shows every chat and note. */
  all: boolean;
  /** The map's data again; with `all`, every chat and note (see projectMap). */
  reload(all: boolean): Promise<ProjectMapHost>;
}

export interface NoteMapHost extends MapActions {
  /** The note: the node in the middle, previewed on ⌘-hover, opened on a click. */
  path: string;
  /** The chats linked to it, each by its strongest link (see LINK_WEIGHTS). */
  chats: { id: string; weight: number }[];
  /** The other notes those chats are linked to, hubs left out (see noteMap). */
  notes: string[];
  /** Which chat worked on which of those notes, and how (see LINK_WEIGHTS). */
  links: [string, string, number][];
  /** Chats linked to it not shown. */
  moreChats: number;
  /** Notes not shown. */
  moreNotes: number;
  /** Whether it shows every chat and note. */
  all: boolean;
  /** The map's data again; with `all`, every chat and note (see noteMap). */
  reload(all: boolean): Promise<NoteMapHost>;
}

export interface FolderMapHost extends MapActions {
  /** The folder: the node in the middle ('' the top of the vault). */
  folder: string;
  /** The chats linked to notes in it or its subfolders, each by its strongest link (see LINK_WEIGHTS). */
  chats: { id: string; weight: number }[];
  /** Those notes, hubs left out (see folderMap). */
  notes: string[];
  /** Which chat worked on which of those notes, and how (see LINK_WEIGHTS). */
  links: [string, string, number][];
  /** Chats linked to its notes not shown. */
  moreChats: number;
  /** Notes not shown. */
  moreNotes: number;
  /** Whether it shows every chat and note. */
  all: boolean;
  /** The map's data again; with `all`, every chat and note (see folderMap). */
  reload(all: boolean): Promise<FolderMapHost>;
}
