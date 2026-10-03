// Ideas captured from a chat: a note per idea, holding its title, a description in the user's own
// words, and the passages of the conversation it came from, each with who wrote it and links back
// to the chat. Kept free of `obsidian` imports so the tests can use it.

/** A passage of one message, as captured. */
export interface IdeaExcerpt {
  /** Who wrote the message. */
  role: 'you' | 'claude';
  /** The passage, with its equations as LaTeX (see selectionWithMath). */
  text: string;
  /** A stretch of its plain text, outside any equation, by which the chat's Find finds it again. */
  needle: string;
}

/** Passages captured together from one chat. */
export interface IdeaSources {
  vault: string;
  chatId: string;
  chatTitle: string;
  /** `YYYY-MM-DD`. */
  date: string;
  excerpts: IdeaExcerpt[];
}

/** The longest passage carried by a "Continue in the chat" link, which quotes it in the chat's input. */
const QUOTE_LINK_CHARS = 2000;

/** The protocol action the plugin answers: `obsidian://vault-claude?…` (see VaultClaudePlugin.onProtocol). */
export const PROTOCOL_ACTION = 'vault-claude';

/** A link that opens chat `chatId` in the panel and finds `find` in it, or quotes `quote` in its input. */
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

/** Square brackets close a link's text: kept out of a chat title used as one. */
function linkText(text: string): string {
  return text.replace(/[[\]]/g, '');
}

/** The section recording passages captured from one chat: the chat and date, then each passage with who wrote it and links back. */
export function ideaSourcesMarkdown(sources: IdeaSources): string {
  const lines = [`### ${linkText(sources.chatTitle)} · ${sources.date}`, ''];
  for (const excerpt of sources.excerpts) {
    const find = chatLink({ vault: sources.vault, chat: sources.chatId, find: excerpt.needle });
    const quote = chatLink({ vault: sources.vault, chat: sources.chatId, quote: excerpt.text.slice(0, QUOTE_LINK_CHARS) });
    lines.push(`**${excerpt.role === 'you' ? 'You' : 'Claude'}** · [Go to the passage](${find}) · [Continue in the chat](${quote})`, '');
    lines.push(blockquote(excerpt.text.trim()), '');
  }
  return lines.join('\n');
}

/** A new idea note: frontmatter, the title, the description, and the passages it came from. */
export function ideaNoteMarkdown(idea: { title: string; description: string; sources: IdeaSources }): string {
  const { date, chatId } = idea.sources;
  const frontmatter = ['---', 'type: idea', 'tags: [idea]', `created: ${date}`, `updated: ${date}`, `claude_chats: [${chatId}]`, '---'];
  const body = [`# ${idea.title.trim()}`, ''];
  if (idea.description.trim()) body.push(idea.description.trim(), '');
  body.push('## Sources', '', ideaSourcesMarkdown(idea.sources));
  return `${[...frontmatter, '', ...body].join('\n').trimEnd()}\n`;
}

/** `note` with passages added at the end of its Sources section, which is made when it has none. */
export function addIdeaSources(note: string, sources: IdeaSources): string {
  const section = ideaSourcesMarkdown(sources);
  const text = note.trimEnd();
  const heading = /^## Sources[ \t]*$/m.exec(text);
  if (!heading) return `${text}\n\n## Sources\n\n${section}`.trimEnd() + '\n';
  // The end of the Sources section: the next heading of its level or above, else the end of the note.
  const after = text.slice(heading.index + heading[0].length);
  const next = /^#{1,2} /m.exec(after);
  const at = next ? heading.index + heading[0].length + next.index : text.length;
  return `${text.slice(0, at).trimEnd()}\n\n${section.trimEnd()}\n${next ? `\n${text.slice(at)}` : ''}`.trimEnd() + '\n';
}

/** A note name made from an idea's title: what file names cannot hold is dropped, and it is kept short. */
export function ideaNoteName(title: string): string {
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
