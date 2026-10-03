// Memos saved from a chat: a note per memo, holding its title, a description, its tags (an idea, a
// todo, something to explore or to read), and the passages of the conversation it came from, each
// with who wrote it and links back to the chat. Kept free of `obsidian` imports so the tests can use it.

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
}

/** Passages saved together from one chat. */
export interface MemoSources {
  vault: string;
  chatId: string;
  chatTitle: string;
  /** `YYYY-MM-DD`. */
  date: string;
  passages: MemoPassage[];
}

/** The tags offered as toggles in the memo form; others are typed. */
export const MEMO_KINDS = ['idea', 'todo', 'explore', 'read'] as const;

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
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `obsidian://${PROTOCOL_ACTION}?${query}`;
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

/** The section recording passages saved from one chat: the chat and date, then each passage with who wrote it and links back. */
function memoSourcesMarkdown(sources: MemoSources): string {
  const lines = [`### ${headingText(sources.chatTitle)} · ${sources.date}`, ''];
  for (const passage of sources.passages) {
    const find = chatLink({ vault: sources.vault, chat: sources.chatId, msg: passage.message, find: passage.needle });
    const quote = chatLink({ vault: sources.vault, chat: sources.chatId, quote: passage.text.slice(0, QUOTE_LINK_CHARS) });
    lines.push(`**${passage.role === 'you' ? 'You' : 'Claude'}** · [Go to the passage](${find}) · [Continue in the chat](${quote})`, '');
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
export function memoNoteMarkdown(memo: { title: string; description: string; tags: string[]; notes: string[]; sources: MemoSources }): string {
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
    // A box in the Memos base: ticked, the memo is finished with, and shows only in the Done view.
    'done: false',
    `claude_chats: [${chatId}]`,
    '---',
  ];
  const body = [`# ${memo.title.trim()}`, ''];
  if (memo.description.trim()) body.push(memo.description.trim(), '');
  body.push('## Sources', '', memoSourcesMarkdown(memo.sources));
  return `${[...frontmatter, '', ...body].join('\n').trimEnd()}\n`;
}

/** `note` with passages added at the end of its Sources section, which is made when it has none. */
export function addMemoSources(note: string, sources: MemoSources): string {
  const section = memoSourcesMarkdown(sources);
  const text = note.trimEnd();
  const heading = /^## Sources[ \t]*$/m.exec(text);
  if (!heading) return `${`${text}\n\n## Sources\n\n${section}`.trimEnd()}\n`;
  // The end of the Sources section: the next heading of its level or above, else the end of the note.
  const after = text.slice(heading.index + heading[0].length);
  const next = /^#{1,2} /m.exec(after);
  const at = next ? heading.index + heading[0].length + next.index : text.length;
  return `${`${text.slice(0, at).trimEnd()}\n\n${section.trimEnd()}\n${next ? `\n${text.slice(at)}` : ''}`.trimEnd()}\n`;
}

/**
 * A note name made from a memo's title: what file names cannot hold is dropped, and what would end or
 * garble a value in a link's query (`&`, `%`, `+`, as the table's chat links carry the path), and it
 * is kept short.
 */
export function memoNoteName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]&%+]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * Where the memo `note` finds its first passage from chat `chatId`: the message (`msg`) and words
 * (`find`) of that chat's first "Go to the passage" link in it. Null when it has none.
 */
export function firstPassageTarget(note: string, chatId: string): { msg?: string; find?: string } | null {
  for (const match of note.matchAll(/obsidian:\/\/vault-claude\?([^)\s]+)/g)) {
    const params = new Map<string, string>();
    for (const pair of match[1].split('&')) {
      const at = pair.indexOf('=');
      if (at === -1) continue;
      try {
        params.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1)));
      } catch {
        // A value garbled by hand: the rest of the link may still do.
      }
    }
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

