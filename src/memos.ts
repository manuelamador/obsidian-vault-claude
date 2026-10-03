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

/** A link that opens chat `chat` in the panel and finds `find` in it, or quotes `quote` in its input. */
export function chatLink(params: { vault: string; chat: string; find?: string; quote?: string }): string {
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
export function memoSourcesMarkdown(sources: MemoSources): string {
  const lines = [`### ${headingText(sources.chatTitle)} · ${sources.date}`, ''];
  for (const passage of sources.passages) {
    const find = chatLink({ vault: sources.vault, chat: sources.chatId, find: passage.needle });
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
  const tags = cleanTags(['memo', ...memo.tags]);
  const frontmatter = [
    '---',
    'type: memo',
    `tags: [${tags.join(', ')}]`,
    `created: ${date}`,
    `updated: ${date}`,
    `chats: ${yamlList([chatTitle])}`,
    ...(memo.notes.length > 0 ? [`notes: ${yamlList(memo.notes)}`] : []),
    // A box in the Memos base: ticked, the memo goes to the chat's input (see VaultClaudePlugin.sendMemo).
    'send: false',
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

/** A note name made from a memo's title: what file names cannot hold is dropped, and it is kept short. */
export function memoNoteName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
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

/**
 * The Memos base the panel writes and opens, in the memos folder: first the memos of chat `chatId`,
 * then those about the note in front (the note it is embedded in, or the active one when it is open
 * in a sidebar), all memos, and those of each kind. Written anew each time it is opened from a chat.
 */
export function memoBaseYaml(folder: string, chatId: string, chatTitle: string): string {
  const where = folder === '/' ? [] : [`file.inFolder(${JSON.stringify(folder)})`];
  const columns = ['send', 'file.name', 'tags', 'chats', 'notes', 'updated'];
  const view = (name: string, filters: string[], sort: { property: string; direction: 'ASC' | 'DESC' }) =>
    [
      '  - type: table',
      `    name: ${JSON.stringify(name)}`,
      '    filters:',
      '      and:',
      ...[...where, 'type == "memo"', ...filters].map((filter) => `        - ${JSON.stringify(filter)}`),
      '    order:',
      ...columns.map((column) => `      - ${column}`),
      '    sort:',
      `      - property: ${sort.property}`,
      `        direction: ${sort.direction}`,
    ].join('\n');
  const newest = { property: 'updated', direction: 'DESC' } as const;
  const oldest = { property: 'created', direction: 'ASC' } as const;
  return [
    `# Written by Vault Claude when a chat's memos are shown (now: ${chatTitle.replace(/\n/g, ' ')}); copy it to keep changes of your own.`,
    'properties:',
    '  send:',
    '    displayName: Send to chat',
    '  file.name:',
    '    displayName: Memo',
    '  tags:',
    '    displayName: Tags',
    '  chats:',
    '    displayName: Chats',
    '  notes:',
    '    displayName: Notes',
    '  updated:',
    '    displayName: Updated',
    'views:',
    view(chatMemosView(chatTitle), [`claude_chats.contains(${JSON.stringify(chatId)})`], newest),
    view('About this note', ['file.hasLink(this.file)'], newest),
    view('All memos', [], newest),
    view('To do', ['file.hasTag("todo")'], oldest),
    view('To read', ['file.hasTag("read")'], oldest),
    view('To explore', ['file.hasTag("explore")'], oldest),
    view('Ideas', ['file.hasTag("idea")'], newest),
    '',
  ].join('\n');
}
