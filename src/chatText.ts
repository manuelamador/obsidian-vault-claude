// Chat text: prompts and replies as the panel shows them and as a saved note, branch titles,
// and background-task notifications. Kept free of `obsidian` imports.
import { closesFence, fenceMarker } from './fences';
import type { EffortLevel, PermissionMode, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { stripContext } from './history';

export interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  /** A tool result's content: text, or text blocks. */
  content?: unknown;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
}

export interface Chip {
  label: string;
  image?: string;
  /** Icon for a chip without an image; a file icon when unset. */
  icon?: string;
  /** Shown after the label in muted text: how much goes, or that only the path does. */
  detail?: string;
  /** What goes with the message for it, on hover; the label when unset. */
  tooltip?: string;
}

/** The chat a branch was made from; the branch starts with its title shown and its settings. */
export interface BranchSource {
  title: string;
  mode: PermissionMode;
  modelOverride: string | undefined;
  effortOverride: EffortLevel | undefined;
  /** The scratch chat, which the branch carries on as a chat of its own. */
  scratch?: boolean;
}

export function branchTitle(title: string): string {
  return `${title.replace(/ · branch$/, '')} · branch`;
}

/**
 * The label of the divider where Claude Code compacted the chat, short enough to sit on one line
 * between its rules. `trigger` is "auto" or "manual" (/compact); `preTokens` the context it had reached.
 */
export function compactionText(trigger: unknown, preTokens: unknown): string {
  const how = trigger === 'manual' ? ' on request' : trigger === 'auto' ? ' automatically' : '';
  const at = typeof preTokens === 'number' && preTokens > 0 ? ` at ${preTokens.toLocaleString()} tokens` : '';
  return `Context compacted${how}${at}`;
}

/** What compaction means, shown when pointing at the divider. */
export const COMPACTION_DETAIL = 'From here on, Claude works from a summary of the earlier conversation.';

/**
 * What a prompt shows in the chat: its bubble's text and chips (images, selections, mentions);
 * 'stopped' for an interruption, which shows as a notice; null when it shows nothing (a background-
 * task notice on its own, command output, a caveat). Its task notices are drawn apart from this.
 */
export function promptBubble(raw: string, images: Chip[]): { text: string; chips: Chip[] } | 'stopped' | null {
  if (raw.includes('<task-notification>')) {
    raw = parseTaskNotifications(raw).rest;
    if (!raw && images.length === 0) return null;
  }
  const { text, attachments } = displayPrompt(raw);
  const chips = [...images, ...attachments];
  if (chips.length > 0) return { text, chips };
  if (!text || /^<(local-command-stdout|local-command-stderr|system-reminder)>/.test(text) || text.startsWith('Caveat:')) return null;
  return text.startsWith('[Request interrupted') ? 'stopped' : { text, chips };
}

/** What a message of yours shows as its bubble (see messagePrompt, promptBubble); null for none. */
export function bubbleOf(message: SessionMessage): { text: string; chips: Chip[] } | null {
  const prompt = messagePrompt(message);
  const bubble = prompt ? promptBubble(prompt.text, prompt.images) : null;
  return bubble === 'stopped' ? null : bubble;
}

/**
 * The text and images of a message of yours as the chat draws it: its text blocks and images,
 * beside any tool results it carries; null when it has neither.
 */
