// The chips that show what goes with a message: in the tray above an input, and in the message sent.
import { setIcon } from 'obsidian';
import { imageDataUrl, type Attachment } from './attachments';
import { lineRange, selectionLabel, type Chip } from './chatText';

export function chipFor(attachment: Attachment): Chip {
  if (attachment.kind === 'image') return { label: attachment.name, image: imageDataUrl(attachment) };
  if (attachment.kind === 'selection') {
    return { label: selectionLabel(attachment.name, lineRange(attachment.fromLine, attachment.toLine)), icon: 'text-select' };
  }
  return { label: attachment.name };
}

/** Draws `chip` into `parent`; with `onRemove`, it has an × that calls it. */
export function renderChip(parent: HTMLElement, chip: Chip, onRemove?: () => void): void {
  const el = parent.createDiv({ cls: 'vc-chip', attr: { title: chip.label } });
  if (chip.image) el.createEl('img', { attr: { src: chip.image, alt: chip.label } });
  else setIcon(el.createSpan({ cls: 'vc-chip-icon' }), chip.icon ?? 'file');
  el.createSpan({ cls: 'vc-chip-label', text: chip.label });
  if (onRemove) {
    const remove = el.createSpan({ cls: 'vc-chip-remove', text: '×', attr: { 'aria-label': `Remove ${chip.label}` } });
    remove.addEventListener('click', onRemove);
  }
}
