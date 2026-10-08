// Minimal stand-in for the `obsidian` module, enough to construct the chat panel and run its
// onOpen() in jsdom (scripts/panel-test.ts). Only what the panel touches while opening.

type Cls = string | string[] | undefined;
interface ElOptions {
  cls?: Cls;
  text?: string;
  attr?: Record<string, string>;
  value?: string;
  href?: string;
}

function applyOptions(el: HTMLElement, options?: ElOptions | string): void {
  if (!options) return;
  if (typeof options === 'string') {
    el.className = options;
    return;
  }
  if (options.cls) el.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls;
  if (options.text !== undefined) el.textContent = options.text;
  if (options.value !== undefined) (el as HTMLInputElement).value = options.value;
  if (options.href !== undefined) el.setAttribute('href', options.href);
  for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
}

/** Adds Obsidian's DOM helpers (createDiv, setText, toggleClass, …) to jsdom's prototypes. */
export function installDomHelpers(window: Window & typeof globalThis): void {
  const proto = window.Node.prototype as unknown as Record<string, unknown>;
  const el = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.createEl = function (this: Node, tag: string, options?: ElOptions | string) {
    const child = (this.ownerDocument ?? (this as Document)).createElement(tag);
    applyOptions(child, options);
    this.appendChild(child);
    return child;
  };
  proto.createDiv = function (this: Node, options?: ElOptions | string) {
    return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl('div', options);
  };
  proto.createSpan = function (this: Node, options?: ElOptions | string) {
    return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl('span', options);
  };
  proto.empty = function (this: Node) {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  proto.appendText = function (this: Node, text: string) {
    this.appendChild((this.ownerDocument ?? (this as Document)).createTextNode(text));
  };
  Object.defineProperty(proto, 'doc', { get(this: Node) { return this.ownerDocument ?? this; } });
  el.setText = function (this: HTMLElement, text: string) { this.textContent = text; };
  el.getText = function (this: HTMLElement) { return this.textContent ?? ''; };
  el.addClass = function (this: HTMLElement, ...c: string[]) { this.classList.add(...c); };
  el.removeClass = function (this: HTMLElement, ...c: string[]) { this.classList.remove(...c); };
  el.hasClass = function (this: HTMLElement, c: string) { return this.classList.contains(c); };
  el.toggleClass = function (this: HTMLElement, c: string, on: boolean) { this.classList.toggle(c, on); };
  el.setAttr = function (this: HTMLElement, k: string, v: string) { this.setAttribute(k, v); };
  el.hide = function (this: HTMLElement) { this.style.display = 'none'; };
  el.show = function (this: HTMLElement) { this.style.display = ''; };
  el.toggle = function (this: HTMLElement, on: boolean) { this.style.display = on ? '' : 'none'; };
  el.isShown = function (this: HTMLElement) { return this.style.display !== 'none'; };
  const w = window as unknown as Record<string, unknown>;
  w.createDiv = (options?: ElOptions) => { const d = window.document.createElement('div'); applyOptions(d, options); return d; };
  w.createFragment = (build: (frag: DocumentFragment) => void) => { const f = window.document.createDocumentFragment(); build(f); return f; };
  w.activeDocument = window.document;
}

export class Component {
  private children: Component[] = [];
  private cleanups: (() => void)[] = [];
  /** Loaded and not unloaded since, for tests of what a view unloads. */
  loaded = false;
  load(): void {
    this.loaded = true;
    this.onload();
    for (const child of this.children) child.load();
  }
  onload(): void {}
  unload(): void {
    this.loaded = false;
    for (const child of this.children) child.unload();
    for (const fn of this.cleanups) fn();
    this.onunload();
  }
  onunload(): void {}
  addChild<T extends Component>(child: T): T {
    this.children.push(child);
    child.load();
    return child;
  }
  removeChild<T extends Component>(child: T): T {
    this.children = this.children.filter((c) => c !== child);
    child.unload();
    return child;
  }
  register(fn: () => void): void {
    this.cleanups.push(fn);
  }
  registerEvent(): void {}
  registerInterval(id: number): number {
    // Cleared on unload, as Obsidian does; otherwise the timer keeps the test process alive.
    this.cleanups.push(() => clearInterval(id));
    return id;
  }
  registerDomEvent(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
  }
}

/** Properties Obsidian's ItemView sets in its constructor; a subclass field with one of these names overwrites them. */
export const ITEM_VIEW_PROPERTIES = ['app', 'leaf', 'containerEl', 'contentEl', 'headerEl', 'titleEl', 'titleContainerEl', 'titleParentEl', 'actionsEl', 'iconEl', 'navigation', 'icon', 'scope'];

/** Every view: the panel asks the workspace for the active one of this type, which is any. */
export class View extends Component {}

export class ItemView extends View {
  app: unknown;
  containerEl: HTMLElement;
  headerEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(public leaf: { app: unknown }) {
    super();
    this.app = leaf.app;
    this.containerEl = document.createElement('div');
    this.headerEl = this.containerEl.appendChild(document.createElement('div'));
    this.titleEl = this.headerEl.appendChild(document.createElement('div'));
    this.contentEl = this.containerEl.appendChild(document.createElement('div'));
    document.body.appendChild(this.containerEl);
  }
}

export class MarkdownView {}
export class TFile {}
export class TFolder {
  path = '';
}
export class FileSystemAdapter {}
export class Plugin extends Component {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {
  /** The modal opened last, so a test can answer it. */
  static last: Modal | null = null;
  /** As Obsidian's: where a modal draws its title and contents, for a test that draws one with onOpen. */
  titleEl = document.createElement('div');
  contentEl = document.createElement('div');
  constructor(public app?: unknown) {}
  open(): void {
    Modal.last = this;
  }
  onClose(): void {}
  /** As Obsidian's: closing runs onClose. */
  close(): void {
    this.onClose();
  }
}
export class SuggestModal<T> {
  /** Typing into it re-runs the query; a test counts those runs. */
  inputEl = { value: '', inputs: 0, dispatchEvent(): boolean { this.inputs += 1; return true; }, focus(): void {} };
  modalEl = document.createElement('div');
  /** Its keys, as registered, for a test to press. */
  scope = {
    keys: [] as { modifiers: string[]; key: string; run: (evt: unknown) => unknown }[],
    register(modifiers: string[], key: string, run: (evt: unknown) => unknown): void {
      this.keys.push({ modifiers, key, run });
    },
  };
  closed = false;
  constructor(public app: unknown) {}
  setPlaceholder(): void {}
  /** The hint line's keys, as last set. */
  instructions: { command: string; purpose: string }[] = [];
  /** Drawn as Obsidian draws them: a .prompt-instruction per key, its key in a .prompt-instruction-command. */
  setInstructions(instructions: { command: string; purpose: string }[]): void {
    this.instructions = instructions;
    this.modalEl.querySelector('.prompt-instructions')?.remove();
    const box = this.modalEl.appendChild(document.createElement('div'));
    box.className = 'prompt-instructions';
    for (const { command, purpose } of instructions) {
      const el = box.appendChild(document.createElement('div'));
      el.className = 'prompt-instruction';
      const key = el.appendChild(document.createElement('span'));
      key.className = 'prompt-instruction-command';
      key.textContent = command;
      el.appendChild(document.createElement('span')).textContent = purpose;
    }
  }
  close(): void {
    this.closed = true;
    this.onClose();
  }
  onClose(): void {}
  selectSuggestion(value: T, evt: unknown): void {
    this.close();
    (this as unknown as { onChooseSuggestion(value: T, evt: unknown): void }).onChooseSuggestion(value, evt);
  }
  /** The last one opened, for a test to choose from. */
  static last: SuggestModal<unknown> | null = null;
  open(): void {
    SuggestModal.last = this as SuggestModal<unknown>;
  }
  declare _t: T;
}
export class FuzzySuggestModal<T> extends SuggestModal<T> {}
/** A menu item that records what it was given, so a test can read a menu back. */
class MenuItem {
  title = '';
  label = false;
  checked: boolean | null = null;
  click: ((evt?: unknown) => unknown) | null = null;
  submenu: Menu | null = null;
  setTitle(title: string): this { this.title = title; return this; }
  setIcon(): this { return this; }
  setIsLabel(label: boolean): this { this.label = label; return this; }
  setDisabled(): this { return this; }
  setWarning(): this { return this; }
  setChecked(checked: boolean | null): this { this.checked = checked; return this; }
  onClick(click: (evt?: unknown) => unknown): this { this.click = click; return this; }
  setSubmenu(): Menu { this.submenu = new Menu(); return this.submenu; }
}
export class Menu {
  items: MenuItem[] = [];
  shown = false;
  /** The last menu shown, for tests. */
  static last: Menu | null = null;
  addItem(build?: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    build?.(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this { return this; }
  /** Where the menu was placed: at the pointer, or at a given position (under a button). */
  placed: 'pointer' | 'position' | null = null;
  showAtMouseEvent(): void { this.shown = true; this.placed = 'pointer'; Menu.last = this; }
  showAtPosition(): void { this.shown = true; this.placed = 'position'; Menu.last = this; }
}
export class Notice {
  constructor(public message: unknown) {
    console.log(`[Notice] ${typeof message === 'string' ? message : '(fragment)'}`);
  }
  hide(): void {}
}
export const Keymap = { isModEvent: () => false };
export class Scope {
  constructor(public parent?: unknown) {}
  register(): void {}
}
export const Platform = { isMacOS: true, isWin: false, isLinux: false };
/** JSON is YAML: enough for a test that reads back what it wrote. */
export function parseYaml(text: string): unknown {
  return JSON.parse(text);
}
export function stringifyYaml(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}
export const MarkdownRenderer = {
  /** The component the last render was given. */
  lastComponent: null as Component | null,
  render: async (_app: unknown, markdown: string, el: HTMLElement, _source?: string, component?: Component) => {
    MarkdownRenderer.lastComponent = component ?? null;
    el.textContent = markdown;
    // A renderer (or another plugin's post-processor) that draws a style loading something (a test's own marker).
    if (markdown === 'STYLED_BY_RENDERER') el.innerHTML = '<a style="background:url(https://evil.test/x)">t</a>';
    // A reply that is one bold phrase, drawn as Obsidian draws it.
    const bold = markdown.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      el.textContent = '';
      el.appendChild(el.ownerDocument.createElement('strong')).textContent = bold[1];
    }
    // Task list items, drawn as Obsidian does: <li class="task-list-item"><input class="task-list-item-checkbox">.
    const tasks = [...markdown.matchAll(/^\s*(?:>\s*)*[-*+] \[([ xX])\] (.*)$/gm)];
    if (tasks.length === 0) return;
    const list = el.appendChild(el.ownerDocument.createElement('ul'));
    for (const task of tasks) {
      const item = list.appendChild(el.ownerDocument.createElement('li'));
      item.className = 'task-list-item';
      const box = item.appendChild(el.ownerDocument.createElement('input'));
      box.type = 'checkbox';
      box.className = 'task-list-item-checkbox';
      box.checked = task[1] !== ' ';
      item.appendChild(el.ownerDocument.createTextNode(task[2]));
    }
  },
};
export function setIcon(el: HTMLElement, name: string): void {
  el.setAttribute('data-icon', name);
}
