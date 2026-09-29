// The one-off request behind "Save summary as note", and the note made from its answer. Kept free
// of `obsidian` imports so the headless tests can use it.

/** Characters of conversation sent at most; a longer chat keeps its start and most of its end. */
const MAX_TRANSCRIPT_CHARS = 400_000;
const MAX_CONVENTIONS_CHARS = 50_000;

/** How to write the summary, then the vault's own conventions (its CLAUDE.md), when there is one. */
export function summarySystem(conventions: string): string {
  const rules = [
    "You write a note for the user's Obsidian vault that summarizes a conversation between the user and Claude Code, an AI assistant working in the vault.",
    'Record what the user asked for, what was done (files, commands, results, with the specifics), the decisions made, and what is still open. Leave out steps that led nowhere unless their outcome matters.',
    "Start with YAML frontmatter as the vault's conventions require, then a level-1 heading with the title given. Return only the note, with no code fence around it.",
  ].join('\n');
  const vault = conventions.trim()
    ? `\n\nThe vault's conventions (its CLAUDE.md), which the note follows:\n<conventions>\n${conventions.slice(0, MAX_CONVENTIONS_CHARS)}\n</conventions>`
    : '';
  return rules + vault;
}

/** The start (15%) and end of an over-long conversation, with the omission marked. */
export function trimTranscript(text: string, max = MAX_TRANSCRIPT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.15);
  const omitted = text.length - max;
  return `${text.slice(0, head)}\n\n[… ${omitted.toLocaleString('en-US')} characters from the middle of the conversation omitted …]\n\n${text.slice(text.length - (max - head))}`;
}

/** The request: the note's title, the date, the session, the model writing it, and the conversation. */
export function summaryPrompt(input: { title: string; date: string; sessionId: string; model?: string; transcript: string }): string {
  const lines = [`Title: ${input.title}`, `Date: ${input.date}`, `Claude Code session: ${input.sessionId}`];
  if (input.model) lines.push(`Model writing this note: ${input.model}`);
  return `${lines.join('\n')}\n\n<conversation>\n${trimTranscript(input.transcript)}\n</conversation>`;
}

/** The note to write: the answer without a wrapping code fence, and with frontmatter added if it has none. */
export function summaryNote(answer: string, fallback: { date: string; sessionId: string }): string {
  let text = answer.trim();
  const fence = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  if (!text.startsWith('---\n')) {
    text = `---\ntags: [claude-chat]\nupdated: ${fallback.date}\nclaude_session: ${fallback.sessionId}\n---\n\n${text}`;
  }
  return `${text}\n`;
}
