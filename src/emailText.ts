// Small text helpers shared by the Gmail adapter, the message parser and the cards. Each scan is
// linear in its input: an email's HTML is the sender's, and a regex that rescans from every `<` of a
// long run of unclosed tags (`<a<a<a…`) would freeze the panel.

/** `value` if it is a string, else empty. */
export const stringValue = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `text` on one line: every run of whitespace, line breaks included, as one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `text` cut at `max` characters, with `…` added where it was cut. */
export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * `text` without its tags, each from a `<` to the first `>` after it (as `<[^>]*>` matches); with
 * `letterTags`, only those whose `<` starts a tag name (`<b`, `</b`), so `a < b` stays. A `<` with no
 * `>` after it is left as written.
 */
export function stripTags(text: string, letterTags = false): string {
  let out = '';
  let from = 0;
  let close = -1;
  for (let open = text.indexOf('<'); open !== -1; open = text.indexOf('<', open + 1)) {
    if (letterTags && !/^<\/?[A-Za-z]/.test(text.slice(open, open + 3))) continue;
    if (close < open) close = text.indexOf('>', open);
    // No `>` after this `<`, so none after any later one either.
    if (close === -1) break;
    out += text.slice(from, open);
    from = close + 1;
    open = close;
  }
  return out + text.slice(from);
}

/**
 * `text` without its `<script>` and `<style>` elements, contents and all. An element never closed
 * loses only its opening tag (which stripTags would take anyway), its contents staying as text.
 */
export function dropScripts(text: string): string {
  const opening = /<(script|style)\b/gi;
  const unclosed = new Set<string>();
  let out = '';
  let from = 0;
  let end = -1;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const name = match[1].toLowerCase();
    if (unclosed.has(name)) continue;
    if (end < opening.lastIndex) end = text.indexOf('>', opening.lastIndex);
    if (end === -1) break;
    const closing = new RegExp(`<\\/${name}\\s*>`, 'gi');
    closing.lastIndex = end + 1;
    const found = closing.exec(text);
    // Searched to the end once: no later element of this name is closed either.
    if (!found) { unclosed.add(name); continue; }
    out += text.slice(from, match.index);
    from = opening.lastIndex = closing.lastIndex;
  }
  return out + text.slice(from);
}

/** The files among MIME part `payload`'s parts, however deep (to twenty levels): each part with a filename, and its type. */
export function mimeFiles(payload: unknown): { name: string; type: string }[] {
  const found: { name: string; type: string }[] = [];
  const walk = (part: unknown, depth: number): void => {
    if (depth > 20 || !part || typeof part !== 'object') return;
    const { filename, mime_type: type, parts } = part as { filename?: unknown; mime_type?: unknown; parts?: unknown };
    if (typeof filename === 'string' && filename) found.push({ name: filename, type: stringValue(type) });
    if (Array.isArray(parts)) for (const child of parts) walk(child, depth + 1);
  };
  walk(payload, 0);
  return found;
}
