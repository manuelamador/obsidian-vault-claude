// The dialogs of projects (see projects.ts): picking one, making one of a folder, choosing another
// folder for one, and writing a project's Context anew beside the one it has.
import { FuzzySuggestModal, Modal, Notice, setIcon, type App } from 'obsidian';
import { errorText, log } from './log';
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
    const status = contentEl.createDiv({ cls: 'vc-project-status vc-pick-up-status' });
    status.createSpan({ cls: 'vc-pick-up-wheel', attr: { 'aria-hidden': 'true' } });
    status.createSpan({ text: 'Claude is reading the project’s notes and chats…' });
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
          try {
            await host.save(text.value.trim());
            this.close();
          } catch (error) {
            // Not saved: the dialog stays, to try again.
            log('saving a project context failed', error);
            new Notice(`The context was not saved: ${errorText(error)}`);
            save.disabled = false;
          }
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
