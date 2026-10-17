// What a chat's saved transcript says about its notes, for rebuilding the links between chats and
// notes (see VaultClaudePlugin.rebuildConnections): the notes sent with its messages, read from the
// context block the panel prepends, and the notes its replies link to. The notes it changed come
// from its tool results (see savedChangedFiles). Kept free of `obsidian` imports so the tests can use it.
import { closesFence, fenceMarker } from './fences';

const CONTEXT = /<obsidian_context>([\s\S]*?)<\/obsidian_context>/;

/** The notes a prompt's context block sent: attached (or, in older chats, active), mentioned, or selected in; as written there, some absolute. */
export function promptNotes(text: string): string[] {
  const block = CONTEXT.exec(text)?.[1];
  if (!block) return [];
  const found: string[] = [];
  for (const pattern of [/^Note attached to this chat: (.+)$/gm, /^Active note in Obsidian: (.+)$/gm, /^Mentioned note: (.+)$/gm, /<note path="([^"]+)">/g, /<selection note="([^"]+)"/g]) {
    for (const match of block.matchAll(pattern)) found.push(match[1].trim());
  }
  return [...new Set(found)];
}

/** `text` with its code left out: fenced blocks (in a quote too) and inline code spans, whose links are examples, not links. */
function withoutCode(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const bare = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
    if (fence) {
      if (closesFence(bare, fence)) fence = null;
      continue;
    }
    const opening = fenceMarker(bare);
    if (opening) {
      fence = opening;
      continue;
    }
    kept.push(line);
  }
  // A code span: a run of backticks closed by a run of the same length, within one paragraph.
  return kept.join('\n').replace(/(?<![`\\])(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g, ' ');
}

/**
 * The link targets in a reply, outside its code: `[[wikilinks]]` (without heading, block or alias)
 * and Markdown links to `.md` files, in angle brackets (`[x](<My Note.md>)`) or not, without a
 * heading or block after `#`, decoded.
 */
export function replyLinks(text: string): string[] {
  const prose = withoutCode(text);
  const found: string[] = [];
  for (const match of prose.matchAll(/\[\[([^\]|#^\n]+)/g)) found.push(match[1].trim());
  for (const match of prose.matchAll(/\]\((?:<([^<>\n]+)>|([^)\s<>]+))/g)) {
    const target = (match[1] ?? match[2]).split('#')[0].trim();
    if (!/\.md$/i.test(target)) continue;
    try {
      found.push(decodeURIComponent(target));
    } catch {
      found.push(target);
    }
  }
  return [...new Set(found.filter(Boolean))];
}

/** The text of a message's content: a string, or its text blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => ((block as { type?: string; text?: unknown })?.type === 'text' ? String((block as { text?: unknown }).text ?? '') : '')).join('\n');
}

/** A transcript's notes sent with prompts and link targets in replies, from the chat's own messages (not a subagent's). */
export function transcriptNotes(transcript: { type: string; message: unknown; parent_tool_use_id?: string | null }[]): { sent: string[]; mentioned: string[] } {
  const sent = new Set<string>();
  const mentioned = new Set<string>();
  for (const row of transcript) {
    if (row.parent_tool_use_id) continue;
    const text = textOf((row.message as { content?: unknown } | null)?.content);
    if (row.type === 'user') for (const path of promptNotes(text)) sent.add(path);
    else if (row.type === 'assistant') for (const target of replyLinks(text)) mentioned.add(target);
  }
  return { sent: [...sent], mentioned: [...mentioned] };
}
