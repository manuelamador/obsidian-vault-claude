// What a chat's saved transcript says about its notes, for rebuilding the links between chats and
// notes (see VaultClaudePlugin.rebuildConnections): the notes sent with its messages, read from the
// context block the panel prepends, and the notes its replies link to. The notes it changed come
// from its tool results (see savedChangedFiles). Kept free of `obsidian` imports so the tests can use it.

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

/** The link targets in a reply: `[[wikilinks]]` (without heading, block or alias) and Markdown links to `.md` files, decoded. */
export function replyLinks(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\[\[([^\]|#^\n]+)/g)) found.push(match[1].trim());
  for (const match of text.matchAll(/\]\(<?([^)\s>]+\.md)>?\)/g)) {
    try {
      found.push(decodeURIComponent(match[1]));
    } catch {
      found.push(match[1]);
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
