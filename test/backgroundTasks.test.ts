import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackTask } from '../src/backgroundTasks';

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
