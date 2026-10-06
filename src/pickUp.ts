// Pick up where you left off: which chats you are likely to carry on, with why and a step to take,
// suggested by the model for small jobs from short excerpts of recent chats and of older ones that
// look unfinished. Kept free of `obsidian` imports so the tests can use it.
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { applyTicks, bubbleOf, replyKey, textBlocks, uncheckedCount, type ContentBlock } from './chatText';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Chats worked on this recently are recent. */
export const RECENT_DAYS = 14;
/** Older chats are looked at back to this. */
export const OLDER_DAYS = 183;
/** How many of each kind are looked at, and how many suggested at most. */
export const RECENT_LOOKED_AT = 10;
export const OLDER_LOOKED_AT = 12;
export const MAX_RECENT = 7;
export const MAX_OLDER = 4;
/** How many of each are shown at first; the rest, ranked after them, stand in for one set aside. */
export const SHOWN_RECENT = 4;
export const SHOWN_OLDER = 2;
/** How much of each exchange goes to the model. */
const EXCHANGES = 6;
const EXCERPT_CHARS = 500;
const PLAN_CHARS = 400;

/** What the plugin keeps between uses: the chats you set aside, with when they were last worked on then; and those you asked to be reminded of, with their suggestion and when you asked. */
export interface PickUpState {
  /** Chats never to suggest again (until the reset command): by id, when it was said. */
  hidden: Record<string, number>;
  /** Chats skipped for now: by id, when they may be suggested again (see SKIP_DAYS). */
  skipped?: Record<string, number>;
  /** Reminders: each with its suggestion, when it was asked for, and the days (`YYYY-MM-DD`) it has been shown on. */
  later?: Record<string, { why: string; next: string; at: number; days?: string[] }>;
  /** The last suggestions, kept for the rest of the day they were made (`day`, local `YYYY-MM-DD`). */
  kept?: { day: string; at: number; suggestions: Suggestion[]; note: string; candidates: Candidate[] };
}

/** A chat skipped for now is left out for this long. */
export const SKIP_DAYS = 7;

/** Whether chat `id` is left out of suggestions now: never to be suggested, or skipped and not yet due. */
export function leftOut(state: PickUpState, id: string, now: number): boolean {
  return id in state.hidden || (state.skipped?.[id] ?? 0) > now;
}

/** A reminder is shown on this many days, then let go of. */
export const REMINDER_DAYS = 5;

/**
 * The reminders to show now, asked for before `before` (not those just asked for, which wait for the
 * next time): each with the days it has left, today counted; today is recorded as one of its days,
 * and one whose days are used up is let go of. `exists`: whether its chat is still there.
 */
export function remindersNow(state: PickUpState, now: number, before: number, exists: (id: string) => boolean): { id: string; why: string; next: string; left: number }[] {
  const today = localDay(now);
  const shown: { id: string; why: string; next: string; left: number }[] = [];
  for (const [id, reminder] of Object.entries(state.later ?? {})) {
    if (reminder.at >= before) continue;
    const days = reminder.days ?? [];
    if (!exists(id) || (days.length >= REMINDER_DAYS && !days.includes(today))) {
      delete state.later?.[id];
      continue;
    }
    if (!days.includes(today)) reminder.days = [...days, today];
    shown.push({ id, why: reminder.why, next: reminder.next, left: REMINDER_DAYS - (reminder.days ?? days).length });
  }
  return shown;
}

/** `at`'s local day, `YYYY-MM-DD`: suggestions are kept for the day they were made. */
export function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Today's kept suggestions, as they still stand: without the chats set aside since, or worked on
 * since they were made (the suggestion is about where they were then). Null when none are kept from today.
 */
export function keptToday(state: PickUpState, now: number, updatedAt: (id: string) => number | undefined): { suggestions: Suggestion[]; note: string; candidates: Candidate[]; at: number } | null {
  const kept = state.kept;
  if (!kept || kept.day !== localDay(now)) return null;
  // Not one gone (deleted, so not listed), set aside, reminded of, or worked on since.
  const standing = kept.suggestions.filter((suggestion) => {
    const at = updatedAt(suggestion.id);
    return at !== undefined && at <= kept.at && !leftOut(state, suggestion.id, now) && !state.later?.[suggestion.id];
  });
  // None left of those there were: asked again, rather than saying nothing is left open.
  if (standing.length === 0 && kept.suggestions.length > 0) return null;
  return { suggestions: standing, note: kept.note, candidates: kept.candidates, at: kept.at };
}

/** A chat as the history lists it, as far as picking up needs. */
export interface ChatItem {
  id: string;
  title: string;
  updatedAt: number;
}

/** A chat put to the model: its excerpts and the clues that something was left open. */
export interface Candidate extends ChatItem {
  older: boolean;
  exchanges: { who: 'You' | 'Claude'; text: string }[];
  clues: string[];
}

/** One suggestion: the chat, why it may be worth picking up, and a step to take. */
export interface Suggestion {
  id: string;
  why: string;
  next: string;
}

