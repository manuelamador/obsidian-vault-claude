// The connections maps: a chat with its notes and the chats that share them (radial), and a project
// with its chats and their notes (two columns). What is shown is worked out here, and where; the
// panel draws it (see connectionsModal.ts). Kept free of `obsidian` imports so the tests can use it.
import { folderOf } from './chatFolders';

/** The most notes and chats one map shows; the rest are counted. */
export const MAP_NOTES = 16;
export const MAP_CHATS = 8;

/** A note on a map: its path and the weight of the chat's link to it (see LINK_WEIGHTS). */
export interface MapNote {
  path: string;
  weight: number;
}

/** Another chat on a map: the notes it shares with the chat (or project), and whether the chat linked to it. */
export interface MapChat {
  id: string;
  shared: string[];
  linked: boolean;
}

/**
 * What a chat's map shows: its notes, the strongest links first (then by path), at most MAP_NOTES;
 * and the chats that share the most of them, or that it linked to, at most MAP_CHATS, those linked
 * first. `recent` orders chats on a tie, the most recent first.
 */
export function chatMap(
  id: string,
  weighted: Map<string, Map<string, number>>,
  linked: string[],
  recent: (id: string) => number,
): { notes: MapNote[]; chats: MapChat[]; moreNotes: number; moreChats: number } {
  const own = [...(weighted.get(id) ?? new Map<string, number>())].map(([path, weight]) => ({ path, weight }));
  own.sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
  const notes = own.slice(0, MAP_NOTES);
  const shown = new Set(notes.map((note) => note.path));
  const others: MapChat[] = [];
  const links = new Set(linked);
  for (const [other, paths] of weighted) {
    if (other === id) continue;
    const shared = [...paths.keys()].filter((path) => shown.has(path));
    if (shared.length > 0 || links.has(other)) others.push({ id: other, shared, linked: links.has(other) });
  }
  for (const other of links) if (!weighted.has(other) && other !== id) others.push({ id: other, shared: [], linked: true });
  others.sort((a, b) => Number(b.linked) - Number(a.linked) || b.shared.length - a.shared.length || recent(b.id) - recent(a.id));
  return { notes, chats: others.slice(0, MAP_CHATS), moreNotes: own.length - notes.length, moreChats: Math.max(0, others.length - MAP_CHATS) };
}

/** A point on a map, in its own units (the centre is 0, 0). */
export interface Point {
  x: number;
  y: number;
}

/**
 * Where a chat's map puts things: its notes on a ring round it, those of a folder side by side (by
 * path); each other chat on an outer ring, towards the notes it shares, spread so that none is
 * nearer another than `gap` radians. Angles start at the top and go clockwise.
 */
export function radialLayout(notes: string[], chats: { id: string; shared: string[] }[], inner: number, outer: number, gap = 0.45): { notes: Map<string, Point>; chats: Map<string, Point> } {
  const at = (angle: number, radius: number): Point => ({ x: radius * Math.sin(angle), y: -radius * Math.cos(angle) });
  const ordered = [...notes].sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || a.localeCompare(b));
  const angles = new Map(ordered.map((path, i) => [path, (2 * Math.PI * i) / Math.max(1, ordered.length)]));
  const notePoints = new Map([...angles].map(([path, angle]) => [path, at(angle, inner)]));
  // Each chat towards the mean of its shared notes' angles; one sharing none (linked only) goes in the first free place.
  const wanted = chats.map((chat, i) => {
    const vectors = chat.shared.flatMap((path) => (angles.has(path) ? [angles.get(path) ?? 0] : []));
    const angle =
      vectors.length > 0
        ? Math.atan2(vectors.reduce((sum, a) => sum + Math.sin(a), 0), vectors.reduce((sum, a) => sum + Math.cos(a), 0))
        : Math.PI + (2 * Math.PI * i) / Math.max(1, chats.length);
    return { id: chat.id, angle: (angle + 2 * Math.PI) % (2 * Math.PI) };
  });
  wanted.sort((a, b) => a.angle - b.angle);
  // Spread: each at least `gap` after the one before it (the gap shrinks when there are many).
  const step = Math.min(gap, (2 * Math.PI) / Math.max(1, wanted.length));
  for (let i = 1; i < wanted.length; i++) wanted[i].angle = Math.max(wanted[i].angle, wanted[i - 1].angle + step);
  return { notes: notePoints, chats: new Map(wanted.map(({ id, angle }) => [id, at(angle, outer)])) };
}

/**
 * What a project's map shows: its chats, newest first, at most MAP_CHATS; and the notes they worked
 * on that the most of them share, at most MAP_NOTES; with which chat worked on which note.
 */
export function projectMap(chats: string[], weighted: Map<string, Map<string, number>>): { chats: string[]; notes: string[]; links: [string, string, number][] } {
  const shown = chats.slice(0, MAP_CHATS);
  const counts = new Map<string, number>();
  for (const id of shown) for (const path of weighted.get(id)?.keys() ?? []) counts.set(path, (counts.get(path) ?? 0) + 1);
  const notes = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAP_NOTES)
    .map(([path]) => path);
  const kept = new Set(notes);
  const links: [string, string, number][] = [];
  for (const id of shown) for (const [path, weight] of weighted.get(id) ?? []) if (kept.has(path)) links.push([id, path, weight]);
  return { chats: shown, notes, links };
}

/** `text` cut to `max` characters, with an ellipsis when cut. */
export function shortLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
