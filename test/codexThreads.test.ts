import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { readCodexThreads, stopCodexReader } from '../src/codexSession';
import VaultClaudePlugin from '../src/main';
import { launchIn } from './fakeCodex';

test("Codex's thread list is read to its last page", async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-threads-`);
  try {
    const threads = await readCodexThreads(launchIn(dir, 'threads'));
    assert.deepEqual(
      threads.map((thread) => [thread.id, thread.title, thread.fromPanel, thread.archived]),
      [
        ['p1', 'First', true, false],
        ['p2', 'Second', true, false],
      ],
    );
  } finally {
    stopCodexReader();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex read that times out is tried again at the next listing, and recovers the chats then', async () => {
  const silent = mkdtempSync(`${tmpdir()}/vc-codex-silent-`);
  const answering = mkdtempSync(`${tmpdir()}/vc-codex-answering-`);
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  const refresh = () => (p as unknown as { refreshCodexStamps(): Promise<void> }).refreshCodexStamps();
  try {
    p.codexLaunch = () => launchIn(silent, 'silent');
    await refresh();
    assert.equal(p.chats.length, 0);
    p.codexLaunch = () => launchIn(answering, 'threads');
    await refresh();
    assert.deepEqual(
      p.chats.map((chat) => [chat.id, chat.title, chat.engine]),
      [
        ['p1', 'First', 'codex'],
        ['p2', 'Second', 'codex'],
      ],
    );
  } finally {
    stopCodexReader();
    rmSync(silent, { recursive: true, force: true });
    rmSync(answering, { recursive: true, force: true });
  }
});
