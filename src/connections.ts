// The connections maps: a chat with its notes and the chats that share them, and a project with its
// chats and their notes; both radial, notes grouped by folder under arcs. What is shown is worked out
// here, and where; the panel draws it (see connectionsView.ts). Kept free of `obsidian` imports so the
// tests can use it.
import { folderOf } from './chatFolders';

/** The most notes and chats one map shows; the rest are counted. */
export const MAP_NOTES = 16;
export const MAP_CHATS = 8;

/** Whether a note goes on a map: not Claude Code's instruction files (CLAUDE.md, CLAUDE.local.md), which most chats touch and so tie together chats that share nothing else. */
export function onMap(path: string): boolean {
  return !/(^|\/)CLAUDE(\.local)?\.md$/i.test(path);
}

/** A note on a map: its path and the weight of the chat's link to it (see LINK_WEIGHTS). */
export interface MapNote {
  path: string;
  weight: number;
}

/** Another chat on a map: the notes it shares with the chat (or project), and whether the chat linked to it. */
export interface MapChat {
  id: string;
  shared: string[];
  /** The chat the map is of links to it. */
  linked: boolean;
  /** It links to the chat the map is of. */
  linkedFrom?: boolean;
}

/**
 * What a chat's map shows: its notes, the strongest links first (then by path), at most MAP_NOTES;
 * the chats that share the most of them, or that it linked to, at most MAP_CHATS, those linked first
 * (`recent` orders a tie, the most recent first); and the folders of all its notes, the busiest first.
 * With `all`, every note and chat, uncapped.
 */
export function chatMap(
  id: string,
  weighted: Map<string, Map<string, number>>,
  linked: string[],
  recent: (id: string) => number,
  all = false,
  hubs: ReadonlySet<string> = new Set(),
  linkedFrom: string[] = [],
): { notes: MapNote[]; chats: MapChat[]; moreNotes: number; moreChats: number; folders: { folder: string; count: number }[] } {
  const own = [...(weighted.get(id) ?? new Map<string, number>())].filter(([path]) => onMap(path)).map(([path, weight]) => ({ path, weight }));
  own.sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
  const notes = all ? own : own.slice(0, MAP_NOTES);
  const shown = new Set(notes.map((note) => note.path));
  const others: MapChat[] = [];
  const links = new Set(linked);
  for (const [other, paths] of weighted) {
    if (other === id) continue;
    // Hubs (see hubNotes) join no chats: one touched by many says little about any two of them.
    const shared = [...paths.keys()].filter((path) => shown.has(path) && !hubs.has(path));
    if (shared.length > 0 || links.has(other)) others.push({ id: other, shared, linked: links.has(other) });
  }
  for (const other of links) if (!weighted.has(other) && other !== id) others.push({ id: other, shared: [], linked: true });
  // Chats linking to this one: shown too, marked as such (a link from them, not to them).
  const from = new Set(linkedFrom);
  for (const chat of others) if (from.has(chat.id)) chat.linkedFrom = true;
  for (const other of from) if (other !== id && !others.some((chat) => chat.id === other)) others.push({ id: other, shared: [], linked: false, linkedFrom: true });
  const tied = (chat: MapChat) => Number(chat.linked || chat.linkedFrom === true);
  others.sort((a, b) => tied(b) - tied(a) || b.shared.length - a.shared.length || recent(b.id) - recent(a.id));
  const counts = new Map<string, number>();
  for (const note of own) counts.set(folderOf(note.path), (counts.get(folderOf(note.path)) ?? 0) + 1);
  const folders = [...counts].map(([folder, count]) => ({ folder, count })).sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
  const chats = all ? others : others.slice(0, MAP_CHATS);
  return { notes, chats, moreNotes: own.length - notes.length, moreChats: others.length - chats.length, folders };
}

/** How many chats a note must be linked to to be a hub (a project's hub note, an index, a to-do list). */
export const HUB_CHATS = 8;
/** How much a hub weighs toward a chat's project, as a share of its link's weight (see homeOf). */
export const HUB_WEIGHT = 0.25;

/** The notes linked to at least HUB_CHATS of the chats given: shown on the maps, but joining no chats, and weighing little toward a project. */
export function hubNotes(weighted: Map<string, Map<string, number>>): Set<string> {
  const counts = new Map<string, number>();
  for (const paths of weighted.values()) for (const path of paths.keys()) counts.set(path, (counts.get(path) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count >= HUB_CHATS).map(([path]) => path));
}