/**
 * The name of the Memos base's view of one chat's memos, which the panel opens (see memoBaseYaml):
 * the chat's title, so that a table left open still says whose memos it lists after the panel moves
 * on to another chat. What would end a link to the view (`#`, `|`, brackets, `^`) is left out.
 */
export function chatMemosView(chatTitle: string): string {
  const title = chatTitle.replace(/[#|[\]^\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `Chat: ${title || 'untitled'}`;
}

/** The name of the Memos base's view of every memo. */
export const ALL_MEMOS_VIEW = 'All memos';

/** The columns of the Memos base's views: its chats as links that open them (see chatLinksFormula). */
const BASE_COLUMNS = ['send', 'done', 'file.name', 'tags', 'formula.chat', 'notes', 'updated'];

/** Every view of the Memos base but Done leaves out the memos finished with. */
const NOT_DONE = 'done != true';

/** The name of the Memos base's view of the memos finished with. */
const DONE_VIEW = 'Done';

/**
 * The Memos base's formula for a memo's chats as links, each showing the chat's title and opening
 * the chat in the panel (see chatLink): Bases makes a link with display text of a URL, `obsidian://`
 * ones included.
 */
function chatLinksFormula(vault: string): string {
  // The memo's path goes with it, so that the chat opens at the memo's first passage from it.
  return `${CHAT_LINKS_START}${encodeURIComponent(vault)}&chat=" + value + "&memo=" + file.path, chats[index]))`;
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
    filters: { and: ['type == "memo"', NOT_DONE, chatFilter(chatId)] },
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
      ...['type == "memo"', ...(name === DONE_VIEW ? [] : [NOT_DONE]), ...filters].map((filter) => `        - ${JSON.stringify(filter)}`),
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
    '  done:',
    '    displayName: Done',
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
    view(chatMemosView(chatTitle), [chatFilter(chatId)], newest),
    view(ALL_MEMOS_VIEW, [], newest),
    view('About this note', ['file.hasLink(this.file)'], newest),
    view('To do', ['file.hasTag("todo")'], oldest),
    view('To read', ['file.hasTag("read")'], oldest),
    view('To explore', ['file.hasTag("explore")'], oldest),
    view('Ideas', ['file.hasTag("idea")'], newest),
    view('By chat', [], newest, 'chats'),
    view('By note', [], newest, 'notes'),
    view(DONE_VIEW, ['done == true'], newest),
    '',
  ].join('\n');
}


/** Whether a view's name is that of a view of one chat's memos, as the plugin names them (see chatMemosView). */
export function isChatViewName(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith('Chat: ');
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
  return addDoneBoxes({ ...record, formulas, properties, views });
}

/**
 * A Memos base from before the Done box, given it once: the column beside Send and the filter that
 * leaves finished memos out in each of the plugin's views (those that pick memos by type), and a
 * Done view at the end. One that has it is returned as it is.
 */
function addDoneBoxes(base: Record<string, unknown>): Record<string, unknown> {
  const properties = base.properties as Record<string, unknown>;
  if (properties.done !== undefined) return base;
  const views = (base.views as unknown[]).map((view) => {
    if (typeof view !== 'object' || view === null) return view;
    const record = view as Record<string, unknown>;
    const order = Array.isArray(record.order) ? record.order.flatMap((column) => (column === 'send' ? ['send', 'done'] : [column])) : record.order;
    const and = (record.filters as { and?: unknown } | undefined)?.and;
    const ours = Array.isArray(and) && and.includes('type == "memo"');
    return { ...record, order, ...(ours ? { filters: { ...(record.filters as object), and: [...and, NOT_DONE] } } : {}) };
  });
  views.push({ type: 'table', name: DONE_VIEW, filters: { and: ['type == "memo"', 'done == true'] }, order: BASE_COLUMNS, sort: [{ property: 'updated', direction: 'DESC' }] });
  return { ...base, properties: { ...properties, done: { displayName: 'Done' } }, views };
}
