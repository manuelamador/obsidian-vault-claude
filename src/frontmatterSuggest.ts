// Suggest frontmatter updates: Claude reads a note, the notes beside it and the chats that worked on
// them, and proposes new values for the note's properties, each with its reason; nothing is written
// until approved (see FrontmatterModal). Vault-agnostic: no conventions of any one vault are assumed,
// beyond what the note, its neighbours and the user's own guidance show. Kept free of `obsidian`
// imports so the tests can use it.

/** Properties never proposed: `updated` is stamped on approval when the note has it. */
const NOT_PROPOSED = new Set(['updated']);

/** How much of the note and of each neighbour's properties the request carries. */
const NOTE_CHARS = 12000;
const NEIGHBOUR_CHARS = 600;

/** A note beside the one updated: its path, its properties, and when it last changed. */
export interface Neighbour {
  path: string;
  frontmatter: Record<string, unknown>;
  modified: string;
}

/** One property proposed: its key, the value proposed (as YAML would hold it), and why. */
export interface FieldSuggestion {
  key: string;
  value: unknown;
  reason: string;
}

/** The instructions for proposing a note's properties. */
export const FRONTMATTER_SYSTEM = [
  "You propose updates to the frontmatter (properties) of a note in the user's Obsidian vault, so that they describe the note as it is now.",
  'You are given the note, the properties and change dates of the notes beside it (its folder and the folders in it), the conversations with an AI assistant that worked on them, and any guidance from the user.',
  "Propose a change only where a value is out of date, wrong, or missing given what the note and its neighbours show; leave the rest alone. Keep each property's type: a list stays a list, a date stays YYYY-MM-DD, a boolean stays true or false.",
  'Follow any conventions the note, its neighbours or the guidance state or show (allowed values, lengths, wording). Add a property only when the neighbours show the note should have it. Never propose "updated": it is stamped when the user approves.',
  'Each reason is one sentence, naming what in the note or its neighbours supports the change. Reply with JSON only: {"fields": [{"key": "…", "value": …, "reason": "…"}]}, with "fields" empty when nothing should change.',
].join('\n');

/** `text` cut to `max` characters, said so when cut. */
function capped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… the rest left out …]`;
}

/** The request: the note, its neighbours, the chats that worked on them, and the user's guidance. */
export function frontmatterPrompt(input: { path: string; text: string; neighbours: Neighbour[]; chats: { title: string; date: string }[]; guidance: string }): string {
  return [
    `Note: ${input.path}`,
    '<note>',
    capped(input.text, NOTE_CHARS),
    '</note>',
    '',
    input.neighbours.length > 0 ? 'Notes beside it, most recently changed first (path, last changed, properties):' : 'No notes beside it.',
    ...input.neighbours.map((note) => `- ${note.path} (${note.modified}): ${capped(JSON.stringify(note.frontmatter), NEIGHBOUR_CHARS)}`),
    '',
    input.chats.length > 0 ? 'Conversations that worked on these notes, most recent first:' : 'No conversations worked on these notes.',
    ...input.chats.map((chat) => `- ${chat.date}: ${chat.title}`),
    '',
    `Guidance from the user: ${input.guidance.trim() || '(none)'}`,
  ].join('\n');
}

/**
 * The proposals in the model's reply: one per key, with a reason, leaving out `updated` and those
 * that would not change the value; null when it is not the JSON asked for.
 */
export function readFrontmatterSuggestions(reply: string, current: Record<string, unknown>): FieldSuggestion[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  const fields = (parsed as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return null;
  const seen = new Set<string>();
  return fields.flatMap((field) => {
    if (typeof field !== 'object' || field === null) return [];
    const { key, value, reason } = field as Record<string, unknown>;
    if (typeof key !== 'string' || !key.trim() || NOT_PROPOSED.has(key) || seen.has(key) || value === undefined) return [];
    if (JSON.stringify(value) === JSON.stringify(current[key])) return [];
    seen.add(key);
    return [{ key, value, reason: typeof reason === 'string' ? reason.trim() : '' }];
  });
}

/** A value as the review shows it to edit: a list one item per line, an object as JSON, the rest as text. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** An edited value read back in the shape of `like` (the value proposed): a list from its lines, a boolean, a number, an object from JSON; else text. */
export function readEdited(text: string, like: unknown): unknown {
  if (Array.isArray(like)) return text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (typeof like === 'boolean') return text.trim().toLowerCase() === 'true';
  if (typeof like === 'number') {
    const number = Number(text.trim());
    return Number.isFinite(number) ? number : text;
  }
  if (like !== null && typeof like === 'object') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text.trim();
}
