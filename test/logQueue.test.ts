import assert from 'node:assert/strict';
import { test } from 'node:test';

test('a log that cannot be written keeps no more than a bounded number of lines, and lets go of them', async () => {
  // A folder that cannot be made: under a file.
  process.env.VAULT_CLAUDE_LOG = '/dev/null/vault-claude/vault-claude.log';
  const { log, queuedLines } = await import('../src/log');
  for (let i = 0; i < 1500; i += 1) log('line', i);
  assert.ok(queuedLines() <= 1000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(queuedLines(), 0);
});
