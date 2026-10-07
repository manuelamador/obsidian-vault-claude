// The Connections map, drawn (see connections.ts): one window, centred on a chat (its notes and the
// chats that share them) or on a project (its chats and their notes), with a trail back. Plain SVG. Notes are squares with a page glyph,
// chats circles with a speech bubble, folders arcs behind their notes. A note opens in a new tab on a
// click and shows Obsidian's page preview on ⌘-hover; a chat offers to open, mention, link or unlink
// it; a folder's arc offers its project, or to make it one. The map stays open through all of these,
// drawn again when what it shows changed; Esc, its close button or a click outside closes it.
import { Menu, Modal, setIcon, type App } from 'obsidian';
import { folderOf } from './chatFolders';
import { chatAngles, noteRing, placeLabels, polar, ringLayout, shortLabel, type MapChat, type MapNote, type Point, type RingArc } from './connections';

const SVG = 'http://www.w3.org/2000/svg';
/** What Link does, said where it is offered. */
const LINK_TIP = 'Link: connects the two chats so you can jump between them; both show it. Nothing is sent unless you tick Include in the links under this chat’s map, which sends a short digest of it once.';
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
  /** Adds a link to chat `id`, or an @-mention of note `path`, to the message being typed in the panel. */
  mentionChat(id: string): void;
  mentionNote(path: string): void;
  /** Rebuilds every chat's links to notes from its session file, after asking; `done` runs after. */
  rebuild(done: () => void): void;
}

