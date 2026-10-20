// The boundary between what the Gmail connectors return, which the sender of a message wrote or
// chose, and what the panel opens or writes into notes. No network access.

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
 * tags escaped, so that rendering the note loads nothing from the sender's server; links stay, opened
 * only when clicked.
 */
export function inertEmailText(text: string): string {
  return text.replace(/!\[/g, '\\![').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
