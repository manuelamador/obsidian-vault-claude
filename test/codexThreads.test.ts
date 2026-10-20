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

test('a Codex read that fails is tried again later, and recovers the chats then, without holding up the listing', async () => {
  const silent = mkdtempSync(`${tmpdir()}/vc-codex-silent-`);
  const answering = mkdtempSync(`${tmpdir()}/vc-codex-answering-`);
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  const internals = p as unknown as { refreshCodexStamps(): Promise<void>; codexRead: Promise<void> | null; codexRecoverAll: boolean; codexReadMaxMs: number; codexRetryMs: number };
  // Records found empty at start: the Codex chats are recovered from Codex's store.
  internals.codexRecoverAll = true;
  internals.codexReadMaxMs = 200;
  internals.codexRetryMs = 0;
  try {
    p.codexLaunch = () => launchIn(silent, 'silent');
    const started = Date.now();
    await internals.refreshCodexStamps();
    assert.ok(Date.now() - started < 150, 'the listing does not wait for a recovery');
    await internals.codexRead;
    assert.equal(p.chats.length, 0);
    p.codexLaunch = () => launchIn(answering, 'threads');
    await internals.refreshCodexStamps();
    await internals.codexRead;
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

test('with records, the panel\'s Codex threads with none are not recorded again: a chat deleted before 0.36.0', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-kept-`);
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  const internals = p as unknown as { refreshCodexStamps(): Promise<void>; codexRead: Promise<void> | null };
  p.chats = [{ id: 'p1', title: 'First', engine: 'codex', at: 0 }];
  try {
    p.codexLaunch = () => launchIn(dir, 'threads');
    await internals.refreshCodexStamps();
    await internals.codexRead;
    assert.deepEqual(p.chats.map((chat) => chat.id), ['p1']);
    // Its time, as Codex has it.
    assert.equal(p.chats[0].at, 1790000000 * 1000);
  } finally {
    stopCodexReader();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuilding by hand offers the Codex chats with no record back, and restores them only when confirmed', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-offer-`);
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  p.vaultRoot = () => null;
  p.listChats = async () => [];
  const asked: string[] = [];
  let answer = false;
  (p as unknown as { confirm(heading: string, message: string): Promise<boolean> }).confirm = async (_heading, message) => (asked.push(message), answer);
  p.chats = [{ id: 'p1', title: 'First', engine: 'codex', at: 0 }];
  try {
    p.codexLaunch = () => launchIn(dir, 'threads');
    await p.rebuildChatList();
    assert.equal(asked.length, 1);
    assert.match(asked[0], /A Codex chat started in the panel is not in the history: “Second”/);
    assert.deepEqual(p.chats.map((chat) => chat.id), ['p1']);
    answer = true;
    await p.rebuildChatList();
    assert.deepEqual(p.chats.map((chat) => chat.id).sort(), ['p1', 'p2']);
    // Quietly, after an update: not asked.
    await p.rebuildChatList(true);
    assert.equal(asked.length, 2);
    // Declined with a recovery waiting since start (records found empty): not restored behind the answer.
    p.chats = [{ id: 'p1', title: 'First', engine: 'codex', at: 0 }];
    answer = false;
    (p as unknown as { codexRecoverAll: boolean }).codexRecoverAll = true;
    await p.rebuildChatList();
    await (p as unknown as { codexRead: Promise<void> | null }).codexRead;
    assert.deepEqual(p.chats.map((chat) => chat.id), ['p1']);
  } finally {
    stopCodexReader();
    rmSync(dir, { recursive: true, force: true });
  }
});
