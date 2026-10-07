// Projects: a folder of the vault, with a note holding its Context (a summary written when the project
// is made, and again on Refresh context), Instructions (yours, optional), and generated lists of its
// chats and key notes. A chat's home project follows from its notes (see homeOf), or is chosen by hand;
// its Context and Instructions go with the chat's first message. A chat has at most one project. Kept
// free of `obsidian` imports so the tests can use it.
import { inFolder } from './chatFolders';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { bubbleOf, textBlocks, type ContentBlock } from './chatText';
import { memoSection } from './memos';

/** The frontmatter `type` of a project note. */
export const PROJECT_TYPE = 'project';

/** Where the generated lists of a project note begin and end; what is outside is never rewritten. */
const BEGIN = '<!-- BEGIN GENERATED -->';
const END = '<!-- END GENERATED -->';

/** A YAML list of `values`, each a double-quoted string. */
function yamlList(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

/** The placeholder a new project's Instructions hold, left out of what is sent. */
const INSTRUCTIONS_PLACEHOLDER = 'Optional: anything every chat in this project should follow. Left empty, nothing is sent from here.';

/** A new project note: its folder, the chats added to it by hand, its Context (as written, or empty), empty Instructions, and the generated lists. */
export function projectNoteMarkdown(project: { name: string; folder: string; added: string[]; date: string; context?: string }): string {
  return [
    '---',
    `type: ${PROJECT_TYPE}`,
    'tags: [project]',
    `folder: ${JSON.stringify(project.folder)}`,
    `added: ${yamlList(project.added)}`,
    ...(project.context ? [`context_updated: ${project.date}`] : []),
    `updated: ${project.date}`,
    '---',
    '',
    `# ${project.name}`,
    '',
    '## Context',
    '',
    BEGIN,
    ...(project.context ? [project.context.trim()] : []),
    END,
    '',
    '## Instructions',
    '',
    INSTRUCTIONS_PLACEHOLDER,
    '',
    '## Chats',
    '',
    BEGIN,
    END,
    '',
    '## Key notes',
    '',
    BEGIN,
    END,
    '',
  ].join('\n');
}

/** A project as membership reads it: its key (the note's path), its folder, and the chats added to it by hand. */
export interface ProjectFolder {
  key: string;
  folder: string;
  added: string[];
}

/** Why a chat is in its project: added by hand; its first attached note is in the folder; or its notes are, `count` of them. */
export type HomeReason = { key: string; why: 'added' } | { key: string; why: 'start'; note: string } | { key: string; why: 'notes'; count: number };

/** The weight of notes in one folder that makes it a chat's project when the chat only mentioned them. */
export const MENTIONS_ENOUGH = 3;

/**
 * Chat `id`'s home project: the one it was added to by hand; else, unless its project was removed by
 * hand (`declined`), the one whose folder holds the note attached when it started (`start`); else the
 * one whose folder's notes weigh most (`notes`: path → weight, see LINK_WEIGHTS), the deeper folder on
 * a tie. A folder counts once the chat edited or was sent a note in it, or its mentions there weigh
 * MENTIONS_ENOUGH. Null for none.
 */
export function homeOf(id: string, chat: { notes?: ReadonlyMap<string, number>; start?: string; declined?: boolean }, projects: ProjectFolder[]): HomeReason | null {
  const added = projects.find((project) => project.added.includes(id));
  if (added) return { key: added.key, why: 'added' };
  if (chat.declined) return null;
  const deeper = (a: ProjectFolder, b: ProjectFolder) => b.folder.length - a.folder.length;
  const folders = projects.filter((project) => project.folder !== '').sort(deeper);
  if (chat.start) {
    const holding = folders.find((project) => inFolder(chat.start ?? '', project.folder));
    if (holding) return { key: holding.key, why: 'start', note: chat.start };
  }
  const notes = [...(chat.notes ?? new Map<string, number>())];
  let best: { project: ProjectFolder; score: number; count: number } | null = null;
  for (const project of folders) {
    const inside = notes.filter(([path]) => inFolder(path, project.folder));
    const score = inside.reduce((sum, [, weight]) => sum + weight, 0);
    const enough = inside.some(([, weight]) => weight > 1) || score >= MENTIONS_ENOUGH;
    if (enough && (!best || score > best.score)) best = { project, score, count: inside.length };
  }
  return best && { key: best.project.key, why: 'notes', count: best.count };
}

/** `note` with the generated part of section `heading` (between its markers) replaced by `body`; as it was when it has none. */
export function withGenerated(note: string, heading: string, body: string): string {
  const start = new RegExp(`^## ${heading}[ \\t]*$`, 'm').exec(note);
  if (!start) return note;
  const from = note.indexOf(BEGIN, start.index);
  const to = from === -1 ? -1 : note.indexOf(END, from);
  // Only the markers of this section: none before the next section's heading.
  const next = /^## /m.exec(note.slice(start.index + start[0].length));
  const limit = next ? start.index + start[0].length + next.index : note.length;
  if (from === -1 || to === -1 || to > limit) return note;
  return `${note.slice(0, from + BEGIN.length)}\n${body.trim()}\n${note.slice(to)}`;
}

/**
 * A project's sections as they go with a chat: its Context (between its markers, or the whole section
 * in a note edited by hand) and its Instructions (their placeholder left out). A note written before
 * Context replaced the Guide gives its Guide as its Context.
 */
export function projectParts(note: string): { context: string; instructions: string } {
  const strip = (text: string) => text.replace(BEGIN, '').replace(END, '').trim();
  const context = strip(memoSection(note, 'Context')) || memoSection(note, 'Guide').trim();
  const instructions = memoSection(note, 'Instructions')
    .replace(INSTRUCTIONS_PLACEHOLDER, '')
    .replace(/^Standing instructions for every chat in this project: yours to write\. Nothing generated changes this section\.\s*/, '')
    .trim();
  return { context, instructions };
}

/** `note` with its Context set to `context`: between the section's markers, the section (and its markers) made when the note has none. */
export function withContext(note: string, context: string): string {
  if (/^## Context[ \t]*$/m.test(note)) {
    const replaced = withGenerated(note, 'Context', context);
    if (replaced !== note || projectParts(note).context === context.trim()) return replaced;
    // A Context section without markers: its text replaced, markers added.
    return note.replace(/^## Context[ \t]*\n[\s\S]*?(?=^## |(?![\s\S]))/m, `## Context\n\n${BEGIN}\n${context.trim()}\n${END}\n\n`);
  }
  const heading = /^# .*$/m.exec(note);
  const at = heading ? heading.index + heading[0].length : note.length;
  return `${note.slice(0, at)}\n\n## Context\n\n${BEGIN}\n${context.trim()}\n${END}\n${note.slice(at)}`;
}

/**
 * What goes with a chat's message from its project: the Instructions of the projects holding its
 * project's folder (`parent`), and its project's Context and Instructions (`home`); each with its
 * project note's path (`note`), which Claude may open when asked to change the project.
 */
export function projectContextBlock(parts: { name: string; note: string; context?: string; instructions?: string; role: 'home' | 'parent' }[]): string {
  const sections = parts.flatMap((part) => {
    const lines: string[] = [];
    if (part.context) lines.push(`Context (a summary of the project, from its notes and chats):\n${part.context}`);
    if (part.instructions) lines.push(`Instructions (the user's own):\n${part.instructions}`);
    return lines.length > 0 ? [`<project name=${JSON.stringify(part.name)} role="${part.role}" note=${JSON.stringify(part.note)}>\n${lines.join('\n\n')}\n</project>`] : [];
  });
  return sections.length > 0 ? `<project_context>\n${sections.join('\n\n')}\n</project_context>` : '';
}

/**
 * What goes with a chat's message from the chats it links to and includes: each one's digest (see
 * VaultClaudePlugin.linkedChatDigest), with its id. Context flows from them into this chat only.
 */
export function linkedChatsBlock(chats: { id: string; title: string; digest: string }[]): string {
  if (chats.length === 0) return '';
  const each = chats.map((chat) => `<linked_chat title=${JSON.stringify(chat.title.replace(/"/g, "'"))} id=${JSON.stringify(chat.id)}>\n${chat.digest}\n</linked_chat>`);
  return `<linked_chats>\nEarlier conversations the user linked to this one, as context:\n\n${each.join('\n\n')}\n</linked_chats>`;
}

/** A short fingerprint of a project's Context and Instructions, to tell whether they changed since they were sent. */
export function contextHash(parts: { context: string; instructions: string }): string {
  let hash = 5381;
  for (const char of `${parts.context}\u0000${parts.instructions}`) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

/** How much of a chat's conversation a digest keeps, at most. */
const DIGEST_CHARS = 8000;

/** A chat as a digest reads it: your prompts and Claude's replies, the latest kept when long. */
export function chatDigest(messages: SessionMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.parent_tool_use_id !== null) continue;
    if (message.type === 'user') {
      const bubble = bubbleOf(message);
      if (bubble?.text.trim()) lines.push(`You: ${bubble.text.trim()}`);
    } else if (message.type === 'assistant') {
      const content = (message.message as { content?: unknown } | null)?.content;
      const text = Array.isArray(content) ? textBlocks(content as ContentBlock[]).join('\n').trim() : '';
      if (text) lines.push(`Claude: ${text}`);
    }
  }
  const all = lines.join('\n\n');
  return all.length <= DIGEST_CHARS ? all : `[… earlier part left out …]\n\n${all.slice(-DIGEST_CHARS)}`;
}

/** The instructions for writing a project's Context. */
export const CONTEXT_SYSTEM = [
  "You write the Context of a project in the user's Obsidian vault: a short summary that goes with every new conversation with an AI assistant about the project, so that it starts knowing what the project is.",
  'You are given the project folder\'s notes (path, properties, opening lines) and the conversations that worked on them (title, date, last exchanges).',
  'Write at most 300 words of Markdown, without a heading: what the project is, where it stands (with dates), its key notes as [[wikilinks]] by note name, and the questions left open. State only what the notes and conversations show; no advice, no praise, no guesses.',
  'Reply with the Context only.',
].join('\n');

/** How much of each note the request carries. */
const PROPERTIES_CHARS = 400;
const OPENING_CHARS = 500;

/** A note's opening lines, without its frontmatter: at most OPENING_CHARS. */
export function noteOpening(text: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
  return body.length <= OPENING_CHARS ? body : `${body.slice(0, OPENING_CHARS)}…`;
}

/** The request for a project's Context: its name and folder, its notes, and its chats. */
export function contextPrompt(project: { name: string; folder: string }, notes: { path: string; properties: Record<string, unknown>; opening: string }[], chats: { title: string; date: string; digest: string }[]): string {
  const cap = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);
  return [
    `Project: ${project.name} (folder ${project.folder})`,
    '',
    notes.length > 0 ? 'Notes in the folder:' : 'The folder has no notes yet.',
    ...notes.flatMap((note) => [`<note path=${JSON.stringify(note.path)}>`, `Properties: ${cap(JSON.stringify(note.properties), PROPERTIES_CHARS)}`, note.opening, '</note>']),
    '',
    chats.length > 0 ? 'Conversations that worked on these notes, most recent first:' : 'No conversations have worked on these notes yet.',
    ...chats.flatMap((chat) => [`<conversation title=${JSON.stringify(chat.title)} date="${chat.date}">`, chat.digest || '(no text)', '</conversation>']),
  ].join('\n');
}

/** The Context in the model's reply: without a heading or a fence it may have added. */
export function readContext(reply: string): string {
  return reply
    .trim()
    .replace(/^```(?:markdown)?\n([\s\S]*?)\n```$/, '$1')
    .replace(/^#{1,3} .*\n+/, '')
    .trim();
}
