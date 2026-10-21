// Markdown written by Claude (or quoting it), drawn outside the chat (Pick up's excerpts): filtered
// as replies are, rendered off the page and swept before it goes in, what comes later swept too (see
// safeMarkdown.ts); its links and file names open the note, and show its preview, as in the chat.
import { Keymap, MarkdownRenderer, type App, type Component } from 'obsidian';
import { linkFileNames } from './fileLinks';
import { previewKey } from './hoverPreview';
import { log } from './log';
import { neutralizeRemoteMedia, openableHref, sweepRemoteMedia } from './safeMarkdown';

/** What the links of drawn Markdown do. */
export interface DrawnLinks {
  /** The vault path a file name in it stands for (`Teaching.md`), or null. */
  resolve(name: string): string | null;
  /** Opens `linktext` (a link's target, or a vault path); `newTab` on ⌘-click. */
  open(linktext: string, newTab: boolean): void;
  /** Shows `linktext`'s preview, as hovering a link does. */
  preview(linktext: string, event: MouseEvent | KeyboardEvent, target: HTMLElement): void;
}

/**
 * Sweeps what is drawn under `root`, or changed there, after it was put in (an embed, another plugin's
 * post-processor) as it comes in (see sweepRemoteMedia). Returns what stops it.
 */
export function watchRemoteMedia(root: HTMLElement): () => void {
  const sweeper = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof Element) sweepRemoteMedia(record.target, true);
        continue;
      }
      for (const node of Array.from(record.addedNodes)) if (node instanceof Element && node.isConnected) sweepRemoteMedia(node);
    }
  });
  sweeper.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'data', 'style', 'href', 'xlink:href', 'background', 'poster'] });
  return () => sweeper.disconnect();
}

/**
 * Renders `markdown`, remote media turned into links (see neutralizeRemoteMedia), off the page and
 * sweeps it before it goes into `el`, so an inline style that would load something is gone before it
 * is ever applied; what is drawn later is moved in when the render is done, failed or not. The
 * promise is the render's own.
 */
export function renderOffPage(app: App, markdown: string, el: HTMLElement, component: Component): Promise<void> {
  const holder = createDiv();
  const rendering = MarkdownRenderer.render(app, neutralizeRemoteMedia(markdown), holder, '', component);
  const moveIn = () => {
    sweepRemoteMedia(holder);
    el.append(...Array.from(holder.childNodes));
  };
  moveIn();
  return rendering.finally(moveIn);
}

/** Draws `markdown` into `el`, loading nothing from outside this computer; its links work as `links` says. */
export async function renderSafely(app: App, markdown: string, el: HTMLElement, component: Component, links?: DrawnLinks): Promise<void> {
  el.addClass('markdown-rendered');
  const rendering = renderOffPage(app, markdown, el, component);
  // Drawn, or changed, after the render (an embed, another plugin): swept as it comes in, as in the panel.
  component.register(watchRemoteMedia(el));
  // A link to a script (javascript:, say) is not followed, as in the panel (see ChatView.onMessagesClick).
  component.registerDomEvent(el, 'click', (evt) => {
    const href = (evt.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a.external-link')?.getAttribute('href');
    if (href && !openableHref(href)) evt.preventDefault();
  });
  await rendering.catch((error: unknown) => log('rendering an excerpt failed', error));
  if (!links) return;
  linkFileNames(el, (name) => links.resolve(name));
  const target = (evt: Event) => (evt.target as HTMLElement | null)?.closest<HTMLElement>('a.internal-link, .vc-file-link[data-path]') ?? null;
  const linktext = (link: HTMLElement) => link.dataset.path ?? link.getAttribute('data-href') ?? link.getAttribute('href') ?? '';
  component.registerDomEvent(el, 'click', (evt) => {
    const link = target(evt);
    if (!link) return;
    evt.preventDefault();
    links.open(linktext(link), Keymap.isModEvent(evt) !== false);
  });
  // Over a link, with ⌘ held or pressed while there: its preview (see previewKey).
  let over: HTMLElement | null = null;
  const key = previewKey(el.ownerDocument, (evt) => over && links.preview(linktext(over), evt, over), () => !!over?.isConnected);
  component.register(key.stop);
  component.registerDomEvent(el, 'mouseover', (evt) => {
    over = target(evt);
    if (!over) return;
    links.preview(linktext(over), evt, over);
    key.start();
  });
  component.registerDomEvent(el, 'mouseout', (evt) => {
    if (!over || over.contains(evt.relatedTarget as Node | null)) return;
    over = null;
    key.stop();
  });
}
