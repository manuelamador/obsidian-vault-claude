// The boundary between what the Gmail connectors return, which the sender of a message wrote or
// chose, and what the panel opens or writes into notes. No network access.
import { stripTags } from './emailText';

/** `value` if it is a Gmail address (https, mail.google.com, no user or port), else undefined: a link from a tool result opens only there. */
export function safeGmailUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'mail.google.com' && !url.username && !url.password && !url.port ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Text from an email as it goes into a note or a message: its images (`![…](…)`, `![[…]]`) and HTML
 * tags made inert, so that rendering the note loads nothing from the sender's server; links stay,
 * opened only when clicked. The `!` of an image becomes its entity, which no backslash before it can
 * undo (an escape could: `\![` escaped is `\\![`, a backslash and a live image); only a `<` that
 * starts a tag is escaped, so `a < b` reads as written.
 */
export function inertEmailText(text: string): string {
  // A line opening with `>` would nest a quote inside the saved one, whose first line could then be a live callout (`> [!danger] …`).
  return text.replace(/!(?=\[)/g, '&#33;').replace(/<(?=[A-Za-z/!?])/g, '&lt;').replace(/^(\s*)>/gm, '$1&gt;');
}

/** The Tasks plugin's markers (dates, recurrence, priority, done) and block ids, which an email's text must not set on a task. */
const TASK_MARKERS = /[📅⏳🛫🔁⏫🔼🔽✅➕❌⛔🆔]\uFE0F?|\^[\w-]+/gu;

/**
 * Text from an email as it goes into a task line (an email card's Make a todo): plain words, shown and
 * edited as typed, with images, tags and the Tasks plugin's markers taken out, so that it loads nothing
 * and sets no date, recurrence or priority of its own.
 */
export function plainEmailText(text: string): string {
  return stripTags(text.replace(/!(?=\[)/g, ''), true)
    .replace(TASK_MARKERS, '')
    .replace(/\s+/g, ' ')
    .trim();
}
