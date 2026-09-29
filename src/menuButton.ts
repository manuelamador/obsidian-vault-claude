import { Menu, setIcon } from 'obsidian';

interface MenuOption {
  value: string;
  /** Shown in the menu. */
  label: string;
  /** Shown on the button. */
  short: string;
}

/**
 * A compact control in place of a <select>, which always shows the chosen option's full
 * text: the button shows a short label, and opens a menu of the full labels with the current one
 * checked. Its tooltip is `name: full label`, or the detail set with setTooltip.
 */
export class MenuButton {
  readonly el: HTMLButtonElement;
  private readonly labelEl: HTMLElement;
  private options: MenuOption[] = [];
  private current = '';
  private detail: string | null = null;

  constructor(
    parent: HTMLElement,
    private readonly name: string,
    private readonly onChange: (value: string) => void,
  ) {
    this.el = parent.createEl('button', { cls: 'vc-menu-button' });
    this.labelEl = this.el.createSpan({ cls: 'vc-menu-button-label' });
    setIcon(this.el.createSpan({ cls: 'vc-menu-button-chevron' }), 'chevron-down');
    this.el.addEventListener('click', (evt) => this.open(evt));
    this.render();
  }

  clear(): void {
    this.options = [];
    this.render();
  }

  add(value: string, label: string, short = label): void {
    this.options.push({ value, label, short });
    this.render();
  }

  get value(): string {
    return this.current;
  }

  set value(value: string) {
    this.current = value;
    this.render();
  }

  set disabled(disabled: boolean) {
    this.el.disabled = disabled;
  }

  /** What the tooltip says instead of `name: full label`, e.g. what the session is running. */
  setTooltip(detail: string): void {
    this.detail = detail;
    this.render();
  }

  private selected(): MenuOption | undefined {
    return this.options.find((option) => option.value === this.current) ?? this.options[0];
  }

  private render(): void {
    const option = this.selected();
    this.labelEl.setText(option?.short ?? '');
    this.el.setAttr('aria-label', this.detail ?? (option ? `${this.name}: ${option.label}` : this.name));
  }

  private open(evt: MouseEvent): void {
    if (this.el.disabled || this.options.length === 0) return;
    const current = this.selected()?.value;
    const menu = new Menu();
    for (const option of this.options) {
      menu.addItem((item) =>
        item
          .setTitle(option.label)
          .setChecked(option.value === current)
          .onClick(() => {
            if (option.value === current) return;
            this.value = option.value;
            this.onChange(option.value);
          }),
      );
    }
    menu.showAtMouseEvent(evt);
  }
}
