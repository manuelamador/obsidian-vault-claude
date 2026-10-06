// A short message shown for a moment just above an input, saying what was put in it.

/** The hint shown above each input, and when it goes. */
const shown = new WeakMap<HTMLElement, { el: HTMLElement; timer: number }>();

/** Shows `text` for a moment just above `input`, at its right edge; a newer one replaces it. */
export function hintAbove(input: HTMLElement, text: string, ms = 2500): void {
  const parent = input.offsetParent instanceof HTMLElement ? input.offsetParent : input.parentElement;
  if (!parent) return;
  const before = shown.get(input);
  if (before) window.clearTimeout(before.timer);
  const el = before?.el ?? parent.createDiv({ cls: 'vc-input-hint' });
  el.setText(text);
  el.style.right = `${parent.clientWidth - (input.offsetLeft + input.offsetWidth)}px`;
  el.style.bottom = `${parent.clientHeight - input.offsetTop + 4}px`;
  const timer = window.setTimeout(() => {
    el.remove();
    shown.delete(input);
  }, ms);
  shown.set(input, { el, timer });
}