/** What the map's search finds: chats, projects and notes whose names hold the words typed. */
export interface SearchHit {
  kind: 'chat' | 'project' | 'note';
  /** A chat's id, or a project's or note's path. */
  key: string;
  label: string;
  detail: string;
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
  /** The chat's links, drawn into `el` (see LinksList), under the map of the chat on screen; the function returned stops what they still run (a summary). */
  drawLinks(el: HTMLElement): () => void;
  search(query: string): SearchHit[];
  /** Makes project `path` the chat's home (null: takes it out). */
  setHome(path: string | null): Promise<void>;
  /** The project whose folder holds `folder` (the deepest), if any: what its notes count toward. */
  projectHolding(folder: string): { path: string; name: string; folder: string } | null;
  /** The map's data again, after something it shows changed; with `all`, every note and chat (see chatMap). */
  reload(all: boolean): Promise<ChatMapHost>;
  /** The map centred on another chat (`centre`), its actions still the chat on screen's (`baseline`). */
  recentre(centre: string): Promise<ChatMapHost>;
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

/** A hover tooltip on `el`: SVG's own `<title>`. */
function tooltip(el: Element, text: string): void {
  svg(el, 'title').textContent = text;
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

  /** The whole map, and the part of it in view (zoomed in, a smaller box within it). */
  private readonly whole: ViewBox;
  private view: ViewBox;

  constructor(parent: HTMLElement, width: number, height: number) {
    const frame = parent.createDiv({ cls: 'vc-map-frame' });
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
    // Full screen: the dialog fills the window, until clicked again (or the dialog closes).
    const modal = frame.closest('.modal');
    if (modal) {
      const full = controls.createEl('button', { cls: 'clickable-icon' });
      const draw = () => {
        const on = modal.hasClass('is-full');
        setIcon(full, on ? 'minimize-2' : 'maximize-2');
        full.setAttr('aria-label', on ? 'Leave full screen' : 'Full screen');
      };
      draw();
      full.addEventListener('click', () => {
        modal.toggleClass('is-full', !modal.hasClass('is-full'));
        draw();
      });
    }
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

  line(from: Point, to: Point, ends: [string, string], kind: string): void {
    this.drawn.add(kind);
    this.ties.push({ line: svg(this.lines, 'line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: `vc-map-line is-${kind}` }), ends });
  }

  /** A node's group, lit with its lines when pointed at. */
  node(key: string, cls: string): SVGGElement {
    const group = svg(this.nodes, 'g', { class: `vc-map-node ${cls}`, tabindex: 0 });
    group.addEventListener('mouseenter', () => {
      this.light(key);
      this.showFull(group);
    });
    group.addEventListener('mouseleave', () => {
      this.light(null);
      this.showFull(null);
    });
    this.groups.set(key, group);
    return group;
  }

  /** A note: a page with a folded corner. */
  note(key: string, at: Point, kind: string): SVGGElement {
    this.drawn.add(`note-${kind}`);
    const group = this.node(key, `is-note is-${kind}`);
    svg(group, 'path', { d: `M ${at.x - 6} ${at.y - 7} h 8 l 4 4 v 10 h -12 z`, class: 'vc-map-page' });
    svg(group, 'path', { d: `M ${at.x + 2} ${at.y - 7} v 4 h 4`, class: 'vc-map-fold' });
    return group;
  }

  /** A chat: a circle with a speech bubble. */
  chat(key: string, at: Point, r: number, cls: string): SVGGElement {
    const group = this.node(key, `is-chat ${cls}`);
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

/** Makes a note open in a new tab on a click and show Obsidian's preview on ⌘-hover, its path in its tooltip. */
function noteNode(group: SVGGElement, path: string, actions: MapActions, parent: unknown, hub = false): void {
  tooltip(group, hub ? `${path}\nA hub: linked to many chats, so it joins none of them on the map, and counts little toward a chat's project` : path);
  group.toggleClass('is-hub', hub);
  group.addEventListener('click', () => actions.openNote(path, true));
  group.addEventListener('mouseover', (evt) => actions.previewNote(path, evt, group, parent));
}

/**
 * Makes a chat offer, on a click or a right-click: open it, mention it in the message being typed, or
 * link (unlink) it from the chat the map is from; `changed` runs after a link changes.
 */
function chatNode(group: SVGGElement, id: string, actions: MapActions, changed: () => void, centre?: () => void): void {
  const offer = (evt: MouseEvent) => {
    evt.preventDefault();
    const linked = actions.linked(id);
    const menu = new Menu();
    const add = (title: string, icon: string, run: () => void) => menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(run));
    if (centre) add('Centre the map here', 'locate-fixed', centre);
    add('Open chat', 'message-square', () => actions.openChat(id));
    add('Mention in your message', 'at-sign', () => actions.mentionChat(id));
    if (linked !== null) {
      add(linked ? 'Unlink' : 'Link', linked ? 'unlink' : 'link', () => {
        actions.link(id, !linked);
        changed();
      });
      menu.addItem((item) => item.setTitle(LINK_TIP).setIsLabel(true));
    }
    menu.showAtMouseEvent(evt);
  };
  group.addEventListener('click', offer);
  group.addEventListener('contextmenu', offer);
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

/** The line under a map: `text`; Show all when some are not shown, or Show fewer when all are; and Rebuild connections. */
function showAll(el: HTMLElement, text: string, all: boolean, set: (all: boolean) => void, rebuild: () => void): void {
  const line = el.createDiv({ cls: 'vc-project-empty', text });
  const action = (label: string, run: () => void, tip?: string) => {
    const link = line.createEl('a', { cls: 'vc-map-show-all', text: label });
    if (tip) link.setAttr('aria-label', tip);
    link.addEventListener('click', run);
  };
  if (all || text.includes('Not shown')) action(all ? 'Show fewer' : 'Show all', () => set(!all));
  action('Rebuild connections…', rebuild, "Reads every chat's session file again for the notes it changed, was sent and linked to; projects stay as they are");
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

/** Where the map is centred: a chat (by id) or a project (by its note's path), with its title. */
type Place = { kind: 'chat' | 'project'; key: string; title: string };

/**
 * The Connections window: one map, centred on the chat on screen to start (or its project). Centred on
 * a chat: the chat in the middle; its notes round it, grouped by folder under arcs, a line to each
 * marked by how it is linked; the chats sharing them, or linked with it, outside; above, the project
 * bar and the search (its own map only), below, its links. Centred on a project: the project in the
 * middle, its chats round it, their notes outside. A chat or project on the map can be centred on, and
 * the trail leads back; links, mentions and the project bar act for the chat on screen throughout.
 */
export class ConnectionsMap extends Modal {
  /** The map centred on a project, when it is (see moveToProject). */
  private project: ProjectMapHost | null = null;
  /** The places the map was centred on before, to go back to (the first: the chat on screen). */
  private trail: Place[] = [];

  constructor(
    app: App,
    private host: ChatMapHost,
    /** A project to start centred on (the project chip's), its trail starting at the chat. */
    private readonly startAt: string | null = null,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('vc-map-modal');
    this.setTitle(`Connections: ${shortLabel(this.host.baseline.title, 60)}`);
    if (this.startAt) void this.moveToProject(this.startAt);
    else this.draw();
  }

  /** Reads the map's data again and draws it in place: after a change to its project, links or connections. */
  private async redraw(all?: boolean): Promise<void> {
    if (this.project) this.project = await this.project.reload(all ?? this.project.all);
    else this.host = await this.host.reload(all ?? this.host.all);
    this.contentEl.empty();
    this.draw();
  }

  /** Where the map is centred now. */
  private here(): Place {
    if (this.project) return { kind: 'project', key: this.project.path, title: this.project.name };
    return { kind: 'chat', key: this.host.centre, title: this.host.centre === this.host.baseline.id ? this.host.baseline.title : this.host.title };
  }

  /** Centres the map on chat `id`, the place shown before going on the trail. */
  private async moveTo(id: string): Promise<void> {
    this.trail.push(this.here());
    this.project = null;
    this.host = await this.host.recentre(id);
    this.contentEl.empty();
    this.draw();
  }

  /** Centres the map on project `path`, the place shown before going on the trail. */
  private async moveToProject(path: string): Promise<void> {
    this.trail.push(this.here());
    this.project = await this.host.projectMap(path);
    this.contentEl.empty();
    this.draw();
  }

  /** Back along the trail to its `index`th place (0: the chat on screen). */
  private async back(index: number): Promise<void> {
    const target = this.trail[index];
    this.trail = this.trail.slice(0, index);
    if (target.kind === 'project') this.project = await this.host.projectMap(target.key);
    else {
      this.project = null;
      this.host = await this.host.recentre(target.key);
    }
    this.contentEl.empty();
    this.draw();
  }

  /** Away from the chat on screen's own map: where the map is, the way back, and that links and mentions still act for the chat on screen. */
  private drawTrail(): void {
    const { host, contentEl } = this;
    const bar = contentEl.createDiv({ cls: 'vc-map-bar vc-map-trail' });
    setIcon(bar.createSpan({ cls: 'vc-project-group-icon' }), 'locate');
    this.trail.forEach((step, i) => {
      const crumb = bar.createEl('a', { text: shortLabel(step.title, 30) });
      crumb.addEventListener('click', () => void this.back(i));
      bar.appendText(' › ');
    });
    bar.createSpan({ cls: 'vc-map-bar-name', text: shortLabel(this.here().title, 40) });
    bar.createDiv({ cls: 'vc-project-size', text: `Links and mentions still act for “${shortLabel(host.baseline.title, 40)}”, the chat on screen.` });
  }

  /** Stops what the links drawn under the map still run (see ChatMapHost.drawLinks). */
  private stopLinks: () => void = () => undefined;

  private draw(): void {
    this.stopLinks();
    this.stopLinks = () => undefined;
    if (this.project) {
      this.drawProjectCentre(this.project);
      return;
    }
    const { host, contentEl } = this;
    // Centred on another chat: the way back in place of the project bar and search, which are the chat on screen's.
    const away = host.centre !== host.baseline.id;
    if (away) this.drawTrail();
    if (host.notes.length === 0 && host.chats.length === 0) {
      if (away) {
        contentEl.createDiv({ cls: 'vc-project-empty', text: 'This chat has worked on no notes yet, and links to no chats.' });
        return;
      }
      this.drawProjectBar();
      this.drawSearch();
      contentEl.createDiv({ cls: 'vc-project-empty', text: 'This chat has worked on no notes yet, and links to no chats. Find a project, chat or note above to add it to, link or mention.' });
      return;
    }
    if (!away) {
      this.drawProjectBar();
      this.drawSearch();
    }
    const ring = noteRing(host.notes.length);
    const scale = ring / BASE_RING;
    const drawing = new MapDrawing(contentEl, 820 * scale, 620 * scale);
    // A project's folder holds its subfolders' arcs.
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
        const name = folder.slice(folder.lastIndexOf('/') + 1) || 'Top of the vault';
        return {
          // Every arc by its folder's name, a project's own folder marked ◆ (its project is named in the tooltip, and the bar above).
          text: project && project.folder === folder ? `◆ ${shortLabel(name, 22)}` : shortLabel(name, 22),
          tip: `${folder || 'Top of the vault'}${project ? ` · in project “${project.name}”` : ''} · click for its project`,
          cls: own ? 'is-home' : project ? 'is-other' : 'is-plain',
        };
      },
      (folder, evt) => this.folderMenu(folder, evt),
    );
    for (const note of host.notes) drawing.line(centre, noteAt(note.path), ['chat', note.path], LINK_KINDS[note.weight] ?? 'mentioned');
    for (const chat of host.chats) {
      for (const path of chat.shared) if (angles.has(path)) drawing.line(chatAt(chat.id), noteAt(path), [chat.id, path], 'shared');
      if (chat.linked || chat.linkedFrom) drawing.line(centre, chatAt(chat.id), ['chat', chat.id], 'linked');
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
      tooltip(group, `${host.titleOf(chat.id)}${project ? ` · in “${project}”` : ''} · ${shared}${chat.linked ? ' · this chat links to it' : chat.linkedFrom ? ' · it links to this chat' : ''}\nClick to open, mention or ${host.linked(chat.id) ? 'unlink' : 'link'} it`);
      chatNode(group, chat.id, host, () => void this.redraw(), () => void this.moveTo(chat.id));
    }
    const centreNode = drawing.chat('chat', centre, 18, 'is-centre');
    const title = svg(centreNode, 'text', { x: 0, y: 34, 'text-anchor': 'middle' });
    // The chat's title only: its project is named in the bar above, and its folder's arc is marked ◆.
    title.textContent = shortLabel(host.title, 40);
    tooltip(centreNode, host.project ? `${host.title} · in “${host.project.name}”` : host.title);
    legend(contentEl, drawing.drawn, LEGEND);
    const more = [host.moreNotes > 0 ? `${host.moreNotes} more note${host.moreNotes === 1 ? '' : 's'}` : '', host.moreChats > 0 ? `${host.moreChats} more chat${host.moreChats === 1 ? '' : 's'}` : ''].filter(Boolean);
    showAll(contentEl, more.length > 0 ? `Not shown: ${more.join(' and ')}.` : '', host.all, (all) => void this.redraw(all), () => host.rebuild(() => void this.redraw(host.all)));
    if (!away) this.stopLinks = host.drawLinks(contentEl.createDiv({ cls: 'vc-map-links' }));
  }

  /**
   * A project's menu: centre on it (when not already), its note, its Context written anew or sent again
   * with the chat's next message (its own project's), another folder, a new name, deletion.
   */
  private projectMenu(path: string, evt: MouseEvent): void {
    const { host } = this;
    const menu = new Menu();
    const add = (title: string, icon: string, run: () => void) => menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(run));
    if (this.project?.path !== path) add('Show the project', 'locate-fixed', () => void this.moveToProject(path));
    add('Open project note', 'file-text', () => host.openProjectNote(path));
    add('Refresh context…', 'refresh-cw', () => host.refreshContext(path, () => void this.redraw()));
    if (host.ownProject?.path === path) add('Send its context again', 'send', () => host.sendAgain(path));
    add('Change folder…', 'folder-input', () => host.changeFolder(path, () => void this.redraw()));
    add('Rename…', 'pencil', () => host.renameProject(path, () => void this.redraw()));
    menu.addSeparator();
    add('Delete project…', 'trash-2', () =>
      host.deleteProject(path, () => {
        // Its map gone: back to the chat on screen's.
        this.project = null;
        void this.back(0).catch(() => this.redraw());
      }),
    );
    menu.showAtMouseEvent(evt);
  }

  /**
   * The chat's project, at the top: its name (centring on it) and its Project menu, then what concerns
   * the chat: Move… (to the search) and Take chat out; or,
   * with none, the project holding most of its notes, the project of a chat it is linked with and the
   * folder its notes suggest, each in one click.
   */
  private drawProjectBar(): void {
    const { host, contentEl } = this;
    const bar = contentEl.createDiv({ cls: 'vc-map-bar' });
    setIcon(bar.createSpan({ cls: 'vc-project-group-icon' }), 'folder-kanban');
    const act = (label: string, run: () => void, cta = false) => {
      const button = bar.createEl('button', { cls: `vc-map-action${cta ? ' mod-cta' : ''}`, text: label });
      button.addEventListener('click', run);
    };
    if (host.project) {
      const { project } = host;
      const name = bar.createEl('a', { cls: 'vc-map-bar-name', text: `In “${project.name}”`, attr: { 'aria-label': 'Centre the map on the project' } });
      name.addEventListener('click', () => void this.moveToProject(project.path));
      const menuButton = bar.createEl('button', { cls: 'vc-map-action' });
      menuButton.appendText('Project');
      setIcon(menuButton.createSpan({ cls: 'vc-project-group-icon' }), 'chevron-down');
      menuButton.addEventListener('click', (evt) => this.projectMenu(project.path, evt));
      act('Move chat…', () => this.focusSearch());
      act('Take chat out', () => void host.setHome(null).then(() => this.redraw()));
      return;
    }
    bar.createSpan({ cls: 'vc-map-bar-name', text: 'No project' });
    const byNotes = this.projectOfMostNotes();
    if (byNotes) act(`Put chat in “${byNotes.name}”`, () => void host.setHome(byNotes.path).then(() => this.redraw()), true);
    if (host.linkedProject && host.linkedProject.path !== byNotes?.path) {
      const { linkedProject } = host;
      act(`Put chat in “${linkedProject.name}”`, () => void host.setHome(linkedProject.path).then(() => this.redraw()), !byNotes);
    }
    if (host.folderSuggestion) {
      const { folder } = host.folderSuggestion;
      act(`Make “${folder}” a project…`, () => host.makeProject(folder, () => void this.redraw()));
    }
    act('Find a project…', () => this.focusSearch());
  }

  /** The project whose folders hold most of the chat's notes, if any. */
  private projectOfMostNotes(): { path: string; name: string } | null {
    const counts = new Map<string, { project: { path: string; name: string }; count: number }>();
    for (const { folder, count } of this.host.folders) {
      const project = this.host.projectHolding(folder);
      if (!project) continue;
      const entry = counts.get(project.path) ?? { project, count: 0 };
      entry.count += count;
      counts.set(project.path, entry);
    }
    const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    return best ? best.project : null;
  }

  private searchInput: HTMLInputElement | null = null;

  /** The search, focused; it finds projects, chats and notes whichever button sent you there. */
  private focusSearch(): void {
    this.searchInput?.focus();
  }

  /** A search above the map: chats, projects and notes by name, each with what can be done with it from this chat. */
  private drawSearch(): void {
    const { host, contentEl } = this;
    const box = contentEl.createDiv({ cls: 'vc-map-search' });
    const input = box.createEl('input', { type: 'search', attr: { placeholder: 'Find a project, chat or note: put this chat in a project, link a chat, mention a note' } });
    this.searchInput = input;
    const results = box.createDiv({ cls: 'vc-map-results' });
    results.hide();
    const act = (parent: HTMLElement, label: string, run: () => void, cta = false) => {
      const button = parent.createEl('button', { cls: `vc-map-action${cta ? ' mod-cta' : ''}`, text: label });
      button.addEventListener('click', run);
      return button;
    };
    input.addEventListener('input', () => {
      results.empty();
      const typed = input.value.trim() !== '';
      const hits = typed ? host.search(input.value) : [];
      results.toggle(typed);
      if (typed && hits.length === 0) results.createDiv({ cls: 'vc-project-empty', text: 'Nothing found.' });
      for (const hit of hits) {
        const row = results.createDiv({ cls: 'vc-project-browser-row' });
        setIcon(row.createSpan({ cls: 'vc-project-group-icon' }), hit.kind === 'chat' ? 'message-square' : hit.kind === 'project' ? 'folder-kanban' : 'file-text');
        const text = row.createDiv({ cls: 'vc-project-chat-text' });
        text.createDiv({ cls: 'vc-project-chat-title', text: hit.label });
        if (hit.detail) text.createDiv({ cls: 'vc-project-chat-when', text: hit.detail });
        const buttons = row.createDiv({ cls: 'vc-map-hit-actions' });
        if (hit.kind === 'chat') {
          const linked = host.linked(hit.key);
          if (linked !== null)
            act(buttons, linked ? 'Unlink' : 'Link', () => {
              host.link(hit.key, !linked);
              void this.redraw();
            }).setAttr('aria-label', LINK_TIP);
          act(buttons, 'Mention', () => host.mentionChat(hit.key)).setAttr('aria-label', 'Mention: puts a link to it in your message; the chats are linked when you send it.');
          act(buttons, 'Open', () => host.openChat(hit.key));
        } else if (hit.kind === 'project') {
          act(buttons, 'Show', () => void this.moveToProject(hit.key)).setAttr('aria-label', 'Centre the map on the project');
          if (hit.key !== host.ownProject?.path) {
            act(buttons, host.ownProject ? 'Move chat here' : 'Put chat here', () => void host.setHome(hit.key).then(() => this.redraw()), true).setAttr('aria-label', HOME_TIP);
          }
          act(buttons, 'Open note', () => host.openProjectNote(hit.key));
        } else {
          act(buttons, 'Mention', () => host.mentionNote(hit.key)).setAttr('aria-label', 'Mention: adds @[[it]] to your message, which sends the note with it.');
          act(buttons, 'Open', () => host.openNote(hit.key, true));
        }
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  /**
   * What a folder offers, by the project holding it (see projectHolding): this chat's project, its note;
   * another project, putting the chat in it, and its note; a folder in no project, Make it a project; a
   * folder inside a project, nothing of its own (its notes count toward that project).
   */
  private folderActions(folder: string): { label: string; tip?: string; run: () => void }[] {
    const { host } = this;
    const project = host.projectHolding(folder);
    if (project && project.folder !== folder) return [];
    const show = (path: string) => ({ label: 'Show the project', run: () => void this.moveToProject(path) });
    if (project && project.path === host.ownProject?.path) return [show(project.path), { label: 'Open project note', run: () => host.openProjectNote(project.path) }];
    if (project)
      return [
        show(project.path),
        { label: host.ownProject ? 'Move chat here' : 'Put chat here', tip: HOME_TIP, run: () => void host.setHome(project.path).then(() => this.redraw()) },
        { label: 'Open project note', run: () => host.openProjectNote(project.path) },
      ];
    if (!folder) return [];
    return [{ label: 'Make it a project…', run: () => host.makeProject(folder, () => void this.redraw()) }];
  }

  private folderMenu(folder: string, evt: MouseEvent): void {
    const holding = this.host.projectHolding(folder);
    // A folder inside a project acts as the project does.
    const actions = this.folderActions(holding && holding.folder !== folder ? holding.folder : folder);
    if (actions.length === 0) return;
    const menu = new Menu();
    for (const action of actions) menu.addItem((item) => item.setTitle(action.label).onClick(action.run));
    menu.showAtMouseEvent(evt);
  }

  /**
   * Centred on project `host`: the trail back, the project's bar (its menu, and putting the chat on
   * screen in it or taking it out), then its map: the project in the middle, its note previewed on
   * ⌘-hover and opened beside the panel on a click; its chats round it; their notes outside.
   */
  private drawProjectCentre(host: ProjectMapHost): void {
    const { contentEl } = this;
    this.drawTrail();
    const bar = contentEl.createDiv({ cls: 'vc-map-bar' });
    setIcon(bar.createSpan({ cls: 'vc-project-group-icon' }), 'folder-kanban');
    bar.createSpan({ cls: 'vc-map-bar-name', text: host.name });
    const menuButton = bar.createEl('button', { cls: 'vc-map-action' });
    menuButton.appendText('Project');
    setIcon(menuButton.createSpan({ cls: 'vc-project-group-icon' }), 'chevron-down');
    menuButton.addEventListener('click', (evt) => this.projectMenu(host.path, evt));
    const own = this.host.ownProject?.path === host.path;
    const chatAction = bar.createEl('button', { cls: `vc-map-action${own ? '' : ' mod-cta'}`, text: own ? 'Take chat out' : this.host.ownProject ? 'Move chat here' : 'Put chat here' });
    if (!own) chatAction.setAttr('aria-label', HOME_TIP);
    chatAction.addEventListener('click', () => void this.host.setHome(own ? null : host.path).then(async () => {
      this.host = await this.host.reload(this.host.all);
      await this.redraw();
    }));
    if (host.chats.length === 0) {
      contentEl.createDiv({ cls: 'vc-project-empty', text: 'No chats have worked on notes in this project yet.' });
      return;
    }
    const ring = noteRing(host.notes.length);
    const scale = ring / BASE_RING;
    const drawing = new MapDrawing(contentEl, 820 * scale, 560 * scale);
    // Many chats and notes make many lines: faint until a chat or note is pointed at.
    drawing.root.addClass('is-quiet');
    // Grouped by the folder within the project; notes outside it by their own folder.
    // Folders outside it keyed by their path after a slash, so that none is taken for a subfolder of
    // the same name; notes at the top of the vault, a group of their own ('/'), not the project folder's ('').
    const TOP = '/';
    const within = (path: string) => {
      const folder = folderOf(path);
      if (folder === host.folder) return '';
      if (folder.startsWith(`${host.folder}/`)) return folder.slice(host.folder.length + 1);
      return `/${folder}`;
    };
    const inside = (path: string) => folderOf(path) === host.folder || folderOf(path).startsWith(`${host.folder}/`);
    const { angles, arcs, spans } = ringLayout(host.notes, within, 0.8, (path) => (inside(path) ? '' : null));
    drawArcs(drawing, ring, arcs, spans, (sub, outer) => ({
      text: shortLabel(sub === TOP ? 'Top of the vault' : sub.startsWith('/') ? sub.slice(1) : sub || `◆ ${host.folder.slice(host.folder.lastIndexOf('/') + 1)}`, 22),
      // The project's own band (sub '') names its folder; its subfolders, their path; folders outside it, theirs.
      tip: sub === '' ? host.folder : sub === TOP ? 'Top of the vault' : sub.startsWith('/') ? sub.slice(1) : `${host.folder}/${sub}`,
      cls: outer === '' || sub === '' ? 'is-home' : 'is-plain',
    }));
    // The chats on a small ring round the project, wider when there are many.
    const inner = Math.max(70, host.chats.length * 7);
    const chatAt = new Map(host.chats.map((id, i) => [id, polar((2 * Math.PI * i) / host.chats.length, inner)]));
    const noteAt = (path: string) => polar(angles.get(path) ?? 0, ring);
    for (const [id, path, weight] of host.links) {
      const from = chatAt.get(id);
      if (from && angles.has(path)) drawing.line(from, noteAt(path), [id, path], LINK_KINDS[weight] ?? 'mentioned');
    }
    const labels = new Map(placeLabels(host.notes.map((path) => ({ key: path, angle: angles.get(path) ?? 0, text: noteName(path) })), ring + ARC_WIDTH / 2 + 2, 26).map((label) => [label.key, label]));
    for (const path of host.notes) {
      const group = drawing.note(path, noteAt(path), 'project');
      const label = labels.get(path);
      if (label) drawing.label(group, label.at, label.side, label.text, 2, noteName(path));
      noteNode(group, path, host, this);
    }
    for (const [id, at] of chatAt) {
      // Every chat here is in the project: its colour.
      const group = drawing.chat(id, at, 11, 'is-same-project');
      const touched = host.links.filter(([chat]) => chat === id).length;
      tooltip(group, `${host.titleOf(id)} · ${touched} note${touched === 1 ? '' : 's'} here\nClick to open or mention it${host.linked(id) === null ? '' : ', or link it'}`);
      chatNode(group, id, host, () => undefined, () => void this.moveTo(id));
    }
    // The project in the middle: its note, previewed on ⌘-hover, opened beside the panel on a click.
    const project = drawing.node('project', 'is-project-node');
    svg(project, 'rect', { x: -16, y: -16, width: 32, height: 32, rx: 7 });
    svg(project, 'path', { d: 'M -8 -6 h 6 l 2 3 h 8 v 9 h -16 z', class: 'vc-map-bubble' });
    const title = svg(project, 'text', { x: 0, y: 32, 'text-anchor': 'middle' });
    title.textContent = shortLabel(host.name, 40);
    tooltip(project, `${host.name}: its note\nClick to open it beside the panel`);
    project.addEventListener('click', () => host.openBeside(host.path));
    project.addEventListener('mouseover', (evt) => host.previewNote(host.path, evt, project, this));
    legend(contentEl, drawing.drawn, LEGEND.filter(([kind]) => ['edited', 'sent', 'mentioned'].includes(kind)));
    const more = [host.moreChats > 0 ? `${host.moreChats} older chat${host.moreChats === 1 ? '' : 's'}` : '', host.moreNotes > 0 ? `${host.moreNotes} more note${host.moreNotes === 1 ? '' : 's'}` : ''].filter(Boolean);
    showAll(contentEl, `Point at a chat to see its notes.${more.length > 0 ? ` Not shown: ${more.join(' and ')}.` : ''}`, host.all, (all) => void this.redraw(all), () => host.rebuild(() => void this.redraw(host.all)));
  }

  onClose(): void {
    this.stopLinks();
    this.contentEl.empty();
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
