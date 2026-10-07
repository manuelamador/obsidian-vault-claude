// The dialogs of projects (see projects.ts): making one of a folder, what a chat's project sends with
// it, managing the projects, and writing a project's Context anew beside the one it has.
import { Component, FuzzySuggestModal, Modal, Notice, setIcon, type App } from 'obsidian';
import { Pane } from './connectionsWindow';
import { ConfirmModal, RenameModal } from './historyModal';
import { estimateTokens, formatTokens } from './contextSize';
import { errorText } from './log';
import { folderOf, type FolderSuggestion } from './chatFolders';

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

export interface CreateProjectHost extends FolderSource {
  /** The folder chosen to start with (from the history's folders view). */
  folder?: string;
  /** The folder the chat it is made for suggests (see suggestFolder). */
  suggestion: FolderSuggestion | null;
  /** Makes it; false when it could not be (said in a notice). */
  create(name: string, folder: string): Promise<boolean>;
  /** Why a project note cannot be called `name` (note names are unique in the vault), or null. */
  nameProblem(name: string): string | null;
  /** A free name for the project of folder `folder`: `Claude Project — <folder's name>`, numbered when taken. */
  defaultName(folder: string): string;
}

/** What a folder browser needs: the vault's folders, which are projects, and how many chats worked in each. */
export interface FolderSource {
  folders: string[];
  projectOf(folder: string): string | null;
  preview(folder: string): { count: number; latest: string };
}

/**
 * A browser of the vault's folders in `el`: the path to the folder shown, each part going back to it;
 * a button (`label`) to choose it; the folders in it, each marked when a project and with how many
 * chats worked in it, a click going into it. The function returned shows a folder.
 */
