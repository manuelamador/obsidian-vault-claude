// Kept free of `obsidian` imports so the headless smoke test can use it.
import { deleteSession, forkSession, getSessionInfo, getSessionMessages, listSessions, renameSession, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs, realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from './log';

/** A chat started from the panel, kept in the plugin's data.json. */
export interface ChatRecord {
  id: string;
  title: string;
  /** For a copy of a chat started outside the panel, made by sending a message in it: that chat's id. */
  copyOf?: string;
}

export interface HistoryItem {
  id: string;
  title: string;
  updatedAt: number;
  fromPanel: boolean;
  /** Set for chats still running in the background, e.g. "Working". */
  status?: string;
  /** Pinned chats are listed first. */
  pinned?: boolean;
  /** The scratch chat: listed first of all, opened in place, and cleared rather than deleted. */
  scratch?: boolean;
  /** Set while the chat has tasks running in the background, which the history offers to stop. */
  tasksRunning?: boolean;
  /** A copy of a chat started outside the panel (see markCopies). */
  copied?: boolean;
  /** A chat started outside the panel: the listed copies of it, most recently active first. */
  copies?: HistoryItem[];
}

// The project and linked-chat blocks: in prompts written before that context went through the
// UserPromptSubmit hook (see ClaudeSession.addContext); stripped there, written nowhere now.
const CONTEXT_BLOCK = /^(?:<project_context>[\s\S]*?<\/project_context>\s*)?(?:<linked_chats>[\s\S]*?<\/linked_chats>\s*)?(?:<obsidian_context>[\s\S]*?<\/obsidian_context>\s*)?/;

/** Removes the note context the panel prepends to prompts. */
export function stripContext(text: string): string {
  return text.replace(CONTEXT_BLOCK, '');
}

export function chatTitle(text: string): string {
  const flat = stripContext(text).replace(/\s+/g, ' ').trim();
  if (!flat) return 'Untitled chat';
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

export function formatDate(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Session files read at once when many are read: enough to overlap the reads, few enough to keep memory flat. */
export const PARALLEL_READS = 6;

/** Runs `work` on each item, PARALLEL_READS at a time. */
export async function eachInParallel<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, items.length) }, worker));
}

/**
 * SDK sessions the plugin has no record of, by id: the title when the first prompt shows the
 * session was a panel chat, else false. A session's first prompt does not change, so each is read
 * once; on 2026-09-25 these reads were 18 of the vault's 115 sessions and 140 ms of the 300 ms
 * the history took to list.
 */
const unrecorded = new Map<string, string | false>();

/** Below this size a session file may hold no prompt: what Claude Code notes about a session alone is a few kilobytes. */
const SMALL_SESSION_BYTES = 16 * 1024;

/**
 * When each listed chat last had a prompt or reply (see lastActive), with the time and size of the
 * file it was read from, so that a file is read again only once it has changed. A session file's own
 * time is not its chat's: rows with no message and no time of their own are added to it after the
 * chat (Claude Code's as its process exits; the desktop app's as it starts, which on 2026-09-29
 * touched ten of its sessions at once and put them at the top of the history). With these reads, the
 * vault's 117 chats listed as fast as before: about 1 s the first time and 150 ms after.
 */
const activeAt = new Map<string, { stamp: string; at: number | null }>();

/**
 * The uuid of each listed session's first prompt, with the time and size of the file it was read
 * from; null for one with none within its first FIRST_PROMPT_BYTES, read again once the file has
 * changed (it may still have been being written). Claude Code keeps the uuid in the copy it makes of a
 * session resumed as a fork, which is how the panel continued a chat started elsewhere, so a copy
 * shares its original's (the SDK's own copies, branches, get new ones).
 */
const firstPrompts = new Map<string, { stamp: string; prompt: string | null }>();

/** How far into a session file its first prompt is looked for: in the vault's 122, it was at most 600 KB in. */
const FIRST_PROMPT_BYTES = 1024 * 1024;

/**
 * Sessions for the vault directory, newest first; panel chats only unless `includeAll`.
 * A session counts as a panel chat when the plugin recorded it, or when it is an SDK
 * session whose first prompt starts with the panel's context block (chats from before
 * recording began; ones sent without a note open cannot be told apart and are left out).
 */
