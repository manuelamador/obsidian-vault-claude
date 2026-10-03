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
  if (chip.image) el.createEl('img', { attr: { src: chip.image, alt: chip.label } });
  else setIcon(el.createSpan({ cls: 'vc-chip-icon' }), chip.icon ?? 'file');
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
