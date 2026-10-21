// File names in replies: bold or code text that names a file in the vault becomes a link to it, and a
// full path to a file outside it a link the system opens (see diskPath).
import * as nodePath from 'path';

/**
 * Makes bold and code text in rendered Markdown that is exactly the name or path of a file in the
 * vault a link to it, as file names in tool lines are (`vc-file-link`, opened by the panel);
 * `resolve` gives the vault path a name stands for, or null. Only text ending in a file extension
 * is looked up, and none inside a link or a code block.
 */
export function linkFileNames(el: HTMLElement, resolve: (name: string) => string | null, outside?: (name: string) => string | null): void {
  for (const node of Array.from(el.querySelectorAll<HTMLElement>('strong, code'))) {
    // Inside bold made a link already, `**`name.md`**`, it is part of that link.
    if (node.closest('a, pre, .vc-file-link')) continue;
    const name = node.textContent?.trim() ?? '';
    if (name.includes('\n') || !/\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(name)) continue;
    // A full path to a file outside the vault: opened as a file by the system (data-file), not as a note.
    const file = outside?.(name);
    if (file) {
      node.classList.add('vc-file-link');
      node.dataset.file = file;
      continue;
    }
    const path = resolve(name);
    if (!path) continue;
    node.classList.add('vc-file-link');
    node.dataset.path = path;
  }
}

/**
 * What a link or a name that is a full path on disk stands for: `vault`, its path in the vault when it
 * is inside it; `file`, the path itself when it is outside (where Obsidian would make an empty note
 * of that name). Null for anything else, a note's name or a relative path, which open as notes do.
 * `~/` is the home folder; a trailing `:line` or `:line:column` is dropped.
 */
export function diskPath(href: string, vaultRoot: string, home: string, paths: typeof nodePath = nodePath): { vault: string } | { file: string } | null {
  let text = href.trim();
  try {
    text = decodeURI(text);
  } catch {
    // Not percent-encoded as a URI: taken as it is.
  }
  if (text.startsWith('~/')) text = paths.join(home, text.slice(2));
  if (!paths.isAbsolute(text)) return null;
  text = text.replace(/:\d+(?::\d+)?$/, '');
  const relative = vaultRoot ? paths.relative(vaultRoot, text) : '';
  if (vaultRoot && relative && !relative.startsWith('..') && !paths.isAbsolute(relative)) return { vault: relative.split(paths.sep).join('/') };
  return { file: text };
}
