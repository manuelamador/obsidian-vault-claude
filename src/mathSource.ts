// Equations in the chat keep their LaTeX, so a quote can carry it instead of the glyphs MathJax
// drew. Kept free of `obsidian` imports so the tests can use it.

/**
 * Obsidian's parser leaves each equation's LaTeX as the text of its `.math` span; its math step
 * then empties the span and draws the equation, keeping the source only in a map of its own. Run
 * before that step, this copies the text into `data-tex`, where the quote can find it. A span
 * already drawn (`is-loaded`) has no source left, and is skipped rather than given the drawing.
 */
export function saveMathSource(el: HTMLElement): void {
  const spans = el.matches('.math') ? [el] : Array.from(el.querySelectorAll<HTMLElement>('.math'));
  for (const span of spans) {
    if (span.classList.contains('is-loaded') || span.dataset.tex !== undefined) continue;
    span.dataset.tex = span.textContent ?? '';
  }
}

/** Where plain text breaks: a blank line after a paragraph and the like, a line after a list item or row. */
const PARAGRAPH = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE', 'DIV']);
const LINE = new Set(['LI', 'TR']);

/**
 * The selected text with its equations as `$…$`, or `$$…$$` on lines of their own, taking in the
 * whole of an equation the selection starts or ends inside. Null when it holds no saved equation,
 * so the caller keeps the browser's own text for it.
 */
export function selectionWithMath(range: Range): string | null {
  const whole = range.cloneRange();
  const equationAt = (node: Node) => (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>('.math[data-tex]');
  const startsIn = equationAt(whole.startContainer);
  if (startsIn) whole.setStartBefore(startsIn);
  const endsIn = equationAt(whole.endContainer);
  if (endsIn) whole.setEndAfter(endsIn);
  const fragment = whole.cloneContents();
  const equations = Array.from(fragment.querySelectorAll<HTMLElement>('.math[data-tex]'));
  if (equations.length === 0) return null;
  for (const equation of equations) {
    const tex = (equation.dataset.tex ?? '').trim();
    equation.replaceWith(equation.classList.contains('math-block') ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`);
  }
  for (const el of Array.from(fragment.querySelectorAll('*'))) {
    if (el.tagName === 'BR') el.replaceWith('\n');
    else if (LINE.has(el.tagName)) el.after('\n');
    else if (PARAGRAPH.has(el.tagName)) el.after('\n\n');
  }
  return (fragment.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