export async function listHistory(dir: string, records: ChatRecord[], includeAll: boolean, sideSessions: ReadonlySet<string> = new Set()): Promise<HistoryItem[]> {
  const [sessions, interactive] = await Promise.all([
    listSessions({ dir, includeWorktrees: false }),
    listSessions({ dir, includeWorktrees: false, includeProgrammatic: false }),
  ]);
  const interactiveIds = new Set(interactive.map((session) => session.sessionId));
  const byId = new Map(records.map((record) => [record.id, record]));
  const existing = new Set(sessions.map((session) => session.sessionId));
  for (const id of unrecorded.keys()) if (!existing.has(id)) unrecorded.delete(id);
  // The unrecorded sessions not read before, a few at a time: the SDK's, to find the panel chats
  // among them, and the command line's small ones, which may hold no prompt at all.
  const unread = sessions.filter(
    ({ sessionId, fileSize }) => !byId.has(sessionId) && !unrecorded.has(sessionId) && (!interactiveIds.has(sessionId) || (fileSize ?? 0) < SMALL_SESSION_BYTES),
  );
  // Those with no prompt: one just starting, or a file of only what Claude Code notes about a
  // session, as a process exiting after its file was deleted writes. Nothing to open; read again next time.
  const empty = new Set<string>();
  await eachInParallel(unread, async ({ sessionId }) => {
    const first = await firstUserText(sessionId, dir);
    if (first === null) empty.add(sessionId);
    else unrecorded.set(sessionId, /^<(obsidian_context|project_context|linked_chats)>/.test(first) ? chatTitle(first) : false);
  });
  const listed: { item: HistoryItem; stamp: string }[] = [];
  for (const session of sessions) {
    if (empty.has(session.sessionId)) continue;
    const record = byId.get(session.sessionId);
    let title = record?.title;
    let fromPanel = record !== undefined;
    const panelTitle = fromPanel || interactiveIds.has(session.sessionId) ? false : unrecorded.get(session.sessionId);
    if (panelTitle) {
      fromPanel = true;
      title = panelTitle;
    }
    if (!fromPanel && !includeAll) continue;
    listed.push({
      item: { id: session.sessionId, title: title ?? chatTitle(session.customTitle ?? session.summary), updatedAt: session.lastModified, fromPanel },
      stamp: `${session.lastModified}:${session.fileSize ?? ''}`,
    });
  }
  // Each listed chat's time, read again only for the files that changed; the file's own time stands
  // in where its messages cannot be read.
  const ids = new Set(listed.map(({ item }) => item.id));
  for (const id of activeAt.keys()) if (!ids.has(id)) activeAt.delete(id);
  await eachInParallel(
    listed.filter(({ item, stamp }) => activeAt.get(item.id)?.stamp !== stamp),
    async ({ item, stamp }) => {
      const at = await lastActive(item.id, dir);
      if (at === undefined) activeAt.delete(item.id);
      else activeAt.set(item.id, { stamp, at });
    },
  );
  const stamps = new Map(listed.map(({ item, stamp }) => [item.id, stamp]));
  const items = listed.map(({ item }) => ({ ...item, updatedAt: activeAt.get(item.id)?.at ?? item.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
  await markCopies(items, byId, stamps, sideSessions, dir);
  return items;
}

/**
 * Marks the copies of chats started outside the panel and links each such chat to the copies of it
 * listed. A copy made since 0.22.0 names its original in its record; an older one is told by sharing
 * its original's first prompt (see firstPrompts), and is linked only when one listed chat from outside
 * the panel has that prompt: a chat forked in the desktop app shares it too, and a copy of either
 * cannot then be told apart. Chats of the panel's own that share a first prompt (a kept side chat and
 * the chat it was opened on) are not copies; side chats still open (`sideSessions`) are left out.
 */
async function markCopies(
  items: HistoryItem[],
  records: Map<string, ChatRecord>,
  stamps: Map<string, string>,
  sideSessions: ReadonlySet<string>,
  dir: string,
): Promise<void> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const link = (copy: HistoryItem, original: HistoryItem | undefined) => {
    copy.copied = true;
    if (original) (original.copies ??= []).push(copy);
  };
  const unrecorded: HistoryItem[] = [];
  for (const item of items) {
    const copyOf = records.get(item.id)?.copyOf;
    if (copyOf) link(item, byId.get(copyOf));
    else if (item.fromPanel) unrecorded.push(item);
  }
  // Older copies, by first prompt: read only when a chat from outside the panel is listed to match.
  const outside = items.filter((item) => !item.fromPanel && !sideSessions.has(item.id));
  for (const id of firstPrompts.keys()) if (!byId.has(id)) firstPrompts.delete(id);
  if (outside.length > 0 && unrecorded.length > 0) {
    const toRead = [...outside, ...unrecorded].filter((item) => {
      const kept = firstPrompts.get(item.id);
      return !kept || (kept.prompt === null && kept.stamp !== stamps.get(item.id));
    });
    await eachInParallel(toRead, async (item) => {
      firstPrompts.set(item.id, { stamp: stamps.get(item.id) ?? '', prompt: await firstPromptId(item.id, dir) });
    });
    const originals = new Map<string, HistoryItem[]>();
    for (const item of outside) {
      const prompt = firstPrompts.get(item.id)?.prompt;
      if (prompt) originals.set(prompt, [...(originals.get(prompt) ?? []), item]);
    }
    for (const item of unrecorded) {
      const prompt = firstPrompts.get(item.id)?.prompt;
      const sharing = prompt ? originals.get(prompt) : undefined;
      if (sharing) link(item, sharing.length === 1 ? sharing[0] : undefined);
    }
  }
  for (const item of items) item.copies?.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The uuid of session `id`'s first prompt (see firstPrompts); null when there is none to read. */
async function firstPromptId(id: string, dir: string): Promise<string | null> {
  const file = await fs.open(sessionFile(id, dir), 'r').catch(() => null);
  if (!file) return null;
  try {
    // Lines are split on the newline byte, which never occurs inside a multi-byte character.
    let rest = Buffer.alloc(0);
    for (let position = 0; position < FIRST_PROMPT_BYTES; ) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let block = Buffer.concat([rest, chunk.subarray(0, bytesRead)]);
      for (let end = block.indexOf(0x0a); end !== -1; end = block.indexOf(0x0a)) {
        const row = parseRow(block.subarray(0, end).toString('utf8'));
        if (row?.type === 'user' && row.uuid) return row.uuid;
        block = block.subarray(end + 1);
      }
      rest = block;
    }
    return null;
  } catch (error) {
    log(`reading the start of session ${id} failed`, error);
    return null;
  } finally {
    await file.close();
  }
}

/** How much of the end of a session file lastActive reads first: its last message is nearly always there. */
const ACTIVE_TAIL_BYTES = 64 * 1024;

/**
 * When session `id` last had a prompt or reply, from the end of its file (see eachRowFromEnd): null
 * when it has none, undefined when its file cannot be read. A copy of a chat (see branchChat) counts
 * from when it was made: the SDK gives the copy's last row the time of copying and every other row
 * its original's, and that last row may be neither a prompt nor a reply (the end of a turn, say).
 */
async function lastActive(id: string, dir: string): Promise<number | null | undefined> {
  let at: number | null = null;
  const read = await eachRowFromEnd(
    id,
    dir,
    (row) => {
      const counts = row.type === 'user' || row.type === 'assistant' || row.forkedFrom !== undefined;
      const time = counts && row.timestamp ? Date.parse(row.timestamp) : NaN;
      if (!Number.isNaN(time)) at = time;
      return at !== null;
    },
    Infinity,
    ACTIVE_TAIL_BYTES,
  ).catch((error: unknown) => {
    log(`reading the end of session ${id} failed`, error);
    return false;
  });
  return read ? at : undefined;
}

/** The text of a session's first prompt: empty for one with none (an image alone), null when it has no prompt. */
async function firstUserText(id: string, dir: string): Promise<string | null> {
  const messages = await getSessionMessages(id, { dir, limit: 3 });
  for (const message of messages) {
    if (message.type !== 'user') continue;
    const content = (message.message as { content?: unknown } | null)?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const block = (content as { type?: string; text?: string }[]).find((item) => item.type === 'text');
      return block?.text ?? '';
    }
  }
  return null;
}

/**
 * Claude Code's title for a session: a /rename title, else the summary it generates; until it
 * has generated one, this is the first prompt (with the panel's context block removed).
 */
export async function sessionTitle(id: string, dir: string): Promise<string | null> {
  const info = await getSessionInfo(id, { dir });
  const title = info?.customTitle ?? info?.summary;
  return title ? chatTitle(title) : null;
}

/** The longest folder name Claude Code uses whole; a longer one is cut here and followed by a hash. */
const MAX_FOLDER_NAME = 200;

/**
 * The folder, under `<config>/projects`, that Claude Code keeps `dir`'s sessions in, named as the
 * Agent SDK names it (the SDK does not export this): the directory's real path, NFC on macOS, with
 * every character other than a letter or digit as "-"; over 200 characters, cut there and followed
 * by a hash of the path. With `CLAUDE_CONFIG_DIR` set, `CLAUDE_CODE_PROJECT_DIR_NAME` names it
 * outright. Claude Code's command line may hash a long path otherwise; the SDK's readers, which
 * the panel falls back to, look for that folder too.
 */
export function projectFolder(dir: string): string {
  const named = process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CODE_PROJECT_DIR_NAME : undefined;
  if (named && /^[A-Za-z0-9_-]{1,64}$/.test(named) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(named)) return named;
  let real = path.resolve(dir);
  try {
    real = realpathSync(real);
  } catch {
    // Not there to resolve: named as given.
  }
  if (process.platform === 'darwin') real = real.normalize('NFC');
  const name = real.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= MAX_FOLDER_NAME) return name;
  let hash = 0;
  for (let i = 0; i < real.length; i += 1) hash = ((hash << 5) - hash + real.charCodeAt(i)) | 0;
  return `${name.slice(0, MAX_FOLDER_NAME)}-${Math.abs(hash).toString(36)}`;
}

