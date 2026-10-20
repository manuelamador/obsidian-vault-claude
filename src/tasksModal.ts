// The background tasks a panel's chats are running (see backgroundTasks.ts): for each, what it is,
// for how long, how it is going, its output so far (a shell command's), and a way to stop it alone.
// Claude Code's only: a Codex turn runs nothing past its end.
import { Modal, setIcon, type App } from 'obsidian';
import { hasOutput, type TaskInfo } from './backgroundTasks';
import type { FinishedTask } from './main';
import { formatDuration } from './usageDisplay';
import { errorText, log } from './log';

/** A chat with tasks running, as the list shows it. */
export interface TaskChat {
  chatId: string | null;
  title: string;
  tasks: TaskInfo[];
}

export interface TasksHost {
  /** The chats with tasks running now, the one on screen first. */
  chats(): TaskChat[];
  output(chatId: string | null, taskId: string): Promise<{ output: string; truncated: boolean } | null>;
  stop(chatId: string | null, taskId: string): Promise<void>;
  stopAll(chatId: string | null): void;
  /** Tasks that have ended, newest first, with their output still readable (see finishedOutput). */
  finished(): FinishedTask[];
  /** Shows chat `chatId` in the panel. */
  openChat(chatId: string): void;
  finishedOutput(task: FinishedTask): Promise<{ output: string; truncated: boolean } | null>;
  /** The list was looked at: the tasks that ended are seen. */
  seen(): void;
  /** Clears the tasks that ended from the list. */
  clearFinished(): void;
  /** Called with a redraw for whenever the tasks change; returns what stops it. */
  watch(changed: () => void): () => void;
}

/** How often an open output is read again while its task runs. */
const OUTPUT_EVERY_MS = 2000;

const KIND: Record<string, { icon: string; label: string }> = {
  local_bash: { icon: 'terminal', label: 'Command' },
  monitor: { icon: 'activity', label: 'Monitor' },
  local_agent: { icon: 'bot', label: 'Agent' },
  local_workflow: { icon: 'workflow', label: 'Workflow' },
};

export class TasksModal extends Modal {
  /** The tasks whose output is open, and the timer reading it again. */
  private readonly shown = new Set<string>();
  /** The output last read of each, shown while it is read again. */
  private readonly outputs = new Map<string, string>();
  private timer = 0;
  private stopWatching: () => void = () => undefined;

