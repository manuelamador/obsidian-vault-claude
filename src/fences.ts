// Fenced code blocks, as CommonMark reads them, for the passes over Markdown that leave code alone.

/**
 * The marker opening or closing a fenced code block on `line` (three or more backticks or tildes,
 * indented at most three spaces): a backtick fence's info string holds no backtick, so ```` ```x``` ````
 * is an inline code span, not a fence. Null when the line is none.
 */
export function fenceMarker(line: string): string | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  return match[1][0] === '`' && match[2].includes('`') ? null : match[1];
}

/** Whether `line` closes the block opened by `fence`: a marker of its kind, at least as long, and nothing after it. */
export function closesFence(line: string, fence: string): boolean {
  const marker = fenceMarker(line);
  return marker !== null && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker;
}

/** How many `>` quote marks open `line`, and the line without them. */
export function quoteMarks(line: string): { depth: number; bare: string } {
  const marks = /^(?: {0,3}>[ \t]?)+/.exec(line)?.[0] ?? '';
  return { depth: marks.split('>').length - 1, bare: line.slice(marks.length) };
}

/**
 * For each of `lines`, whether it is part of a fenced code block, its fences included. A fence in a
 * quote is one too; it ends with its quote (a line with fewer `>` marks), and inside a fence, a line
 * at another quote depth is content, a fence-like line included.
 */
export function fencedLines(lines: string[]): boolean[] {
  let fence: string | null = null;
  let quotes = 0;
  return lines.map((line) => {
    const { depth, bare } = quoteMarks(line);
    if (fence) {
      if (depth >= quotes) {
        if (depth === quotes && closesFence(bare, fence)) fence = null;
        return true;
      }
      fence = null;
    }
    const opening = fenceMarker(bare);
    if (!opening) return false;
    fence = opening;
    quotes = depth;
    return true;
  });
}