/** Claude Code's config folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
function configDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).normalize('NFC');
}

/** Where Claude Code keeps `dir`'s sessions: `<config>/projects/<projectFolder>`. */
function sessionFolder(dir: string): string {
  return path.join(configDir(), 'projects', projectFolder(dir));
}

/** The plans folder Claude Code's settings name (`plansDirectory`), absolute; null for its default. */
let customPlans: string | null = null;

/** Sets the plans folder from Claude Code's `plansDirectory` setting, relative to the vault `cwd`; none, the default. */
export function setPlansDirectory(setting: string | undefined, cwd: string): void {
  const root = path.resolve(cwd).normalize('NFC');
  const named = setting ? path.resolve(root, setting).normalize('NFC') : null;
  // As Claude Code takes it: only a folder inside the vault, else its default.
  const next = named && (named === root || named.startsWith(root + path.sep)) ? named : null;
  if (next === customPlans) return;
  customPlans = next;
  plansFolder = null;
}

/** Where Claude Code writes the plans it shows for approval: its `plansDirectory` setting, else `<config>/plans`. */
function plansDir(): string {
  return customPlans ?? path.join(configDir(), 'plans');
}

/**
 * The text of a plan Claude wrote in plan mode, from `file` as its ExitPlanMode request names it;
 * null when it is not a Markdown file in Claude Code's plans folder (see isPlanFile), or cannot be
 * read. The request carries the plan's text only when Claude passed it, or wrote the file first.
 */
