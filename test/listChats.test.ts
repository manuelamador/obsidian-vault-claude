import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';
import { projectFolder } from '../src/history';

test('the chats as last listed are kept for the history; listings at once share one, and a deleted chat leaves the list', async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-list-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) {
    const row = { type: 'user', uuid: randomUUID(), parentUuid: null, sessionId: id, cwd: root, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } };
    writeFileSync(`${dir}/${id}.jsonl`, `${JSON.stringify(row)}\n`);
  }
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  p.vaultRoot = () => root;
  p.settings = { ...p.settings, historyIncludesAllSessions: true };
  (p as unknown as { app: unknown }).app = { workspace: { getLeavesOfType: () => [] } };
  try {
    assert.equal(p.listedChats(), null);
    const first = p.listChats();
    assert.equal(p.listChats(), first);
    assert.deepEqual((await first).map((item) => item.id).sort(), [...ids].sort());
    assert.deepEqual(p.listedChats()?.map((item) => item.id).sort(), [...ids].sort());
    const second = p.listChats();
    assert.notEqual(second, first);
    await second;
    assert.equal(await p.deleteChat(ids[0]), true);
    assert.deepEqual(p.listedChats()?.map((item) => item.id), [ids[1]]);
    // A chat being deleted is left out of a listing already running, even while its file is there.
    const running = p.listChats();
    (p as unknown as { unlist(id: string): void }).unlist(ids[1]);
    assert.deepEqual(await running, []);
    // Links to sessions whose files are gone are let go at startup; those of sessions still there stay.
    // So are links to notes no longer on disk.
    for (const note of ['A.md', 'B.md', 'C.md']) writeFileSync(`${root}/${note}`, '');
    p.noteChats = { 'A.md': [ids[0], ids[1]], 'Gone/Deleted.md': [ids[1]] };
    p.noteRefs = { 'B.md': [ids[0]] };
    p.noteMentions = { 'C.md': [ids[1], 'gone-too'] };
    await p.pruneNoteLinks();
    assert.deepEqual([p.noteChats, p.noteRefs, p.noteMentions], [{ 'A.md': [ids[1]] }, {}, { 'C.md': [ids[1]] }]);
    // A note that is not on disk is not linked, however the chat reports it: made and deleted in one
    // reply, or seen again in a saved chat after it was deleted.
    p.linkNoteChat('Gone/Deleted.md', ids[1]);
    p.linkNoteRef('Gone/Deleted.md', ids[1]);
    p.linkNoteMention('Gone/Deleted.md', ids[1]);
    p.linkNoteChat('B.md', ids[1]);
    assert.deepEqual([p.noteChats, p.noteRefs, p.noteMentions], [{ 'A.md': [ids[1]], 'B.md': [ids[1]] }, {}, { 'C.md': [ids[1]] }]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a chat's search text is kept, and read again only when its file changes", async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-text-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  const id = randomUUID();
  const file = `${dir}/${id}.jsonl`;
  const row = (text: string) => JSON.stringify({ type: 'user', uuid: randomUUID(), parentUuid: null, sessionId: id, cwd: root, message: { role: 'user', content: text } });
  // A whole second, which setting the time again reproduces exactly.
  const when = new Date('2026-09-01T12:00:00Z');
  writeFileSync(file, `${row('apples')}\n`);
  utimesSync(file, when, when);
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.vaultRoot = () => root;
  try {
    assert.match(await p.chatSearchText(id), /apples/);
    // Same size and time: the text kept is used, not the file's.
    writeFileSync(file, `${row('pears!')}\n`);
    utimesSync(file, when, when);
    assert.match(await p.chatSearchText(id), /apples/);
    // Changed: read again.
    writeFileSync(file, `${row('pears and plums')}\n`);
    assert.match(await p.chatSearchText(id), /pears and plums/);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
