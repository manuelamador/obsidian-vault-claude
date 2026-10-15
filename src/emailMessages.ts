// The messages in what Claude Code's Gmail tools return (a search, a thread, a message), for the
// chat to show them as cards (see emailCards.ts). Read from the tool results only: the plugin itself
// asks Gmail for nothing. Kept free of `obsidian` imports so the tests can use it.

/** A message as a card shows it. */
export interface EmailMessage {
  sender: string;
  to: string[];
  subject: string;
  /** When it was sent, in milliseconds; NaN when the tool gave no date. */
  time: number;
  /** Gmail's snippet, or the start of the message's text. */
  text: string;
  /** The message's whole text, when the tool gave it (a thread or a message, not a search). */
  body?: string;
  unread: boolean;
  /** Where Gmail shows it, when the tool gave the link. */
  url?: string;
  /** Messages in its thread, for a search, which lists threads by their last message. */
  count?: number;
  /** Gmail's id for its thread: how an opened thread finds its card in a search shown before it. */
  threadId?: string;
}

/** The Gmail tools whose results are messages: a search, a thread, a message. */
const GMAIL_READ = /^mcp__.*gmail.*__(search_threads|get_thread|get_message)$/i;

/** Whether tool `name` reads mail (see GMAIL_READ). */
export function readsMail(name: string): boolean {
  return GMAIL_READ.test(name);
}

/** Whether tool `name` reads a whole thread, whose messages the chat shows together (see renderEmailThread). */
export function readsThread(name: string): boolean {
  return readsMail(name) && /__get_thread$/i.test(name);
}

interface RawMessage {
  sender?: unknown;
  toRecipients?: unknown;
  subject?: unknown;
  date?: unknown;
  snippet?: unknown;
  plaintextBody?: unknown;
  labelIds?: unknown;
  viewUrl?: unknown;
  threadId?: unknown;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** `text` with the HTML escapes Gmail leaves in snippets (`&lt;`, `&#39;`, …) turned back into characters. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function message(raw: RawMessage, count?: number): EmailMessage {
  const labels = Array.isArray(raw.labelIds) ? raw.labelIds : [];
  const full = str(raw.plaintextBody).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const body = decodeEntities(full);
  const url = str(raw.viewUrl);
  const threadId = str(raw.threadId);
  return {
    sender: decodeEntities(str(raw.sender)) || 'Unknown sender',
    to: Array.isArray(raw.toRecipients) ? raw.toRecipients.filter((each): each is string => typeof each === 'string') : [],
    // A search asked for metadata only carries no subject at all: left empty rather than shown as
    // "(no subject)", which would say the message has none.
    subject: raw.subject === undefined ? '' : decodeEntities(str(raw.subject)) || '(no subject)',
    time: Date.parse(str(raw.date)),
    text: decodeEntities(str(raw.snippet)) || body.replace(/\s+/g, ' '),
    unread: labels.includes('UNREAD'),
    ...(body ? { body } : {}),
    ...(url ? { url } : {}),
    ...(count && count > 1 ? { count } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

/**
 * The messages in the result `text` of Gmail tool `name` (see GMAIL_READ): each message of a thread,
 * the message asked for, or, for a search, each thread by its last message. Null for another tool,
 * or a result that is not the tool's JSON (an error, say).
 */
export function emailMessages(name: string, text: string): EmailMessage[] | null {
  if (!readsMail(name)) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const value = data as { threads?: unknown; messages?: unknown; messageCount?: unknown };
  if (Array.isArray(value.threads)) {
    return value.threads.flatMap((thread: { messages?: unknown; messageCount?: unknown }) => {
      const messages = Array.isArray(thread?.messages) ? (thread.messages as RawMessage[]) : [];
      const last = messages[messages.length - 1];
      return last ? [message(last, typeof thread.messageCount === 'number' ? thread.messageCount : messages.length)] : [];
    });
  }
  if (Array.isArray(value.messages)) return (value.messages as RawMessage[]).map((each) => message(each));
  const single = data as RawMessage;
  return single.sender !== undefined || single.subject !== undefined ? [message(single)] : null;
}

/** The text of a tool result's content, as Claude Code saves it: a string, or text blocks. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: { type?: unknown; text?: unknown }) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('');
}

/** A draft Claude wrote or changed with the Gmail connector, as its card shows it: what the call set, and where Gmail opens it. */
export interface EmailDraft {
  /** Gmail's id for the draft. */
  id: string;
  /** The message it replies to, when it is a reply (as written; a draft updated since does not say). */
  replyTo?: string;
  /** Gmail's id for the thread it is in, to archive once it is sent. */
  threadId?: string;
  updated: boolean;
  to: string[];
  cc: string[];
  subject?: string;
  body?: string;
  url?: string;
}

/** The Gmail tools that write drafts. */
const GMAIL_DRAFT = /^mcp__.*gmail.*__(create_draft|update_draft)$/i;

/** The draft tool `name` wrote, from its `input` and its result `text`; null for another tool or a failed call. */
export function emailDraft(name: string, input: Record<string, unknown>, text: string): EmailDraft | null {
  const kind = GMAIL_DRAFT.exec(name)?.[1];
  if (!kind) return null;
  let result: { viewUrl?: unknown; id?: unknown; threadId?: unknown } = {};
  try {
    result = JSON.parse(text) as typeof result;
  } catch {
    return null;
  }
  if (!result || typeof result !== 'object' || result.id === undefined) return null;
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : typeof value === 'string' && value ? [value] : []);
  const url = str(result.viewUrl);
  const replyTo = str(input.replyToMessageId);
  const threadId = str(result.threadId);
  return {
    id: String(result.id),
    ...(replyTo ? { replyTo } : {}),
    ...(threadId ? { threadId } : {}),
    updated: kind.toLowerCase() === 'update_draft',
    to: list(input.to),
    cc: list(input.cc),
    ...(typeof input.subject === 'string' ? { subject: input.subject } : {}),
    ...(typeof input.body === 'string' ? { body: input.body.replace(/\r\n?/g, '\n').trim() } : {}),
    ...(url ? { url } : {}),
  };
}
