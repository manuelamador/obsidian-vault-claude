// What goes with a message, and roughly how much of it: the @-mentions in its text, and sizes for
// the chips above the input. Kept free of `obsidian` imports so the tests can use it.

/** An `@[[…]]` mention: its target is the first group, before any heading or display text. */
const MENTION = /@\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

/** The targets of the `@[[…]]` mentions in `text`, in order: a note or file by its link text, a folder ending in `/`. */
export function mentionTargets(text: string): string[] {
  return [...text.matchAll(MENTION)].map((match) => match[1].trim());
}

/** `text` without the mentions whose target `drop` picks, each with the space after it. */
export function removeMentions(text: string, drop: (target: string) => boolean): string {
  return text.replace(new RegExp(`${MENTION.source}[ \\t]?`, 'g'), (whole, target: string) => (drop(target.trim()) ? '' : whole));
}

/** Tokens in `chars` characters of text, as a rough estimate: about four characters a token. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** `~2,400 tokens`: rounded, as an estimate should be. */
export function formatTokens(tokens: number): string {
  const step = tokens < 100 ? 10 : tokens < 10_000 ? 100 : 1000;
  const rounded = Math.max(step, Math.round(tokens / step) * step);
  return `~${rounded.toLocaleString('en-US')} tokens`;
}

/** `420 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