export function messagePrompt(message: SessionMessage): { text: string; images: Chip[] } | null {
  if (message.type !== 'user' || message.parent_tool_use_id !== null) return null;
  const content = (message.message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content.trim() ? { text: content, images: [] } : null;
  if (!Array.isArray(content)) return null;
  const blocks = content as ContentBlock[];
  const text = textBlocks(blocks).join('\n');
  const images: Chip[] = blocks
    .filter((block) => block.type === 'image' && block.source?.type === 'base64' && block.source.data)
    .map((block) => ({ label: 'Image', image: `data:${block.source?.media_type};base64,${block.source?.data}` }));
  return text.trim() || images.length > 0 ? { text, images } : null;
}

/**
 * A message's text as find and the history search read it: a prompt of yours as its bubble shows it
 * (see bubbleOf), a reply's text; empty for the rest.
 */
export function messageSearchText(message: SessionMessage): string {
  if (message.type === 'user') return bubbleOf(message)?.text ?? '';
  if (message.type !== 'assistant' || message.parent_tool_use_id !== null) return '';
  const content = (message.message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return '';
  return textBlocks(content as ContentBlock[]).join('\n');
}

/** The texts of a message's text blocks, in order, empty ones left out. */
export function textBlocks(content: readonly { type?: string; text?: unknown }[]): string[] {
  return content.flatMap((block) => (block.type === 'text' && typeof block.text === 'string' && block.text ? [block.text] : []));
}

/**
 * A reply's Markdown as it reads once drawn, near enough for counting find's matches in turns not
 * drawn yet: equations dropped (drawn, they are no text), links and embeds as their text, and
 * emphasis, code and heading marks taken off.
 */
export function shownText(markdown: string): string {
  return markdown
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]+\$/g, ' ')
    .replace(/!?\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*+|~~|`+/g, '')
    .replace(/(^|\W)_+|_+(?=\W|$)/g, '$1')
    .replace(/^ {0,3}(?:#{1,6}\s+|>\s?)/gm, '');
}

/**
 * Whether a message of yours starts a turn: a prompt (see messagePrompt) that carries no tool
 * result. A message that does carry one belongs to the turn already under way.
 */
export function startsTurn(message: SessionMessage): boolean {
  const content = (message.message as { content?: unknown } | null)?.content;
  if (Array.isArray(content) && (content as ContentBlock[]).some((block) => block.type === 'tool_result')) return false;
  return messagePrompt(message) !== null;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** `3` or `3-5`: the line range written into a selection's context tag. */
export function lineRange(fromLine: number, toLine: number): string {
  return fromLine === toLine ? `${fromLine}` : `${fromLine}-${toLine}`;
}

/** `Note, lines 3–5` from a note name and a line range as written by lineRange(). */
export function selectionLabel(name: string, lines: string): string {
  return lines.includes('-') ? `${name}, lines ${lines.replace('-', '–')}` : `${name}, line ${lines}`;
}

/** A prompt as the panel shows it: its text without the context block, and chips for what it attached. */
function displayPrompt(raw: string): { text: string; attachments: Chip[] } {
  const attachments: Chip[] = [
    ...[...raw.matchAll(/<selection note="([^"]+)" lines="([^"]+)">/g)].map((match) => ({
      label: selectionLabel(baseName(match[1]).replace(/\.md$/, ''), match[2]),
      icon: 'text-select',
    })),
    ...[...raw.matchAll(/^Attached file: (.+)$/gm)].map((match) => ({ label: baseName(match[1]) })),
  ];
  let text = stripContext(raw).trim();
  const command = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? '';
    text = `${command[1]} ${args}`.trim();
  }
  return { text, attachments };
}

/**
 * A chat as a note: each prompt as a quote, each reply as Markdown, without tool calls or
 * background-task reports; frontmatter carries tags, the date and the Claude Code session id.
 */
/**
 * The id under which a reply text's checkbox ticks are kept: the message's uuid, with the text
 * block's position appended for any text block after the first (replies usually have one).
 */
export function replyKey(messageUuid: string, textIndex: number): string {
  return textIndex === 0 ? messageUuid : `${messageUuid}#${textIndex}`;
}

/**
 * Flips the task checkboxes (`- [ ]`, `- [x]`) at the given positions, counted in document order
 * outside fenced code, the order in which the renderer draws them: a reply with the reader's ticks.
 */
export function applyTicks(markdown: string, toggled: ReadonlySet<number>): string {
  if (toggled.size === 0) return markdown;
  let index = 0;
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      if (fence) {
        if (closesFence(line, fence)) fence = null;
        return line;
      }
      const marker = fenceMarker(line);
      if (marker) {
        fence = marker;
        return line;
      }
      return line.replace(/^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/, (match, prefix: string, state: string) => {
        const flip = toggled.has(index);
        index += 1;
        return flip ? `${prefix}[${state === ' ' ? 'x' : ' '}]` : match;
      });
    })
    .join('\n');
}

