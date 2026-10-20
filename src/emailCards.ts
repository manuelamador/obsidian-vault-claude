// Cards for the messages Claude read with Claude Code's Gmail tools (see emailMessages.ts): who sent
// each, its subject, when, and the start of its text; to open in Gmail, quote in the next message,
// start a new chat about it, or save as a note. A long search shows its first cards, the rest a click
// away; an opened thread shows its messages framed together, in place of its card in the search.
import { setIcon } from 'obsidian';
import { formatDate } from './history';
import { attachmentKind, type EmailDraft, type EmailMessage } from './emailMessages';

/** Cards shown before "Show N more". */
const FIRST_CARDS = 5;
/** How much of a message's text a card shows. */
const CARD_TEXT_CHARS = 220;

export interface EmailCardActions {
  quote: (message: EmailMessage) => void;
  /** A new chat, with the message quoted in its input. */
  chat: (message: EmailMessage) => void;
  save: (message: EmailMessage) => void;
  /** A todo made from the message (see TodoModal). */
  todo: (message: EmailMessage) => void;
  /** A thread's messages saved together as one note. */
  saveThread: (messages: EmailMessage[]) => void;
  /** A request in the input for Claude to open the message's thread, for a card that has only its snippet (a search's). */
  openThread: (message: EmailMessage) => void;
  /** Claude asked to draft a reply to the message, as you say it should (see ReplyModal). */
  reply: (message: EmailMessage) => void;
}

/** When `message` was sent, as the chat writes dates; empty when unknown. */
export function emailDate(message: EmailMessage): string {
  return Number.isNaN(message.time) ? '' : formatDate(message.time);
}

/** Who a message or draft goes to, on one line: `To a, b · Cc c · Bcc d`, each part only when it has someone. */
export function recipientsLine(to: string[], cc: string[], bcc: string[]): string {
  return [
    ['To', to],
    ['Cc', cc],
    ['Bcc', bcc],
  ]
    .filter(([, who]) => who.length > 0)
    .map(([label, who]) => `${label} ${(who as string[]).join(', ')}`)
    .join(' · ');
}

/** `message` as Markdown, to quote or save: who, when and what, its attachments by name (the files stay in Gmail), then its text. */
export function emailMarkdown(message: EmailMessage): string {
  const head = [`**${message.subject || '(no subject)'}**`, `From ${message.sender}${message.to.length > 0 ? ` to ${message.to.join(', ')}` : ''}${emailDate(message) ? `, ${emailDate(message)}` : ''}`];
  if (message.attachments) head.push(`Attachments: ${message.attachments.map((each) => `${each.url ? `[${each.name}](${each.url})` : each.name} (${attachmentKind(each.type)})`).join(', ')}`);
  if (message.url) head.push(`[Open in Gmail](${message.url})`);
  return [...head, '', ...(message.body ?? message.text).split('\n')].map((line) => (line ? `> ${line}` : '>')).join('\n');
}

/** A thread's messages as one note: its subject, then each message quoted (see emailMarkdown), oldest first. */
export function threadMarkdown(messages: EmailMessage[]): string {
  const subject = messages[0]?.subject || '(no subject)';
  return [`# ${subject}`, ...messages.map((message) => emailMarkdown(message))].join('\n\n');
}

