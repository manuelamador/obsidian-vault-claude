import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteSessions } from '../src/history';

test('deleteSessions tries each session but those kept, and a failure does not stop the rest', async () => {
  const tried: string[] = [];
  const remove = async (id: string, dir: string) => {
    tried.push(`${id}@${dir}`);
    if (id === 'gone') throw new Error(`Session ${id} not found`);
  };
  const failed = await deleteSessions(['gone', 'kept', 'left'], '/vault', new Set(['kept']), remove);
  assert.deepEqual(tried, ['gone@/vault', 'left@/vault']);
  // The one that failed, to try again.
  assert.deepEqual(failed, ['gone']);
});
