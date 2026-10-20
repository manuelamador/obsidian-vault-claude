import { codexGmailMessages, codexGmailTool, gmailBody, gmailResult } from './gmailAdapter';

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
  /** Where Gmail downloads all its attachments as one zip, when it has more than one. */
  attachmentsZip?: string;
  /** Its attachments, by name and type, when the tool gave them (a thread or a message read whole); the files themselves are in Gmail. */
  attachments?: { name: string; type: string; url?: string }[];
}

/** Where Gmail downloads all of message `id`'s attachments as one zip (its Download all), for the account `viewUrl` names. */
export function attachmentsZipUrl(viewUrl: string, id: string): string | undefined {
  const account = /[?&]authuser=([^&#]+)/.exec(viewUrl)?.[1];
  if (!account || !/^[0-9a-f]+$/i.test(id)) return undefined;
  return `https://mail.google.com/mail/?authuser=${account}&ui=2&view=att&th=${id}&attid=0&disp=zip&zw`;
}

/**
 * Where Gmail opens attachment `part` of message `id` itself (its `view=att` address), for the account
 * message link `viewUrl` names (its `authuser`); undefined when any of them is missing.
 */
export function attachmentUrl(viewUrl: string, id: string, part: string): string | undefined {
  const account = /[?&]authuser=([^&#]+)/.exec(viewUrl)?.[1];
  if (!account || !/^[0-9a-f]+$/i.test(id) || !/^[0-9.]+$/.test(part)) return undefined;
  return `https://mail.google.com/mail/?authuser=${account}&ui=2&view=att&th=${id}&attid=0.${part}&disp=safe`;
}

/** A file type as a card names it: `PDF`, `Word`, `image`, or the type's last part. */
export function attachmentKind(type: string): string {
  if (type === 'application/pdf') return 'PDF';
  if (type.startsWith('image/')) return 'image';
  if (/wordprocessingml|msword/.test(type)) return 'Word';
  if (/spreadsheetml|ms-excel|text\/csv/.test(type)) return 'spreadsheet';
  if (/presentationml|ms-powerpoint/.test(type)) return 'slides';
  if (/calendar|ics/.test(type)) return 'calendar';
  return type.split('/').pop()?.replace(/^x-/, '') || 'file';
}

/** The Gmail tools whose results are messages: a search, a thread, a message. */
const GMAIL_READ = /^mcp__.*gmail.*__(search_threads|get_thread|get_message)$/i;

/** Whether tool `name` reads mail (see GMAIL_READ). */
export function readsMail(name: string): boolean {
  return GMAIL_READ.test(name) || ['read_email', 'read_email_thread', 'search_emails', 'batch_read_email', 'batch_read_email_threads'].includes(codexGmailTool(name) ?? '');
}

/** Whether tool `name` reads a whole thread, whose messages the chat shows together (see renderEmailThread). */
export function readsThread(name: string): boolean {
  return (readsMail(name) && /__get_thread$/i.test(name)) || codexGmailTool(name) === 'read_email_thread';
}

interface RawMessage {
  id?: unknown;
  sender?: unknown;
  toRecipients?: unknown;
  subject?: unknown;
  date?: unknown;
  snippet?: unknown;
  plaintextBody?: unknown;
  labelIds?: unknown;
  viewUrl?: unknown;
  threadId?: unknown;
  attachments?: unknown;
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
  const zip = attachmentsZipUrl(url, str(raw.id));
  const attachments = (Array.isArray(raw.attachments) ? raw.attachments : []).flatMap((each: { filename?: unknown; mimeType?: unknown; partId?: unknown }) => {
    if (!each || typeof each.filename !== 'string' || !each.filename) return [];
    const link = attachmentUrl(url, str(raw.id), str(each.partId));
    return [{ name: decodeEntities(each.filename), type: str(each.mimeType), ...(link ? { url: link } : {}) }];
  });
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
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(attachments.length > 1 && zip ? { attachmentsZip: zip } : {}),
  };
}

/**
 * The messages in the result `text` of Gmail tool `name` (see GMAIL_READ): each message of a thread,
 * the message asked for, or, for a search, each thread by its last message. Null for another tool,
 * or a result that is not the tool's JSON (an error, say).
 */
export function emailMessages(name: string, text: string, structured?: unknown): EmailMessage[] | null {
  if (!readsMail(name)) return null;
  const data = gmailResult(text, structured);
  if (codexGmailTool(name)) return data ? codexGmailMessages(data).map(each => message(each)) : null;
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
  /** Connector whose native draft ID and tools this card uses. */
  connector?: 'codex';
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

/** The Gmail tools that end a draft: sending it by its id, or deleting it. */
const GMAIL_DRAFT_END = /^mcp__.*gmail.*__(send_message|send_draft|delete_draft)$/i;

/** The draft tool `name` sent or deleted, by the `draftId` in its `input`; null for another tool or call. */
export function draftEnded(name: string, input: Record<string, unknown>): { id: string; outcome: 'sent' | 'deleted' } | null {
  const kind = GMAIL_DRAFT_END.exec(name)?.[1] ?? (codexGmailTool(name) === 'send_draft' ? 'send_draft' : undefined);
  const id = str(input.draftId) || (codexGmailTool(name) ? str(input.draft_id) : '');
  if (!kind || !id) return null;
  return { id, outcome: kind.toLowerCase() === 'delete_draft' ? 'deleted' : 'sent' };
}

/** The Gmail tools that write drafts. */
const GMAIL_DRAFT = /^mcp__.*gmail.*__(create_draft|update_draft)$/i;

/** The draft tool `name` wrote, from its `input` and its result `text`; null for another tool or a failed call. */
export function emailDraft(name: string, input: Record<string, unknown>, text: string, structured?: unknown): EmailDraft | null {
  const codex = codexGmailTool(name);
  const kind = GMAIL_DRAFT.exec(name)?.[1] ?? (codex === 'create_draft' || codex === 'update_draft' ? codex : undefined);
  if (!kind) return null;
  const result = gmailResult(text, structured) as { viewUrl?: unknown; id?: unknown; threadId?: unknown; message?: { thread_id?: unknown } } | null;
  if (!result || typeof result !== 'object' || typeof result.id !== 'string' || !result.id) return null;
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : typeof value === 'string' && value ? [value] : []);
  const url = str(result.viewUrl);
  const replyTo = str(input.replyToMessageId);
  const threadId = str(result.threadId) || str(result.message?.thread_id);
  return {
    id: result.id,
    ...(codex ? { connector: 'codex' as const } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(threadId ? { threadId } : {}),
    updated: kind.toLowerCase() === 'update_draft',
    to: list(input.to),
    cc: list(input.cc),
    ...(typeof input.subject === 'string' ? { subject: input.subject } : {}),
    ...(codex && input.payload ? { body: decodeEntities(gmailBody(input.payload)) } : typeof input.body === 'string' ? { body: input.body.replace(/\r\n?/g, '\n').trim() } : {}),
    ...(url ? { url } : {}),
  };
}

/** An email thread as the panel names it: its subject, else who sent it (a read that gave no subject, see MailThread). */
export function mailThreadTitle(thread: { subject: string; from?: string }): string {
  return thread.subject || (thread.from ? `From ${thread.from}` : 'Email thread');
}
