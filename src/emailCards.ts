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
  const head = [`**${message.subject || '(no subject)'}**`, `From ${message.sender}${message.to.length > 0 ? ` to ${message.to.join(', ')}` : ''}${emailDate(message) ? `, ${emailDate(message)}` : ''}`];
  if (message.url) head.push(`[Open in Gmail](${message.url})`);
  return [...head, '', ...(message.body ?? message.text).split('\n')].map((line) => (line ? `> ${line}` : '>')).join('\n');
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
    if (message.subject) card.createDiv({ cls: 'vc-email-subject', text: message.subject });
    const text = message.text.length > CARD_TEXT_CHARS ? `${message.text.slice(0, CARD_TEXT_CHARS)}…` : message.text;
    const textEl = text ? card.createDiv({ cls: 'vc-email-text', text }) : null;
    // A thread or a message carries the whole text: a click on the card opens it there, and closes it again.
    if (message.body && textEl) {
      const body = message.body;
      card.addClass('is-expandable');
      card.setAttr('aria-expanded', 'false');
      card.setAttr('title', 'Show the whole message');
      card.addEventListener('click', (evt) => {
        if ((evt.target as HTMLElement).closest('.vc-email-actions, a, button')) return;
        if (window.getSelection()?.toString()) return;
        const open = !card.hasClass('is-expanded');
        card.toggleClass('is-expanded', open);
        card.setAttr('aria-expanded', String(open));
        card.setAttr('title', open ? 'Show less' : 'Show the whole message');
        textEl.setText(open ? body : text);
      });
    }
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
