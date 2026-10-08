// The Connections pane, drawn (see connections.ts): the map of the chat in the Claude panel, which
// it follows, centred on that chat (its notes and the chats that share them) or on a project (its
// chats and their notes). Plain SVG. Notes are squares with a page glyph,
// chats circles with a speech bubble, folders arcs behind their notes. A note opens in a new tab on a
// click and shows Obsidian's page preview on ⌘-hover; a chat opens in the panel on a click, and a
// right-click offers to mention, link or unlink it; a folder's arc offers
// its project, or to make it one.
import { ItemView, Menu, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { ProjectPicker } from './projectModals';
import { folderOf } from './chatFolders';
import { chatAngles, noteRing, placeLabels, polar, ringLayout, shortLabel, type MapChat, type MapNote, type Point, type RingArc } from './connections';

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
  openNote(path: string, newTab: boolean): void;
  previewNote(path: string, event: MouseEvent | KeyboardEvent, target: Element, parent: unknown): void;
  openChat(id: string): void;
  /** Whether the chat the map is from links to chat `id`; null when there is none (a project's map with no chat on screen). */
  linked(id: string): boolean | null;
  link(id: string, on: boolean): void;
  /** The project each chat is in, by name, if any. */
  projectOfChat(id: string): string | null;
  /** Adds a link to chat `id` to the message being typed in the panel. */
  mentionChat(id: string): void;
}


export interface ChatMapHost extends MapActions {
  title: string;
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
  /** The chat the map is centred on: the chat on screen, unless moved to another. */
  centre: string;
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
      const units = this.view.w / this.root.getBoundingClientRect().width;
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

  /** A chat: a circle with a speech bubble. */
  chat(key: string, at: Point, r: number, cls: string): SVGGElement {
    const group = this.node(key, `is-chat ${cls}`);
    this.place(key, at);
    svg(group, 'circle', { cx: at.x, cy: at.y, r });
    const s = r / 10;
    svg(group, 'path', { d: `M ${at.x - 5 * s} ${at.y - 4 * s} h ${10 * s} v ${6 * s} h ${-6 * s} l ${-3 * s} ${3 * s} v ${-3 * s} h ${-1 * s} z`, class: 'vc-map-bubble' });
    return group;
  }