export async function readPlanFile(file: unknown): Promise<string | null> {
  if (typeof file !== 'string' || !file.endsWith('.md') || !isPlanFile(file)) return null;
  return fs.readFile(path.resolve(file.normalize('NFC')), 'utf8').catch(() => null);
}

/**
 * Whether `file` is in Claude Code's plans folder (`<config>/plans`), where it writes the plan it
 * shows for approval: compared as real paths, as readPlanFile does, without case on Windows.
 */
export function isPlanFile(file: string): boolean {
  const plans = plansDir();
  const real = (where: string): string | null => {
    try {
      return realpathSync(where).normalize('NFC');
    } catch {
      return null;
    }
  };
  // Every file a chat changes is asked about, a chat opened from the history replaying them all:
  // the folder's real path is looked up once for each config folder, and the file's only when its
  // folder is called `plans`.
  // A folder not there yet is looked up again next time, rather than kept as it was named.
  if (plansFolder?.path !== plans || plansFolder.real === null) plansFolder = { path: plans, real: real(plans) };
  const folder = path.dirname(path.resolve(file.normalize('NFC')));
  if (path.basename(folder).toLowerCase() !== path.basename(plans).toLowerCase()) return false;
  const inFolder = real(folder) ?? folder;
  const plansReal = plansFolder.real ?? plans;
  return process.platform === 'win32' ? inFolder.toLowerCase() === plansReal.toLowerCase() : inFolder === plansReal;
}

/** The real path of Claude Code's plans folder, for the path it was found for (see isPlanFile). */
let plansFolder: { path: string; real: string | null } | null = null;

/** Where Claude Code keeps a session: `<config>/projects/<projectFolder>/<id>.jsonl`. */
function sessionFile(id: string, dir: string): string {
  return path.join(sessionFolder(dir), `${id}.jsonl`);
}

/** What tells whether session `id`'s file has changed since it was read: its time and size; null when it cannot be read. */
export async function sessionStamp(id: string, dir: string): Promise<string | null> {
  const stat = await fs.stat(sessionFile(id, dir)).catch(() => null);
  return stat ? `${stat.mtimeMs}:${stat.size}` : null;
}

/**
 * When messages `uuids` of session `id` were written, each as a local `YYYY-MM-DD`, read from the end
 * of its file until all are found; one not found (its file gone, say) is left out.
 */
/** How far back from the end of a chat's file to look for queued messages taken up. */
const QUEUED_TAIL_BYTES = 256 * 1024;

/**
 * The queued messages Claude Code has taken up mid-turn in session `id`, by their text, read from
 * the end of its file (no further than QUEUED_TAIL_BYTES): it writes one as an attachment the moment
 * it folds it into the turn running, before any result says so.
 */
