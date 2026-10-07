// The connections maps, drawn (see connections.ts): a chat with its notes and the chats that share
// them, and a project with its chats and their notes. Plain SVG; a note opens on a click and shows
// Obsidian's page preview on ⌘-hover; a chat opens, or is linked to (see ChatView.openLinks).
import { Keymap, Menu, Modal, setIcon, type App } from 'obsidian';
import { folderOf } from './chatFolders';
import { radialLayout, shortLabel, type MapChat, type MapNote, type Point } from './connections';

const SVG = 'http://www.w3.org/2000/svg';
/** How a note is linked, by weight (see LINK_WEIGHTS). */
const LINK_KINDS: Record<number, string> = { 3: 'edited', 2: 'sent', 1: 'mentioned' };

/** What the maps need from the panel. */
interface MapActions {
  titleOf(id: string): string;
  openNote(path: string, newTab: boolean): void;
  previewNote(path: string, event: MouseEvent | KeyboardEvent, target: Element, parent: unknown): void;
  openChat(id: string): void;
  /** Whether the chat the map is from links to chat `id`; null when there is none (a project's map with no chat on screen). */
  linked(id: string): boolean | null;
  link(id: string, on: boolean): void;
}

export interface ChatMapHost extends MapActions {
  title: string;
  notes: MapNote[];
  chats: MapChat[];
  moreNotes: number;
  moreChats: number;
  /** The chat's home project: its name and folder. */
  project: { name: string; folder: string } | null;
  /** The project each other chat is in, by name, if any. */
  projectOfChat(id: string): string | null;
  /** The project a folder is, if any: its note's path and name. */
  folderProject(folder: string): { path: string; name: string } | null;
  makeProject(folder: string): void;
  connect(path: string): void;
}

/** An SVG element of `tag` with `attrs`, added to `parent`. */
function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  parent.appendChild(el);
  return el;
}

/** Draws a map: lines first, then nodes; pointing at a node lights it and its lines (`ties` names, for each line, the two nodes it joins). */
class MapDrawing {
  readonly root: SVGSVGElement;
  private readonly lines: SVGGElement;
  private readonly nodes: SVGGElement;
  private readonly ties: { line: SVGLineElement; ends: [string, string] }[] = [];
  private readonly groups = new Map<string, SVGGElement>();

  constructor(parent: HTMLElement, width: number, height: number) {
    this.root = svg(parent, 'svg', { viewBox: `${-width / 2} ${-height / 2} ${width} ${height}`, class: 'vc-map' });
    this.lines = svg(this.root, 'g', {});
    this.nodes = svg(this.root, 'g', {});
  }