  /** A label beside a node, on its outer side; `full`, the text it shortens, shown whole while the node is pointed at. */
  label(group: SVGGElement, at: Point, side: 'right' | 'left', text: string, gap = 10, full = text): void {
    const label = svg(group, 'text', { x: at.x + (side === 'right' ? gap : -gap), y: at.y + 4, 'text-anchor': side === 'right' ? 'start' : 'end' });
    label.textContent = text;
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

/**
 * Shows Obsidian's page preview for `el` once per entry, or when ⌘ is pressed while over it. Not on
 * every mouseover: those repeat as the pointer crosses the node's parts, and each preview asked for
 * replaces the one open, which then showed and went away.
 */
function previewOnHover(el: SVGGElement, show: (evt: MouseEvent | KeyboardEvent) => void): void {
  const key = (evt: KeyboardEvent) => {
    // Drawn away under the pointer (the map redrawn), which no mouseleave says: the listener goes.
    if (!el.isConnected) return el.doc.removeEventListener('keydown', key);
    if (evt.key === 'Meta' || evt.key === 'Control') show(evt);
  };
  el.addEventListener('mouseenter', (evt) => {
    show(evt);
    el.doc.addEventListener('keydown', key);
  });
  el.addEventListener('mouseleave', () => el.doc.removeEventListener('keydown', key));
}

/** Makes a note open in a new tab on a click and show Obsidian's preview on ⌘-hover, its path in its tooltip. */
function noteNode(group: SVGGElement, path: string, actions: MapActions, parent: unknown, hub = false): void {
  tooltip(group, hub ? `${path}\nA hub: linked to many chats, so it joins none of them on the map, and counts little toward a chat's project` : path);
  group.toggleClass('is-hub', hub);
  group.addEventListener('click', () => actions.openNote(path, true));
  previewOnHover(group, (evt) => actions.previewNote(path, evt, group, parent));
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
 * marked for another project's, each labelled inside the ring; `click` acts on one. `spans`, the
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
 * outside. Nodes on both the map before and the one after glide from one place to the other. Each
 * move to a project and back is a step in the tab's history, for its ← and →.
 */
export class ConnectionsView extends ItemView {
  /** The map of the panel's chat (null: no chat with connections in the panel). */
  private host: ChatMapHost | null = null;
  /** The map centred on a project, when it is. */
  private project: ProjectMapHost | null = null;
  /** The map drawn last: where its nodes were, for the next to glide from. */
  private drawing: MapDrawing | null = null;
  private barEl!: HTMLElement;
  private actionEl!: HTMLElement;
  private mapEl!: HTMLElement;
  private footEl!: HTMLElement;
  private linksEl!: HTMLElement;
  /** Whether the links are unfolded, kept from one map to the next. */
  private linksOpen = false;
  /** Each change of map counts: a map read for an earlier one is not drawn. */
  private generation = 0;

  constructor(
    leaf: WorkspaceLeaf,
    /** Asks for the map of the panel's chat (see follow), once the pane is open. */
    private readonly opened: (view: ConnectionsView) => void,
  ) {
    super(leaf);
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
    this.draw();
    this.opened(this);
  }

  async onClose(): Promise<void> {
    this.stopLinks();
    this.contentEl.empty();
  }

  /** Shows the map of the panel's chat (`host`; null, none), or with `atProject`, that project's. */
  async follow(host: ChatMapHost | null, atProject: string | null = null): Promise<void> {
    const generation = ++this.generation;
    const project = host && atProject ? await host.projectMap(atProject) : null;
    if (generation !== this.generation) return;
    this.host = host;
    this.project = project;
    this.draw();
  }

  /** Reads the map shown again and draws it in place: after its data changed. */
  async refresh(all?: boolean): Promise<void> {
    // Not a move: one under way is not cancelled by it (its step is already in the tab's history),
    // and what is read here is dropped if the map moved meanwhile. The chat's map is read again too
    // when a project is shown, as what it says of the chat (its project) may have changed.
    const generation = this.generation;
    const { host, project } = this;
    const [nextHost, nextProject] = await Promise.all([
      host ? host.reload(project ? host.all : (all ?? host.all)) : null,
      project ? project.reload(all ?? project.all) : null,
    ]);
    if (generation !== this.generation) return;
    // What the map shows, its functions left out (JSON drops them): unchanged, it is not drawn
    // again, so a node pointed at keeps its tooltip and label rather than being replaced under the
    // pointer by each refresh while a chat works. The links under it are drawn again all the same.
    const key = (map: unknown) => JSON.stringify(map);
    const same = key([host, project]) === key([nextHost ?? host, nextProject ?? project]);
    if (nextHost) this.host = nextHost;
    if (nextProject) this.project = nextProject;
    if (same) this.links?.redraw();
    else this.draw();
  }

  /**
   * Where the map is centred, as the tab's history keeps it: the panel's chat, or a project. Obsidian asks for it before each move, to put on the tab's ← list.
   */
  getState(): Record<string, unknown> {
    return { centre: this.host?.centre ?? null, project: this.project?.path ?? null };
  }

  /**
   * Centres the map where `state` says: a move made here (see go), which then becomes a step in
   * the tab's history, or the tab's ← or → going back to one.
   */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (this.going) result.history = true;
    const place = (state ?? {}) as { centre?: unknown; project?: unknown };
    if (typeof place.project === 'string') await this.showProject(place.project);
    else this.showOwn();
  }

  /** A move made in the pane, under way (see go). */
  private going = false;

  /** Moves the map to `place` as a step in the tab's history, so that its ← comes back here. */
  private async go(place: { centre: string | null; project: string | null }): Promise<void> {
    if (!this.host) return;
    this.going = true;
    try {
      await this.leaf.setViewState({ type: CONNECTIONS_VIEW_TYPE, state: place });
    } finally {
      this.going = false;
    }
  }

  /** The map of the panel's chat again, not as a step of its own (a step back, a project gone). */
  private showOwn(): void {
    if (!this.host) return;
    ++this.generation;
    this.project = null;
    this.draw();
  }

  /** Back to the map of the panel's chat, as a step in the tab's history. */
  private backToChat(): Promise<void> {
    return this.host ? this.go({ centre: this.host.baseline.id, project: null }) : Promise.resolve();
  }

  /** Centres the map on project `path`. */
  private moveToProject(path: string): Promise<void> {
    return this.go({ centre: this.host?.centre ?? null, project: path });
  }

  /** Centres the map on project `path` (see moveToProject), not as a step of its own. */
  private async showProject(path: string): Promise<void> {
    if (!this.host) return;
    const generation = ++this.generation;
    // Gone since (a step in the tab's history to a project deleted or renamed): the chat's map instead.
    const project = await this.host.projectMap(path).catch(() => null);
    if (generation !== this.generation) return;
    if (!project) return this.showOwn();
    this.project = project;
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
    const previous = this.drawing?.positions ?? new Map<string, Point>();
    this.drawing = null;
    for (const el of [this.barEl, this.actionEl, this.mapEl, this.footEl]) el.empty();
    const { host } = this;
    // The links stay while the map is redrawn for the same chat, drawn again in place: a summary of a
    // linked chat still being written is not stopped by the map changing around it.
    if (this.links && this.links.chat !== host?.baseline.id) this.stopLinks();
    if (!host) {
      this.barEl.createSpan({ cls: 'vc-map-bar-name', text: 'No chat' });
      this.mapEl.createDiv({ cls: 'vc-project-empty', text: 'Open a chat in the Claude panel: its connections show here, and follow it as you change chat.' });
      return;
    }
    if (this.project) this.drawProjectCentre(this.project);
    else this.drawOwn();
    // Set by the drawing above, which TypeScript does not follow.
    (this.drawing as MapDrawing | null)?.glide(previous);
    if (this.links) return this.links.redraw();
    if (host.lookOnly) {
      this.linksEl.empty();
      this.linksEl.createDiv({ cls: 'vc-project-empty', text: 'Links between chats can be made once you send this chat a message.' });
      return;
    }
    const links = this.linksEl.createEl('details');
    links.open = this.linksOpen;
    links.createEl('summary', { text: `Links of “${shortLabel(host.baseline.title, 50)}”` });
    links.addEventListener('toggle', () => (this.linksOpen = links.open));
    this.links = { ...host.drawLinks(links.createDiv()), chat: host.baseline.id };
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
    this.barEl.createSpan({ cls: 'vc-map-bar-name', text: host.title, attr: { title: host.title } });
    this.drawProjectBar(this.actionEl);
    this.drawChatMap(host);
  }

  /** A chat's map: the chat in the middle, its notes round it, the chats sharing them outside. */
  private drawChatMap(host: ChatMapHost): void {
    const { mapEl, footEl } = this;
    if (host.notes.length === 0 && host.chats.length === 0) {
      mapEl.createDiv({ cls: 'vc-project-empty', text: 'This chat has worked on no notes yet, and links to no chats.' });
      return;
    }
    const ring = noteRing(host.notes.length);
    const scale = ring / BASE_RING;
    const drawing = new MapDrawing(mapEl, 820 * scale, 620 * scale);
    this.drawing = drawing;
    // A project's folder holds its subfolders' arcs; each folder on its own side (see ringLayout).
    const { angles, arcs, spans } = ringLayout(host.notes.map((note) => note.path), folderOf, 0.8, (path) => host.projectHolding(folderOf(path))?.folder ?? null, true);
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
        const name = folder.slice(folder.lastIndexOf('/') + 1) || 'Top of the vault';
        return {
          // Every arc by its folder's name, a project's own folder marked ◆ (its project is named in the tooltip).
          text: project && project.folder === folder ? `◆ ${shortLabel(name, 22)}` : shortLabel(name, 22),
          tip: `${folder || 'Top of the vault'}${project ? ` · in project “${project.name}”` : ''} · click for its project`,
          cls: own ? 'is-home' : project ? 'is-other' : 'is-plain',
        };
      },
      (folder, evt) => this.folderMenu(folder, evt),
    );
    const me = host.centre;
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
      noteNode(group, note.path, host, this, host.hubs.has(note.path));
    }
    const chatLabels = new Map(placeLabels(host.chats.map((chat) => ({ key: chat.id, angle: placesOfChats.get(chat.id) ?? 0, text: host.titleOf(chat.id) })), ring + CHAT_GAP, 26).map((label) => [label.key, label]));
    for (const chat of host.chats) {
      const at = chatAt(chat.id);
      const project = host.projectOfChat(chat.id);
      const other = project !== null && project !== host.project?.name;
      // A chat in this chat's project takes the project's colour.
      const same = project !== null && project === host.project?.name;
      if (same) drawing.drawn.add('same');
      const group = drawing.chat(chat.id, at, 10, `${chat.linked ? 'is-linked' : ''}${same ? ' is-same-project' : ''}`);
      if (other) {
        projectBadge(group, at, 10);
        drawing.drawn.add('badge');
      }
      const label = chatLabels.get(chat.id);
      if (label) drawing.label(group, label.at, label.side, label.text, 14, host.titleOf(chat.id));
      const shared = `${chat.shared.length} shared note${chat.shared.length === 1 ? '' : 's'}`;
      tooltip(group, `${host.titleOf(chat.id)}${project ? ` · in “${project}”` : ''} · ${shared}${chat.linked ? ' · linked from this chat' : chat.linkedFrom ? ' · links to this chat' : ''}\n${CHAT_CLICK}`);
      chatNode(group, chat.id, host);
    }
    const centreNode = drawing.chat(me, centre, 18, 'is-centre');
    const title = svg(centreNode, 'text', { x: 0, y: 34, 'text-anchor': 'middle' });
    title.textContent = shortLabel(host.title, 40);
    tooltip(centreNode, host.project ? `${host.title} · in “${host.project.name}”` : host.title);
    legend(footEl, drawing.drawn, LEGEND);
    const more = [host.moreNotes > 0 ? `${host.moreNotes} more note${host.moreNotes === 1 ? '' : 's'}` : '', host.moreChats > 0 ? `${host.moreChats} more chat${host.moreChats === 1 ? '' : 's'}` : ''].filter(Boolean);
    showAll(footEl, more.length > 0 ? `Not shown: ${more.join(' and ')}.` : '', host.all, (all) => void this.refresh(all));
  }

  /**
   * A project's menu: centre on it (when not already), its note, its Context written anew or sent again
   * with the chat's next message (its own project's), another folder, a new name, deletion.
   */
  private projectMenu(path: string, evt: MouseEvent): void {
    const { host } = this;
    if (!host) return;
    const menu = new Menu();
    const add = (title: string, icon: string, run: () => void) => menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(run));
    if (this.project?.path !== path) add('Show the project', 'locate-fixed', () => void this.moveToProject(path));
    add('Open project note', 'file-text', () => host.openProjectNote(path));
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
    if (host.lookOnly) {
      if (host.project) {
        const { project } = host;
        const name = bar.createEl('a', { cls: 'vc-map-bar-name', text: project.name, attr: { 'aria-label': 'Show the project’s map' } });
        name.addEventListener('click', () => void this.moveToProject(project.path));
      } else bar.createSpan({ cls: 'vc-map-bar-name is-quiet', text: 'No project' });
      bar.createSpan({ cls: 'vc-project-size', text: 'Look only: send this chat a message to put it in a project or link it.' });
      return;
    }
    if (host.project) {
      const { project } = host;
      const name = bar.createEl('a', { cls: 'vc-map-bar-name', text: project.name, attr: { 'aria-label': 'Show the project’s map' } });
      name.addEventListener('click', () => void this.moveToProject(project.path));
      const menuButton = bar.createEl('button', { cls: 'vc-map-action' });
      menuButton.appendText('Project');
      setIcon(menuButton.createSpan({ cls: 'vc-project-group-icon' }), 'chevron-down');
      menuButton.addEventListener('click', (evt) => this.projectMenu(project.path, evt));
      act('Move…', () => this.pickProject(host, 'Move this chat to…', project.path, changed));
      act('Take out', () => void host.setHome(null).then(changed));
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
  private folderActions(folder: string): { label: string; tip?: string; run: () => void }[] {
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
        { label: host.ownProject ? 'Move chat here' : 'Put chat here', tip: HOME_TIP, run: () => void host.setHome(project.path).then(() => this.refresh()) },
        { label: 'Open project note', run: () => host.openProjectNote(project.path) },
      ];
    if (!folder) return [];
    return [{ label: 'Make it a project…', run: () => host.makeProject(folder, () => void this.refresh()) }];
  }

  private folderMenu(folder: string, evt: MouseEvent): void {
    const holding = this.host?.projectHolding(folder) ?? null;
    // A folder inside a project acts as the project does.
    const actions = this.folderActions(holding && holding.folder !== folder ? holding.folder : folder);
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
    const { host, mapEl, footEl } = this;
    if (!host) return;
    this.backButton();
    setIcon(this.barEl.createSpan({ cls: 'vc-project-group-icon' }), 'folder-kanban');
    this.barEl.createSpan({ cls: 'vc-map-bar-name', text: project.name, attr: { title: project.name } });
    const menuButton = this.barEl.createEl('button', { cls: 'vc-map-action' });
    menuButton.appendText('Project');
    setIcon(menuButton.createSpan({ cls: 'vc-project-group-icon' }), 'chevron-down');
    menuButton.addEventListener('click', (evt) => this.projectMenu(project.path, evt));
    const own = host.ownProject?.path === project.path;
    const chat = `“${shortLabel(host.baseline.title, 32)}”`;
    const chatAction = host.lookOnly ? null : this.actionEl.createEl('button', {
      cls: `vc-map-action${own ? '' : ' mod-cta'}`,
      text: own ? `Take ${chat} out` : host.ownProject ? `Move ${chat} here` : `Put ${chat} here`,
    });
    chatAction?.setAttr('aria-label', own ? `Takes “${host.baseline.title}”, the chat in the panel, out of this project.` : `“${host.baseline.title}”, the chat in the panel. ${HOME_TIP}`);
    chatAction?.addEventListener('click', () => void host.setHome(own ? null : project.path).then(() => this.refresh()));
    if (project.chats.length === 0) {
      mapEl.createDiv({ cls: 'vc-project-empty', text: 'No chats have worked on notes in this project yet.' });
      return;
    }
    const ring = noteRing(project.notes.length);
    const scale = ring / BASE_RING;
    const drawing = new MapDrawing(mapEl, 820 * scale, 560 * scale);
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
    const { angles, arcs, spans } = ringLayout(project.notes, within, 0.8, (path) => (inside(path) ? '' : null), true);
    drawArcs(drawing, ring, arcs, spans, (sub, outer) => ({
      text: shortLabel(sub === TOP ? 'Top of the vault' : sub.startsWith('/') ? sub.slice(1) : sub || `◆ ${project.folder.slice(project.folder.lastIndexOf('/') + 1)}`, 22),
      // The project's own band (sub '') names its folder; its subfolders, their path; folders outside it, theirs.
      tip: sub === '' ? project.folder : sub === TOP ? 'Top of the vault' : sub.startsWith('/') ? sub.slice(1) : `${project.folder}/${sub}`,
      cls: outer === '' || sub === '' ? 'is-home' : 'is-plain',
    }));
    // The chats on a small ring round the project, wider when there are many.
    const inner = Math.max(70, project.chats.length * 7);
    const chatAt = new Map(project.chats.map((id, i) => [id, polar((2 * Math.PI * i) / project.chats.length, inner)]));
    const noteAt = (path: string) => polar(angles.get(path) ?? 0, ring);
    for (const [id, path, weight] of project.links) {
      const from = chatAt.get(id);
      if (from && angles.has(path)) drawing.line(from, noteAt(path), [id, path], LINK_KINDS[weight] ?? 'mentioned');
    }
    const labels = new Map(placeLabels(project.notes.map((path) => ({ key: path, angle: angles.get(path) ?? 0, text: noteName(path) })), ring + ARC_WIDTH / 2 + 2, 26).map((label) => [label.key, label]));
    for (const path of project.notes) {
      const group = drawing.note(path, noteAt(path), 'project');
      const label = labels.get(path);
      if (label) drawing.label(group, label.at, label.side, label.text, 2, noteName(path));
      noteNode(group, path, project, this);
    }
    for (const [id, at] of chatAt) {
      // Every chat here is in the project: its colour. The chat in the panel is marked, larger.
      const open = id === host.baseline.id;
      const group = drawing.chat(id, at, open ? 14 : 11, `is-same-project${open ? ' is-open-chat' : ''}`);
      const touched = project.links.filter(([chat]) => chat === id).length;
      tooltip(group, `${project.titleOf(id)}${open ? ' · the chat in the panel' : ''} · ${touched} note${touched === 1 ? '' : 's'} here${open ? '' : `\n${CHAT_CLICK}`}`);
      // Its name beside it, on the side away from the middle, shortened (in full on hover).
      const title = project.titleOf(id);
      drawing.label(group, at, at.x >= 0 ? 'right' : 'left', shortLabel(title, 24), 14, title);
      chatNode(group, id, project);
    }
    // The project in the middle: its note, previewed on ⌘-hover, opened on a click.
    const node = drawing.node(project.path, 'is-project-node');
    drawing.place(project.path, { x: 0, y: 0 });
    svg(node, 'rect', { x: -16, y: -16, width: 32, height: 32, rx: 7 });
    svg(node, 'path', { d: 'M -8 -6 h 6 l 2 3 h 8 v 9 h -16 z', class: 'vc-map-bubble' });
    const title = svg(node, 'text', { x: 0, y: 32, 'text-anchor': 'middle' });
    title.textContent = shortLabel(project.name, 40);
    tooltip(node, `${project.name}: its note\nClick to open it`);
    node.addEventListener('click', () => project.openBeside(project.path));
    previewOnHover(node, (evt) => project.previewNote(project.path, evt, node, this));
    legend(footEl, drawing.drawn, LEGEND.filter(([kind]) => ['edited', 'sent', 'mentioned'].includes(kind)));
    const more = [project.moreChats > 0 ? `${project.moreChats} older chat${project.moreChats === 1 ? '' : 's'}` : '', project.moreNotes > 0 ? `${project.moreNotes} more note${project.moreNotes === 1 ? '' : 's'}` : ''].filter(Boolean);
    showAll(footEl, `Point at a chat to see its notes.${more.length > 0 ? ` Not shown: ${more.join(' and ')}.` : ''}`, project.all, (all) => void this.refresh(all));
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
