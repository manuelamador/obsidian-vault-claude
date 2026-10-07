// Memos saved from a chat: a note per memo, holding its title, a description, its tags (an idea, a
// todo, something to explore or to read), and the passages of the conversation it came from, each
// with who wrote it and links back to the chat. Kept free of `obsidian` imports so the tests can use it.
import { closesFence, fenceMarker } from './fences';

/** A passage of one message, as saved. */
export interface MemoPassage {
  /** Who wrote the message. */
  role: 'you' | 'claude';
  /** The passage, with its equations as LaTeX (see selectionWithMath). */
  text: string;
  /** A stretch of its plain text, outside any equation, by which the chat's Find finds it again. */
  needle: string;
  /** The notes and files it links to, by link text or vault path (see ChatView.passageLinks). */
  links?: string[];
  /**
   * The message it came from: your message's id, or a reply text's key (its message's id, see
   * replyKey). A link goes straight to it; the needle then finds the passage within it.
   */
  message?: string;
  /** When that message was written, `YYYY-MM-DD`, when known: not when the passage was saved. */
  written?: string;
}


/** Passages saved together from one chat. */
export interface MemoSources {
  vault: string;
  chatId: string;
  chatTitle: string;
  /** When the passages were saved, `YYYY-MM-DD`. */
  date: string;
  passages: MemoPassage[];
}

/** The tags offered as toggles in the memo form; others are typed. */
export const MEMO_KINDS = ['idea', 'todo', 'explore', 'read', 'bookmark'] as const;

/** The tag of a memo saved with no title given: a bookmark (see quickMemoTitle). */
export const BOOKMARK_TAG = 'bookmark';

/** The longest passage carried by a "Continue in the chat" link, which quotes it in the chat's input. */
const QUOTE_LINK_CHARS = 2000;

/** The protocol action the plugin answers: `obsidian://vault-claude?…` (see VaultClaudePlugin.openChatLink). */
export const PROTOCOL_ACTION = 'vault-claude';

/**
 * A link that opens chat `chat` in the panel and goes to message `msg` (and the words `find` in it),
 * or finds `find` in the chat when it has no `msg`, or quotes `quote` in its input.
 */
export function chatLink(params: { vault: string; chat: string; msg?: string; find?: string; quote?: string }): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([key, value]) => `${key}=${linkValue(value)}`)
    .join('&');
  return `obsidian://${PROTOCOL_ACTION}?${query}`;
}

/** The chats that links made by chatLink in `text` open, each once. */
export function linkedChatIds(text: string): string[] {
  const ids = [...text.matchAll(new RegExp(`obsidian://${PROTOCOL_ACTION}\\?([^)\\s>]*)`, 'g'))].flatMap((match) => {
    try {
      return new URLSearchParams(match[1]).get('chat') ?? [];
    } catch {
      return [];
    }
  });
  return [...new Set(ids)];
}

/** `text` without its Markdown links to chat `id` (made by chatLink). */
export function removeChatLinks(text: string, id: string): string {
  return text
    .replace(new RegExp(`\\[[^\\]]*\\]\\(obsidian://${PROTOCOL_ACTION}\\?[^)\\s]*\\)[ \\t]?`, 'g'), (link) => (linkedChatIds(link).includes(id) ? '' : link))
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * `value` encoded for a link written in Markdown: as encodeURIComponent, and its parentheses too,
 * since one left unmatched (words cut inside one, an interval like [0,1)) would end the link early.
 */
function linkValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `text` as a Markdown blockquote, every line marked, blank ones included. */
function blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** Square brackets close a link's text: kept out of a chat title used as a heading. */
function headingText(text: string): string {
  return text.replace(/[[\]]/g, '');
}

/**
 * Tags as Obsidian takes them: without `#`, spaces as hyphens, only letters, numbers, `-`, `_` and
 * `/`, not all digits; each once, in the order given.
 */
export function cleanTags(tags: string[]): string[] {
  const clean = tags
    .map((tag) =>
      tag
        .trim()
        .replace(/^#+/, '')
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}_/-]/gu, ''),
    )
    .filter((tag) => tag && !/^\d+$/.test(tag));
  return [...new Set(clean)];
}

/** What started the line of a comment on a passage, in memos saved with 0.26.0, which had them: read back still. */
const COMMENT_MARK = '*Comment:* ';