/** A chat's notes with each hub's weight cut to HUB_WEIGHT of it (see hubNotes): what places it in a project. */
export function withoutHubs(notes: ReadonlyMap<string, number> | undefined, hubs: ReadonlySet<string>): Map<string, number> | undefined {
  return notes && new Map([...notes].map(([path, weight]) => [path, hubs.has(path) ? weight * HUB_WEIGHT : weight]));
}

/** A point on a map, in its own units (the centre is 0, 0). */
export interface Point {
  x: number;
  y: number;
}

/** A point at `angle` (radians clockwise from the top) and `radius` from the centre. */
export function polar(angle: number, radius: number): Point {
  return { x: radius * Math.sin(angle), y: -radius * Math.cos(angle) };
}

/** A folder's group on a ring: the folder (by `group`), the angles its notes span, and the enclosing group it sits in (see ringLayout). */
export interface RingArc {
  folder: string;
  start: number;
  end: number;
  outer: string | null;
}

/** A direction for group `name` on a ring, the same on every map: radians clockwise from the top. */
export function groupDirection(name: string): number {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (hash / 2 ** 32) * 2 * Math.PI;
}

/** The most a note's place on a ring spans (see ringLayout), in radians: few notes stay near their folders' directions. */
const STABLE_STEP = 0.3;

/**
 * Notes on a ring, grouped by `group` (their folder, by default): the notes in a group side by side, a
 * gap of `gap` note places between groups. Each note's angle, and each group's arc, padded by half a
 * place either side. `outer` puts groups inside an enclosing one (a project's folder round its
 * subfolders): those are kept side by side, and `spans` gives each enclosing group's extent, a quarter
 * place wider either side than the arcs it holds. Each top-level group (one, or an enclosing one with
 * those inside it) is centred on its own direction (see groupDirection), pushed aside only as far as
 * it must be to clear the others, so that a folder sits on the same side from one map to the next; a
 * place spans at most STABLE_STEP.
 */
export function ringLayout(
  notes: string[],
  group: (path: string) => string = folderOf,
  gap = 0.8,
  outer: (path: string) => string | null = () => null,
): { angles: Map<string, number>; arcs: RingArc[]; spans: RingArc[] } {
  const key = (path: string) => outer(path) ?? group(path);
  const order = (a: string, b: string) => groupDirection(key(a)) - groupDirection(key(b)) || key(a).localeCompare(key(b));
  const groups = new Map<string, string[]>();
  for (const path of [...notes].sort((a, b) => order(a, b) || group(a).localeCompare(group(b)) || a.localeCompare(b))) {
    const name = group(path);
    groups.set(name, [...(groups.get(name) ?? []), path]);
  }
  // Top-level blocks: a group, or the groups inside one enclosing group, side by side.
  const blocks: { key: string; groups: [string, string[]][]; notes: number }[] = [];
  for (const [folder, paths] of groups) {
    const last = blocks[blocks.length - 1];
    if (last && last.key === key(paths[0])) {
      last.groups.push([folder, paths]);
      last.notes += paths.length;
    } else blocks.push({ key: key(paths[0]), groups: [[folder, paths]], notes: paths.length });
  }
  const gaps = groups.size > 1 ? groups.size : 0;
  const places = notes.length + gaps * gap;
  const step = Math.min((2 * Math.PI) / Math.max(1, places), STABLE_STEP);
  // From a block's first note to its last.
  const extent = blocks.map((block) => (block.notes - 1 + (block.groups.length - 1) * gap) * step);
  const centres = blocks.map((block) => groupDirection(block.key));
  // Neighbours too near are pushed apart, half each, until none is: they fit, the places spanning
  // at most the whole ring between them.
  for (let round = 0; round < 500 && blocks.length > 1; round++) {
    let moved = false;
    for (let i = 0; i < blocks.length; i++) {
      const j = (i + 1) % blocks.length;
      const next = centres[j] + (j === 0 ? 2 * Math.PI : 0);
      const over = (extent[i] + extent[j]) / 2 + step * (1 + gap) - (next - centres[i]);
      if (over <= 1e-9) continue;
      centres[i] -= over / 2;
      centres[j] += over / 2;
      moved = true;
    }
    if (!moved) break;
  }
  // Where each block's first note goes, as said above.
  const starts = centres.map((centre, i) => centre - extent[i] / 2);
  const angles = new Map<string, number>();
  const arcs: RingArc[] = [];
  const spans = new Map<string, RingArc>();
  blocks.forEach((block, i) => {
    let at = starts[i];
    for (const [folder, paths] of block.groups) {
      const start = at;
      for (const path of paths) {
        angles.set(path, at);
        at += step;
      }
      const arc = { folder, start: start - step / 2, end: at - step / 2, outer: outer(paths[0]) };
      arcs.push(arc);
      if (arc.outer !== null) {
        const span = spans.get(arc.outer);
        if (span) span.end = arc.end + step / 4;
        else spans.set(arc.outer, { folder: arc.outer, start: arc.start - step / 4, end: arc.end + step / 4, outer: null });
      }
      if (gaps > 0) at += gap * step;
    }
  });
  return { angles, arcs, spans: [...spans.values()] };
}

