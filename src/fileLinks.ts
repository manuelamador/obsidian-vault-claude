// File names in replies: bold or code text that names a file in the vault becomes a link to it.

/**
 * Makes bold and code text in rendered Markdown that is exactly the name or path of a file in the
 * vault a link to it, as file names in tool lines are (`vc-file-link`, opened by the panel);
 * `resolve` gives the vault path a name stands for, or null. Only text ending in a file extension
 * is looked up, and none inside a link or a code block.
 */
export function linkFileNames(el: HTMLElement, resolve: (name: string) => string | null): void {
  for (const node of Array.from(el.querySelectorAll<HTMLElement>('strong, code'))) {
    // Inside bold made a link already, `**`name.md`**`, it is part of that link.
    if (node.closest('a, pre, .vc-file-link')) continue;
    const name = node.textContent?.trim() ?? '';
    if (name.includes('\n') || !/\.[A-Za-z0-9]{1,8}$/.test(name)) continue;
    const path = resolve(name);
    if (!path) continue;
    node.classList.add('vc-file-link');
    node.dataset.path = path;
  }
}