export async function queuedTaken(id: string, dir: string): Promise<{ texts: string[]; uuids: Set<string> }> {
  const texts: string[] = [];
  const uuids = new Set<string>();
  await eachRowFromEnd(
    id,
    dir,
    (row) => {
      if (row.type === 'attachment' && row.attachment?.type === 'queued_command') {
        const prompt = row.attachment.prompt;
        const text = typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? textBlocksOf(prompt) : '';
        if (text) texts.push(text);
        if (row.attachment.source_uuid) uuids.add(row.attachment.source_uuid);
      }
      // The small row that says it was taken up, by the uuid it was sent with: found even when the
      // message's own row (an image in it) is too large for the end of the file read here.
      if (row.type === 'queue-operation' && row.operation === 'remove' && row.reason === 'absorbed_mid_turn' && row.commandUuid) uuids.add(row.commandUuid);
      return false;
    },
    QUEUED_TAIL_BYTES,
    QUEUED_TAIL_BYTES,
  ).catch((error: unknown) => log(`reading the queued messages of session ${id} failed`, error));
  return { texts, uuids };
}

/** The text of content blocks, as a queued message's prompt may be given. */
function textBlocksOf(blocks: unknown[]): string {
  return blocks.flatMap((block) => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : [])).join('\n');
}

export async function messageDates(id: string, dir: string, uuids: string[]): Promise<Map<string, string>> {
  const wanted = new Set(uuids);
  const dates = new Map<string, string>();
  if (wanted.size === 0) return dates;
  await eachRowFromEnd(id, dir, (row) => {
    const time = row.uuid && wanted.has(row.uuid) && row.timestamp ? Date.parse(row.timestamp) : NaN;
    if (row.uuid && !Number.isNaN(time)) dates.set(row.uuid, formatDate(time).slice(0, 10));
    return dates.size === wanted.size;
  }).catch((error: unknown) => log(`reading the dates of messages in session ${id} failed`, error));
  return dates;
}

/** The ids of the sessions Claude Code keeps for `dir`, by their files; null when their folder cannot be read. */
export async function sessionIds(dir: string): Promise<Set<string> | null> {
  const names = await fs.readdir(sessionFolder(dir)).catch(() => null);
  return names && new Set(names.filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)));
}

/**
 * A row's structured tool result with the tool_use_id it answers: it belongs to the message, so it
 * is taken only when the message holds one tool result. `diffsOnly`: only one that carries a diff.
 */
export function rowToolResult(
  row: { message?: { content?: unknown }; toolUseResult?: unknown },
  diffsOnly: boolean,
): [id: string, result: unknown] | null {
  const result = row.toolUseResult;
  if (!result || typeof result !== 'object') return null;
  if (diffsOnly && !('structuredPatch' in result || 'bashEditDiff' in result)) return null;
  const content = row.message?.content;
  const results = Array.isArray(content) ? (content.filter((block: { type?: string }) => block?.type === 'tool_result') as { tool_use_id?: string }[]) : [];
  return results.length === 1 && results[0].tool_use_id ? [results[0].tool_use_id, result] : null;
}

/** A chat as the panel draws it: its messages (see loadChat) and the tool results that carry a diff. */
export interface LoadedChat {
  transcript: SessionMessage[];
  /** Tool results with a diff (an Edit or Write patch, or the files a Bash command changed), by tool_use_id. */
  edits: Map<string, unknown>;
}

/**
 * A chat's prompts and replies, in the order they were written, and the tool results that carry a
 * diff, from one read of its session file. Claude Code keeps a session in `<config>/projects/<dir,
 * with every other character than letters and digits turned into "-">/<id>.jsonl`.
 *
 * Claude Code's own loader walks the chain of parent uuids and stops where a session branches,
 * which a resumed chat does mid-file: one chat here ended at 728 of its 917 messages, so its last
 * replies were missing from the panel although they were on disk. The file is read directly
 * instead, and the loader is the fallback when it cannot be read (with no diffs: the loader leaves
 * structured results out). Rows that are not messages (attachments, titles, queue operations),
 * a subagent's own traffic and compaction summaries are left out, as the loader leaves them out.
 * Where the chat was compacted, a `system` message stands in for the boundary, its `message`
 * holding `{ subtype: 'compact_boundary', trigger, preTokens }`.
 */
export function loadChat(id: string, dir: string): Promise<LoadedChat> {
  return readSession(id, dir, true);
}

/** A chat's prompts and replies (see loadChat), for reading rather than drawing: its diffs are not collected. */
export async function loadTranscript(id: string, dir: string): Promise<SessionMessage[]> {
  return (await readSession(id, dir, false)).transcript;
}

/** A row of a session file, as far as the panel reads it. */
interface SessionRow {
  type?: string;
  subtype?: string;
  compactMetadata?: { trigger?: unknown; preTokens?: unknown };
  uuid?: string;
  /** The entry before it in the chat's chain; null for the first. */
  parentUuid?: string | null;
  sessionId?: string;
  message?: { content?: unknown };
  toolUseResult?: unknown;
  /** When the row was written, for the rows of a chat's messages; the rows Claude Code adds about a session have none. */
  timestamp?: string;
  /** In a copy of a chat (see branchChat), the message the row copies. */
  forkedFrom?: unknown;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  /** What Claude Code attached to the chat: a queued message taken up mid-turn is one (`queued_command`). */
  attachment?: { type?: string; prompt?: unknown; source_uuid?: string };
  /** A queue operation's: what it did, why, and to which message (by the uuid it was sent with). */
  operation?: string;
  reason?: string;
  commandUuid?: string;
  isVisibleInTranscriptOnly?: boolean;
}

