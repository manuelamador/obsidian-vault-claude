// Obsidian's page preview for what the pointer is over, shown when it gets there and again when ⌘
// (Ctrl elsewhere) is pressed while it is there, as over a link in a note. Used by the drawn excerpts
// (see safeRender.ts), Pick up's note names and the connections map's nodes.

/**
 * ⌘ or Ctrl pressed in `doc`: `show` called, while `still()` says the pointer is over what it shows.
 * The key is listened for only between start() and stop(), and no longer once `still()` is false, as
 * when what was pointed at is drawn away under the pointer, which no mouseout or mouseleave says.
 */
export function previewKey(doc: Document, show: (evt: KeyboardEvent) => void, still: () => boolean): { start(): void; stop(): void } {
  const key = (evt: KeyboardEvent) => {
    if (!still()) return stop();
    if (evt.key === 'Meta' || evt.key === 'Control') show(evt);
  };
  const stop = () => doc.removeEventListener('keydown', key);
  return { start: () => doc.addEventListener('keydown', key), stop };
}

/**
 * Shows the preview for `el` once per entry, and when ⌘ is pressed while over it. Not on every
 * mouseover: those repeat as the pointer crosses the element's parts, and each preview asked for
 * replaces the one open, which then showed and went away. Returns what stops listening for the key.
 */
export function previewOnHover(el: Element, show: (evt: MouseEvent | KeyboardEvent) => void): () => void {
  const key = previewKey(el.ownerDocument, show, () => el.isConnected);
  el.addEventListener('mouseenter', (evt) => {
    show(evt as MouseEvent);
    key.start();
  });
  el.addEventListener('mouseleave', () => key.stop());
  return key.stop;
}
