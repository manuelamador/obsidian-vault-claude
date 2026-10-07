// The dialogs of projects (see projects.ts): making one of a folder, what a chat's projects send with
// it, and adding to a project's Guide from its chats after reviewing what Claude proposes.
import { Component, FuzzySuggestModal, Modal, setIcon, type App } from 'obsidian';
import { estimateTokens, formatTokens } from './contextSize';
import { errorText } from './log';
import { folderOf, type FolderSuggestion } from './chatFolders';
import type { GuideProposal } from './projects';

/** A project as the dialogs show it. */
export interface ProjectRef {
  path: string;
  name: string;
}

/** Picks a project from those in the vault. */
export class ProjectPicker extends FuzzySuggestModal<ProjectRef> {
  constructor(app: App, private readonly projects: ProjectRef[], placeholder: string, private readonly chosen: (project: ProjectRef) => void) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): ProjectRef[] {
    return this.projects;
  }

  getItemText(project: ProjectRef): string {
    return project.name;
  }

  onChooseItem(project: ProjectRef): void {
    this.chosen(project);
  }
}

/** A chat offered in a list of chats. */
export interface ChatChoice {
  id: string;
  title: string;
  /** When it was last active, as shown. */
  when: string;
  ticked: boolean;
}

/** A list of chats with a box each, and a filter above it when long. The ids ticked, in the list's order. */
function chatChecklist(el: HTMLElement, chats: ChatChoice[], changed: () => void): () => string[] {
  const ticked = new Set(chats.filter((chat) => chat.ticked).map((chat) => chat.id));
  const filter = chats.length > 8 ? el.createEl('input', { type: 'search', cls: 'vc-project-filter', attr: { placeholder: 'Filter chats' } }) : null;
  const list = el.createDiv({ cls: 'vc-project-chats' });
  const rows = chats.map((chat) => {
    const row = list.createEl('label', { cls: 'vc-project-chat' });
    const box = row.createEl('input', { type: 'checkbox' });
    box.checked = ticked.has(chat.id);
    box.addEventListener('change', () => {
      if (box.checked) ticked.add(chat.id);
      else ticked.delete(chat.id);
      changed();
    });
    const text = row.createDiv({ cls: 'vc-project-chat-text' });
    text.createDiv({ cls: 'vc-project-chat-title', text: chat.title });
    text.createDiv({ cls: 'vc-project-chat-when', text: chat.when });
    return { row, title: chat.title.toLowerCase() };
  });
  filter?.addEventListener('input', () => {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const { row, title } of rows) row.toggle(words.every((word) => title.includes(word)));
  });
  return () => chats.map((chat) => chat.id).filter((id) => ticked.has(id));
}

export interface CreateProjectHost {
  /** Folders of the vault that may be projects. */
  folders: string[];
  /** The folder chosen to start with (from the history's folders view). */
  folder?: string;
  /** The folder the chat it is made for suggests (see suggestFolder). */
  suggestion: FolderSuggestion | null;
  /** How many chats worked on notes in a folder, and when the latest was last active. */
  preview(folder: string): { count: number; latest: string };
  /** The project a folder is already, if any. */
  projectOf(folder: string): string | null;
  /** Makes it; false when it could not be (said in a notice). */
  create(name: string, folder: string): Promise<boolean>;
  /** Why a project note cannot be called `name` (note names are unique in the vault), or null. */
  nameProblem(name: string): string | null;
  /** A free name for the project of folder `folder`: `Claude Project — <folder's name>`, numbered when taken. */
  defaultName(folder: string): string;
}

/**
 * Makes a project of a folder, chosen in a browser of the vault's folders: the chats that work on its
 * notes are its chats. Its name starts as the folder's.
 */