/**
 * Where each other chat goes on the outer ring: towards the mean of the angles of the notes it shares
 * (one sharing none, opposite the top, in turn), spread so that none is nearer the one before than
 * `gap` radians (less when there are many).
 */
export function chatAngles(chats: { id: string; shared: string[] }[], noteAngles: Map<string, number>, gap = 0.45): Map<string, number> {
  const wanted = chats.map((chat, i) => {
    const angles = chat.shared.flatMap((path) => (noteAngles.has(path) ? [noteAngles.get(path) ?? 0] : []));
    const angle =
      angles.length > 0
        ? Math.atan2(angles.reduce((sum, a) => sum + Math.sin(a), 0), angles.reduce((sum, a) => sum + Math.cos(a), 0))
        : Math.PI + (2 * Math.PI * i) / Math.max(1, chats.length);
    return { id: chat.id, angle: (angle + 2 * Math.PI) % (2 * Math.PI) };
  });
  wanted.sort((a, b) => a.angle - b.angle);
  const step = Math.min(gap, (2 * Math.PI) / Math.max(1, wanted.length));
  for (let i = 1; i < wanted.length; i++) wanted[i].angle = Math.max(wanted[i].angle, wanted[i - 1].angle + step);
  return new Map(wanted.map(({ id, angle }) => [id, angle]));
}

/** A label placed outside its ring: at `at`, on the `right` or left of its node, `text` already cut to fit. */
export interface PlacedLabel {
  key: string;
  at: Point;
  side: 'right' | 'left';
  text: string;
}

/**
 * Labels on the outside of a ring of `radius`, for nodes at `angles`: each `max` characters at most;
 * where two on the same side would come nearer than `line` units up or down, the shorter is cut to
 * `tight` characters (the full name shows on hover).
 */
export function placeLabels(labels: { key: string; angle: number; text: string }[], radius: number, max: number, tight = 10, line = 14): PlacedLabel[] {
  const placed = labels.map((label) => {
    const at = polar(label.angle, radius);
    return { key: label.key, at, side: at.x >= -0.5 ? ('right' as const) : ('left' as const), text: shortLabel(label.text, max), full: label.text };
  });
  for (const side of ['right', 'left'] as const) {
    const column = placed.filter((label) => label.side === side).sort((a, b) => a.at.y - b.at.y);
    for (let i = 1; i < column.length; i++) {
      const [a, b] = [column[i - 1], column[i]];
      if (Math.abs(a.at.y - b.at.y) >= line) continue;
      const shorter = a.full.length <= b.full.length ? a : b;
      shorter.text = shortLabel(shorter.full, tight);
    }
  }
  return placed.map(({ key, at, side, text }) => ({ key, at, side, text }));
}

/**
 * What a project's map shows: its chats, newest first, at most MAP_CHATS; and the notes they worked
 * on that the most of them share, at most MAP_NOTES; with which chat worked on which note. With
 * `all`, every chat and note, uncapped.
 */
export function projectMap(
  chats: string[],
  weighted: Map<string, Map<string, number>>,
  all = false,
): { chats: string[]; notes: string[]; links: [string, string, number][]; moreNotes: number } {
  const shown = all ? chats : chats.slice(0, MAP_CHATS);
  const counts = new Map<string, number>();
  for (const id of shown) for (const path of weighted.get(id)?.keys() ?? []) if (onMap(path)) counts.set(path, (counts.get(path) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([path]) => path);
  const notes = all ? ranked : ranked.slice(0, MAP_NOTES);
  const kept = new Set(notes);
  const links: [string, string, number][] = [];
  for (const id of shown) for (const [path, weight] of weighted.get(id) ?? []) if (kept.has(path)) links.push([id, path, weight]);
  return { chats: shown, notes, links, moreNotes: ranked.length - notes.length };
}

/**
 * The radius of the notes' ring for `count` notes: 150 for up to 16, wider beyond so that their
 * labels, in columns either side, stay about 14 units apart.
 */
export function noteRing(count: number): number {
  return Math.max(150, Math.ceil(count * 9.5));
}

/** `text` cut to `max` characters, with an ellipsis when cut. */
export function shortLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
