/**
 * Folds `box` (class `is-collapsed`) and adds a link at its end that unfolds it and then reads
 * "Show less". The link's `data-expand` lets find in chat unfold the box to show a match inside it.
 */
export function addFoldToggle(box: HTMLElement, cls: string, label: string): void {
  box.addClass('is-collapsed');
  const toggle = box.createEl('button', { cls, text: label, attr: { 'data-expand': '' } });
  toggle.addEventListener('click', () => {
    const collapse = !box.hasClass('is-collapsed');
    box.toggleClass('is-collapsed', collapse);
    toggle.setText(collapse ? label : 'Show less');
  });
}