/** The card for `message` at the end of `list`; `subject`: whether it shows the subject (a thread's header shows it once). */
function drawCard(list: HTMLElement, message: EmailMessage, actions: EmailCardActions, subject = true): HTMLElement {
  const card = list.createDiv({ cls: `vc-email-card${message.unread ? ' is-unread' : ''}` });
  if (message.threadId) card.dataset.thread = message.threadId;
  const head = card.createDiv({ cls: 'vc-email-head' });
  head.createSpan({ cls: 'vc-email-sender', text: message.sender });
  if (message.count) head.createSpan({ cls: 'vc-email-count', text: String(message.count) });
  head.createSpan({ cls: 'vc-email-date', text: emailDate(message) });
  const recipients = recipientsLine(message.to, message.cc ?? [], message.bcc ?? []);
  if (recipients) card.createDiv({ cls: 'vc-email-recipients', text: recipients });
  if (subject && message.subject) card.createDiv({ cls: 'vc-email-subject', text: message.subject });
  const text = message.text.length > CARD_TEXT_CHARS ? `${message.text.slice(0, CARD_TEXT_CHARS)}…` : message.text;
  const textEl = text ? card.createDiv({ cls: 'vc-email-text', text }) : null;
  // Its attachments by name and type, images (often a signature's) folded into a count; opened in Gmail.
  if (message.attachments) {
    const line = card.createDiv({ cls: 'vc-email-attachments' });
    const files = message.attachments.filter((each) => !each.type.startsWith('image/'));
    const images = message.attachments.length - files.length;
    for (const file of files) {
      // The file itself in Gmail where its address is known, else the message holding it.
      const href = file.url ?? message.url;
      const chip = href ? line.createEl('a', { cls: 'vc-email-attachment', href, attr: { 'aria-label': file.url ? 'Open this attachment in Gmail' : 'Open the message in Gmail, with its attachments' } }) : line.createSpan({ cls: 'vc-email-attachment' });
      setIcon(chip.createSpan({ cls: 'vc-email-attachment-icon' }), 'paperclip');
      chip.createSpan({ text: file.name });
      chip.createSpan({ cls: 'vc-email-attachment-kind', text: attachmentKind(file.type) });
    }
    if (images > 0) line.createSpan({ cls: 'vc-email-attachment is-images', text: `+${images} image${images === 1 ? '' : 's'}` });
    // All of them in one zip, as Gmail's Download all gives them.
    if (message.attachmentsZip) {
      const all = line.createEl('a', { cls: 'vc-email-attachment is-all', href: message.attachmentsZip, attr: { 'aria-label': 'Download all the attachments from Gmail, as one zip' } });
      setIcon(all.createSpan({ cls: 'vc-email-attachment-icon' }), 'download');
      all.createSpan({ text: 'Download all' });
    }
  }
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
  // A search's card carries only the snippet: Claude opens the thread, whose messages then expand.
  if (!message.body && message.threadId) button('book-open', 'Ask Claude to open this thread', () => actions.openThread(message));
  button('reply', 'Reply with Claude', () => actions.reply(message));
  button('quote', 'Quote in your next message', () => actions.quote(message));
  button('message-square-plus', 'New chat about this message', () => actions.chat(message));
  button('list-plus', 'Make a todo', () => actions.todo(message));
  button('file-plus', 'Save as a note', () => actions.save(message));
  return card;
}

/** The frame in `parent` holding thread `id`, opened earlier in the reply; null when it was not. */
function openedThread(parent: HTMLElement, id: string | undefined): HTMLElement | null {
  return id ? parent.querySelector<HTMLElement>(`.vc-email-thread[data-thread="${CSS.escape(id)}"]`) : null;
}

/** Cards for `messages` in `parent`: a search's threads, or a message. A thread already opened in the reply is not shown again. */
export function renderEmailCards(parent: HTMLElement, messages: EmailMessage[], actions: EmailCardActions): void {
  const shown = messages.filter((message) => !openedThread(parent, message.threadId));
  if (shown.length === 0) return;
  const list = parent.createDiv({ cls: 'vc-email-cards' });
  shown.slice(0, FIRST_CARDS).forEach((message) => drawCard(list, message, actions));
  const rest = shown.slice(FIRST_CARDS);
  if (rest.length === 0) return;
  const more = list.createEl('button', { cls: 'vc-email-more', text: `Show ${rest.length} more` });
  more.addEventListener('click', () => {
    more.remove();
    // A thread opened since the search was shown is in its frame already.
    rest.filter((message) => !openedThread(parent, message.threadId)).forEach((message) => drawCard(list, message, actions));
  });
}

/**
 * The messages of one thread in `parent`, framed together under its subject. The thread takes the
 * place of its card in a search shown earlier in the reply, or of its own frame if opened before;
 * otherwise it goes at the end.
 */