/** A session file's line as a row; null for a line still being written. */
function parseRow(line: string): SessionRow | null {
  try {
    return JSON.parse(line) as SessionRow;
  } catch {
    return null;
  }
}

/** A row as one of the chat's messages (see loadChat): a prompt or reply, or a compaction boundary; null for the rest. */
function rowMessage(row: SessionRow, id: string): SessionMessage | null {
  if (row.type === 'system' && row.subtype === 'compact_boundary' && !row.isSidechain) {
    return {
      type: 'system',
      uuid: row.uuid,
      session_id: row.sessionId ?? id,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { subtype: 'compact_boundary', trigger: row.compactMetadata?.trigger, preTokens: row.compactMetadata?.preTokens },
    } as unknown as SessionMessage;
  }
  // A message sent while Claude worked and taken up mid-turn is kept only as this attachment: drawn as the message it was.
  if (row.type === 'attachment' && row.attachment?.type === 'queued_command' && !row.isSidechain) {
    const { prompt, source_uuid: uuid } = row.attachment;
    if (typeof prompt !== 'string' && !Array.isArray(prompt)) return null;
    return {
      type: 'user',
      uuid: uuid ?? row.uuid,
      session_id: row.sessionId ?? id,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { role: 'user', content: prompt },
    } as unknown as SessionMessage;
  }
  if ((row.type !== 'user' && row.type !== 'assistant') || row.isSidechain || row.isMeta || !row.message) return null;
  // The summary Claude Code writes when it compacts a chat is stored as a user message, but it is
  // not one: it would show as a long message of yours, and be searched and saved as one.
  if (row.isCompactSummary || row.isVisibleInTranscriptOnly) return null;
  return {
    type: row.type,
    uuid: row.uuid,
    session_id: row.sessionId ?? id,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: row.message,
  } as unknown as SessionMessage;
}

async function readSession(id: string, dir: string, withEdits: boolean): Promise<LoadedChat> {
  let text: string;
  try {
    text = await fs.readFile(sessionFile(id, dir), 'utf8');
  } catch {
    return { transcript: await getSessionMessages(id, { dir }), edits: new Map() };
  }
  const messages: SessionMessage[] = [];
  const edits = new Map<string, unknown>();
  // Queued messages taken up mid-turn (see rowMessage), and the uuids of the messages of their own.
  const queued = new Set<SessionMessage>();
  const own = new Set<string>();
  for (const line of text.split('\n')) {
    const row = line ? parseRow(line) : null;
    if (!row) continue;
    const edit = withEdits ? rowToolResult(row, true) : null;
    if (edit) edits.set(...edit);
    const message = rowMessage(row, id);
    if (!message) continue;
    messages.push(message);
    if (row.type === 'attachment') queued.add(message);
    else if (message.uuid) own.add(message.uuid);
  }
  // A queued message that also became a message of its own is drawn once, as that message.
  const once = messages.filter((message) => !queued.has(message) || !message.uuid || !own.has(message.uuid));
  const transcript = once.some((message) => message.type !== 'system') ? once : await getSessionMessages(id, { dir });
  return { transcript, edits };
}

/** The end of a session file lastMessages reads first; each further read, further back, is twice the last. */
const TAIL_BYTES = 256 * 1024;

/**
 * Visits a session file's rows from the last back, until `visit` returns true or `maxBytes` have
 * been read; false when the file cannot be opened. The first read takes the last `firstBytes`, and
 * each further one goes further back, twice as far as the last; each byte is read and parsed once,
 * so a row costs in proportion to its distance from the end.
 */
async function eachRowFromEnd(id: string, dir: string, visit: (row: SessionRow) => boolean, maxBytes = Infinity, firstBytes = TAIL_BYTES): Promise<boolean> {
  let file: fs.FileHandle;
  try {
    file = await fs.open(sessionFile(id, dir), 'r');
  } catch {
    return false;
  }
  try {
    const { size } = await file.stat();
    // Everything from `end` on has been read; `cut` holds the start of the oldest line read, whose
    // beginning lies before `end` and comes with the next read.
    let end = size;
    let cut = Buffer.alloc(0);
    let done = false;
    for (let length = firstBytes; end > 0 && !done && size - end < maxBytes; length *= 2) {
      // Never past `maxBytes` read in all.
      const start = Math.max(0, end - Math.min(length, maxBytes - (size - end)));
      const bytes = Buffer.alloc(end - start);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
      // A short read (the file changed underneath): what is not there cannot be joined up.
      if (bytesRead < bytes.length) break;
      const block = Buffer.concat([bytes, cut]);
      // A newline byte never occurs inside a multi-byte character, so the split is safe in UTF-8.
      const first = start > 0 ? block.indexOf(0x0a) : -1;
      if (start > 0 && first === -1) {
        cut = block;
      } else {
        cut = start > 0 ? block.subarray(0, first) : Buffer.alloc(0);
        const lines = block.subarray(start > 0 ? first + 1 : 0).toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0 && !done; i -= 1) {
          const row = lines[i] ? parseRow(lines[i]) : null;
          if (row) done = visit(row);
        }
      }
      end = start;
    }
  } finally {
    await file.close();
  }
  return true;
}

