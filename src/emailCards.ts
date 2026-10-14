// Cards for the messages Claude read with Claude Code's Gmail tools (see emailMessages.ts): who sent
// each, its subject, when, and the start of its text; to open in Gmail, quote in the next message, or
// save as a note. A long search shows its first cards, the rest a click away.
import { setIcon } from 'obsidian';
import { formatDate } from './history';
import type { EmailMessage } from './emailMessages';

/** Cards shown before "Show N more". */
const FIRST_CARDS = 5;
/** How much of a message's text a card shows. */
const CARD_TEXT_CHARS = 220;

export interface EmailCardActions {
  quote: (message: EmailMessage) => void;
  save: (message: EmailMessage) => void;
}

/** When `message` was sent, as the chat writes dates; empty when unknown. */
export function emailDate(message: EmailMessage): string {
  return Number.isNaN(message.time) ? '' : formatDate(message.time);
}

/** `message` as Markdown, to quote or save: who, when and what, then its text. */
export function emailMarkdown(message: EmailMessage): string {
  const head = [`**${message.subject}**`, `From ${message.sender}${message.to.length > 0 ? ` to ${message.to.join(', ')}` : ''}${emailDate(message) ? `, ${emailDate(message)}` : ''}`];
  if (message.url) head.push(`[Open in Gmail](${message.url})`);
  return [...head, '', message.text].map((line) => (line ? `> ${line}` : '>')).join('\n');
}

/** Cards for `messages` in `parent`. */
export function renderEmailCards(parent: HTMLElement, messages: EmailMessage[], actions: EmailCardActions): void {
  if (messages.length === 0) return;
  const list = parent.createDiv({ cls: 'vc-email-cards' });
  const draw = (message: EmailMessage) => {
    const card = list.createDiv({ cls: `vc-email-card${message.unread ? ' is-unread' : ''}` });
    const head = card.createDiv({ cls: 'vc-email-head' });
    head.createSpan({ cls: 'vc-email-sender', text: message.sender });
    if (message.count) head.createSpan({ cls: 'vc-email-count', text: String(message.count) });
    head.createSpan({ cls: 'vc-email-date', text: emailDate(message) });
    card.createDiv({ cls: 'vc-email-subject', text: message.subject });
    const text = message.text.length > CARD_TEXT_CHARS ? `${message.text.slice(0, CARD_TEXT_CHARS)}…` : message.text;
    if (text) card.createDiv({ cls: 'vc-email-text', text });
    const buttons = card.createDiv({ cls: 'vc-email-actions' });
    const button = (icon: string, label: string, run: () => void) => {
      const el = buttons.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
      setIcon(el, icon);
      el.addEventListener('click', run);
    };
    if (message.url) {
      const open = buttons.createEl('a', { cls: 'clickable-icon', href: message.url, attr: { 'aria-label': 'Open in Gmail' } });
      setIcon(open, 'external-link');
    }
    button('quote', 'Quote in your next message', () => actions.quote(message));
    button('file-plus', 'Save as a note', () => actions.save(message));
  };
  messages.slice(0, FIRST_CARDS).forEach(draw);
  const rest = messages.slice(FIRST_CARDS);
  if (rest.length === 0) return;
  const more = list.createEl('button', { cls: 'vc-email-more', text: `Show ${rest.length} more` });
  more.addEventListener('click', () => {
    more.remove();
    rest.forEach(draw);
  });
}
