// Markdown written by Claude (or quoting it), drawn outside the chat (Pick up's excerpts): filtered
// as replies are, rendered off the page and swept before it goes in, what comes later swept too (see
// safeMarkdown.ts); its links and file names open the note, and show its preview, as in the chat.
import { Keymap, MarkdownRenderer, type App, type Component } from 'obsidian';
import { linkFileNames } from './fileLinks';
import { log } from './log';
import { neutralizeRemoteMedia, sweepRemoteMedia } from './safeMarkdown';

/** What the links of drawn Markdown do. */
export interface DrawnLinks {
  /** The vault path a file name in it stands for (`Teaching.md`), or null. */
  resolve(name: string): string | null;
  /** Opens `linktext` (a link's target, or a vault path); `newTab` on ⌘-click. */
  open(linktext: string, newTab: boolean): void;
  /** Shows `linktext`'s preview, as hovering a link does. */
  preview(linktext: string, event: MouseEvent | KeyboardEvent, target: HTMLElement): void;
}

/** Draws `markdown` into `el`, loading nothing from outside this computer; its links work as `links` says. */
export async function renderSafely(app: App, markdown: string, el: HTMLElement, component: Component, links?: DrawnLinks): Promise<void> {
  el.addClass('markdown-rendered');
  const holder = createDiv();
  const moveIn = () => {
    sweepRemoteMedia(holder);
    el.append(...Array.from(holder.childNodes));
  };
  const rendering = MarkdownRenderer.render(app, neutralizeRemoteMedia(markdown), holder, '', component);
  moveIn();
  // Drawn, or changed, after the render (an embed, another plugin): swept as it comes in, as in the panel.
  const sweeper = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof Element) sweepRemoteMedia(record.target, true);
        continue;
      }
      for (const node of Array.from(record.addedNodes)) if (node instanceof Element && node.isConnected) sweepRemoteMedia(node);
    }
  });
  sweeper.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'data', 'style', 'href', 'xlink:href', 'background', 'poster'] });
  component.register(() => sweeper.disconnect());
  await rendering.catch((error: unknown) => log('rendering an excerpt failed', error)).finally(moveIn);
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
  // Over a link, with ⌘ held or pressed while there: its preview. The key is listened for only while
  // over one, and no longer once the excerpt is drawn away under the pointer, which no mouseout says.
  let over: HTMLElement | null = null;
  const doc = el.ownerDocument;
  const key = (evt: KeyboardEvent) => {
    if (!over || !over.isConnected) return stop();
    if (evt.key === 'Meta' || evt.key === 'Control') links.preview(linktext(over), evt, over);
  };
  const stop = () => doc.removeEventListener('keydown', key);
  component.register(stop);
  component.registerDomEvent(el, 'mouseover', (evt) => {
    over = target(evt);
    if (!over) return;
    links.preview(linktext(over), evt, over);
    doc.addEventListener('keydown', key);
  });
  component.registerDomEvent(el, 'mouseout', (evt) => {
    if (!over || over.contains(evt.relatedTarget as Node | null)) return;
    over = null;
    stop();
  });
}