/**
 * The latest `count` of a chat's messages (see loadChat) that `match` accepts, in the order they
 * were written, read from the end of its session file (see eachRowFromEnd): the prompt that started
 * a turn was written there moments before, so a long chat is not read whole to find it; `maxBytes`
 * stops the search short of the whole file, for messages that may not be there at all.
 */
export async function lastMessages(
  id: string,
  dir: string,
  match: (message: SessionMessage) => boolean,
  count = 1,
  maxBytes = Infinity,
): Promise<SessionMessage[]> {
  const found: SessionMessage[] = [];
  const read = await eachRowFromEnd(
    id,
    dir,
    (row) => {
      const message = rowMessage(row, id);
      if (message && match(message)) found.unshift(message);
      return found.length >= count;
    },
    maxBytes,
  );
  return read ? found : (await loadTranscript(id, dir)).filter(match).slice(-count);
}

/**
 * Where a copy of a chat ends to leave out a turn still in progress: the entry just before the
 * earliest of `prompts`, the messages that turn answers, read from the end of its session file no
 * further back than `maxBytes`. Null when that turn is the chat's first. When none of them is found
 * (the turn has only just begun, and Claude Code has not written its prompt yet), the chat's last
 * entry as it stands; undefined when the file has none or cannot be read.
 */
export async function entryBefore(id: string, dir: string, prompts: Iterable<string>, maxBytes = Infinity): Promise<string | null | undefined> {
  const left = new Set(prompts);
  let before: string | null | undefined;
  let last: string | undefined;
  await eachRowFromEnd(
    id,
    dir,
    (row) => {
      // An entry of the chat's own chain: a subagent's, or a row that is not an entry, has none.
      if (last === undefined && row.uuid && row.parentUuid !== undefined && !row.isSidechain) last = row.uuid;
      if (row.uuid && left.delete(row.uuid)) before = row.parentUuid ?? null;
      // Done once every prompt is found, and something to end at is known.
      return left.size === 0 && (before !== undefined || last !== undefined);
    },
    maxBytes,
  );
  return before === undefined ? last : before;
}

/** Deletes the session's saved transcript (and its subagents' transcripts) from this computer. */
export function deleteSessionFile(id: string, dir: string): Promise<void> {
  return deleteSession(id, { dir });
}

/** Deletes the session as deleteSessionFile does, and resolves as well when it has no file to delete: never written, or gone already. */
export async function deleteSessionIfAny(id: string, dir: string): Promise<void> {
  try {
    await deleteSessionFile(id, dir);
  } catch (error) {
    const written = await fs.stat(sessionFile(id, dir)).then(
      () => true,
      () => false,
    );
    if (written) throw error;
  }
}

/**
 * Deletes the sessions `ids`, except those in `keep`, trying each; one with no file is passed over,
 * and one that fails to go is logged and passed over. Returns those that failed, to try again.
 */
export async function deleteSessions(ids: string[], dir: string, keep: Set<string>, remove = deleteSessionIfAny): Promise<string[]> {
  const failed: string[] = [];
  for (const id of ids) {
    if (keep.has(id)) continue;
    try {
      await remove(id, dir);
    } catch (error) {
      log('a session was not deleted', id, error);
      failed.push(id);
    }
  }
  return failed;
}

/**
 * A background agent's transcript, read from the output file its task names (a link to the agent's
 * transcript), else from `fallback`; null for another task's output, which is not read: a shell
 * command's may be long.
 */
export async function agentTranscript(outputFile: string | undefined, fallback?: string): Promise<string | null> {
  // The output file lives in a temporary folder: once that is gone, the transcript kept with the chat.
  for (const candidate of [outputFile, fallback]) {
    if (!candidate) continue;
    const file = await fs.realpath(candidate).catch(() => null);
    if (file) return file.endsWith('.jsonl') ? fs.readFile(file, 'utf8') : null;
  }
  return null;
}

