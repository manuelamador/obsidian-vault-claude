// The text sent for an inline edit and the cleanup of the answer. Kept free of `obsidian`
// imports so the headless smoke test can use it.

/** Characters of the note on each side of the selection sent as context. */
export const INLINE_CONTEXT_CHARS = 2000;
const MAX_CONVENTIONS_CHARS = 50_000;

/** System prompt: how to answer, then the vault's own conventions (its CLAUDE.md), when there is one. */
export function inlineEditSystem(insert: boolean, conventions: string): string {
  const task = insert ? 'Return only the text to insert at the cursor.' : 'Return only the replacement for the selected text.';
  const rules = [
    "You edit text inside a note in an Obsidian vault, following the user's instruction.",
    `${task} No preamble, no explanation, no quotation marks or code fences around it.`,
    "Keep the note's Markdown: [[wikilinks]], callouts, and $…$ / $$…$$ math. Change only what the instruction asks for.",
    'The text around the selection is context only; never repeat it in the answer.',
  ].join('\n');
  const vault = conventions.trim()
    ? `\n\nThe vault's conventions (its CLAUDE.md):\n<conventions>\n${conventions.slice(0, MAX_CONVENTIONS_CHARS)}\n</conventions>`
    : '';
  return rules + vault;
}

/** The note's path, the selection (or cursor) in its surrounding text, and the instruction. */
export function inlineEditPrompt(target: { path: string; original: string; before: string; after: string }, instruction: string): string {
  const middle = target.original ? `<selection>${target.original}</selection>` : '<cursor/>';
  return [`Note: ${target.path}`, '', `<context>${target.before}${middle}${target.after}</context>`, '', `Instruction: ${instruction}`].join('\n');
}

/**
 * The answer as the text to put in the note. An answer wrapped whole in a code fence (unless
 * the selection is itself a code block) or in selection tags is unwrapped, and the selection's
 * own leading and trailing whitespace is kept, so paragraphs stay separated.
 */
export function cleanReplacement(answer: string, original: string): string {
  let text = answer.trim();
  const fence = text.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fence && !original.trim().startsWith('```')) text = fence[1];
  const tags = text.match(/^<selection>([\s\S]*)<\/selection>$/);
  if (tags) text = tags[1].trim();
  if (!original) return text;
  const lead = original.match(/^\s*/)?.[0] ?? '';
  const trail = original.match(/\s*$/)?.[0] ?? '';
  return `${lead}${text}${trail}`;
}