/**
 * Where section `heading` (a `## ` heading) of a memo note is: from the start of its heading line
 * (`start`) and the end of it (`body`) to the next heading of its level or above (`end`, the note's
 * length when none). Headings are lines outside code fences, so an example in your Why is not one.
 */
function sectionBounds(note: string, heading: string): { start: number; body: number; end: number } | null {
  let fence: string | null = null;
  let found: { start: number; body: number } | null = null;
  let at = 0;
  for (const line of note.split('\n')) {
    const lineStart = at;
    at += line.length + 1;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker) {
      fence = marker;
      continue;
    }
    if (found) {
      if (/^#{1,2} /.test(line)) return { ...found, end: lineStart };
    } else if (line.replace(/[ \t]+$/, '') === `## ${heading}`) {
      found = { start: lineStart, body: lineStart + line.length };
    }
  }
  return found ? { ...found, end: note.length } : null;
}

/**
 * The section recording passages saved from one chat: the chat and the day they were saved, then each
 * passage: who wrote it and when (the message's date, when known), links back, and the passage quoted.
 */
function memoSourcesMarkdown(sources: MemoSources): string {
  const lines = [`### ${headingText(sources.chatTitle)} · saved ${sources.date}`, ''];
  for (const passage of sources.passages) {
    const find = chatLink({ vault: sources.vault, chat: sources.chatId, msg: passage.message, find: passage.needle });
    const quote = chatLink({ vault: sources.vault, chat: sources.chatId, quote: passage.text.slice(0, QUOTE_LINK_CHARS) });
    const who = [passage.role === 'you' ? 'You' : 'Claude', passage.written].filter(Boolean).join(' · ');
    lines.push(`**${who}** · [Go to the passage](${find}) · [Continue in the chat](${quote})`, '');
    lines.push(blockquote(passage.text.trim()), '');
  }
  return lines.join('\n');
}

/** A YAML list of `values`, each a double-quoted string (JSON's quoting is YAML's). */
function yamlList(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

/**
 * A new memo note: frontmatter, the title, the description, and the passages it came from. Its
 * properties name the chat it came from and, as links, the notes it is about (`notes`, wikilinks),
 * so that a note's backlinks and the Memos base find it.
 */
export function memoNoteMarkdown(memo: { title: string; description: string; why?: string; tags: string[]; notes: string[]; sources: MemoSources }): string {
  const { date, chatId, chatTitle } = memo.sources;
  // No `memo` tag: `type: memo` says what it is, and a tag every memo had would say nothing in a table.
  const tags = cleanTags(memo.tags);
  const frontmatter = [
    '---',
    'type: memo',
    ...(tags.length > 0 ? [`tags: [${tags.join(', ')}]`] : []),
    `created: ${date}`,
    `updated: ${date}`,
    `chats: ${yamlList([chatTitle])}`,
    ...(memo.notes.length > 0 ? [`notes: ${yamlList(memo.notes)}`] : []),
    // A box in the Memos base, in step with the chat's input: ticked while the memo is mentioned in it
    // (see VaultClaudePlugin.followMemoBox and ChatView.followMemoBoxes).
    'send: false',
    // A box in the Memos base: ticked, the memo is finished with, kept for reference in the Archived view only.
    'archived: false',
    // Yours to fill in, in the Memos base or the note: exploring, incorporated, resolved, discarded, or your own.
    'status:',
    `claude_chats: [${chatId}]`,
    '---',
  ];
  const body = [`# ${memo.title.trim()}`, ''];
  if (memo.description.trim()) body.push(memo.description.trim(), '');
  // Yours: why you keep it, and what comes next. A bookmark has neither, unless you gave it a Why.
  if (!tags.includes(BOOKMARK_TAG) || memo.why?.trim()) body.push('## Why', '', ...(memo.why?.trim() ? [memo.why.trim(), ''] : []), '## Next', '');
  body.push('## Sources', '', memoSourcesMarkdown(memo.sources));
  return `${[...frontmatter, '', ...body].join('\n').trimEnd()}\n`;
}

/** The text of section `heading` (a `## ` heading) of a memo note, without its heading; empty when it has none. */
export function memoSection(note: string, heading: string): string {
  const bounds = sectionBounds(note, heading);
  return bounds ? note.slice(bounds.body, bounds.end).trim() : '';
}

/**
 * A passage as a memo note holds it: its line (who and when; a label first, in memos saved with
 * 0.26.0) and its text, with a comment for those; and the chat and message its link goes to.
 */
export interface SavedPassage {
  header: string;
  text: string;
  comment: string;
  chat?: string;
  msg?: string;
}

/** The passages in a memo note's Sources section, in order (see memoSourcesMarkdown). */
export function savedPassages(note: string): SavedPassage[] {
  const lines = memoSection(note, 'Sources').split('\n');
  const passages: SavedPassage[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^\*\*(.+?)\*\* · \[Go to the passage\]\(obsidian:\/\/vault-claude\?([^)\s]*)\)/.exec(lines[i]);
    if (!head) continue;
    const params = new URLSearchParams(head[2]);
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('>')) j += 1;
    const quoted: string[] = [];
    for (; j < lines.length && lines[j].startsWith('>'); j += 1) quoted.push(lines[j].replace(/^> ?/, ''));
    while (j < lines.length && !lines[j].trim()) j += 1;
    const line = j < lines.length ? lines[j].trim() : '';
    // Before the comment mark, a comment was the line in italics.
    const comment = line.startsWith(COMMENT_MARK.trim()) ? line.slice(COMMENT_MARK.trim().length).trim() : /^\*[^*].*\*$/.test(line) ? line.slice(1, -1) : '';
    passages.push({ header: head[1], text: quoted.join('\n').trim(), comment, chat: params.get('chat') ?? undefined, msg: params.get('msg') ?? undefined });
  }
  return passages;
}

