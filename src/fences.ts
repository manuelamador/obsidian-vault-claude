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