/** Where Claude Code keeps the transcript of agent `agentId` of session `sessionId` (a task's id is its agent's). */
export function subagentFile(sessionId: string, agentId: string, dir: string): string {
  return path.join(path.dirname(sessionFile(sessionId, dir)), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

/** Sets the session's title in Claude Code's own record (as /rename does). */
export function renameSessionTitle(id: string, dir: string, title: string): Promise<void> {
  return renameSession(id, title, { dir });
}

/**
 * Copies a session into a new one, up to and including message `upTo` (the whole session when
 * omitted); returns the new session's id. The original is not modified, and no Claude process
 * runs until the copy is resumed.
 */
export async function branchChat(id: string, dir: string, title: string, upTo?: string): Promise<string> {
  const { sessionId } = await forkSession(id, { dir, title, upToMessageId: upTo });
  return sessionId;
}

/** Rows of a session's file that hold no message and stay where a chat is cut: its title, mode and costs. Others (the last prompt, queue operations) refer to what was cut. */
const KEPT_WHEN_CUT = new Set(['custom-title', 'mode', 'cost-state', 'atis-latch']);

/**
 * What is left of a session's file `text` cut at message `from` (a prompt of yours): the rows before
 * it, and those after it that hold no message (see KEPT_WHEN_CUT); and the text cut, to put back.
 * Null when `from` is not there.
 */
export function cutSessionText(text: string, from: string): { kept: string; cut: string } | null {
  const lines = text.split('\n').filter((line) => line.trim());
  const rows = lines.map((line) => {
    try {
      return JSON.parse(line) as { uuid?: string; type?: string };
    } catch {
      return {};
    }
  });
  const start = rows.findIndex((row) => row.uuid === from);
  if (start === -1) return null;
  const keep = (i: number) => i < start || (rows[i].uuid === undefined && KEPT_WHEN_CUT.has(rows[i].type ?? ''));
  const kept = lines.filter((_, i) => keep(i));
  const cut = lines.filter((_, i) => !keep(i));
  return { kept: kept.length > 0 ? `${kept.join('\n')}\n` : '', cut: `${cut.join('\n')}\n` };
}

/**
 * Cuts session `id` at message `from` (a prompt of yours), in place, so the chat keeps its id: that
 * message and everything after it go (see cutSessionText). Its process must have ended. What is left,
 * to tell later that nothing was added since, and what was cut, to put back (see uncutChat).
 */
export async function cutChat(id: string, dir: string, from: string): Promise<{ kept: string; cut: string }> {
  const file = sessionFile(id, dir);
  const result = cutSessionText(await fs.readFile(file, 'utf8'), from);
  if (!result) throw new Error('that message is not in the saved conversation');
  const written = `${file}.tmp`;
  await fs.writeFile(written, result.kept);
  await fs.rename(written, file);
  return result;
}

/** Puts back what cutChat cut, when the chat is as it left it; false when something was added since. */
export async function uncutChat(id: string, dir: string, done: { kept: string; cut: string }): Promise<boolean> {
  const file = sessionFile(id, dir);
  if ((await fs.readFile(file, 'utf8').catch(() => null)) !== done.kept) return false;
  const written = `${file}.tmp`;
  await fs.writeFile(written, done.kept + done.cut);
  await fs.rename(written, file);
  return true;
}

/**
 * Copies a session from message `from` (a prompt of yours) on, up to and including `upTo` (the end
 * when omitted); returns the new session's id. The SDK's copy (see branchChat) is cut at its start:
 * each of its entries names the message it copies (`forkedFrom`), and those before `from`'s copy
 * are left out, which then starts the chat. A copy that Claude Code's reader cannot read is deleted.
 */
export async function branchChatFrom(id: string, dir: string, title: string, from: string, upTo?: string): Promise<string> {
  const copy = await branchChat(id, dir, title, upTo);
  const file = sessionFile(copy, dir);
  const written = `${file}.tmp`;
  try {
    const rows = (await fs.readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { forkedFrom?: { messageUuid?: string }; parentUuid?: string | null; logicalParentUuid?: string | null });
    const start = rows.findIndex((row) => row.forkedFrom?.messageUuid === from);
    if (start === -1) throw new Error('that message is not in the saved conversation');
    // Rows that copy no message (the title, say) are kept wherever they are.
    const kept = rows.filter((row, i) => i >= start || !row.forkedFrom);
    Object.assign(rows[start], { parentUuid: null, logicalParentUuid: null });
    await fs.writeFile(written, `${kept.map((row) => JSON.stringify(row)).join('\n')}\n`);
    await fs.rename(written, file);
    if ((await getSessionMessages(copy, { dir })).length === 0) throw new Error('the copy could not be read');
  } catch (error) {
    await fs.rm(written, { force: true }).catch(() => undefined);
    await deleteSessionIfAny(copy, dir).catch((deleting: unknown) => log('deleting a copy that failed', deleting));
    throw error;
  }
  return copy;
}