export function renderEmailThread(parent: HTMLElement, messages: EmailMessage[], actions: EmailCardActions): void {
  if (messages.length === 0) return;
  const id = messages.find((message) => message.threadId)?.threadId;
  const frame = createDiv({ cls: 'vc-email-thread' });
  if (id) frame.dataset.thread = id;
  const head = frame.createDiv({ cls: 'vc-email-thread-head' });
  head.createSpan({ cls: 'vc-email-thread-subject', text: messages[0].subject || '(no subject)' });
  if (messages.length > 1) head.createSpan({ cls: 'vc-email-count', text: String(messages.length) });
  const save = head.createEl('button', { cls: 'clickable-icon vc-email-thread-save', attr: { 'aria-label': 'Save the thread as a note' } });
  setIcon(save, 'file-plus');
  save.addEventListener('click', () => actions.saveThread(messages));
  messages.forEach((message) => drawCard(frame, message, actions, message.subject !== messages[0].subject));
  const earlier =
    openedThread(parent, id) ??
    (id ? parent.querySelector<HTMLElement>(`.vc-email-cards > .vc-email-card[data-thread="${CSS.escape(id)}"]`) : null);
  if (earlier) earlier.replaceWith(frame);
  else parent.createDiv({ cls: 'vc-email-cards' }).appendChild(frame);
}

/** What a draft card does beyond opening in Gmail (see renderEmailDraft). */
export interface DraftActions {
  /** When sending is allowed (see the settings): its Send button, which asks first. */
  send?: (draft: EmailDraft) => void;
  /** Its Edit button: the subject and text as edited on the card, for Claude to write to the draft. */
  edit?: (draft: EmailDraft, subject: string, body: string) => void;
}

/**
 * A card for draft `draft` in `parent`: to whom, its subject and the start of its text (all of it on
 * a click), to open in Gmail, edit on the card, or send (see DraftActions).
 */
export function renderEmailDraft(parent: HTMLElement, draft: EmailDraft, actions: DraftActions = {}): HTMLElement {
  const card = parent.createDiv({ cls: 'vc-email-cards' }).createDiv({ cls: 'vc-email-card vc-email-draft', attr: { 'data-draft': draft.id } });
  drawDraft(card, draft, actions);
  return card;
}

/** What became of a draft whose card is no longer to act on (see settleDraftCards). */
export type DraftOutcome = 'sent' | 'deleted' | 'updated';

const OUTCOME_SAID: Record<DraftOutcome, [string, string]> = {
  sent: ['Sent', 'Sent: the draft is gone from Gmail.'],
  deleted: ['Deleted', 'Deleted from Gmail.'],
  updated: ['Earlier version', 'Updated since: the card below has the draft as it is now.'],
};

/**
 * Draft `id`'s cards in `root`, all of them, or for `updated` all but the last: no longer to send or
 * edit, since the draft was sent, deleted, or changed by a later call whose card is the one kept.
 */
export function settleDraftCards(root: HTMLElement, id: string, outcome: DraftOutcome): void {
  const cards = [...root.querySelectorAll<HTMLElement>('.vc-email-draft')].filter((card) => card.dataset.draft === id);
  for (const card of outcome === 'updated' ? cards.slice(0, -1) : cards) {
    if (card.dataset.outcome === outcome) continue;
    card.dataset.outcome = outcome;
    card.addClass('is-settled');
    card.removeClass('is-editing');
    card.querySelectorAll('.vc-email-actions, .vc-email-edit-buttons, .vc-email-note').forEach((el) => el.remove());
    card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((el) => (el.disabled = true));
    const [badge, note] = OUTCOME_SAID[outcome];
    const badgeEl = card.querySelector('.vc-email-badge');
    if (badgeEl) badgeEl.setText(badge);
    card.createDiv({ cls: 'vc-email-note vc-muted', text: note });
  }
}

