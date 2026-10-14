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
  unread: boolean;
  /** Where Gmail shows it, when the tool gave the link. */
  url?: string;
  /** Messages in its thread, for a search, which lists threads by their last message. */
  count?: number;
}

/** The Gmail tools whose results are messages: a search, a thread, a message. */
const GMAIL_READ = /^mcp__.*gmail.*__(search_threads|get_thread|get_message)$/i;

/** Whether tool `name` reads mail (see GMAIL_READ). */
export function readsMail(name: string): boolean {
  return GMAIL_READ.test(name);
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
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function message(raw: RawMessage, count?: number): EmailMessage {
  const labels = Array.isArray(raw.labelIds) ? raw.labelIds : [];
  const body = str(raw.plaintextBody).replace(/\s+/g, ' ').trim();
  const url = str(raw.viewUrl);
  return {
    sender: str(raw.sender) || 'Unknown sender',
    to: Array.isArray(raw.toRecipients) ? raw.toRecipients.filter((each): each is string => typeof each === 'string') : [],
    subject: str(raw.subject) || '(no subject)',
    time: Date.parse(str(raw.date)),
    text: str(raw.snippet) || body,
    unread: labels.includes('UNREAD'),
    ...(url ? { url } : {}),
    ...(count && count > 1 ? { count } : {}),
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