/** A memo linked from the one continued from: its name, Why and passages (see ContinueMemoModal). */
export interface LinkedMemo {
  name: string;
  why: string;
  passages: SavedPassage[];
}

/**
 * The draft that starts a chat from a memo (see ContinueMemoModal): the memo by name, what you chose
 * of it (your Why and Next, passages), the linked memos chosen with their Why and passages, and the
 * related notes as `@` mentions, so they go with it.
 */
export function continueDraft(memo: { name: string; why: string; next: string; passages: SavedPassage[]; notes: string[]; linked?: LinkedMemo[] }): string {
  // Only the related notes ticked go with it: a mention in what is quoted stays a plain link.
  const quiet = (text: string) => text.replace(/@(?=\[\[)/g, '');
  const quoted = (passage: SavedPassage) => `${quiet(passage.header)}:\n${blockquote(quiet(passage.text))}${passage.comment ? `\n(${quiet(passage.comment)})` : ''}`;
  const parts = [`Continuing from the memo [[${memo.name}]].`];
  if (memo.why) parts.push(`Why I kept it: ${quiet(memo.why)}`);
  if (memo.next) parts.push(`Next: ${quiet(memo.next)}`);
  if (memo.passages.length > 0) parts.push('Passages:', ...memo.passages.map(quoted));
  for (const linked of memo.linked ?? []) {
    parts.push(`From the linked memo [[${linked.name}]]:`);
    if (linked.why) parts.push(`Why I kept it: ${quiet(linked.why)}`);
    parts.push(...linked.passages.map(quoted));
  }
  if (memo.notes.length > 0) parts.push(`Related notes: ${memo.notes.map((note) => `@${note}`).join(' ')}`);
  return `${parts.join('\n\n')}\n\n`;
}

/**
 * A note name made from a memo's title: what file names cannot hold is dropped, and what would end or
 * garble a value in a link's query (`&`, `%`, `+`, as the table's chat links carry the path), and it
 * is kept short.
 */
export function memoNoteName(title: string): string {
  // No leading dot either: Obsidian does not see a file whose name starts with one.
  return title.replace(/[\\/:*?"<>|#^[\]&%+]/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim().slice(0, 100).trim();
}

/**
 * Where the memo `note` finds its first passage from chat `chatId`: the message (`msg`) and words
 * (`find`) of that chat's first "Go to the passage" link in it. Null when it has none.
 */
export function firstPassageTarget(note: string, chatId: string): { msg?: string; find?: string } | null {
  for (const match of note.matchAll(/obsidian:\/\/vault-claude\?([^)\s]+)/g)) {
    // `+` is never a space here: chatLink writes it as %2B.
    const params = new URLSearchParams(match[1]);
    if (params.get('chat') !== chatId || params.has('quote')) continue;
    const msg = params.get('msg');
    const find = params.get('find');
    if (msg || find) return { ...(msg ? { msg } : {}), ...(find ? { find } : {}) };
  }
  return null;
}

/**
 * The plain words to find a passage by in its chat: its first line of text outside equations, up to
 * `max` characters, cut at a word. Empty when it has none (an equation alone).
 */
export function passageNeedle(plain: string, max = 60): string {
  const line = plain.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

/**
 * The title of a memo saved with none given: the first words of its first passage that has any, or
 * of its text (an equation alone), else "Bookmark". Its note's name leaves out what a name cannot hold.
 */
export function quickMemoTitle(passages: MemoPassage[]): string {
  for (const passage of passages) {
    const words = passage.needle || passageNeedle(passage.text);
    if (memoNoteName(words)) return words;
  }
  return 'Bookmark';
}

/**
 * `title` made into a memo name no note has yet (`taken`): as it is, else with the date and time
 * added (`stamp`, as "2026-10-03 1432"), else with a number after that.
 */
export function freeMemoTitle(title: string, stamp: string, taken: (name: string) => boolean): string {
  if (!taken(memoNoteName(title))) return title;
  // Short enough that the date and number still fit in a note name (see memoNoteName), so each candidate differs.
  const stamped = `${title.slice(0, 60).trim()} ${stamp}`;
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? stamped : `${stamped} ${n}`;
    if (!taken(memoNoteName(candidate))) return candidate;
  }
}

/** The instructions for suggesting a memo's title and description (see VaultClaudePlugin.suggestMemo). */
export const MEMO_SUGGESTION_SYSTEM = [
  'You suggest a title and a description for a memo a researcher is saving from passages of a conversation with an AI assistant.',
  'Reply with JSON only, in this form: {"title": "…", "description": "…"}.',
  'The title: what the passages are about, as a short statement or question, at most ten words, with no final full stop.',
  'The description: one or two sentences saying what came out of the passages, in plain factual terms: what was asked, proposed or corrected.',
  'No claims about novelty, importance or who had the idea; no first person; no praise. Keep mathematical notation as LaTeX between $ signs.',
].join('\n');

/** The request for a suggestion: the chat's title, then the passages in order, with who wrote each. */
export function memoSuggestionPrompt(chatTitle: string, passages: MemoPassage[]): string {
  const quoted = passages.map((passage) => `${passage.role === 'you' ? 'The researcher' : 'The assistant'}:\n${passage.text.trim()}`);
  return `Conversation: ${chatTitle}\n\nPassages, in order:\n\n${quoted.join('\n\n')}`;
}

/** The suggestion in a reply: its JSON object's title and description; null when there is none to read. */
export function readMemoSuggestion(reply: string): { title: string; description: string } | null {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (!json) return null;
  try {
    const value = JSON.parse(json) as { title?: unknown; description?: unknown };
    const title = typeof value.title === 'string' ? value.title.trim().replace(/\.$/, '') : '';
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    return title || description ? { title, description } : null;
  } catch {
    return null;
  }
}

/** How the name of the view of one chat's memos starts (see chatMemosView, isChatViewName). */
const CHAT_VIEW_PREFIX = 'Chat: ';

/**
 * The name of the Memos base's view of one chat's memos, which the panel opens (see memoBaseYaml):
 * the chat's title, so that a table left open still says whose memos it lists after the panel moves
 * on to another chat. What would end a link to the view (`#`, `|`, brackets, `^`) is left out.
 */
export function chatMemosView(chatTitle: string): string {
  const title = chatTitle.replace(/[#|[\]^\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${CHAT_VIEW_PREFIX}${title || 'untitled'}`;
}

/** The name of the Memos base's view of every memo. */
export const ALL_MEMOS_VIEW = 'All memos';

/** The columns of the Memos base's views: its chats as links that open them (see chatLinksFormula). */
const BASE_COLUMNS = ['send', 'archived', 'file.name', 'status', 'tags', 'formula.chat', 'notes', 'updated'];

/** Every view of the Memos base but Archived leaves out the memos archived. */
const NOT_ARCHIVED = 'archived != true';

/** The name of the Memos base's view of the memos archived. */
const ARCHIVED_VIEW = 'Archived';

/**
 * The Memos base's formula for a memo's chats as links, each showing the chat's title and opening
 * the chat in the panel (see chatLink): Bases makes a link with display text of a URL, `obsidian://`
 * ones included.
 */
function chatLinksFormula(vault: string): string {
  // The memo's name goes with it, so that the chat opens at the memo's first passage from it: its
  // name, not its path, as a folder's name may hold what a link's query cannot (a formula cannot
  // encode it), and the names of memos leave that out (see memoNoteName).
  return `${CHAT_LINKS_START}${encodeURIComponent(vault)}&chat=" + value + "&memo=" + file.name, chats[index]))`;
}

/** How the plugin's chat-link formula starts, by which a formula of its own is told from one of the user's. */
const CHAT_LINKS_START = `claude_chats.map(link("obsidian://${PROTOCOL_ACTION}?vault=`;

/**
 * A memo's chats, paired: `ids[i]` is the chat whose title is `titles[i]`, which the table's links rely
 * on. Chat `chatId` is added with its title when it is not there, and its title updated when it is.
 */
export function pairChat(ids: string[], titles: string[], chatId: string, chatTitle: string): { ids: string[]; titles: string[] } {
  const paired = { ids: [...ids], titles: ids.map((_, i) => titles[i] ?? '') };
  const at = paired.ids.indexOf(chatId);
  if (at === -1) {
    paired.ids.push(chatId);
    paired.titles.push(chatTitle);
  } else paired.titles[at] = chatTitle;
  return paired;
}

/** The filter that picks chat `chatId`'s memos, by which the base's view of one chat is known. */
function chatFilter(chatId: string): string {
  return `claude_chats.contains(${JSON.stringify(chatId)})`;
}

/** The view of chat `chatId`'s memos, newest first. */
function chatView(chatId: string, chatTitle: string): Record<string, unknown> {
  return {
    type: 'table',
    name: chatMemosView(chatTitle),
    filters: { and: ['type == "memo"', NOT_ARCHIVED, chatFilter(chatId)] },
    order: BASE_COLUMNS,
    sort: [{ property: 'updated', direction: 'DESC' }],
  };
}

/**
 * The Memos base the panel writes for a new file and opens: first the memos of chat `chatId`, then
 * those about the note in front (the note it is embedded in, or the active one when it is open in a
 * sidebar), all memos, and those of each kind. Memos are found by `type: memo` wherever they are.
 */
export function memoBaseYaml(chatId: string, chatTitle: string, vault: string): string {
  // `group`: rows in sections by that property, whose column is then left out.
  const view = (name: string, filters: string[], sort: { property: string; direction: 'ASC' | 'DESC' }, group?: 'chats' | 'notes') =>
    [
      '  - type: table',
      `    name: ${JSON.stringify(name)}`,
      '    filters:',
      '      and:',
      ...['type == "memo"', ...(name === ARCHIVED_VIEW ? [] : [NOT_ARCHIVED]), ...filters].map((filter) => `        - ${JSON.stringify(filter)}`),
      ...(group ? ['    groupBy:', `      property: ${group}`, '      direction: ASC'] : []),
      '    order:',
      ...BASE_COLUMNS.filter((column) => !(group === 'chats' && column === 'formula.chat') && column !== group).map((column) => `      - ${column}`),
      '    sort:',
      `      - property: ${sort.property}`,
      `        direction: ${sort.direction}`,
    ].join('\n');
  const newest = { property: 'updated', direction: 'DESC' } as const;
  const oldest = { property: 'created', direction: 'ASC' } as const;
  return [
    'formulas:',
    `  chat: ${JSON.stringify(chatLinksFormula(vault))}`,
    'properties:',
    '  send:',
    '    displayName: Send to chat',
    '  archived:',
    '    displayName: Archived',
    '  status:',
    '    displayName: Status',
    '  file.name:',
    '    displayName: Memo',
    '  tags:',
    '    displayName: Tags',
    '  formula.chat:',
    '    displayName: Chats',
    '  notes:',
    '    displayName: Notes',
    '  updated:',
    '    displayName: Updated',
    'views:',
    // A chat not started has no id to pick its memos by: no view of its own until it has one.
    ...(chatId ? [view(chatMemosView(chatTitle), [chatFilter(chatId)], newest)] : []),
    view(ALL_MEMOS_VIEW, [], newest),
    view('About this note', ['file.hasLink(this.file)'], newest),
    view('To do', ['file.hasTag("todo")'], oldest),
    view('To read', ['file.hasTag("read")'], oldest),
    view('To explore', ['file.hasTag("explore")'], oldest),
    view('Ideas', ['file.hasTag("idea")'], newest),
    view('Bookmarks', [`file.hasTag("${BOOKMARK_TAG}")`], newest),
    view('By chat', [], newest, 'chats'),
    view('By note', [], newest, 'notes'),
    view(ARCHIVED_VIEW, ['archived == true'], newest),
    '',
  ].join('\n');
}


/** Whether a view's name is that of a view of one chat's memos, as the plugin names them (see chatMemosView). */
export function isChatViewName(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith(CHAT_VIEW_PREFIX);
}

/** Whether `value`, part of a view's filters, holds the filter of one chat's memos. */
function picksChat(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('claude_chats.contains(');
  if (Array.isArray(value)) return value.some(picksChat);
  return typeof value === 'object' && value !== null && Object.values(value).some(picksChat);
}

/**
 * The Memos base `base` (as parsed from its file) turned to chat `chatId`: its view of one chat's
 * memos gets the chat's name and filter, and everything else in it (columns, sorts, widths, views of
 * the user's own) stays. A base with no such view gets one, first. Null when `base` is not a base.
 */
export function retargetMemoBase(base: unknown, chatId: string, chatTitle: string, vault: string): Record<string, unknown> | null {
  if (typeof base !== 'object' || base === null || !Array.isArray((base as { views?: unknown }).views)) return null;
  // Chats as links that open them, in a base written before they were: the formula, and in each
  // view the column of chat titles swapped for it.
  const record = base as Record<string, unknown>;
  const formulas = { ...(typeof record.formulas === 'object' && record.formulas !== null ? (record.formulas as Record<string, unknown>) : {}) };
  const upgrading = formulas.chat === undefined;
  // The plugin's own formula is kept pointing at this vault (renamed, or a copy); one of the user's is left alone.
  if (upgrading || (typeof formulas.chat === 'string' && formulas.chat.startsWith(CHAT_LINKS_START))) formulas.chat = chatLinksFormula(vault);
  const properties = { ...(typeof record.properties === 'object' && record.properties !== null ? (record.properties as Record<string, unknown>) : {}) };
  properties['formula.chat'] ??= { displayName: 'Chats' };
  // Once, as the formula comes in: a column of chats put in by the user later stays as they put it.
  const views = (record.views as unknown[]).map((view) => {
    if (!upgrading || typeof view !== 'object' || view === null || !Array.isArray((view as { order?: unknown }).order)) return view;
    const order = (view as { order: unknown[] }).order.map((column) => (column === 'chats' ? 'formula.chat' : column));
    return { ...(view as Record<string, unknown>), order };
  });
  const at = views.findIndex((view) => typeof view === 'object' && view !== null && picksChat((view as { filters?: unknown }).filters));
  if (at === -1) views.unshift(chatView(chatId, chatTitle));
  else {
    const view = views[at] as Record<string, unknown>;
    const retarget = (value: unknown): unknown =>
      typeof value === 'string' ? (picksChat(value) ? chatFilter(chatId) : value) : Array.isArray(value) ? value.map(retarget) : typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, retarget(inner)])) : value;
    views[at] = { ...view, name: chatMemosView(chatTitle), filters: retarget(view.filters) };
  }
  return upgradeMemoBase({ ...record, formulas, properties, views });
}

/**
 * A Memos base (as parsed from its file) brought up to date, whatever chat it is on: Done renamed
 * Archived, and the Archived and Status columns given once. Null when `base` is not a base.
 */
export function upgradeMemoBase(base: unknown): Record<string, unknown> | null {
  if (typeof base !== 'object' || base === null || !Array.isArray((base as { views?: unknown }).views)) return null;
  const record = base as Record<string, unknown>;
  const properties = { ...(typeof record.properties === 'object' && record.properties !== null ? (record.properties as Record<string, unknown>) : {}) };
  // Status first: the Archived view added after it has every column, Status among them.
  return addArchivedBoxes(addStatusColumn(renameDoneToArchived({ ...record, properties })));
}

/** Whether a view of `base` has column `column`. */
function hasColumn(base: Record<string, unknown>, column: string): boolean {
  return (base.views as unknown[]).some((view) => typeof view === 'object' && view !== null && Array.isArray((view as { order?: unknown }).order) && ((view as { order: unknown[] }).order.includes(column)));
}

/** Whether `base` has a view named `name`. */
function hasView(base: Record<string, unknown>, name: string): boolean {
  return (base.views as unknown[]).some((view) => typeof view === 'object' && view !== null && (view as { name?: unknown }).name === name);
}

/**
 * A Memos base from before the Status column, given it once, after the memo's name in each of the
 * plugin's views (those that pick memos by type); views of your own are left as they are. One that
 * has it is returned as it is.
 */
function addStatusColumn(base: Record<string, unknown>): Record<string, unknown> {
  const properties = base.properties as Record<string, unknown>;
  if (properties.status !== undefined) return base;
  // Its display name taken out by hand, the column stays as it is.
  if (hasColumn(base, 'status')) return { ...base, properties: { ...properties, status: { displayName: 'Status' } } };
  const views = (base.views as unknown[]).map((view) => {
    if (typeof view !== 'object' || view === null || !Array.isArray((view as { order?: unknown }).order)) return view;
    const and = ((view as { filters?: { and?: unknown } }).filters ?? {}).and;
    const order = (view as { order: unknown[] }).order;
    if (!Array.isArray(and) || !and.includes('type == "memo"') || order.includes('status')) return view;
    return { ...(view as Record<string, unknown>), order: order.flatMap((column) => (column === 'file.name' ? ['file.name', 'status'] : [column])) };
  });
  return { ...base, properties: { ...properties, status: { displayName: 'Status' } }, views };
}

/**
 * A Memos base from before the Archived box, given it once: the column beside Send and the filter
 * that leaves archived memos out in each of the plugin's views (those that pick memos by type), and
 * an Archived view at the end. One that has it is returned as it is.
 */
function addArchivedBoxes(base: Record<string, unknown>): Record<string, unknown> {
  const properties = base.properties as Record<string, unknown>;
  if (properties.archived !== undefined) return base;
  // Its display name taken out by hand, the Archived view there already stays the only one.
  if (hasView(base, ARCHIVED_VIEW)) return { ...base, properties: { ...properties, archived: { displayName: 'Archived' } } };
  const views = (base.views as unknown[]).map((view) => {
    if (typeof view !== 'object' || view === null) return view;
    const record = view as Record<string, unknown>;
    const order = Array.isArray(record.order) ? record.order.flatMap((column) => (column === 'send' ? ['send', 'archived'] : [column])) : record.order;
    const and = (record.filters as { and?: unknown } | undefined)?.and;
    const ours = Array.isArray(and) && and.includes('type == "memo"') && !and.includes(NOT_ARCHIVED);
    return { ...record, order, ...(ours ? { filters: { ...(record.filters as object), and: [...and, NOT_ARCHIVED] } } : {}) };
  });
  views.push({ type: 'table', name: ARCHIVED_VIEW, filters: { and: ['type == "memo"', 'archived == true'] }, order: BASE_COLUMNS, sort: [{ property: 'updated', direction: 'DESC' }] });
  return { ...base, properties: { ...properties, archived: { displayName: 'Archived' } }, views };
}

/**
 * A Memos base from when an archived memo was called done (before 0.27.0): its Done column, filters
 * and view become Archived ones, everything else as it was. One without them is returned as it is.
 */
function renameDoneToArchived(base: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...(base.properties as Record<string, unknown>) };
  if (properties.done === undefined || properties.archived !== undefined) return base;
  delete properties.done;
  properties.archived = { displayName: 'Archived' };
  const renamed = (value: unknown): unknown =>
    typeof value === 'string'
      ? value.replace(/^done ([!=]=) true$/, 'archived $1 true')
      : Array.isArray(value)
        ? value.map(renamed)
        : typeof value === 'object' && value !== null
          ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, renamed(inner)]))
          : value;
  const views = (base.views as unknown[]).map((view) => {
    if (typeof view !== 'object' || view === null) return view;
    const record = view as Record<string, unknown>;
    const order = Array.isArray(record.order) ? record.order.map((column) => (column === 'done' ? 'archived' : column)) : record.order;
    return { ...record, ...(record.name === 'Done' ? { name: ARCHIVED_VIEW } : {}), order, filters: renamed(record.filters) };
  });
  return { ...base, properties, views };
}