export class CreateProjectModal extends Modal {
  constructor(app: App, private readonly host: CreateProjectHost) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('vc-project-modal');
    this.setTitle('Create project');
    const { contentEl, host } = this;
    contentEl.createDiv({ cls: 'vc-project-label', text: 'A project is a folder: chats that work on its notes are its chats, and its Instructions and Guide go with them.' });
    let chosen = '';
    // The name follows the folder until it is typed in.
    let named = false;
    const name = contentEl.createEl('input', { type: 'text', cls: 'vc-project-name', attr: { placeholder: 'Project name' } });
    const nameHint = contentEl.createDiv({ cls: 'vc-project-suggest vc-project-problem' });
    name.addEventListener('input', () => {
      named = name.value.trim() !== '';
      update();
    });
    const shownFolder = contentEl.createDiv({ cls: 'vc-project-folder' });
    const hint = contentEl.createDiv({ cls: 'vc-project-suggest' });
    const browser = contentEl.createDiv({ cls: 'vc-project-browser' });
    const foot = contentEl.createDiv({ cls: 'vc-project-foot' });
    const button = foot.createEl('button', { cls: 'mod-cta', text: 'Create' });
    const taken = () => (chosen ? host.projectOf(chosen) : null);
    const update = () => {
      const problem = name.value.trim() ? host.nameProblem(name.value) : null;
      nameHint.setText(problem ?? '');
      nameHint.toggle(problem !== null);
      button.disabled = !chosen || !name.value.trim() || taken() !== null || problem !== null;
    };
    const choose = (folder: string) => {
      chosen = folder;
      if (!named) name.value = host.defaultName(folder);
      showFolder();
      browseAt(folder);
      update();
    };
    // The folder chosen, with how many chats worked on its notes; or the folder the chat suggests.
    const showFolder = () => {
      shownFolder.empty();
      hint.empty();
      setIcon(shownFolder.createSpan({ cls: 'vc-project-group-icon' }), chosen ? 'folder' : 'folder-x');
      shownFolder.createSpan({ cls: chosen ? 'vc-project-folder-path' : 'vc-project-empty', text: chosen || 'No folder chosen: choose one below' });
      if (chosen) {
        const project = taken();
        const { count, latest } = host.preview(chosen);
        hint.setText(project ? `This folder is the project “${project}” already.` : count === 0 ? 'No chats have worked on its notes yet.' : `${count} chat${count === 1 ? ' has' : 's have'} worked on its notes, the latest on ${latest}.`);
      } else if (host.suggestion) {
        const { folder, count, total } = host.suggestion;
        hint.appendText('Suggested by this chat\'s notes: ');
        hint.createEl('code', { text: folder });
        hint.appendText(` — ${count} of its ${total} notes · `);
        hint.createEl('a', { text: 'Use' }).addEventListener('click', () => choose(folder));
      }
    };
    // The browser at `at`: the path to it, each part going back there; Choose this folder; the folders in it.
    const browseAt = (at: string) => {
      browser.empty();
      const crumbs = browser.createDiv({ cls: 'vc-project-crumbs' });
      const parts = at ? at.split('/') : [];
      const crumb = (label: string, path: string, last: boolean) => {
        const el = crumbs.createEl(last ? 'span' : 'a', { text: label });
        if (!last) el.addEventListener('click', () => browseAt(path));
      };
      crumb('Vault', '', parts.length === 0);
      parts.forEach((part, i) => {
        crumbs.appendText(' › ');
        crumb(part, parts.slice(0, i + 1).join('/'), i === parts.length - 1);
      });
      if (at && at !== chosen) crumbs.createEl('button', { cls: 'mod-cta', text: 'Choose this folder' }).addEventListener('click', () => choose(at));
      const children = host.folders.filter((folder) => folderOf(folder) === at);
      const rows = browser.createDiv({ cls: 'vc-project-browser-rows' });
      if (children.length === 0) rows.createDiv({ cls: 'vc-project-empty', text: 'No folders in it.' });
      for (const child of children) {
        const row = rows.createDiv({ cls: 'vc-project-browser-row' });
        const project = host.projectOf(child);
        setIcon(row.createSpan({ cls: 'vc-project-group-icon' }), project ? 'folder-kanban' : 'folder');
        row.createSpan({ text: child.slice(child.lastIndexOf('/') + 1) });
        const { count } = host.preview(child);
        const detail = [project ? 'project' : '', count > 0 ? `${count} chat${count === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
        if (detail) row.createSpan({ cls: 'vc-project-size', text: detail });
        if (host.folders.some((folder) => folderOf(folder) === child)) setIcon(row.createSpan({ cls: 'vc-project-group-icon vc-project-into' }), 'chevron-right');
        row.addEventListener('click', () => browseAt(child));
      }
    };
    button.addEventListener('click', async () => {
      button.disabled = true;
      if (await host.create(name.value.trim(), chosen)) this.close();
      else update();
    });
    if (host.folder) choose(host.folder);
    else {
      showFolder();
      browseAt(host.suggestion ? folderOf(host.suggestion.folder) : '');
    }
    update();
    window.setTimeout(() => name.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** What a chat's projects send with it, and the choices about it. */
export interface ChatProjectHost {
  /** Whether the chat has started (has an id): connections need one. */
  started: boolean;
  home(): ProjectRef | null;
  /** The projects this chat is connected to. */
  connections(): ProjectRef[];
  projects(): ProjectRef[];
  parts(path: string): Promise<{ instructions: string; guide: string }>;
  /** Whether the home Guide goes; which connected projects' Guides go; which projects' context went already. */
  includeGuide(): boolean;
  setIncludeGuide(on: boolean): void;
  usesGuide(path: string): boolean;
  setUsesGuide(path: string, on: boolean): void;
  sent(path: string): boolean;
  /** Whether a project's Instructions or Guide changed since they went with the chat. */
  updated(path: string): boolean;
  sendAgain(path: string): void;
  setHome(path: string | null): Promise<void>;
  /** Why the chat is in its home project, in a few words (see homeOf). */
  homeWhy(): string;
  /** Shows a project's map (see ProjectMapModal). */
  openMap(path: string): void;
  /** The projects holding a project's folder, the outermost first, whose Instructions go too. */
  parents(path: string): string[];
  connect(path: string, on: boolean): Promise<void>;
  createProject(): void;
  open(path: string): void;
  render(markdown: string, el: HTMLElement, component: Component): Promise<void>;
}

/** Shows what goes with the next message from a chat's home project (and the Guides chosen of its connected ones), with the choices about it. */
export class ChatProjectModal extends Modal {
  private parts: Component | null = null;

  constructor(app: App, private readonly host: ChatProjectHost) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('vc-project-modal');
    this.setTitle('Project context');
    void this.draw();
  }

  private async draw(): Promise<void> {
    const { contentEl, host } = this;
    this.parts?.unload();
    this.parts = new Component();
    this.parts.load();
    const parts = this.parts;
    contentEl.empty();
    const home = host.home();
    if (!home) {
      contentEl.createDiv({ cls: 'vc-project-status', text: 'This chat has no project.' });
      const row = contentEl.createDiv({ cls: 'vc-project-foot' });
      row.createEl('button', { text: 'Choose a project…' }).addEventListener('click', () => this.chooseHome());
      row.createEl('button', { text: 'Create project…' }).addEventListener('click', () => {
        this.close();
        host.createProject();
      });
      return;
    }
    const head = contentEl.createDiv({ cls: 'vc-project-head' });
    const name = head.createEl('a', { cls: 'vc-project-title', text: home.name, attr: { 'aria-label': 'Open project' } });
    name.addEventListener('click', () => {
      this.close();
      host.open(home.path);
    });
    const actions = head.createDiv({ cls: 'vc-project-actions' });
    actions.createEl('button', { text: 'Map' }).addEventListener('click', () => {
      this.close();
      host.openMap(home.path);
    });
    actions.createEl('button', { text: 'Change…' }).addEventListener('click', () => this.chooseHome());
    actions.createEl('button', { text: 'Remove' }).addEventListener('click', async () => {
      await host.setHome(null);
      await this.draw();
    });
    const { instructions, guide } = await host.parts(home.path);
    if (parts !== this.parts) return;
    contentEl.createDiv({ cls: 'vc-project-suggest', text: host.homeWhy() });
    const parents = host.parents(home.path);
    if (parents.length > 0) contentEl.createDiv({ cls: 'vc-project-suggest', text: `The Instructions of ${parents.map((name) => `“${name}”`).join(' and ')}, whose folder holds this one, go too.` });
    const withGuide = host.includeGuide() && guide !== '';
    const chars = instructions.length + (withGuide ? guide.length : 0);
    const status = contentEl.createDiv({ cls: 'vc-project-status' });
    if (host.sent(home.path)) {
      status.appendText(host.updated(home.path) ? 'Went with this chat already; the Instructions or Guide changed since. ' : 'Went with this chat already. ');
      const again = status.createEl('a', { text: 'Send again with the next message' });
      again.addEventListener('click', async () => {
        host.sendAgain(home.path);
        await this.draw();
      });
    } else if (chars === 0) status.setText('Nothing to send yet: the project has no Instructions or Guide.');
    else status.setText(`Goes with your next message: about ${formatTokens(estimateTokens(chars))} tokens.`);
    const section = (title: string, markdown: string, empty: string) => {
      const box = contentEl.createDiv({ cls: 'vc-project-section' });
      const top = box.createDiv({ cls: 'vc-project-section-head' });
      top.createSpan({ text: title });
      if (markdown) top.createSpan({ cls: 'vc-project-size', text: `~${formatTokens(estimateTokens(markdown.length))} tokens` });
      const body = box.createDiv({ cls: 'vc-project-body' });
      if (markdown) void host.render(markdown, body, parts);
      else body.createDiv({ cls: 'vc-project-empty', text: empty });
      return top;
    };
    section('Instructions', instructions, 'None written. Open the project note to write them.');
    const guideHead = section('Guide', guide, 'Empty. Run “Update project guide” to propose additions from its chats.');
    if (guide) {
      const toggle = guideHead.createEl('label', { cls: 'vc-project-toggle' });
      const box = toggle.createEl('input', { type: 'checkbox' });
      box.checked = host.includeGuide();
      toggle.appendText('Include');
      box.addEventListener('change', async () => {
        host.setIncludeGuide(box.checked);
        await this.draw();
      });
    }
    this.drawConnections(contentEl);
  }

  /** The projects this chat is connected to, behind a fold: each opens, and its Guide goes when chosen. */
  private drawConnections(el: HTMLElement): void {
    const { host } = this;
    const connected = host.connections();
    const fold = el.createEl('details', { cls: 'vc-project-connections' });
    fold.open = connected.some((project) => host.usesGuide(project.path));
    fold.createEl('summary', { text: connected.length > 0 ? `Connections (${connected.length})` : 'Connections…' });
    if (!host.started) {
      fold.createDiv({ cls: 'vc-project-empty', text: 'A chat can be connected to other projects once it has started.' });
      return;
    }
    for (const project of connected) {
      const row = fold.createDiv({ cls: 'vc-project-connection' });
      const name = row.createEl('a', { text: project.name, attr: { 'aria-label': 'Open project' } });
      name.addEventListener('click', () => {
        this.close();
        host.open(project.path);
      });
      const toggle = row.createEl('label', { cls: 'vc-project-toggle' });
      const box = toggle.createEl('input', { type: 'checkbox' });
      box.checked = host.usesGuide(project.path);
      toggle.appendText(host.sent(project.path) && box.checked ? 'Use its Guide in this chat (sent)' : 'Use its Guide in this chat');
      box.addEventListener('change', async () => {
        host.setUsesGuide(project.path, box.checked);
        await this.draw();
      });
      const remove = row.createSpan({ cls: 'clickable-icon', attr: { 'aria-label': 'Disconnect' } });
      setIcon(remove, 'x');
      remove.addEventListener('click', async () => {
        await host.connect(project.path, false);
        await this.draw();
      });
    }
    const add = fold.createEl('button', { text: 'Connect to a project…' });
    add.addEventListener('click', () => {
      const home = host.home()?.path;
      const taken = new Set(connected.map((project) => project.path));
      new ProjectPicker(this.app, host.projects().filter((project) => project.path !== home && !taken.has(project.path)), 'Connect this chat to…', async (project) => {
        await host.connect(project.path, true);
        await this.draw();
      }).open();
    });
  }

  private chooseHome(): void {
    const home = this.host.home()?.path;
    new ProjectPicker(this.app, this.host.projects().filter((project) => project.path !== home), "This chat's project", async (project) => {
      await this.host.setHome(project.path);
      await this.draw();
    }).open();
  }

  onClose(): void {
    this.parts?.unload();
    this.parts = null;
    this.contentEl.empty();
  }
}

export interface GuideHost {
  project: ProjectRef;
  /** Its own chats, and its connected chats (offered unticked, used only when ticked). */
  chats: ChatChoice[];
  connected: ChatChoice[];
  propose(chats: string[], signal: AbortSignal): Promise<GuideProposal[]>;
  /** Adds the accepted proposals to the Guide. */
  apply(accepted: GuideProposal[]): Promise<void>;
  titleOf(chat: string): string;
  openChat(chat: string): void;
}

/** Proposes additions to a project's Guide from the chats chosen, and adds those accepted after review. */
export class GuideModal extends Modal {
  private abort: AbortController | null = null;

  constructor(app: App, private readonly host: GuideHost) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('vc-project-modal');
    this.setTitle(`Update Guide: ${this.host.project.name}`);
    this.chooseChats();
  }

  private chooseChats(): void {
    const { contentEl, host } = this;
    contentEl.empty();
    contentEl.createDiv({ cls: 'vc-project-label', text: 'Claude reads the chats ticked and proposes additions, each linked to its chat. Nothing is added until you accept it.' });
    if (host.chats.length === 0 && host.connected.length === 0) {
      contentEl.createDiv({ cls: 'vc-project-empty', text: 'This project has no chats.' });
      return;
    }
    const own = chatChecklist(contentEl, host.chats, () => update());
    let others = (): string[] => [];
    if (host.connected.length > 0) {
      contentEl.createDiv({ cls: 'vc-project-label', text: 'Connected chats (used only when ticked)' });
      others = chatChecklist(contentEl, host.connected, () => update());
    }
    const foot = contentEl.createDiv({ cls: 'vc-project-foot' });
    const status = foot.createDiv({ cls: 'vc-project-status' });
    const button = foot.createEl('button', { cls: 'mod-cta', text: 'Propose additions' });
    const update = () => {
      button.disabled = own().length + others().length === 0;
    };
    update();
    button.addEventListener('click', async () => {
      const chosen = [...own(), ...others()];
      button.disabled = true;
      status.empty();
      setIcon(status.createSpan({ cls: 'vc-pick-up-wheel' }), 'loader-2');
      status.appendText(` Claude is reading ${chosen.length} chat${chosen.length === 1 ? '' : 's'}…`);
      this.abort = new AbortController();
      try {
        const proposals = await this.host.propose(chosen, this.abort.signal);
        if (!this.abort.signal.aborted) this.review(proposals);
      } catch (error) {
        if (this.abort?.signal.aborted) return;
        status.setText(`No proposals: ${errorText(error)}.`);
        update();
      }
    });
  }

  private review(proposals: GuideProposal[]): void {
    const { contentEl, host } = this;
    contentEl.empty();
    if (proposals.length === 0) {
      contentEl.createDiv({ cls: 'vc-project-status', text: 'Nothing new to add from these chats.' });
      contentEl.createDiv({ cls: 'vc-project-foot' }).createEl('button', { text: 'Back' }).addEventListener('click', () => this.chooseChats());
      return;
    }
    // A proposal that contradicts the Guide starts unticked: it is added only when chosen.
    const rows = proposals.map((proposal) => {
      const row = contentEl.createDiv({ cls: 'vc-project-proposal' });
      const top = row.createDiv({ cls: 'vc-project-proposal-head' });
      const box = top.createEl('input', { type: 'checkbox' });
      box.checked = !proposal.conflicts;
      top.createSpan({ cls: 'vc-project-kind', text: proposal.kind === 'question' ? 'Open question' : proposal.kind === 'example' ? 'Example' : 'Finding' });
      const source = top.createEl('a', { cls: 'vc-project-source', text: host.titleOf(proposal.source), attr: { 'aria-label': 'Open the chat it comes from' } });
      source.addEventListener('click', () => host.openChat(proposal.source));
      const text = row.createEl('textarea', { cls: 'vc-project-text' });
      text.value = proposal.text;
      text.rows = Math.min(6, Math.max(2, Math.ceil(proposal.text.length / 80)));
      if (proposal.conflicts) {
        const conflict = row.createDiv({ cls: 'vc-project-conflict' });
        conflict.createSpan({ cls: 'vc-project-kind', text: 'Conflicts with the Guide: ' });
        conflict.appendText(proposal.conflicts);
      }
      box.addEventListener('change', () => count());
      return { proposal, box, text };
    });
    const foot = contentEl.createDiv({ cls: 'vc-project-foot' });
    foot.createEl('button', { text: 'Back' }).addEventListener('click', () => this.chooseChats());
    const add = foot.createEl('button', { cls: 'mod-cta' });
    const count = () => {
      const n = rows.filter((row) => row.box.checked && row.text.value.trim()).length;
      add.setText(n === 0 ? 'Add to Guide' : `Add ${n} to Guide`);
      add.disabled = n === 0;
    };
    for (const row of rows) row.text.addEventListener('input', count);
    count();
    add.addEventListener('click', async () => {
      add.disabled = true;
      const accepted = rows.filter((row) => row.box.checked && row.text.value.trim()).map((row) => ({ ...row.proposal, text: row.text.value.trim() }));
      await host.apply(accepted);
      this.close();
    });
  }

  onClose(): void {
    this.abort?.abort();
    this.contentEl.empty();
  }
}