  line(from: Point, to: Point, ends: [string, string], cls: string): void {
    this.ties.push({ line: svg(this.lines, 'line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: `vc-map-line ${cls}` }), ends });
  }

  /** A node at `at`: a dot (`r`), its label beside it (`side`: where the label goes), lit with its lines when pointed at. */
  node(key: string, at: Point, r: number, cls: string, label: string, side: 'left' | 'right' | 'below'): SVGGElement {
    const group = svg(this.nodes, 'g', { class: `vc-map-node ${cls}`, tabindex: 0 });
    svg(group, 'circle', { cx: at.x, cy: at.y, r });
    const text = svg(group, 'text', {
      x: side === 'below' ? at.x : at.x + (side === 'right' ? r + 4 : -r - 4),
      y: side === 'below' ? at.y + r + 13 : at.y + 4,
      'text-anchor': side === 'below' ? 'middle' : side === 'right' ? 'start' : 'end',
    });
    text.textContent = label;
    group.addEventListener('mouseenter', () => this.light(key));
    group.addEventListener('mouseleave', () => this.light(null));
    this.groups.set(key, group);
    return group;
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

/** Makes a node open its note on a click (⌘: in a new tab) and show Obsidian's preview on ⌘-hover. */
function noteNode(group: SVGGElement, path: string, actions: MapActions, parent: unknown): void {
  group.setAttribute('aria-label', path);
  group.addEventListener('click', (evt) => actions.openNote(path, Keymap.isModEvent(evt) !== false));
  group.addEventListener('mouseover', (evt) => actions.previewNote(path, evt, group, parent));
}

/** Makes a node offer its chat: open it, or link to it (or not) from the chat the map is from. */
function chatNode(group: SVGGElement, id: string, actions: MapActions, close: () => void): void {
  group.addEventListener('click', (evt) => {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Open chat')
        .setIcon('message-square')
        .onClick(() => {
          close();
          actions.openChat(id);
        }),
    );
    const linked = actions.linked(id);
    if (linked !== null) {
      menu.addItem((item) =>
        item
          .setTitle(linked ? 'Unlink this chat' : 'Link to this chat')
          .setIcon(linked ? 'unlink' : 'link')
          .onClick(() => {
            close();
            actions.link(id, !linked);
          }),
      );
    }
    menu.showAtMouseEvent(evt);
  });
}

/** The ways a note is linked, as the legend shows them. */
function legend(el: HTMLElement, items: [string, string][]): void {
  const row = el.createDiv({ cls: 'vc-map-legend' });
  for (const [cls, label] of items) {
    const item = row.createSpan({ cls: 'vc-map-legend-item' });
    item.createSpan({ cls: `vc-map-swatch ${cls}` });
    item.appendText(label);
  }
}

/**
 * A chat's connections: the chat in the middle; its notes round it, marked by how it is linked to
 * each, those in its project's folder picked out; the chats sharing them, or linked from it, outside.
 * Under it, the folders of its notes, each with its project or the offer to make one or connect.
 */
export class ChatMapModal extends Modal {
  constructor(app: App, private readonly host: ChatMapHost) {
    super(app);
  }

  onOpen(): void {
    const { host, contentEl } = this;
    this.modalEl.addClass('vc-map-modal');
    this.setTitle(`Connections: ${shortLabel(host.title, 60)}`);
    if (host.notes.length === 0 && host.chats.length === 0) {
      contentEl.createDiv({ cls: 'vc-project-empty', text: 'This chat has worked on no notes yet, and links to no chats. Attach or mention a note, or use what another chat found, to connect it.' });
      return;
    }
    const drawing = new MapDrawing(contentEl, 720, 560);
    const { notes, chats } = radialLayout(
      host.notes.map((note) => note.path),
      host.chats.map(({ id, shared }) => ({ id, shared })),
      150,
      235,
    );
    const centre = { x: 0, y: 0 };
    const inProject = (path: string) => host.project !== null && (path === host.project.folder || path.startsWith(`${host.project.folder}/`));
    for (const note of host.notes) {
      const at = notes.get(note.path);
      if (at) drawing.line(centre, at, ['chat', note.path], `is-${LINK_KINDS[note.weight] ?? 'mentioned'}`);
    }
    for (const chat of host.chats) {
      const at = chats.get(chat.id);
      if (!at) continue;
      for (const path of chat.shared) {
        const to = notes.get(path);
        if (to) drawing.line(at, to, [chat.id, path], 'is-shared');
      }
      if (chat.linked) drawing.line(centre, at, ['chat', chat.id], 'is-linked');
    }
    for (const note of host.notes) {
      const at = notes.get(note.path);
      if (!at) continue;
      const name = note.path.slice(note.path.lastIndexOf('/') + 1).replace(/\.md$/, '');
      const group = drawing.node(note.path, at, 5, `is-note is-${LINK_KINDS[note.weight] ?? 'mentioned'}${inProject(note.path) ? ' is-project' : ''}`, shortLabel(name, 24), at.x >= 0 ? 'right' : 'left');
      noteNode(group, note.path, host, this);
    }
    for (const chat of host.chats) {
      const at = chats.get(chat.id);
      if (!at) continue;
      const project = host.projectOfChat(chat.id);
      const group = drawing.node(chat.id, at, 7, `is-chat${chat.linked ? ' is-linked' : ''}`, shortLabel(host.titleOf(chat.id), 22), at.x >= 0 ? 'right' : 'left');
      group.setAttribute('aria-label', `${host.titleOf(chat.id)}${project ? ` · in ${project}` : ''} · ${chat.shared.length} shared note${chat.shared.length === 1 ? '' : 's'}${chat.linked ? ' · linked from this chat' : ''}`);
      chatNode(group, chat.id, host, () => this.close());
    }
    drawing.node('chat', centre, 12, 'is-centre', host.project ? `${shortLabel(host.title, 30)} · ${host.project.name}` : shortLabel(host.title, 36), 'below');
    legend(contentEl, [
      ['is-edited', 'edited'],
      ['is-sent', 'sent'],
      ['is-mentioned', 'mentioned'],
      ['is-project', "in the project's folder"],
      ['is-chat', 'chat sharing notes'],
      ['is-linked', 'linked chat'],
    ]);
    const more = [host.moreNotes > 0 ? `${host.moreNotes} more note${host.moreNotes === 1 ? '' : 's'}` : '', host.moreChats > 0 ? `${host.moreChats} more chat${host.moreChats === 1 ? '' : 's'}` : ''].filter(Boolean);
    if (more.length > 0) contentEl.createDiv({ cls: 'vc-project-empty', text: `Not shown: ${more.join(' and ')}.` });
    this.drawFolders();
  }

  /** The folders of the chat's notes, by how many: each its project (Connect, when not the chat's), or Make it a project. */
  private drawFolders(): void {
    const { host, contentEl } = this;
    const counts = new Map<string, number>();
    for (const note of host.notes) {
      const folder = folderOf(note.path);
      if (folder) counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    if (counts.size === 0) return;
    const box = contentEl.createDiv({ cls: 'vc-map-folders' });
    box.createDiv({ cls: 'vc-project-label', text: 'Folders of its notes' });
    for (const [folder, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      const row = box.createDiv({ cls: 'vc-project-browser-row' });
      const project = host.folderProject(folder);
      setIcon(row.createSpan({ cls: 'vc-project-group-icon' }), project ? 'folder-kanban' : 'folder');
      row.createSpan({ cls: 'vc-project-folder-path', text: folder });
      row.createSpan({ cls: 'vc-project-size', text: `${n} note${n === 1 ? '' : 's'}${project ? ` · project “${project.name}”` : ''}` });
      const action = (label: string, run: () => void) => {
        const button = row.createEl('button', { cls: 'vc-map-action', text: label });
        button.addEventListener('click', () => {
          this.close();
          run();
        });
      };
      if (!project) action('Make it a project…', () => host.makeProject(folder));
      else if (host.project?.name !== project.name) action('Connect', () => host.connect(project.path));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface ProjectMapHost extends MapActions {
  name: string;
  chats: string[];
  notes: string[];
  /** Which chat worked on which note, and how (see LINK_WEIGHTS). */
  links: [string, string, number][];
  /** Chats in the project not shown. */
  moreChats: number;
}

/** A project's map: its chats on the left, the notes they worked on on the right, a line where a chat worked on a note. */
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
    const rows = Math.max(host.chats.length, host.notes.length);
    const height = Math.max(200, rows * 30 + 40);
    const drawing = new MapDrawing(contentEl, 720, height);
    const place = (i: number, count: number, x: number): Point => ({ x, y: -height / 2 + 20 + ((i + 0.5) * (height - 40)) / count });
    const chatAt = new Map(host.chats.map((id, i) => [id, place(i, host.chats.length, -150)]));
    const noteAt = new Map(host.notes.map((path, i) => [path, place(i, host.notes.length, 150)]));
    for (const [id, path, weight] of host.links) {
      const from = chatAt.get(id);
      const to = noteAt.get(path);
      if (from && to) drawing.line(from, to, [id, path], `is-${LINK_KINDS[weight] ?? 'mentioned'}`);
    }
    for (const [id, at] of chatAt) {
      const group = drawing.node(id, at, 7, 'is-chat', shortLabel(host.titleOf(id), 30), 'left');
      group.setAttribute('aria-label', host.titleOf(id));
      chatNode(group, id, host, () => this.close());
    }
    for (const [path, at] of noteAt) {
      const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
      noteNode(drawing.node(path, at, 5, 'is-note is-project', shortLabel(name, 30), 'right'), path, host, this);
    }
    legend(contentEl, [
      ['is-edited', 'edited'],
      ['is-sent', 'sent'],
      ['is-mentioned', 'mentioned'],
    ]);
    if (host.moreChats > 0) contentEl.createDiv({ cls: 'vc-project-empty', text: `Not shown: ${host.moreChats} older chat${host.moreChats === 1 ? '' : 's'}.` });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
