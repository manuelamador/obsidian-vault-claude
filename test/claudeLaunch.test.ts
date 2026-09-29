import assert from 'node:assert/strict';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';

test('claudeLaunch: the vault, the executable and the extra PATH; or why Claude Code cannot run', () => {
  const plugin = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  plugin.settings = { ...plugin.settings, claudePath: '/opt/claude/bin/claude', extraPath: '/a/bin:/b/bin' };
  plugin.vaultRoot = () => '/vault';
  assert.deepEqual(plugin.claudeLaunch(), { cwd: '/vault', claudePath: '/opt/claude/bin/claude', extraPath: ['/a/bin', '/b/bin'] });
  plugin.vaultRoot = () => null;
  assert.equal(plugin.claudeLaunch(), 'Vault Claude needs a vault stored on the local file system.');
  // launchOrNotice gives null then, having said why.
  assert.equal(plugin.launchOrNotice(), null);
});

test('a chat waits for a session still ending, and not for one that is not', async () => {
  const plugin = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  let waited = false;
  await plugin.sessionEnded('free');
  const ended = plugin.sessionEnding('kept');
  const waiting = plugin.sessionEnded('kept').then(() => void (waited = true));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(waited, false);
  ended();
  await waiting;
  assert.equal(waited, true);
  // Once ended, nothing is left to wait for.
  await plugin.sessionEnded('kept');
});

test('a chat stops waiting for a session whose end never comes, at the time limit', async () => {
  const plugin = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  plugin.sessionEnding('stuck');
  const started = Date.now();
  await plugin.sessionEnded('stuck', 30);
  assert.ok(Date.now() - started >= 25);
});
