// The connections maps, drawn (see connections.ts): a chat with its notes and the chats that share
// them, and a project with its chats and their notes. Plain SVG. Notes are squares with a page glyph,
// chats circles with a speech bubble, folders arcs behind their notes. A note opens in a new tab on a
// click and shows Obsidian's page preview on ⌘-hover; a chat offers to open, mention, link or unlink
// it; a folder's arc offers its project, or to make it one. The map stays open through all of these,
// drawn again when what it shows changed; Esc, its close button or a click outside closes it.
import { Menu, Modal, setIcon, type App } from 'obsidian';
import { folderOf } from './chatFolders';
import { chatAngles, placeLabels, polar, ringLayout, shortLabel, type MapChat, type MapNote, type Point, type RingArc } from './connections';

const SVG = 'http://www.w3.org/2000/svg';
/** What Link does, said where it is offered. */
const LINK_TIP = 'Link: both chats list each other. Nothing is sent unless you tick Include on the links chip; then a digest of it goes once.';
/** What putting a chat in a project does, said where it is offered. A chat has at most one project. */
const HOME_TIP = "This project's Instructions and Guide then go with this chat's next message. A chat is in one project at most.";
/** How a note is linked, by weight (see LINK_WEIGHTS). */
const LINK_KINDS: Record<number, string> = { 3: 'edited', 2: 'sent', 1: 'mentioned' };
/** The rings: notes, their labels, the arcs behind them, and the other chats. */
const NOTE_RING = 150;
const ARC_WIDTH = 26;
const CHAT_RING = 245;
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
  notes: MapNote[];
  chats: MapChat[];
  moreNotes: number;
  moreChats: number;
  /** The folders of all its notes, the busiest first. */
  folders: { folder: string; count: number }[];
  /** The chat's home project: its name, folder and note. */
  project: { name: string; folder: string; path: string } | null;
  /** Create project for `folder`; `created` runs once it is made. */
  makeProject(folder: string, created: () => void): void;
  openProjectNote(path: string): void;
  /** Chooses another folder for project `path`; `changed` runs once it is set. */
  changeFolder(path: string, changed: () => void): void;
  search(query: string): SearchHit[];
  /** Makes project `path` the chat's home (null: takes it out). */
  setHome(path: string | null): Promise<void>;
  /** Whether the chat was taken out of a project by hand, so that its notes no longer place it in one. */
  declined: boolean;
  /** The project whose folder holds `folder` (the deepest), if any: what its notes count toward. */
  projectHolding(folder: string): { path: string; name: string; folder: string } | null;
  /** The map's data again, after something it shows changed. */
  reload(): Promise<ChatMapHost>;
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

  constructor(parent: HTMLElement, width: number, height: number) {
    this.root = svg(parent, 'svg', { viewBox: `${-width / 2} ${-height / 2} ${width} ${height}`, class: 'vc-map' });
    this.arcs = svg(this.root, 'g');
    this.lines = svg(this.root, 'g');
    this.nodes = svg(this.root, 'g');
    this.top = svg(this.root, 'g', { class: 'vc-map-top' });
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
function noteNode(group: SVGGElement, path: string, actions: MapActions, parent: unknown): void {
  tooltip(group, path);
  group.addEventListener('click', () => actions.openNote(path, true));
  group.addEventListener('mouseover', (evt) => actions.previewNote(path, evt, group, parent));
}

/**
 * Makes a chat offer, on a click or a right-click: open it, mention it in the message being typed, or
 * link (unlink) it from the chat the map is from; `changed` runs after a link changes.
 */
function chatNode(group: SVGGElement, id: string, actions: MapActions, changed: () => void): void {
  const offer = (evt: MouseEvent) => {
    evt.preventDefault();
    const linked = actions.linked(id);
    const menu = new Menu();
    const add = (title: string, icon: string, run: () => void) => menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(run));
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
  arcs: RingArc[],
  spans: RingArc[],
  label: (folder: string, outer: string | null) => { text: string; tip: string; cls: string },
  click?: (folder: string, evt: MouseEvent) => void,
): void {
  const band = (arc: RingArc, extra: number, labelGap: number) => {
    const { text, tip, cls } = label(arc.folder, arc.outer);
    drawing.drawn.add(`arc-${cls}`);
    const group = svg(drawing.arcs, 'g', { class: `vc-map-arc ${cls}` });
    const inner = NOTE_RING - ARC_WIDTH / 2 - extra;
    svg(group, 'path', { d: arcPath(arc.start, arc.end, inner, NOTE_RING + ARC_WIDTH / 2 + extra) });
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
  ['badge', 'is-badge', 'chat in another project'],
];

/**
 * A chat's connections: the chat in the middle; its notes round it, grouped by folder under arcs, a
 * line to each marked by how it is linked; the chats sharing them, or linked from it, outside. Under
 * it, every folder of its notes with the same actions as the arcs.
 */
export class ChatMapModal extends Modal {
  constructor(app: App, private host: ChatMapHost) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('vc-map-modal');
    this.setTitle(`Connections: ${shortLabel(this.host.title, 60)}`);
    this.draw();
  }

  /** Reads the map's data again and draws it in place: after a change to its project, links or connections. */
  private async redraw(): Promise<void> {
    this.host = await this.host.reload();
    this.contentEl.empty();
    this.draw();
  }

  private draw(): void {
    const { host, contentEl } = this;
    if (host.notes.length === 0 && host.chats.length === 0) {
      this.drawProjectBar();
      this.drawSearch();
      contentEl.createDiv({ cls: 'vc-project-empty', text: 'This chat has worked on no notes yet, and links to no chats. Find a project, chat or note above to add it to, link or mention.' });
      return;
    }
    this.drawProjectBar();
    this.drawSearch();
    const drawing = new MapDrawing(contentEl, 820, 620);
    // A project's folder holds its subfolders' arcs.
    const { angles, arcs, spans } = ringLayout(host.notes.map((note) => note.path), folderOf, 0.8, (path) => host.projectHolding(folderOf(path))?.folder ?? null);
    const placesOfChats = chatAngles(host.chats, angles);
    const centre = { x: 0, y: 0 };
    const noteAt = (path: string) => polar(angles.get(path) ?? 0, NOTE_RING);
    const chatAt = (id: string) => polar(placesOfChats.get(id) ?? 0, CHAT_RING);
    const home = host.project?.folder ?? null;
    drawArcs(
      drawing,
      arcs,
      spans,
      (folder) => {
        const project = host.projectHolding(folder);
        const own = project !== null && project.folder === home;
        const name = folder.slice(folder.lastIndexOf('/') + 1) || 'Top of the vault';
        return {
          // A project's own folder is named by the project; a folder inside it by its name, in the project's tint.
          text: project && project.folder === folder ? `◆ ${shortLabel(project.name, 22)}` : shortLabel(name, 22),
          tip: `${folder || 'Top of the vault'}${project ? ` · in project “${project.name}”` : ''} · click for its project`,
          cls: own ? 'is-home' : project ? 'is-other' : 'is-plain',
        };
      },
      (folder, evt) => this.folderMenu(folder, evt),
    );
    for (const note of host.notes) drawing.line(centre, noteAt(note.path), ['chat', note.path], LINK_KINDS[note.weight] ?? 'mentioned');
    for (const chat of host.chats) {
      for (const path of chat.shared) if (angles.has(path)) drawing.line(chatAt(chat.id), noteAt(path), [chat.id, path], 'shared');
      if (chat.linked) drawing.line(centre, chatAt(chat.id), ['chat', chat.id], 'linked');
    }
    const noteLabels = new Map(placeLabels(host.notes.map((note) => ({ key: note.path, angle: angles.get(note.path) ?? 0, text: noteName(note.path) })), NOTE_RING + ARC_WIDTH / 2 + 2, 24).map((label) => [label.key, label]));
    for (const note of host.notes) {
      const at = noteAt(note.path);
      const group = drawing.note(note.path, at, LINK_KINDS[note.weight] ?? 'mentioned');
      const label = noteLabels.get(note.path);
      if (label) drawing.label(group, label.at, label.side, label.text, 2, noteName(note.path));
      noteNode(group, note.path, host, this);
    }
    const chatLabels = new Map(placeLabels(host.chats.map((chat) => ({ key: chat.id, angle: placesOfChats.get(chat.id) ?? 0, text: host.titleOf(chat.id) })), CHAT_RING, 26).map((label) => [label.key, label]));
    for (const chat of host.chats) {
      const at = chatAt(chat.id);
      const project = host.projectOfChat(chat.id);
      const other = project !== null && project !== host.project?.name;
      const group = drawing.chat(chat.id, at, 10, chat.linked ? 'is-linked' : '');
      if (other) {
        projectBadge(group, at, 10);
        drawing.drawn.add('badge');
      }
      const label = chatLabels.get(chat.id);
      if (label) drawing.label(group, label.at, label.side, label.text, 14, host.titleOf(chat.id));
      const shared = `${chat.shared.length} shared note${chat.shared.length === 1 ? '' : 's'}`;
      tooltip(group, `${host.titleOf(chat.id)}${project ? ` · in “${project}”` : ''} · ${shared}${chat.linked ? ' · linked from this chat' : ''}\nClick to open, mention or ${host.linked(chat.id) ? 'unlink' : 'link'} it`);
      chatNode(group, chat.id, host, () => void this.redraw());
    }
    const centreNode = drawing.chat('chat', centre, 18, 'is-centre');
    const title = svg(centreNode, 'text', { x: 0, y: 34, 'text-anchor': 'middle' });
    title.textContent = shortLabel(host.title, 40);
    if (host.project) {
      const project = svg(centreNode, 'text', { x: 0, y: 50, 'text-anchor': 'middle', class: 'vc-map-sub' });
      project.textContent = `◆ ${shortLabel(host.project.name, 36)}`;
    }
    tooltip(centreNode, host.project ? `${host.title} · in “${host.project.name}”` : host.title);
    legend(contentEl, drawing.drawn, LEGEND);
    const more = [host.moreNotes > 0 ? `${host.moreNotes} more note${host.moreNotes === 1 ? '' : 's'}` : '', host.moreChats > 0 ? `${host.moreChats} more chat${host.moreChats === 1 ? '' : 's'}` : ''].filter(Boolean);
    if (more.length > 0) contentEl.createDiv({ cls: 'vc-project-empty', text: `Not shown: ${more.join(' and ')}.` });
  }

  /**
   * The chat's project, at the top: its name, its note, Change folder…, Move… (to the search) and Take chat out; or,
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
      bar.createSpan({ cls: 'vc-map-bar-name', text: `In “${project.name}”` });
      act('Open note', () => host.openProjectNote(project.path));
      act('Change folder…', () => host.changeFolder(project.path, () => void this.redraw()));
      act('Move…', () => this.focusSearch());
      act('Take chat out', () => void host.setHome(null).then(() => this.redraw()));
      return;
    }
    bar.createSpan({ cls: 'vc-map-bar-name', text: host.declined ? 'No project (taken out by hand)' : 'No project' });
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
          if (hit.key !== host.project?.path) {
            act(buttons, host.project ? 'Move chat here' : 'Put chat here', () => void host.setHome(hit.key).then(() => this.redraw()), true).setAttr('aria-label', HOME_TIP);
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
    if (project && project.path === host.project?.path) return [{ label: 'Open project note', run: () => host.openProjectNote(project.path) }];
    if (project)
      return [
        { label: host.project ? 'Move chat here' : 'Put chat here', tip: HOME_TIP, run: () => void host.setHome(project.path).then(() => this.redraw()) },
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

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface ProjectMapHost extends MapActions {
  name: string;
  /** The project's folder: its notes are grouped by the folders in it. */
  folder: string;
  chats: string[];
  notes: string[];
  /** Which chat worked on which note, and how (see LINK_WEIGHTS). */
  links: [string, string, number][];
  /** Chats in the project not shown. */
  moreChats: number;
}

/** A project's map: its chats in the middle, the notes they worked on round them, grouped by folder within the project, a line where a chat worked on a note. */
export class ProjectMapModal extends Modal {
  constructor(app: App, private readonly host: ProjectMapHost) {
    super(app);
  }

  onOpen(): void {
    const { host, contentEl } = this;
    this.modalEl.addClass('vc-map-modal');
    this.setTitle(`Project map: ${host.name}`);
    if (host.chats.length === 0) {
      contentEl.createDiv({ cls: 'vc-project-empty', text: 'No chats have worked on notes in this project yet.' });
      return;
    }
    const drawing = new MapDrawing(contentEl, 820, 560);
    // Grouped by the folder within the project; notes outside it by their own folder.
    const within = (path: string) => {
      const folder = folderOf(path);
      return folder === host.folder ? '' : folder.startsWith(`${host.folder}/`) ? folder.slice(host.folder.length + 1) : folder;
    };
    const inside = (path: string) => folderOf(path) === host.folder || folderOf(path).startsWith(`${host.folder}/`);
    const { angles, arcs, spans } = ringLayout(host.notes, within, 0.8, (path) => (inside(path) ? '' : null));
    drawArcs(drawing, arcs, spans, (sub, outer) => ({
      text: shortLabel(sub || host.name, 22),
      tip: outer === null ? sub : sub ? `${host.folder}/${sub}` : host.folder,
      cls: outer === '' || sub === '' ? 'is-home' : 'is-plain',
    }));
    const inner = host.chats.length === 1 ? 0 : 60;
    const chatAt = new Map(host.chats.map((id, i) => [id, polar((2 * Math.PI * i) / host.chats.length, inner)]));
    const noteAt = (path: string) => polar(angles.get(path) ?? 0, NOTE_RING);
    for (const [id, path, weight] of host.links) {
      const from = chatAt.get(id);
      if (from && angles.has(path)) drawing.line(from, noteAt(path), [id, path], LINK_KINDS[weight] ?? 'mentioned');
    }
    const labels = new Map(placeLabels(host.notes.map((path) => ({ key: path, angle: angles.get(path) ?? 0, text: noteName(path) })), NOTE_RING + ARC_WIDTH / 2 + 2, 26).map((label) => [label.key, label]));
    for (const path of host.notes) {
      const group = drawing.note(path, noteAt(path), 'project');
      const label = labels.get(path);
      if (label) drawing.label(group, label.at, label.side, label.text, 2, noteName(path));
      noteNode(group, path, host, this);
    }
    for (const [id, at] of chatAt) {
      const group = drawing.chat(id, at, 11, '');
      const touched = host.links.filter(([chat]) => chat === id).length;
      tooltip(group, `${host.titleOf(id)} · ${touched} note${touched === 1 ? '' : 's'} here\nClick to open or mention it${host.linked(id) === null ? '' : ', or link it'}`);
      chatNode(group, id, host, () => undefined);
    }
    legend(contentEl, drawing.drawn, LEGEND.filter(([kind]) => ['edited', 'sent', 'mentioned'].includes(kind)));
    contentEl.createDiv({ cls: 'vc-project-empty', text: `Point at a chat to see its notes.${host.moreChats > 0 ? ` Not shown: ${host.moreChats} older chat${host.moreChats === 1 ? '' : 's'}.` : ''}` });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