/**
 * The chats to look at: the most recent first; then older ones (back to OLDER_DAYS) in a random
 * order, so that each time other ones may come up; neither those never to be suggested, nor those
 * skipped and not yet due (see leftOut). `random`: a number in [0, 1), as Math.random gives.
 */
export function chatsToLookAt(items: ChatItem[], state: PickUpState, now: number, random: () => number = Math.random): { recent: ChatItem[]; older: ChatItem[] } {
  const open = items.filter((item) => !leftOut(state, item.id, now)).sort((a, b) => b.updatedAt - a.updatedAt);
  const recent = open.filter((item) => now - item.updatedAt <= RECENT_DAYS * DAY_MS).slice(0, RECENT_LOOKED_AT);
  const older = open.filter((item) => now - item.updatedAt > RECENT_DAYS * DAY_MS && now - item.updatedAt <= OLDER_DAYS * DAY_MS);
  // Shuffled (Fisher–Yates).
  for (let i = older.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [older[i], older[j]] = [older[j], older[i]];
  }
  return { recent, older };
}

/**
 * `text` with its lines kept, cut when long, its end kept for a reply (where it says what is left);
 * a code fence or display equation cut in two is closed or dropped, so the rest is not drawn as code.
 */
function excerpt(text: string, keepEnd: boolean): string {
  // Its lines kept (it is Markdown, drawn as such), runs of blank ones made one.
  const flat = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  const cut = keepEnd ? flat.slice(-EXCERPT_CHARS).trimStart() : flat.slice(0, EXCERPT_CHARS).trimEnd();
  const fences = (cut.match(/^ {0,3}(`{3,}|~{3,}|\$\$)/gm) ?? []).length;
  // An odd number: one was cut off. From the end: what is before the first is inside code, dropped. From the start: closed.
  const whole = fences % 2 === 0 ? cut : keepEnd ? cut.slice(cut.search(/^ {0,3}(`{3,}|~{3,}|\$\$)/m)).replace(/^[^\n]*\n?/, '') : `${cut}\n${/^ {0,3}(\$\$)/m.test(cut) ? '$$' : '```'}`;
  return keepEnd ? `…${whole}` : `${whole}…`;
}

/** A message of the chat's own (not a subagent's), yours or Claude's. */
export function ownMessage(message: { type: string; parent_tool_use_id: string | null }): boolean {
  return (message.type === 'user' || message.type === 'assistant') && message.parent_tool_use_id === null;
}

