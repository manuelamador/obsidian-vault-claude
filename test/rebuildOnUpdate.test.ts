import assert from 'node:assert/strict';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';

test('the chat list is rebuilt once per version, quietly', async () => {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  const runs: boolean[] = [];
  p.rebuildChatList = async (quiet = false) => void runs.push(quiet);
  const onUpdate = () => (p as unknown as { rebuildChatListOnUpdate(): Promise<void> }).rebuildChatListOnUpdate();
  (p as unknown as { manifest: { version: string } }).manifest = { version: '1.0.0' };
  await onUpdate();
  await onUpdate();
  (p as unknown as { manifest: { version: string } }).manifest = { version: '1.1.0' };
  await onUpdate();
  assert.deepEqual(runs, [true, true]);
});
