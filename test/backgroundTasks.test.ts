import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasOutput, noteTask, trackTask, type TaskInfo } from '../src/backgroundTasks';

const sys = (fields: Record<string, unknown>) => ({ type: 'system', uuid: 'u', session_id: 's', ...fields }) as never;

test('only tasks sent to the background count, and not watchers', () => {
  const tasks = new Set<string>();
  trackTask(tasks, sys({ subtype: 'task_started', task_id: 'fg', is_backgrounded: false, description: '' }));
  trackTask(tasks, sys({ subtype: 'task_started', task_id: 'watch', is_backgrounded: true, ambient: true, description: '' }));
  trackTask(tasks, sys({ subtype: 'task_started', task_id: 'bg', is_backgrounded: true, description: '' }));
  trackTask(tasks, sys({ subtype: 'task_updated', task_id: 'moved', patch: { is_backgrounded: true } }));
  assert.deepEqual([...tasks].sort(), ['bg', 'moved']);
});

test('a task ends with its notification or a final status', () => {
  const tasks = new Set(['bg', 'moved']);
  assert.equal(trackTask(tasks, sys({ subtype: 'task_notification', task_id: 'bg', status: 'completed' })), true);
  assert.equal(trackTask(tasks, sys({ subtype: 'task_updated', task_id: 'moved', patch: { status: 'killed' } })), true);
  assert.equal(tasks.size, 0);
});

test('other messages leave the set alone', () => {
  const tasks = new Set(['bg']);
  assert.equal(trackTask(tasks, { type: 'result' } as never), false);
  assert.equal(trackTask(tasks, sys({ subtype: 'task_progress', task_id: 'bg' })), false);
  assert.deepEqual([...tasks], ['bg']);
});

test("Claude Code's whole set of tasks replaces the one kept, watchers left out, and is then the only word on it", () => {
  const tasks = new Set<string>(['stale']);
  const level = (list: { task_id: string; ambient?: boolean }[]) => sys({ subtype: 'background_tasks_changed', tasks: list.map((task) => ({ task_type: 'local_agent', description: '', ...task })) });
  assert.equal(trackTask(tasks, level([{ task_id: 'bg' }, { task_id: 'watch', ambient: true }])), true);
  assert.deepEqual([...tasks], ['bg']);
  // The same set again: no change.
  assert.equal(trackTask(tasks, level([{ task_id: 'bg' }])), false);
  // A start or end message after it is passed over: the next whole set says it.
  assert.equal(trackTask(tasks, sys({ subtype: 'task_started', task_id: 'late', is_backgrounded: true, description: '' })), false);
  assert.equal(trackTask(tasks, level([])), true);
  assert.equal(tasks.size, 0);
});

test('the task list knows what each task is, how it is going, and drops it when it ends', () => {
  const infos = new Map<string, TaskInfo>();
  assert.equal(noteTask(infos, sys({ subtype: 'task_started', task_id: 't1', description: 'Run the simulation', task_type: 'local_bash', is_backgrounded: true })), true);
  noteTask(infos, sys({ subtype: 'task_started', task_id: 't2', description: 'Review the notes', subagent_type: 'general-purpose', is_backgrounded: true }));
  // A housekeeping task is not listed.
  assert.equal(noteTask(infos, sys({ subtype: 'task_started', task_id: 'w', description: 'watch', ambient: true })), false);
  noteTask(infos, sys({ subtype: 'task_progress', task_id: 't2', description: 'Review the notes', summary: 'Reading thread notes', usage: { total_tokens: 1, tool_uses: 3, duration_ms: 1 } }));
  assert.deepEqual([...infos.values()].map((info) => [info.id, info.type, info.description, info.progress ?? '', hasOutput(info)]), [
    ['t1', 'local_bash', 'Run the simulation', '', true],
    ['t2', 'local_agent', 'Review the notes', 'Reading thread notes', false],
  ]);
  noteTask(infos, sys({ subtype: 'task_notification', task_id: 't1', status: 'completed', output_file: '', summary: '' }));
  assert.deepEqual([...infos.keys()], ['t2']);
  // The whole set, when Claude Code sends it, is the only word: one not in it goes.
  noteTask(infos, sys({ subtype: 'background_tasks_changed', tasks: [{ task_id: 't3', task_type: 'local_bash', description: 'Build' }] }));
  assert.deepEqual([...infos.keys()], ['t3']);
});
