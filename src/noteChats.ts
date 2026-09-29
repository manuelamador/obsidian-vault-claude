import type { HistoryItem } from './history';

/** Chats per note, for one reason (changed it, were sent it, or mentioned it): vault path → chat ids, newest first. */
export type NoteChats = Record<string, string[]>;

/** A chat offered for a note, and why: it changed the note (or wrote it), or the note went with a message. */
export interface NoteChatEntry {
  id: string;
  title: string;
  why: 'changed' | 'sent';
}

/** How a chat is linked to a note: as offered for the note, or, in the history's notes view, having mentioned it. */
type NoteLinkKind = NoteChatEntry['why'] | 'mentioned';

/** The same icons as the chat's notes button and the note chip. */
export const NOTE_CHAT_ICONS: Record<NoteLinkKind, string> = { changed: 'file-pen', sent: 'paperclip', mentioned: 'file-text' };

/**
 * Records that `chatId` changed `path`: at the front, as the newest (`promote`, for an edit made
 * now), or, for an edit seen again in a saved chat, at the end if it is missing, so that an old chat
 * does not move ahead of newer ones. Every chat is kept. Returns whether the index changed.
 */
export function linkNote(index: NoteChats, path: string, chatId: string, promote = true): boolean {
  const before = index[path] ?? [];
  if (!promote) {
    if (before.includes(chatId)) return false;
    index[path] = [...before, chatId];
    return true;
  }
  const after = [chatId, ...before.filter((id) => id !== chatId)];
  if (before.length === after.length && before.every((id, i) => id === after[i])) return false;
  index[path] = after;
  return true;
}

/**
 * Where `path` is once the note or folder `from` has moved to `to`: null when `from` was deleted
 * (`to` null), undefined when `path` is neither `from` nor inside it.
 */
export function movedPath(path: string, from: string, to: string | null): string | null | undefined {
  if (path !== from && !path.startsWith(`${from}/`)) return undefined;
  return to === null ? null : to + path.slice(from.length);
}

/**
 * Follows a note, or a folder's notes, that moved to `to`, joining any chats already listed where
 * each went (its own first); or that was deleted (`to` null), so a note made later at its path
 * starts with none. Returns whether the index changed.
 */
export function followNote(index: NoteChats, from: string, to: string | null): boolean {
  let changed = false;
  for (const key of Object.keys(index)) {
    const dest = movedPath(key, from, to);
    if (dest === undefined) continue;
    const chats = index[key];
    delete index[key];
    changed = true;
    if (dest === null) continue;
    const there = index[dest] ?? [];
    index[dest] = [...chats, ...there.filter((id) => !chats.includes(id))];
  }
  return changed;
}

/**
 * Follows the note attached to each draft in `drafts` that moved to `to`, or detaches it when it was
 * deleted (`to` null); a draft left with no text goes, through `drop`. Returns whether any changed.
 */
export function followDraftNotes(
  drafts: Iterable<[string, { text?: string; note?: string }]>,
  from: string,
  to: string | null,
  drop: (key: string) => void,
): boolean {
  let changed = false;
  for (const [key, draft] of [...drafts]) {
    const note = draft.note === undefined ? undefined : movedPath(draft.note, from, to);
    if (note === undefined) continue;
    changed = true;
    if (note !== null) draft.note = note;
    else if (draft.text?.trim()) delete draft.note;
    else drop(key);
  }
  return changed;
}

/** Drops a chat that no longer exists from every note. */
export function forgetChat(index: NoteChats, chatId: string): boolean {
  let changed = false;
  for (const [path, chats] of Object.entries(index)) {
    if (!chats.includes(chatId)) continue;
    const left = chats.filter((id) => id !== chatId);
    if (left.length > 0) index[path] = left;
    else delete index[path];
    changed = true;
  }
  return changed;
}

/**
 * The chats offered for a note, each once: those that changed it, the chat a saved chat note came
 * from, then those it was sent with. Newest first within each group.
 */
export function noteChatEntries(
  changed: { id: string; title: string }[],
  source: string | null,
  sent: { id: string; title: string }[],
): NoteChatEntry[] {
  const entries: NoteChatEntry[] = [];
  const add = (id: string, title: string, why: NoteChatEntry['why']) => {
    if (!entries.some((entry) => entry.id === id)) entries.push({ id, title, why });
  };
  for (const chat of changed) add(chat.id, chat.title, 'changed');
  if (source) add(source, 'The chat this note came from', 'changed');
  for (const chat of sent) add(chat.id, chat.title, 'sent');
  return entries;
}

/** A note in the history's notes view, with the chats linked to it, newest first. */
export interface NoteGroup {
  path: string;
  chats: { item: HistoryItem; why: NoteLinkKind }[];
}

/**
 * The notes found by `term` (every note when it is empty), each with the listed chats that changed
 * it, that it was sent to, or that mentioned it (each chat once, by the first of these), newest
 * first; the notes with the most recent chats first. The words of `term`, in any case, find a note
 * by its vault path: one at least is in the path, and those that are not must be in a chat's title
 * for the chat to be listed under it. A chat not listed in the history (its session gone) is left
 * out, and a note left with none.
 */
export function chatsByNote(changed: NoteChats, sent: NoteChats, mentioned: NoteChats, items: HistoryItem[], term: string): NoteGroup[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: NoteGroup[] = [];
  for (const path of new Set([...Object.keys(changed), ...Object.keys(sent), ...Object.keys(mentioned)])) {
    const inPath = path.toLowerCase();
    const inTitle = words.filter((word) => !inPath.includes(word));
    if (words.length > 0 && inTitle.length === words.length) continue;
    const chats = new Map<string, NoteGroup['chats'][number]>();
    for (const [ids, why] of [
      [changed[path] ?? [], 'changed'],
      [sent[path] ?? [], 'sent'],
      [mentioned[path] ?? [], 'mentioned'],
    ] as const) {
      for (const id of ids) {
        const item = byId.get(id);
        const title = item?.title.toLowerCase() ?? '';
        if (item && !chats.has(id) && inTitle.every((word) => title.includes(word))) chats.set(id, { item, why });
      }
    }
    if (chats.size > 0) groups.push({ path, chats: [...chats.values()].sort((a, b) => b.item.updatedAt - a.item.updatedAt) });
  }
  return groups.sort((a, b) => b.chats[0].item.updatedAt - a.chats[0].item.updatedAt || a.path.localeCompare(b.path));
}
