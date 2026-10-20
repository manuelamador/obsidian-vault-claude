// Codex's Gmail connector uses Gmail API fields and MCP result envelopes. Convert them to the
// existing card parser's input; Claude's connector keeps its original format. No Gmail requests here.
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';

/**
 * Only explicit Gmail connector names, never a suffix on an unrelated tool. The app-server names the
 * call by its action, `gmail.create_draft` (as the panel sees it, `mcp__codex_apps__gmail.create_draft`);
 * Codex's own scripts call it `gmail_create_draft`. Either is taken.
 */
export function codexGmailTool(name: string): string | null {
  return /^mcp__codex_apps__gmail[._](create_draft|update_draft|send_draft|read_email|read_email_thread|search_emails|batch_read_email|batch_read_email_threads)$/i.exec(name)?.[1].toLowerCase() ?? null;
}

/** Accept raw JSON, a complete MCP result, or structuredContent supplied separately. */
export function gmailResult(text: string, structured?: unknown): unknown {
  let value = structured;
  if (value === undefined) {
    try { value = JSON.parse(text); } catch { return null; }
  }
  for (let depth = 0; depth < 4; depth++) {
    const envelope = object(value);
    if (envelope.isError === true) return null;
    if (envelope.structuredContent !== undefined) { value = envelope.structuredContent; continue; }
    if (Array.isArray(envelope.content)) {
      const blocks = envelope.content.map(object).filter(block => block.type === 'text').map(block => string(block.text));
      try { value = JSON.parse(blocks.join('')); continue; } catch { return null; }
    }
    return value;
  }
  return null;
}

/** A MIME body's readable text. HTML is reduced to text, never inserted into the DOM. */
export function gmailBody(payload: unknown, depth = 0): string {
  if (depth > 20) return '';
  const part = object(payload);
  if (part.filename || part.content_disposition === 'attachment') return '';
  const type = string(part.mime_type).toLowerCase();
  if (Array.isArray(part.parts)) {
    const texts = part.parts.map(child => gmailBody(child, depth + 1)).filter(Boolean);
    // An alternative repeats the same message in several formats: prefer plain text.
    if (type === 'multipart/alternative') {
      const plain = part.parts.find(child => object(child).mime_type === 'text/plain');
      return (plain && gmailBody(plain, depth + 1)) || texts[0] || '';
    }
    return texts.join('\n\n');
  }
  const text = string(object(part.body).content);
  if (type === 'text/plain') return text;
  if (type !== 'text/html') return '';
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** One Gmail API message, with absent metadata left absent rather than an ID-only empty card. */
function message(value: unknown): ObjectValue | null {
  const raw = object(value);
  // A search's result: one flat row per message (`from_`, `to`, `subject`, `email_ts`, …), no MIME payload.
  if (raw.payload === undefined && (raw.from_ !== undefined || raw.email_ts !== undefined)) return searchRow(raw);
  const payload = object(raw.payload);
  const headers = Array.isArray(payload.headers) ? payload.headers.map(object) : [];
  const header = (name: string) => headers.find(each => string(each.name).toLowerCase() === name)?.value;
  const subject = header('subject');
  const sender = header('from');
  const body = gmailBody(payload);
  if (subject === undefined && sender === undefined && !raw.snippet && !body) return null;
  const attachments: ObjectValue[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 20) return;
    const part = object(value);
    if (part.filename) attachments.push({ filename: part.filename, mimeType: part.mime_type });
    if (Array.isArray(part.parts)) part.parts.forEach(child => collect(child, depth + 1));
  };
  collect(payload);
  const time = Number(raw.internal_date);
  return {
    id: raw.id, threadId: raw.thread_id, subject, sender,
    toRecipients: typeof header('to') === 'string' ? [header('to')] : [],
    ccRecipients: typeof header('cc') === 'string' ? [header('cc')] : [],
    bccRecipients: typeof header('bcc') === 'string' ? [header('bcc')] : [],
    date: header('date') ?? (raw.internal_date != null && Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : undefined),
    labelIds: raw.label_ids, snippet: raw.snippet, plaintextBody: body, attachments,
  };
}

/** "Name address" as Codex's search gives a sender or recipient, written as mail does: "Name <address>". */
function mailbox(value: unknown): string {
  const text = string(value).trim();
  const match = /^(.*?)\s*<?([^\s<>]+@[^\s<>]+)>?$/.exec(text);
  return match && match[1] ? `${match[1]} <${match[2]}>` : text;
}

/** A search's flat row (see message), in the fields the card parser reads. */
function searchRow(raw: ObjectValue): ObjectValue {
  const list = (value: unknown) => (Array.isArray(value) ? value.map(mailbox).filter(Boolean) : []);
  const attachments = (Array.isArray(raw.attachments) ? raw.attachments.map(object) : []).flatMap((each) => {
    const filename = string(each.filename) || string(each.name);
    return filename ? [{ filename, mimeType: string(each.mime_type) || string(each.mimeType) }] : [];
  });
  return {
    id: raw.id,
    threadId: raw.thread_id,
    ...(typeof raw.subject === 'string' ? { subject: raw.subject } : {}),
    ...(raw.from_ !== undefined ? { sender: mailbox(raw.from_) } : {}),
    toRecipients: list(raw.to),
    ccRecipients: list(raw.cc),
    bccRecipients: list(raw.bcc),
    date: raw.email_ts,
    labelIds: raw.labels,
    snippet: raw.snippet,
    viewUrl: raw.display_url,
    attachments,
  };
}

/** Search/thread/batch results share the same message cards. Unknown result shapes produce none. */
export function codexGmailMessages(value: unknown): ObjectValue[] {
  const raw = object(value);
  const entries = Array.isArray(value) ? value : Array.isArray(raw.messages) ? raw.messages : Array.isArray(raw.emails) ? raw.emails : Array.isArray(raw.threads) ? raw.threads : [value];
  return entries.flatMap(entry => {
    const row = object(entry);
    if (Array.isArray(row.messages)) return codexGmailMessages(row);
    const normalized = message(entry);
    return normalized ? [normalized] : [];
  });
}
