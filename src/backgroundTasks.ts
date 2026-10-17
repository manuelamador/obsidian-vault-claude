import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Sets kept from Claude Code's whole-set messages (see trackTask), whose start and end messages are passed over. */
const levelled = new WeakSet<Set<string>>();

/**
 * Records the background tasks a session has running — subagents and shell commands Claude sent
 * to the background — from Claude Code's task messages. They live inside the Claude Code process,
 * so the process must stay up until they finish, or they are killed with it. Watchers and other
 * housekeeping tasks (`ambient`) do not count: they may run for as long as the session does.
 * Returns whether the set changed.
 */
export function trackTask(tasks: Set<string>, message: SDKMessage): boolean {
  if (message.type !== 'system') return false;
  if (message.subtype === 'background_tasks_changed') {
    // The whole set, whenever it changes: taken as it is, and from then on the only word on it.
    // Older versions of Claude Code send only the starts and ends below.
    levelled.add(tasks);
    const now = message.tasks.filter((task) => !task.ambient).map((task) => task.task_id);
    const changed = now.length !== tasks.size || now.some((id) => !tasks.has(id));
    tasks.clear();
    for (const id of now) tasks.add(id);
    return changed;
  }
  if (levelled.has(tasks)) return false;
  switch (message.subtype) {
    case 'task_started':
      if (!message.is_backgrounded || message.ambient || tasks.has(message.task_id)) return false;
      tasks.add(message.task_id);
      return true;
    case 'task_updated': {
      const { status, is_backgrounded } = message.patch;
      if (status === 'completed' || status === 'failed' || status === 'killed') return tasks.delete(message.task_id);
      if (!is_backgrounded || tasks.has(message.task_id)) return false;
      tasks.add(message.task_id);
      return true;
    }
    case 'task_notification':
      return tasks.delete(message.task_id);
    default:
      return false;
  }
}

/** A background task as the task list shows it (see TasksModal): what it is, since when, and how it is going. */
export interface TaskInfo {
  id: string;
  /** Claude Code's type for it: `local_bash` (a shell command), `local_agent` (a subagent), `local_workflow`, `monitor`… */
  type: string;
  description: string;
  started: number;
  /** Its latest one-line status: a subagent's summary or the tool it last used. */
  progress?: string;
  toolUses?: number;
}

/** Whether the task list can read `info`'s output (see ClaudeSession.taskOutput): a shell command's or a monitor's, not a subagent's. */
export function hasOutput(info: TaskInfo): boolean {
  return info.type === 'local_bash' || info.type === 'monitor';
}

/**
 * Keeps `infos`, the background tasks of one session by id, as Claude Code's task messages describe
 * them (see trackTask, which counts the same tasks): started, making progress, renamed, ended.
 * Housekeeping tasks (`ambient`) are left out. Returns whether anything changed.
 */
export function noteTask(infos: Map<string, TaskInfo>, message: SDKMessage): boolean {
  if (message.type !== 'system') return false;
  switch (message.subtype) {
    case 'background_tasks_changed': {
      const now = message.tasks.filter((task) => !task.ambient);
      const ids = new Set(now.map((task) => task.task_id));
      let changed = false;
      for (const id of [...infos.keys()]) if (!ids.has(id)) changed = infos.delete(id) || changed;
      for (const task of now) {
        const known = infos.get(task.task_id);
        if (known && known.description === task.description) continue;
        infos.set(task.task_id, { ...(known ?? { id: task.task_id, started: Date.now() }), type: task.task_type, description: task.description });
        changed = true;
      }
      return changed;
    }
    case 'task_started':
      if (message.ambient || message.skip_transcript) return false;
      infos.set(message.task_id, { id: message.task_id, type: message.task_type ?? (message.subagent_type ? 'local_agent' : 'local_bash'), description: message.description, started: Date.now() });
      return true;
    case 'task_progress': {
      const info = infos.get(message.task_id);
      if (!info) return false;
      info.progress = message.summary ?? (message.last_tool_name ? `Using ${message.last_tool_name}` : info.progress);
      info.toolUses = message.usage?.tool_uses;
      return true;
    }
    case 'task_updated': {
      const info = infos.get(message.task_id);
      const { status, description } = message.patch;
      if (status === 'completed' || status === 'failed' || status === 'killed') return infos.delete(message.task_id);
      if (!info || !description || description === info.description) return false;
      info.description = description;
      return true;
    }
    case 'task_notification':
      return infos.delete(message.task_id);
    default:
      return false;
  }
}
