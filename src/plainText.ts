// Deciding whether a block of a reply needs Obsidian's Markdown renderer. Kept free of `obsidian`
// imports so the tests can use it.

/** None of Markdown's markers, and nothing Obsidian turns into a link: a paragraph is just text. */
const MARKDOWN_MARKER = /[<>*_`~#$[\]|\\]|(?:^|[\s(])(?:https?:\/\/|www\.)|^\s*(?:[-+>]|\d+[.)])\s|^\s*-{3,}\s*$|[^\n]\n(?!\n)/m;

/** Past this length a block is worth the renderer's own paragraph handling. */
const MAX_PLAIN = 4000;

export function isPlainText(text: string): boolean {
  return text.length <= MAX_PLAIN && !MARKDOWN_MARKER.test(text);
}

/**
 * Obsidian's Markdown renderer builds a preview component for every block it renders, which costs
 * far more than a sentence between two tool calls is worth: a long reply spends seconds of the main
 * thread there. Text with no Markdown in it is written as paragraphs directly; everything else is
 * left to the renderer, which alone knows wikilinks, math, callouts and the rest. Returns whether
 * it wrote the text.
 */
export function renderPlainText(text: string, el: HTMLElement): boolean {
  if (!isPlainText(text)) return false;
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (trimmed) el.createEl('p', { text: trimmed });
  }
  return true;
}