  constructor(app: App, private readonly host: TasksHost) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Background tasks');
    this.modalEl.addClass('vc-tasks-modal');
    this.stopWatching = this.host.watch(() => this.draw());
    this.draw();
    this.host.seen();
    this.timer = window.setInterval(() => this.draw(), OUTPUT_EVERY_MS);
  }

  onClose(): void {
    window.clearInterval(this.timer);
    this.stopWatching();
    this.contentEl.empty();
  }

  private draw(): void {
    const { contentEl } = this;
    // An output being read is kept where it is scrolled to.
    const scrolls = new Map([...contentEl.querySelectorAll<HTMLElement>('.vc-task-output')].map((el) => [el.dataset.task ?? '', el.scrollTop]));
    contentEl.empty();
    const chats = this.host.chats().filter((chat) => chat.tasks.length > 0);
    const finished = this.host.finished();
    if (chats.length === 0) contentEl.createDiv({ cls: 'vc-muted', text: 'No tasks running in the background.' });
    for (const chat of chats) {
      const head = contentEl.createDiv({ cls: 'vc-task-chat' });
      this.chatLink(head.createSpan({ cls: 'vc-task-chat-title', text: chat.title }), chat.chatId);
      if (chat.tasks.length > 1) {
        const all = head.createEl('button', { text: 'Stop all', attr: { 'aria-label': `Stop the ${chat.tasks.length} tasks of this chat` } });
        all.addEventListener('click', () => this.host.stopAll(chat.chatId));
      }
      for (const task of chat.tasks) this.drawTask(contentEl, chat, task, scrolls.get(task.id));
    }
    if (finished.length === 0) return;
    const head = contentEl.createDiv({ cls: 'vc-task-chat' });
    head.createSpan({ cls: 'vc-task-chat-title', text: 'Finished' });
    const clear = head.createEl('button', { text: 'Clear', attr: { 'aria-label': 'Clear the finished tasks from the list' } });
    clear.addEventListener('click', () => {
      this.host.clearFinished();
      this.draw();
    });
    for (const task of finished) this.drawFinished(contentEl, task, scrolls.get(task.info.id));
  }

  /** `el`, naming chat `chatId`, opens it on click (the list closing), when the chat has an id. */
  private chatLink(el: HTMLElement, chatId: string | null): void {
    if (!chatId) return;
    el.addClass('vc-task-chat-link');
    el.setAttr('aria-label', 'Go to this chat');
    el.addEventListener('click', () => {
      this.close();
      this.host.openChat(chatId);
    });
  }

  /** A task that ended: how, when, in which chat, and its output from the file Claude Code keeps. */
  private drawFinished(parent: HTMLElement, task: FinishedTask, scroll: number | undefined): void {
    const kind = KIND[task.info.type] ?? { icon: 'circle-dot', label: 'Task' };
    const row = parent.createDiv({ cls: `vc-task is-ended is-${task.status}` });
    const top = row.createDiv({ cls: 'vc-task-head' });
    setIcon(top.createSpan({ cls: 'vc-task-icon', attr: { 'aria-label': task.status } }), task.status === 'completed' ? 'check' : task.status === 'failed' ? 'alert-circle' : 'square');
    top.createSpan({ cls: 'vc-task-description', text: task.info.description || task.summary || kind.label });
    top.createSpan({ cls: 'vc-task-time', text: `${task.status === 'completed' ? 'finished' : task.status === 'failed' ? 'failed' : 'stopped'} ${new Date(task.ended).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` });
    const shown = this.shown.has(task.info.id);
    const toggle = top.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': shown ? 'Hide its output' : 'Show its output' } });
    setIcon(toggle, shown ? 'chevron-up' : 'scroll-text');
    toggle.addEventListener('click', () => {
      if (shown) this.shown.delete(task.info.id);
      else this.shown.add(task.info.id);
      this.draw();
    });
    this.chatLink(row.createDiv({ cls: 'vc-task-progress', text: `In “${task.chatTitle}”` }), task.chatId);
    if (!shown) return;
    const out = row.createEl('pre', { cls: 'vc-task-output', attr: { 'data-task': task.info.id } });
    out.setText(this.outputs.get(task.info.id) ?? 'Reading…');
    if (scroll !== undefined) out.scrollTop = scroll;
    void this.host.finishedOutput(task).then((read) => {
      if (!out.isConnected) return;
      const text = read ? `${read.truncated ? '… ' : ''}${read.output || '(it wrote nothing)'}` : task.summary || 'Its output file is gone.';
      this.outputs.set(task.info.id, text);
      out.setText(text);
      out.scrollTop = scroll ?? out.scrollHeight;
    });
  }

  private drawTask(parent: HTMLElement, chat: TaskChat, task: TaskInfo, scroll: number | undefined): void {
    const kind = KIND[task.type] ?? { icon: 'circle-dot', label: 'Task' };
    const row = parent.createDiv({ cls: 'vc-task' });
    const top = row.createDiv({ cls: 'vc-task-head' });
    setIcon(top.createSpan({ cls: 'vc-task-icon', attr: { 'aria-label': kind.label } }), kind.icon);
    top.createSpan({ cls: 'vc-task-description', text: task.description || kind.label });
    top.createSpan({ cls: 'vc-task-time', text: formatDuration(Date.now() - task.started) });
    if (hasOutput(task)) {
      const shown = this.shown.has(task.id);
      const toggle = top.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': shown ? 'Hide its output' : 'Show its output so far' } });
      setIcon(toggle, shown ? 'chevron-up' : 'scroll-text');
      toggle.addEventListener('click', () => {
        if (shown) this.shown.delete(task.id);
        else this.shown.add(task.id);
        this.draw();
      });
    }
    const stop = top.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Stop this task' } });
    setIcon(stop, 'square');
    stop.addEventListener('click', () => {
      stop.disabled = true;
      this.host.stop(chat.chatId, task.id).catch((error: unknown) => log('stopping a task failed', error));
    });
    const status = task.progress ?? (task.toolUses ? `${task.toolUses} tool calls` : '');
    if (status) row.createDiv({ cls: 'vc-task-progress', text: status });
    if (!this.shown.has(task.id)) return;
    const out = row.createEl('pre', { cls: 'vc-task-output', attr: { 'data-task': task.id } });
    out.setText(this.outputs.get(task.id) ?? 'Reading…');
    if (scroll !== undefined) out.scrollTop = scroll;
    void this.host.output(chat.chatId, task.id).then(
      (read) => {
        if (!out.isConnected) return;
        const text = read ? `${read.truncated ? '… ' : ''}${read.output || '(nothing written yet)'}` : 'Its output cannot be read.';
        this.outputs.set(task.id, text);
        // At the end unless scrolled up to read.
        const atEnd = scroll === undefined || scroll + out.clientHeight >= out.scrollHeight - 4;
        out.setText(text);
        out.scrollTop = atEnd ? out.scrollHeight : (scroll ?? 0);
      },
      (error: unknown) => out.isConnected && out.setText(`Its output could not be read: ${errorText(error)}`),
    );
  }
}
