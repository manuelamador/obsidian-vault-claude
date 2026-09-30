import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';
import { projectFolder } from '../src/history';

test('the startup sweep deletes the side chats left from the last run, but not a kept one or one opened since', async () => {
  const config = mkdtempSync(join(tmpdir(), 'vc-sweep-config-'));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), 'vc-sweep-vault-')));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const folder = join(config, 'projects', projectFolder(vault));
    mkdirSync(folder, { recursive: true });
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    const [left, kept, opened] = ids;
    for (const id of ids) {
      const row = { type: 'user', uuid: `${id}-u`, parentUuid: null, sessionId: id, cwd: vault, timestamp: new Date().toISOString(), message: { role: 'user', content: 'side question' } };
      writeFileSync(join(folder, `${id}.jsonl`), `${JSON.stringify(row)}\n`);
    }
    const plugin = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
    plugin.saveSettings = async () => undefined;
    plugin.vaultRoot = () => vault;
    // Held at the last quit: one left open, one since kept as a chat, and one that never wrote a file.
    const neverWritten = '44444444-4444-4444-8444-444444444444';
    plugin.sideSessions = [left, kept, neverWritten];
    plugin.chats = [{ id: kept, title: 'Side chat: kept' }];
    const leftover = [...plugin.sideSessions];
    // A side chat opened after the plugin loaded holds its own session.
    plugin.holdSideSession(opened);
    await (plugin as unknown as { sweepSideSessions(ids: string[]): Promise<void> }).sweepSideSessions(leftover);
    assert.deepEqual(
      ids.map((id) => existsSync(join(folder, `${id}.jsonl`))),
      [false, true, true],
    );
    assert.deepEqual(plugin.sideSessions, [opened]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});
