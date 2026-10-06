// The chips that show what goes with a message: in the tray above an input, and in the message sent.
import { setIcon } from 'obsidian';
import { imageDataUrl, type Attachment } from './attachments';
import { lineRange, selectionLabel, type Chip } from './chatText';
import { estimateTokens, formatBytes, formatTokens } from './contextSize';

/** An attachment's chip, saying on hover what goes with the message for it. */
export function chipFor(attachment: Attachment): Chip {
  if (attachment.kind === 'image') {
    const bytes = Math.floor((attachment.data.length * 3) / 4);
    return { label: attachment.name, image: imageDataUrl(attachment), tooltip: `${attachment.name}: the image goes with the message (${formatBytes(bytes)})` };
  }
  if (attachment.kind === 'selection') {
    const label = selectionLabel(attachment.name, lineRange(attachment.fromLine, attachment.toLine));
    return { label, icon: 'text-select', tooltip: `${label}: the selected text goes with the message (${formatTokens(estimateTokens(attachment.text.length))})` };
  }
  return { label: attachment.name, tooltip: `${attachment.name}: only its path goes; Claude reads the file if it needs to` };
}

/** Draws `chip` into `parent`; with `onRemove`, it has an × that calls it. */
export function renderChip(parent: HTMLElement, chip: Chip, onRemove?: () => void): HTMLElement {
  const el = parent.createDiv({ cls: 'vc-chip', attr: { 'aria-label': chip.tooltip ?? chip.label } });
  if (chip.image) {
    el.createEl('img', { attr: { src: chip.image, alt: chip.label } });
    // An image is shown full size on a click (or Enter), over everything else.
    const image = chip.image;
    el.addClass('is-image');
    el.setAttr('role', 'button');
    el.setAttr('tabindex', '0');
    el.addEventListener('click', (evt) => {
      // Not also a click on the message it is in.
      evt.stopPropagation();
      showImage(image, chip.label, el);
    });
    el.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      evt.preventDefault();
      evt.stopPropagation();
      showImage(image, chip.label, el);
    });
  } else setIcon(el.createSpan({ cls: 'vc-chip-icon' }), chip.icon ?? 'file');
  el.createSpan({ cls: 'vc-chip-label', text: chip.label });
  if (chip.detail) el.createSpan({ cls: 'vc-chip-detail', text: chip.detail });
  if (onRemove) {
    const remove = el.createSpan({ cls: 'vc-chip-remove', text: '×', attr: { 'aria-label': `Remove ${chip.label}` } });
    remove.addEventListener('click', (evt) => {
      evt.stopPropagation();
      onRemove();
    });
  }
  return el;
}

/** The image shown full size, if one is: closing it takes it off and puts focus back. */
let shown: { close: () => void } | null = null;

/** Image `src` shown full size over the window, in place of one already shown; a click anywhere or Esc closes it. */
export function showImage(src: string, label: string, from?: HTMLElement): void {
  shown?.close();
  const doc = from?.ownerDocument ?? activeDocument;
  const backdrop = doc.body.createDiv({ cls: 'vc-image-preview', attr: { role: 'dialog', 'aria-label': label, tabindex: '-1' } });
  backdrop.createEl('img', { attr: { src, alt: label } });
  backdrop.createDiv({ cls: 'vc-image-preview-label', text: label });
  const onKey = (evt: KeyboardEvent) => {
    if (evt.key !== 'Escape') return;
    // Esc closes the image only, not the panel's reply or anything under it.
    evt.preventDefault();
    evt.stopPropagation();
    current.close();
  };
  const current = {
    close: () => {
      backdrop.remove();
      doc.removeEventListener('keydown', onKey, true);
      if (shown === current) shown = null;
      from?.focus();
    },
  };
  shown = current;
  backdrop.addEventListener('click', () => current.close());
  doc.addEventListener('keydown', onKey, true);
  backdrop.focus();
}

/** Closes the image shown full size, if any (its panel is closing). */
export function closeImage(): void {
  shown?.close();
}