/** Draws `draft` in `card`, in place of what it held: as read, or, from its Edit button, as a form. */
function drawDraft(card: HTMLElement, draft: EmailDraft, actions: DraftActions, note?: string): void {
  card.empty();
  card.removeClass('is-expandable', 'is-expanded', 'is-editing');
  card.removeAttribute('title');
  const head = card.createDiv({ cls: 'vc-email-head' });
  head.createSpan({ cls: 'vc-email-badge', text: draft.updated ? 'Draft updated' : 'Draft' });
  head.createSpan({ cls: 'vc-email-sender', text: recipientsLine(draft.to, draft.cc, draft.bcc) });
  if (draft.subject) card.createDiv({ cls: 'vc-email-subject', text: draft.subject });
  if (draft.body) {
    const body = draft.body;
    const short = body.length > CARD_TEXT_CHARS ? `${body.slice(0, CARD_TEXT_CHARS)}…` : body;
    const textEl = card.createDiv({ cls: 'vc-email-text', text: short });
    if (short !== body || body.includes('\n')) {
      card.addClass('is-expandable');
      card.setAttr('title', 'Show the whole draft');
      card.onclick = (evt) => {
        if ((evt.target as HTMLElement).closest('.vc-email-actions, a, button, input, textarea')) return;
        if (window.getSelection()?.toString()) return;
        const open = !card.hasClass('is-expanded');
        card.toggleClass('is-expanded', open);
        card.setAttr('title', open ? 'Show less' : 'Show the whole draft');
        textEl.setText(open ? body : short);
      };
    }
  }
  // The files it carries, by name and type: they are sent with it (see confirmSendDraft), opened from the draft in Gmail.
  if (draft.attachments) {
    const line = card.createDiv({ cls: 'vc-email-attachments' });
    for (const file of draft.attachments) {
      const chip = draft.url ? line.createEl('a', { cls: 'vc-email-attachment', href: draft.url, attr: { 'aria-label': 'Open the draft in Gmail, with its attachments' } }) : line.createSpan({ cls: 'vc-email-attachment' });
      setIcon(chip.createSpan({ cls: 'vc-email-attachment-icon' }), 'paperclip');
      chip.createSpan({ text: file.name });
      if (file.type) chip.createSpan({ cls: 'vc-email-attachment-kind', text: attachmentKind(file.type) });
    }
  }
  if (note) card.createDiv({ cls: 'vc-email-note vc-muted', text: note });
  const { send, edit } = actions;
  if (!draft.url && !send && !edit) return;
  const buttons = card.createDiv({ cls: 'vc-email-actions' });
  if (draft.url) {
    const open = buttons.createEl('a', { cls: 'clickable-icon', href: draft.url, attr: { 'aria-label': 'Open the draft in Gmail' } });
    setIcon(open, 'external-link');
  }
  if (edit) {
    const button = buttons.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Edit the subject and text here' } });
    setIcon(button, 'pencil');
    button.addEventListener('click', () => drawDraftForm(card, draft, actions));
  }
  if (send) {
    const button = buttons.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Send this draft…' } });
    setIcon(button, 'send');
    button.addEventListener('click', () => send(draft));
  }
}

/**
 * The draft's subject and whole text, to edit on the card: Save hands them to Claude to write to the
 * draft (see DraftActions.edit), and the card shows them as saved; Cancel, or Esc, leaves it as it was.
 */
function drawDraftForm(card: HTMLElement, draft: EmailDraft, actions: DraftActions): void {
  card.empty();
  card.removeClass('is-expandable', 'is-expanded');
  card.addClass('is-editing');
  card.onclick = null;
  card.removeAttribute('title');
  const head = card.createDiv({ cls: 'vc-email-head' });
  head.createSpan({ cls: 'vc-email-badge', text: 'Editing draft' });
  head.createSpan({ cls: 'vc-email-sender', text: recipientsLine(draft.to, draft.cc, draft.bcc) });
  const subject = card.createEl('input', { cls: 'vc-email-edit-subject', attr: { type: 'text', placeholder: 'Subject', 'aria-label': 'Subject' } });
  subject.value = draft.subject ?? '';
  const body = card.createEl('textarea', { cls: 'vc-email-edit-body', attr: { 'aria-label': 'Text', rows: String(Math.min(20, Math.max(6, (draft.body ?? '').split('\n').length + 2))) } });
  body.value = draft.body ?? '';
  const buttons = card.createDiv({ cls: 'vc-email-edit-buttons' });
  const cancel = () => drawDraft(card, draft, actions);
  const save = () => {
    const edited = { ...draft, subject: subject.value.trim(), body: body.value.replace(/\r\n?/g, '\n').trim() };
    if (edited.subject === (draft.subject ?? '') && edited.body === (draft.body ?? '')) return cancel();
    actions.edit?.(draft, edited.subject, edited.body);
    drawDraft(card, edited, actions, 'Edited here: sent to Claude to update the draft in Gmail.');
  };
  buttons.createEl('button', { cls: 'mod-cta', text: 'Save' }).addEventListener('click', save);
  buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', cancel);
  card.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') {
      evt.preventDefault();
      evt.stopPropagation();
      cancel();
    } else if (evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey)) {
      evt.preventDefault();
      save();
    }
  });
  body.focus();
}