function folderBrowser(el: HTMLElement, source: FolderSource, chosen: () => string, choose: (folder: string) => void, label: string): (at: string) => void {
  const browseAt = (at: string) => {
    el.empty();
    const crumbs = el.createDiv({ cls: 'vc-project-crumbs' });
    const parts = at ? at.split('/') : [];
    const crumb = (text: string, path: string, last: boolean) => {
      const part = crumbs.createEl(last ? 'span' : 'a', { text });
      if (!last) part.addEventListener('click', () => browseAt(path));
    };
    crumb('Vault', '', parts.length === 0);
    parts.forEach((part, i) => {
      crumbs.appendText(' › ');
      crumb(part, parts.slice(0, i + 1).join('/'), i === parts.length - 1);
    });
    if (at && at !== chosen()) crumbs.createEl('button', { cls: 'mod-cta', text: label }).addEventListener('click', () => choose(at));
    const children = source.folders.filter((folder) => folderOf(folder) === at);
    const rows = el.createDiv({ cls: 'vc-project-browser-rows' });
    if (children.length === 0) rows.createDiv({ cls: 'vc-project-empty', text: 'No folders in it.' });
    for (const child of children) {
      const row = rows.createDiv({ cls: 'vc-project-browser-row' });
      const project = source.projectOf(child);
      setIcon(row.createSpan({ cls: 'vc-project-group-icon' }), project ? 'folder-kanban' : 'folder');
      row.createSpan({ text: child.slice(child.lastIndexOf('/') + 1) });
      const { count } = source.preview(child);
      const detail = [project ? 'project' : '', count > 0 ? `${count} chat${count === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
      if (detail) row.createSpan({ cls: 'vc-project-size', text: detail });
      if (source.folders.some((folder) => folderOf(folder) === child)) setIcon(row.createSpan({ cls: 'vc-project-group-icon vc-project-into' }), 'chevron-right');
      row.addEventListener('click', () => browseAt(child));
    }
  };
  return browseAt;
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
    contentEl.createDiv({ cls: 'vc-project-label', text: 'A project is a folder: chats that work on its notes are its chats, and its Context, a summary written from its notes and chats when it is made, goes with them.' });
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
    const browseAt = folderBrowser(browser, host, () => chosen, choose, 'Choose this folder');
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
  home(): ProjectRef | null;
  projects(): ProjectRef[];
  parts(path: string): Promise<{ context: string; instructions: string }>;
  /** Whether its context went already. */
  sent(path: string): boolean;
  /** Writes the project's Context anew, to save or not (see ContextModal); `saved` runs once saved. */
  refreshContext(path: string, saved: () => void): void;
  /** Whether a project's Context or Instructions changed since they went with the chat. */
  updated(path: string): boolean;
  sendAgain(path: string): void;
  setHome(path: string | null): Promise<void>;
  /** Why the chat is in its home project, in a few words (see homeOf). */
  homeWhy(): string;
  /** Opens Manage projects (see ManageProjectsModal). */
  manage(): void;
  /** The projects holding a project's folder, the outermost first, whose Instructions go too. */
  parents(path: string): string[];
  createProject(): void;
  open(path: string): void;
  render(markdown: string, el: HTMLElement, component: Component): Promise<void>;
}

/** Shows what goes with the next message from a chat's project, with the choices about it. A chat has at most one project. */
export class ChatProjectModal extends Pane {
  private parts: Component | null = null;

  constructor(app: App, private readonly host: ChatProjectHost) {
    super(app);
  }

  onOpen(): void {
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
    const manageLink = (el: HTMLElement) =>
      el.createEl('a', { cls: 'vc-project-manage', text: 'Manage projects…' }).addEventListener('click', () => {
        host.manage();
      });
    if (!home) {
      contentEl.createDiv({ cls: 'vc-project-status', text: 'This chat has no project.' });
      const row = contentEl.createDiv({ cls: 'vc-project-foot' });
      row.createEl('button', { text: 'Choose a project…' }).addEventListener('click', () => this.chooseHome());
      row.createEl('button', { text: 'Create project…' }).addEventListener('click', () => {
        host.createProject();
      });
      manageLink(contentEl.createDiv({ cls: 'vc-project-foot' }));
      return;
    }
    const head = contentEl.createDiv({ cls: 'vc-project-head' });
    const name = head.createEl('a', { cls: 'vc-project-title', text: home.name, attr: { 'aria-label': 'Open project' } });
    name.addEventListener('click', () => {
      host.open(home.path);
    });
    const actions = head.createDiv({ cls: 'vc-project-actions' });
    actions.createEl('button', { text: 'Move chat…' }).addEventListener('click', () => this.chooseHome());
    const leave = actions.createEl('button', { text: 'Take chat out' });
    leave.setAttr('aria-label', 'This chat leaves the project; the project and its note stay');
    leave.addEventListener('click', async () => {
      await host.setHome(null);
      await this.draw();
    });
    const { context, instructions } = await host.parts(home.path);
    if (parts !== this.parts) return;
    contentEl.createDiv({ cls: 'vc-project-suggest', text: host.homeWhy() });
    const parents = host.parents(home.path);
    if (parents.length > 0) contentEl.createDiv({ cls: 'vc-project-suggest', text: `The Instructions of ${parents.map((name) => `“${name}”`).join(' and ')}, whose folder holds this one, go too.` });
    const chars = context.length + instructions.length;
    const status = contentEl.createDiv({ cls: 'vc-project-status' });
    if (host.sent(home.path)) {
      status.appendText(host.updated(home.path) ? 'Went with this chat already; the Context or Instructions changed since. ' : 'Went with this chat already. ');
      const again = status.createEl('a', { text: 'Send again with the next message' });
      again.addEventListener('click', async () => {
        host.sendAgain(home.path);
        await this.draw();
      });
    } else if (chars === 0) status.setText('Nothing to send yet: the project has no Context or Instructions.');
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
    const contextHead = section('Context', context, 'Not written yet. Refresh context writes it from the project’s notes and chats.');
    const refresh = contextHead.createEl('button', { cls: 'vc-map-action vc-project-section-action', text: context ? 'Refresh…' : 'Write…' });
    refresh.setAttr('aria-label', 'Write the Context anew from the project’s notes and chats, and compare it with this one before saving');
    refresh.addEventListener('click', () => host.refreshContext(home.path, () => void this.draw()));
    section('Instructions', instructions, 'None: optional. Anything you write in the project note’s Instructions goes with each chat too.');
    manageLink(contentEl.createDiv({ cls: 'vc-project-foot' }));
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

/** A project as Manage projects lists it. */
export interface ManagedProject {
  path: string;
  name: string;
  folder: string;
  /** How many chats are in it, and when its Context was last written ('' for never). */
  chats: number;
  contextUpdated: string;
}

export interface ManageProjectsHost extends FolderSource {
  projects(): ManagedProject[];
  open(path: string): void;
  map(path: string): void;
  refreshContext(path: string, saved: () => void): void;
  /** Writes a project's Context anew straight into its note; false when it could not be (logged). */
  writeContext(path: string): Promise<boolean>;
  setFolder(path: string, folder: string): Promise<boolean>;
  /** Renames a project's note; false when it could not be (said in a notice). */
  rename(path: string, name: string): Promise<boolean>;
  nameProblem(name: string): string | null;
  /** Moves a project's note to the trash: its chats stay, without it. */
  remove(path: string): Promise<void>;
  create(): void;
}

/** The vault's projects, each with its folder, chats and Context, and what can be done to it: open, map, refresh its Context, change its folder, rename, delete. */
export class ManageProjectsModal extends Pane {
  constructor(app: App, private readonly host: ManageProjectsHost) {
    super(app);
  }

  onOpen(): void {
    this.draw();
  }

  private draw(): void {
    const { contentEl, host } = this;
    contentEl.empty();
    const projects = host.projects();
    if (projects.length === 0) contentEl.createDiv({ cls: 'vc-project-empty', text: 'No projects yet. A project is a folder: chats that work on its notes share its Context.' });
    for (const project of projects) {
      const box = contentEl.createDiv({ cls: 'vc-project-section' });
      const top = box.createDiv({ cls: 'vc-project-section-head' });
      setIcon(top.createSpan({ cls: 'vc-project-group-icon' }), 'folder-kanban');
      const name = top.createEl('a', { text: project.name, attr: { 'aria-label': 'Open its note' } });
      name.addEventListener('click', () => {
        host.open(project.path);
      });
      const facts = box.createDiv({ cls: 'vc-project-size' });
      facts.setText(
        `${project.folder || 'No folder'} · ${project.chats} chat${project.chats === 1 ? '' : 's'} · ${project.contextUpdated ? `Context written ${project.contextUpdated}` : 'Context not written yet'}`,
      );
      const actions = box.createDiv({ cls: 'vc-project-manage-actions' });
      const action = (label: string, icon: string, run: () => void, warning = false) => {
        const button = actions.createEl('button', { cls: warning ? 'mod-warning' : '' });
        setIcon(button.createSpan({ cls: 'vc-project-group-icon' }), icon);
        button.appendText(label);
        button.addEventListener('click', run);
      };
      action('Map', 'waypoints', () => {
        host.map(project.path);
      });
      action(project.contextUpdated ? 'Refresh context…' : 'Write context…', 'refresh-cw', () => host.refreshContext(project.path, () => this.draw()));
      action('Change folder…', 'folder-input', () =>
        new ChooseFolderModal(this.app, host, project.folder, project.name, async (folder) => {
          if (await host.setFolder(project.path, folder)) this.draw();
        }).open(),
      );
      action('Rename…', 'pencil', () =>
        new RenameModal(
          this.app,
          project.name,
          (next) => {
            const problem = next.trim() === project.name ? null : host.nameProblem(next);
            if (problem) return void new Notice(problem);
            if (next.trim() !== project.name) void host.rename(project.path, next).then((done) => done && this.draw());
          },
          'Rename project',
        ).open(),
      );
      action(
        'Delete…',
        'trash-2',
        () =>
          new ConfirmModal(
            this.app,
            'Delete project',
            `The project note “${project.name}” goes to the trash, with its Context and Instructions. Its ${project.chats} chat${project.chats === 1 ? '' : 's'} and the notes in ${project.folder || 'its folder'} stay as they are; the chats no longer get the project's context.`,
            'Delete',
            () => void host.remove(project.path).then(() => this.draw()),
          ).open(),
        true,
      );
    }
    const foot = contentEl.createDiv({ cls: 'vc-project-foot' });
    const status = foot.createDiv({ cls: 'vc-project-status' });
    if (projects.length > 0) {
      const all = foot.createEl('button', { text: 'Write context for all…' });
      all.setAttr('aria-label', 'Write every project’s Context anew from its notes and chats, straight into its note: one request each, on the model for small jobs');
      all.addEventListener('click', async () => {
        all.disabled = true;
        let done = 0;
        for (const project of projects) {
          status.empty();
          setIcon(status.createSpan({ cls: 'vc-pick-up-wheel' }), 'loader-2');
          status.appendText(` Writing ${done + 1} of ${projects.length}: ${project.name}…`);
          if (await host.writeContext(project.path)) done += 1;
        }
        new Notice(`Context written for ${done} of ${projects.length} project${projects.length === 1 ? '' : 's'}.`);
        this.draw();
      });
    }
    foot.createEl('button', { cls: 'mod-cta', text: 'New project…' }).addEventListener('click', () => {
      host.create();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Chooses a new folder for project `name`, in the folder browser, starting at its folder now. */
export class ChooseFolderModal extends Modal {
  constructor(
    app: App,
    private readonly source: FolderSource,
    private readonly current: string,
    private readonly name: string,
    private readonly chosen: (folder: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('vc-project-modal');
    this.setTitle(`Folder of “${this.name}”`);
    this.contentEl.createDiv({ cls: 'vc-project-label', text: `Now: ${this.current || 'no folder'}. Its chats are those working on notes in the folder chosen.` });
    const browser = this.contentEl.createDiv({ cls: 'vc-project-browser' });
    folderBrowser(browser, this.source, () => this.current, (folder) => {
      const taken = this.source.projectOf(folder);
      if (taken) return void new Notice(`“${folder}” is the folder of “${taken}” already.`);
      this.close();
      this.chosen(folder);
    }, 'Use this folder')(this.current ? folderOf(this.current) : '');
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface ContextHost {
  name: string;
  current: string;
  write(signal: AbortSignal): Promise<string>;
  save(context: string): Promise<void>;
}

/** Writes a project's Context anew from its notes and chats, and shows it beside the one it has, editable, to save or not. */
export class ContextModal extends Modal {
  private abort = new AbortController();

  constructor(app: App, private readonly host: ContextHost) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, host } = this;
    this.modalEl.addClass('vc-project-modal');
    this.setTitle(`Context: ${host.name}`);
    const status = contentEl.createDiv({ cls: 'vc-project-status' });
    setIcon(status.createSpan({ cls: 'vc-pick-up-wheel' }), 'loader-2');
    status.appendText(' Claude is reading the project’s notes and chats…');
    void host.write(this.abort.signal).then(
      (context) => {
        if (this.abort.signal.aborted) return;
        contentEl.empty();
        const sides = contentEl.createDiv({ cls: 'vc-context-sides' });
        const was = sides.createDiv({ cls: 'vc-project-section' });
        was.createDiv({ cls: 'vc-project-section-head', text: 'Now' });
        was.createEl('pre', { cls: 'vc-link-digest', text: host.current || '(none)' });
        const next = sides.createDiv({ cls: 'vc-project-section' });
        next.createDiv({ cls: 'vc-project-section-head', text: 'Written now (edit before saving if you like)' });
        const text = next.createEl('textarea', { cls: 'vc-project-text vc-context-text' });
        text.value = context;
        const foot = contentEl.createDiv({ cls: 'vc-project-foot' });
        foot.createEl('button', { text: 'Keep the one it has' }).addEventListener('click', () => this.close());
        const save = foot.createEl('button', { cls: 'mod-cta', text: 'Save' });
        save.addEventListener('click', async () => {
          save.disabled = true;
          await host.save(text.value.trim());
          this.close();
        });
      },
      (error: unknown) => {
        if (!this.abort.signal.aborted) status.setText(`No context written: ${errorText(error)}.`);
      },
    );
  }

  onClose(): void {
    this.abort.abort();
    this.contentEl.empty();
  }
}
