// Todos made from the chat (an email card's "Make a todo"): a checkbox line in the Tasks plugin's
// format, added to the end of a section of the todo note set in the settings. Kept free of
// `obsidian` imports so the tests can use it.
import { sectionBounds } from './memos';

/** A todo line: its text, then its due date in the Tasks plugin's form (`📅 YYYY-MM-DD`), when given. */
export function todoLine(text: string, due?: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return `- [ ] ${clean}${due ? ` 📅 ${due}` : ''}`;
}

/** Whether `value` is a date as the Tasks plugin writes one: YYYY-MM-DD. */
export function isTaskDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * `note` with `line` added at the end of section `heading` (a `## ` heading), after its last line
 * that is not blank; at the end of the note, under a new section, when it has none.
 */
export function withTodo(note: string, line: string, heading: string): string {
  const section = sectionBounds(note, heading);
  if (!section) return `${note.replace(/\s*$/, '')}${note.trim() ? '\n\n' : ''}## ${heading}\n\n${line}\n`;
  const body = note.slice(section.body, section.end);
  const kept = body.replace(/\s*$/, '');
  const at = section.body + kept.length;
  const rest = note.slice(section.end);
  return `${note.slice(0, at)}\n${line}\n${rest ? `\n${rest.replace(/^\s*/, '')}` : ''}`;
}