/** A message's own content blocks: none for one that is not the chat's (a subagent's). */
function blocksOf(message: SessionMessage): ContentBlock[] {
  if (message.parent_tool_use_id !== null) return [];
  const content = (message.message as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/**
 * A chat as it is put to the model, from its last messages: its last exchanges, and the clues that
 * something was left open (see clueLines). `ticks`: its checkbox ticks by reply key; `memoNext`, the
 * Next sections of memos saved from it.
 */
export function candidateOf(item: ChatItem, older: boolean, messages: SessionMessage[], ticks: Record<string, number[]>, memoNext: string[]): Candidate {
  const exchanges: Candidate['exchanges'] = [];
  for (const message of messages) {
    if (message.type === 'user') {
      const bubble = bubbleOf(message);
      if (bubble?.text.trim()) exchanges.push({ who: 'You', text: excerpt(bubble.text, false) });
    } else if (message.type === 'assistant') {
      const text = textBlocks(blocksOf(message)).join('\n').trim();
      if (text) exchanges.push({ who: 'Claude', text: excerpt(text, true) });
    }
  }
  return { ...item, older, exchanges: exchanges.slice(-EXCHANGES), clues: clueLines(messages, ticks, memoNext) };
}

/**
 * What may say something was left open, as clues for the model to weigh, not as proof: Claude's last
 * reply ending on a question, a plan put to you and not answered, unticked checkboxes in its last
 * reply, your last message with no reply, and memos' Next sections.
 */
export function clueLines(messages: SessionMessage[], ticks: Record<string, number[]>, memoNext: string[]): string[] {
  const clues: string[] = [];
  const own = messages.filter(ownMessage);
  const answered = new Set(own.flatMap((message) => (message.type === 'user' ? blocksOf(message).filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id) : [])));
  // The last message with text of its own: your prompt, or Claude's reply.
  const lastSaid = [...own].reverse().find((message) => (message.type === 'user' ? !!bubbleOf(message)?.text.trim() : textBlocks(blocksOf(message)).join('').trim() !== ''));
  if (lastSaid?.type === 'user') clues.push('Your last message has no reply after it.');
  if (lastSaid?.type === 'assistant') {
    const blocks = textBlocks(blocksOf(lastSaid));
    const text = blocks.join('\n').trim();
    const lastLine = text.split('\n').filter((line) => line.trim()).pop() ?? '';
    // A question however its end is marked up: `?**`, `?)`, `?"`, a fullwidth `？`.
    if (/[?？][*_)"'`\s]*$/.test(lastLine)) clues.push(`Claude's last reply ends with a question: "${excerpt(lastLine, true)}"`);
    let unticked = 0;
    blocks.forEach((block, index) => {
      unticked += uncheckedCount(applyTicks(block, new Set(ticks[replyKey(lastSaid.uuid, index)] ?? [])));
    });
    if (unticked > 0) clues.push(`Claude's last reply has ${unticked} unticked checkbox${unticked === 1 ? '' : 'es'} (they may be examples, not tasks).`);
  }
  // A plan put to you with no answer recorded: the chat ended while it waited.
  for (const message of [...own].reverse()) {
    if (message.type !== 'assistant') continue;
    const plan = blocksOf(message).find((block) => block.type === 'tool_use' && block.name === 'ExitPlanMode');
    if (!plan) continue;
    if (!answered.has(plan.id)) {
      const text = typeof (plan.input as { plan?: unknown } | undefined)?.plan === 'string' ? ((plan.input as { plan: string }).plan) : '';
      clues.push(`A plan was put to you and not answered${text ? `; it begins: "${text.replace(/\s+/g, ' ').trim().slice(0, PLAN_CHARS)}"` : '.'}`);
    }
    break;
  }
  for (const next of memoNext) clues.push(`A memo saved from this chat has under Next: "${excerpt(next, false)}"`);
  return clues;
}

/** The instructions for suggesting chats to pick up. */
export const PICK_UP_SYSTEM = [
  'You help a researcher decide which of their conversations with an AI assistant to carry on. You are given recent conversations and some older ones, each with its last exchanges and clues that something may have been left open.',
  `Choose the ones the person is most likely to want to continue, ranked best first: up to ${MAX_RECENT} recent and up to ${MAX_OLDER} older. The first ${SHOWN_RECENT} recent and ${SHOWN_OLDER} older are shown; the rest stand in when the person sets one aside. Choose fewer, or none, when nothing looks left open; never pad the list.`,
  'Treat the clues as clues, not proof: a closing question may be a routine offer, unticked checkboxes may be examples, a plan may have been dealt with elsewhere. Weigh them against the exchanges.',
  'For each, give "why": one plain sentence on what was left open, from what the excerpts say; and "next": one step the person could take, phrased as a suggestion. Never decide for them or assume their answer: write "Decide whether to apply the fix to all three files, then rerun the tests", never "Answer yes".',
  'Reply with JSON only: {"suggestions": [{"id": "…", "why": "…", "next": "…"}], "note": "…"}. Use the ids as given. "note" is only for when "suggestions" is empty: one sentence saying why (for example, that nothing looks left open). Anything worth mentioning about a conversation goes in a suggestion, never in the note.',
].join('\n');

/** The request: the candidates, recent and older, each with its id, title, age, exchanges and clues. */
export function pickUpPrompt(candidates: Candidate[], now: number): string {
  const describe = (candidate: Candidate) => {
    const days = Math.max(0, Math.round((now - candidate.updatedAt) / DAY_MS));
    const lines = [`id: ${candidate.id}`, `title: ${candidate.title}`, `last worked on: ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}`];
    if (candidate.clues.length > 0) lines.push('clues:', ...candidate.clues.map((clue) => `- ${clue}`));
    lines.push('last exchanges:', ...candidate.exchanges.map((exchange) => `${exchange.who}: ${exchange.text}`));
    return lines.join('\n');
  };
  const recent = candidates.filter((candidate) => !candidate.older);
  const older = candidates.filter((candidate) => candidate.older);
  return [
    `Recent conversations (the last ${RECENT_DAYS} days):`,
    recent.length > 0 ? recent.map(describe).join('\n\n') : '(none)',
    '',
    `Older conversations that may be unfinished (up to ${OLDER_DAYS} days back):`,
    older.length > 0 ? older.map(describe).join('\n\n') : '(none)',
  ].join('\n');
}

/**
 * The suggestions in the model's reply: only chats it was given, each once, at most MAX_RECENT recent
 * and MAX_OLDER older, with a why and a next step; and its note, if any. Null when it is not the JSON asked for.
 */
export function readPickUp(reply: string, candidates: Candidate[]): { suggestions: Suggestion[]; note: string } | null {
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const given = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const list = Array.isArray((parsed as { suggestions?: unknown }).suggestions) ? (parsed as { suggestions: unknown[] }).suggestions : [];
  const suggestions: Suggestion[] = [];
  const taken = { recent: 0, older: 0 };
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, why, next } = entry as Record<string, unknown>;
    const candidate = typeof id === 'string' ? given.get(id) : undefined;
    if (!candidate || typeof why !== 'string' || typeof next !== 'string' || !why.trim() || !next.trim()) continue;
    if (suggestions.some((suggestion) => suggestion.id === id)) continue;
    const kind = candidate.older ? 'older' : 'recent';
    if (taken[kind] >= (candidate.older ? MAX_OLDER : MAX_RECENT)) continue;
    taken[kind] += 1;
    suggestions.push({ id: candidate.id, why: why.trim(), next: next.trim() });
  }
  const note = (parsed as { note?: unknown }).note;
  return { suggestions, note: typeof note === 'string' ? note.trim() : '' };
}