/** `ticks`: this chat's checkbox ticks by reply key (see replyKey), applied to the replies' text. */
export function chatToMarkdown(title: string, sessionId: string, transcript: SessionMessage[], date: string, ticks: Record<string, number[]> = {}): string {
  const parts: string[] = [];
  let reply: string[] = [];
  const flush = () => {
    if (reply.length > 0) parts.push(reply.join('\n\n'));
    reply = [];
  };
  for (const message of transcript) {
    if (message.parent_tool_use_id !== null) continue;
    if (message.type === 'assistant') {
      const content = (message.message as { content?: unknown } | null)?.content;
      if (!Array.isArray(content)) continue;
      let textIndex = 0;
      for (const block of content as ContentBlock[]) {
        if (block.type !== 'text' || !block.text?.trim()) continue;
        const toggled = new Set(ticks[replyKey(message.uuid, textIndex)] ?? []);
        textIndex += 1;
        reply.push(applyTicks(block.text, toggled).trim());
      }
      continue;
    }
    // As the chat draws it (see promptBubble): a background-task notice is left out, the text after it kept.
    const prompt = messagePrompt(message);
    const bubble = prompt ? promptBubble(prompt.text, prompt.images) : null;
    if (bubble === 'stopped') {
      reply.push('*Stopped.*');
      continue;
    }
    if (!bubble) continue;
    flush();
    const quote = ['**You**', '', ...(bubble.text ? bubble.text.split('\n') : [])];
    const labels = bubble.chips.map((chip) => chip.label);
    if (labels.length > 0) quote.push('', `*Attached: ${labels.join(', ')}*`);
    parts.push(quote.map((line) => (line ? `> ${line}` : '>')).join('\n'));
  }
  flush();
  const frontmatter = ['---', 'tags: [claude-chat]', `updated: ${date}`, `claude_session: ${sessionId}`, '---'];
  return [...frontmatter, '', `# ${title}`, '', parts.join('\n\n'), ''].join('\n');
}

export interface TaskNotice {
  summary: string;
  status: string;
  details: string[];
  result?: string;
  taskId?: string;
  /** The task's output file: for an agent, a link to its transcript. */
  outputFile?: string;
}

/**
 * Pulls `<task-notification>` blocks (background task completions that Claude Code stores
 * as user messages) out of transcript text; returns them and the text left over.
 */
export function parseTaskNotifications(text: string): { notices: TaskNotice[]; rest: string } {
  const notices: TaskNotice[] = [];
  const rest = text
    .replace(/<task-notification>([\s\S]*?)<\/task-notification>/g, (_match, block: string) => {
      const field = (name: string) => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '';
      const usage = field('usage').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const details = [
        `Task ${field('task-id')}`,
        field('output-file') ? `Output: ${field('output-file')}` : '',
        usage ? `Usage: ${usage}` : '',
        field('note'),
      ].filter((line) => line.length > 0);
      notices.push({ summary: field('summary'), status: field('status'), details, result: field('result') || undefined, taskId: field('task-id') || undefined, outputFile: field('output-file') || undefined });
      return '';
    })
    .trim();
  return { notices, rest };
}

/**
 * One-line header for a background-task notification: the summary's first line without
 * Markdown markers. Live notifications can carry a whole agent report in `summary`; `rest`
 * is set when there is more than the header shows, and goes into the collapsed body.
 */
export function noticeHeader(summary: string): { title: string; rest: string | undefined } {
  const full = summary.trim();
  const first = full.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  const plain = first.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
  const title = plain.length > 120 ? `${plain.slice(0, 119)}…` : plain;
  const truncated = full !== first || plain.length > 120;
  return { title, rest: truncated ? full : undefined };
}

/** An input's text `value` with `text` quoted after it (see quoteMarkdown, and its `max`), and a line to write on below. */
export function withQuote(value: string, text: string, max?: number): string {
  const before = value.replace(/\s+$/, '');
  return `${before ? `${before}\n\n` : ''}${quoteMarkdown(text, max)}\n\n`;
}

/**
 * Text selected in the chat, as a Markdown quote for the input: the reply is already in the
 * conversation, so a long selection is cut at a word and marked with an ellipsis.
 */
export function quoteMarkdown(text: string, max = 600): string {
  const trimmed = text.replace(/\r/g, '').trim();
  const cut = trimmed.length > max ? `${trimmed.slice(0, max).replace(/\s+\S*$/, '')}…` : trimmed;
  return cut
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}
