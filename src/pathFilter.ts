/**
 * Vault paths left out of the notes a chat lists: everything that is not a note (`.md`), plus the
 * paths matching the patterns in the settings — one per line, `*` standing for any characters and
 * `#` starting a comment. A pattern matches the whole path.
 */
export function hiddenPaths(patterns: string): (path: string) => boolean {
  const rules = patterns
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => new RegExp(`^${line.split('*').map(escapeRegExp).join('.*')}$`, 'i'));
  return (path: string) => !/\.md$/i.test(path) || rules.some((rule) => rule.test(path));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
