// Chats by the folders of the notes they worked on: the history's folders view, and the folder
// suggested for a project. Read from the note indexes (see noteChats.ts); kept free of `obsidian`
// imports so the tests can use it.
import type { NoteChats } from './noteChats';

/** The folder holding vault path `path`; empty for the vault's top level. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Whether vault path `path` is in folder `folder` (at any depth); every path is in the top level (''). */
export function inFolder(path: string, folder: string): boolean {
  return folder === '' || path.startsWith(`${folder}/`);
}

/** Each chat's notes, from the indexes given: chat id → vault paths. */
export function notesByChat(...indexes: NoteChats[]): Map<string, Set<string>> {
  const notes = new Map<string, Set<string>>();
  for (const index of indexes) {
    for (const [path, ids] of Object.entries(index)) {
      for (const id of ids) {
        let set = notes.get(id);
        if (!set) notes.set(id, (set = new Set()));
        set.add(path);
      }
    }
  }
  return notes;
}

/** How strongly a link ties a chat to a note: it edited it, was sent it, or only mentioned it. */
export const LINK_WEIGHTS = { changed: 3, sent: 2, mentioned: 1 } as const;

/** Each chat's notes with the weight of its strongest link to each (see LINK_WEIGHTS): chat id → path → weight. */
export function weightedNotes(changed: NoteChats, sent: NoteChats, mentioned: NoteChats): Map<string, Map<string, number>> {
  const notes = new Map<string, Map<string, number>>();
  for (const [index, weight] of [
    [changed, LINK_WEIGHTS.changed],
    [sent, LINK_WEIGHTS.sent],
    [mentioned, LINK_WEIGHTS.mentioned],
  ] as const) {
    for (const [path, ids] of Object.entries(index)) {
      for (const id of ids) {
        let map = notes.get(id);
        if (!map) notes.set(id, (map = new Map()));
        map.set(path, Math.max(map.get(path) ?? 0, weight));
      }
    }
  }
  return notes;
}

/** A folder in the folders view: its path, and the chats that worked on notes anywhere in it. */
export interface FolderRow {
  path: string;
  chats: string[];
  /** When the most recent of them was last active (ms). */
  latest: number;
}

/**
 * What the folders view shows in `folder` ('' for the top level): the folders directly in it with
 * chats, the most recent first; then its chats, newest first: in a folder, every chat that worked on a
 * note anywhere in it; at the top level, those with notes there. `words` (lower case) keep the folders
 * whose name holds them all, and the chats whose title does. Chats not in `when` (gone from the
 * history) are left out.
 */
export function folderView(notes: Map<string, Set<string>>, when: Map<string, { updatedAt: number; title: string }>, folder: string, words: string[]): { folders: FolderRow[]; chats: string[] } {
  const below = new Map<string, Set<string>>();
  const here = new Set<string>();
  for (const [id, paths] of notes) {
    if (!when.has(id)) continue;
    for (const path of paths) {
      if (!inFolder(path, folder)) continue;
      const rest = folder === '' ? path : path.slice(folder.length + 1);
      const slash = rest.indexOf('/');
      if (slash !== -1) {
        const child = folder === '' ? rest.slice(0, slash) : `${folder}/${rest.slice(0, slash)}`;
        let set = below.get(child);
        if (!set) below.set(child, (set = new Set()));
        set.add(id);
      }
      if (folder !== '' || slash === -1) here.add(id);
    }
  }
  const latest = (ids: Iterable<string>) => Math.max(0, ...[...ids].map((id) => when.get(id)?.updatedAt ?? 0));
  const named = (path: string) => {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    return words.every((word) => name.includes(word));
  };
  const folders = [...below]
    .filter(([path]) => named(path))
    .map(([path, ids]) => ({ path, chats: [...ids], latest: latest(ids) }))
    .sort((a, b) => b.latest - a.latest || a.path.localeCompare(b.path));
  const chats = [...here]
    .filter((id) => {
      const title = when.get(id)?.title.toLowerCase() ?? '';
      return words.every((word) => title.includes(word));
    })
    .sort((a, b) => (when.get(b)?.updatedAt ?? 0) - (when.get(a)?.updatedAt ?? 0));
  return { folders, chats };
}

/** The history's folders query (see FOLDERS_PREFIX), read: the folder gone into (up to its last `/`) and the words typed after it. */
export function readFolderQuery(rest: string): { folder: string; words: string[] } {
  const slash = rest.lastIndexOf('/');
  const folder = slash === -1 ? '' : rest.slice(0, slash).replace(/^\/+|\/+$/g, '');
  const words = rest.slice(slash + 1).toLowerCase().split(/\s+/).filter(Boolean);
  return { folder, words };
}

/** The folder query one level up from `rest`: its last folder taken off (the words typed with it too). */
export function folderUp(rest: string): string {
  const { folder } = readFolderQuery(rest);
  const parent = folderOf(folder);
  return parent ? `${parent}/` : '';
}

/** A folder suggested for a project: the deepest holding at least `share` of the notes given. */
export interface FolderSuggestion {
  folder: string;
  /** How many of the notes are in it, of how many. */
  count: number;
  total: number;
}

/** The share of a project's chats' notes its suggested folder must hold. */
export const FOLDER_SHARE = 0.6;

/**
 * The folder to suggest for notes `paths`: the deepest one holding at least `share` of them, leaving
 * out the top level and the folders `skip` says to (the plugin's own, those hidden). Notes in skipped
 * folders do not count. Null when none does, or there are fewer than two notes.
 */
export function suggestFolder(paths: Iterable<string>, skip: (folder: string) => boolean, share = FOLDER_SHARE): FolderSuggestion | null {
  const notes = [...new Set(paths)].filter((path) => !ancestors(folderOf(path)).some(skip));
  if (notes.length < 2) return null;
  const counts = new Map<string, number>();
  for (const path of notes) for (const folder of ancestors(folderOf(path))) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  let best: FolderSuggestion | null = null;
  for (const [folder, count] of counts) {
    if (count < share * notes.length) continue;
    if (!best || folder.split('/').length > best.folder.split('/').length) best = { folder, count, total: notes.length };
  }
  return best;
}

/** `folder` and the folders holding it, outermost first; none for the top level. */
function ancestors(folder: string): string[] {
  if (!folder) return [];
  const parts = folder.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}
