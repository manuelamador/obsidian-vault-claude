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
