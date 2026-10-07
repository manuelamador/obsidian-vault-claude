// Projects: a folder of the vault, with a note holding Instructions (yours), a Guide (findings you
// accepted, each with its source chat), and generated lists of its chats and key notes. A chat's home
// project follows from its notes (see homeOf), or is chosen by hand; its Instructions and Guide go
// with the chat's first message. A chat may be connected to other projects, whose Guides go only when
// you choose. Kept free of `obsidian` imports so the tests can use it.
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

/** A new project note: its folder, the chats added to it by hand, empty Instructions and Guide, and the generated lists. */
export function projectNoteMarkdown(project: { name: string; folder: string; added: string[]; date: string }): string {
  return [
    '---',
    `type: ${PROJECT_TYPE}`,
    'tags: [project]',
    `folder: ${JSON.stringify(project.folder)}`,
    `added: ${yamlList(project.added)}`,
    'connected_chats: []',
    `updated: ${project.date}`,
    '---',
    '',
    `# ${project.name}`,
    '',
    '## Instructions',
    '',
    'Standing instructions for every chat in this project: yours to write. Nothing generated changes this section.',
    '',
    '## Guide',
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

/** `note` with `lines` added at the end of its Guide section (made when it has none). */
export function withGuideLines(note: string, lines: string[]): string {
  if (lines.length === 0) return note;
  const added = lines.join('\n');
  const start = /^## Guide[ \t]*$/m.exec(note);
  if (!start) return `${note.trimEnd()}\n\n## Guide\n\n${added}\n`;
  const after = start.index + start[0].length;
  const next = /^## /m.exec(note.slice(after));
  const at = next ? after + next.index : note.length;
  return `${note.slice(0, at).trimEnd()}\n\n${added}\n${next ? `\n${note.slice(at)}` : ''}`;
}

/** A project's sections as they go with a chat: its Instructions and Guide (the Instructions' placeholder left out). */
export function projectParts(note: string): { instructions: string; guide: string } {
  const instructions = memoSection(note, 'Instructions').replace(/^Standing instructions for every chat in this project: yours to write\. Nothing generated changes this section\.\s*/, '');
  return { instructions: instructions.trim(), guide: memoSection(note, 'Guide').trim() };
}

/**
 * What goes with a chat's message from its projects: the Instructions of the projects holding its home
 * project's folder (`parent`), its home project's Instructions and (if chosen) Guide, and the Guides
 * chosen of others (`connected`); each with its project note's path (`note`), which Claude may open
 * when asked to change the project.
 */
export function projectContextBlock(parts: { name: string; note: string; instructions?: string; guide?: string; role: 'home' | 'parent' | 'connected' }[]): string {
  const sections = parts.flatMap((part) => {
    const lines: string[] = [];
    if (part.instructions) lines.push(`Instructions:\n${part.instructions}`);
    if (part.guide) lines.push(`Guide (findings from earlier chats, accepted by the user):\n${part.guide}`);
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

/** A short fingerprint of a project's Instructions and Guide, to tell whether they changed since they were sent. */
export function contextHash(parts: { instructions: string; guide: string }): string {
  let hash = 5381;
  for (const char of `${parts.instructions}\u0000${parts.guide}`) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

/** How much of a chat's conversation and edits a guide update reads, at most. */
const DIGEST_CHARS = 8000;
const EDIT_CHARS = 4000;

/** A chat as a guide update reads it: your prompts and Claude's replies, the latest kept when long. */
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

/** The edits a chat made to files, as before and after, from its Edit, MultiEdit and Write calls; the latest kept when long. */
export function chatEdits(messages: SessionMessage[]): string {
  const edits: string[] = [];
  for (const message of messages) {
    if (message.type !== 'assistant' || message.parent_tool_use_id !== null) continue;
    const content = (message.message as { content?: unknown } | null)?.content;
    for (const block of Array.isArray(content) ? (content as ContentBlock[]) : []) {
      if (block.type !== 'tool_use') continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const file = typeof input.file_path === 'string' ? input.file_path.split('/').pop() : '';
      const pair = (before: unknown, after: unknown) => `In ${file}:\nBefore: ${String(before ?? '').slice(0, 600)}\nAfter: ${String(after ?? '').slice(0, 600)}`;
      if (block.name === 'Edit') edits.push(pair(input.old_string, input.new_string));
      else if (block.name === 'MultiEdit' && Array.isArray(input.edits)) for (const edit of input.edits as Record<string, unknown>[]) edits.push(pair(edit.old_string, edit.new_string));
      else if (block.name === 'Write') edits.push(`Wrote ${file}:\n${String(input.content ?? '').slice(0, 600)}`);
    }
  }
  const all = edits.join('\n\n');
  return all.length <= EDIT_CHARS ? all : `[… earlier edits left out …]\n\n${all.slice(-EDIT_CHARS)}`;
}

/** One finding proposed for a project's Guide. */
export interface GuideProposal {
  text: string;
  kind: 'finding' | 'example' | 'question';
  /** The chat it comes from (its id). */
  source: string;
  /** The Guide's line it contradicts, if any: shown as a conflict, never applied silently. */
  conflicts: string;
}

/** The instructions for proposing additions to a project's Guide. */
export const GUIDE_SYSTEM = [
  "You propose additions to a project's Guide: a short record of what was learned across the user's conversations with an AI assistant in that project, which goes with every new conversation in it.",
  'Propose only what the given conversations show: patterns in what the user asked for and accepted, decisions and their reasons, conventions followed, and questions left open. Each item is one or two sentences, general enough to apply to the next piece of work.',
  'Each item names the conversation it comes from by its id. Do not restate the project\'s Instructions or anything already in its Guide. When an item contradicts a Guide line, still propose it, and quote that line under "conflicts".',
  'Use kind "example" only for a before/after pair taken from the edits given, quoting them briefly; "question" for something left open; otherwise "finding". Never decide for the user: an observation stays an observation.',
  'Propose few items, the most useful first; none when nothing new was learned. Reply with JSON only: {"items": [{"text": "…", "kind": "finding", "source": "…", "conflicts": ""}]}.',
].join('\n');

/** The request: the project's Instructions and Guide, then each conversation with its id, title, digest and edits. */
export function guidePrompt(project: { name: string; instructions: string; guide: string }, chats: { id: string; title: string; digest: string; edits: string }[]): string {
  return [
    `Project: ${project.name}`,
    '',
    'Instructions (the user\'s own; not to be restated):',
    project.instructions || '(none)',
    '',
    'Guide so far:',
    project.guide || '(empty)',
    '',
    ...chats.flatMap((chat) => [
      `<conversation id=${JSON.stringify(chat.id)} title=${JSON.stringify(chat.title)}>`,
      chat.digest || '(no text)',
      ...(chat.edits ? ['', 'Edits made:', chat.edits] : []),
      '</conversation>',
      '',
    ]),
  ].join('\n');
}

/** The proposals in the model's reply: only from chats it was given, with text; null when it is not the JSON asked for. */
export function readGuideProposals(reply: string, chatIds: string[]): GuideProposal[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  const items = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const given = new Set(chatIds);
  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const { text, kind, source, conflicts } = item as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim() || typeof source !== 'string' || !given.has(source)) return [];
    const sort = kind === 'example' || kind === 'question' ? kind : 'finding';
    return [{ text: text.trim(), kind: sort, source, conflicts: typeof conflicts === 'string' ? conflicts.trim() : '' }];
  });
}

/** A Guide line for an accepted proposal: its kind when not a plain finding, its text, and a link to its source chat. */
export function guideLine(proposal: { text: string; kind: GuideProposal['kind'] }, source: { title: string; link: string }, date: string): string {
  const label = proposal.kind === 'example' ? '**Example:** ' : proposal.kind === 'question' ? '**Open question:** ' : '';
  return `- ${label}${proposal.text.replace(/\s*\n\s*/g, ' ')} ([${source.title.replace(/[[\]]/g, '')}](${source.link}), ${date})`;
}
