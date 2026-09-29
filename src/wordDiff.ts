export interface DiffPart {
  type: 'same' | 'del' | 'ins';
  text: string;
}

/** Largest token grid diffed exactly; past it the changed middle shows as one deletion and one insertion. */
const MAX_CELLS = 4_000_000;

/**
 * Aligns two token lists: the common prefix and suffix are split off first, and the changed
 * middle is aligned by longest common subsequence. `emit` receives every token, in order.
 */
function alignTokens(x: string[], y: string[], emit: (type: DiffPart['type'], token: string) => void): void {
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start += 1;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX -= 1;
    endY -= 1;
  }
  for (let k = 0; k < start; k += 1) emit('same', x[k]);

  const mx = x.slice(start, endX);
  const my = y.slice(start, endY);
  const n = mx.length;
  const m = my.length;
  if (n * m > MAX_CELLS) {
    for (const token of mx) emit('del', token);
    for (const token of my) emit('ins', token);
  } else {
    // lcs[i(m+1) + j]: length of the longest common subsequence of mx[i..] and my[j..].
    const lcs = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[at(i, j)] = mx[i] === my[j] ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (mx[i] === my[j]) {
        emit('same', mx[i]);
        i += 1;
        j += 1;
      } else if (lcs[at(i + 1, j)] >= lcs[at(i, j + 1)]) {
        emit('del', mx[i]);
        i += 1;
      } else {
        emit('ins', my[j]);
        j += 1;
      }
    }
    while (i < n) emit('del', mx[i++]);
    while (j < m) emit('ins', my[j++]);
  }

  for (let k = endX; k < x.length; k += 1) emit('same', x[k]);
}

/**
 * Word-level diff of `a` into `b`. Words and runs of whitespace are separate tokens. Joining the
 * `same` and `del` parts gives `a`; joining `same` and `ins` gives `b`.
 */
export function wordDiff(a: string, b: string): DiffPart[] {
  const parts: DiffPart[] = [];
  alignTokens(a.match(/\s+|\S+/g) ?? [], b.match(/\s+|\S+/g) ?? [], (type, text) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  });
  return parts;
}

/** Line-level diff of `a` into `b`: one part per line, without the line breaks. */
export function lineDiff(a: string, b: string): DiffPart[] {
  const lines = (text: string) => (text === '' ? [] : text.split('\n'));
  const parts: DiffPart[] = [];
  alignTokens(lines(a), lines(b), (type, text) => parts.push({ type, text }));
  return parts;
}
