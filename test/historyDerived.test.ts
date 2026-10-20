import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { listHistory, projectFolder } from '../src/history';

test('the history lists the SDK sessions as panel chats without records, leaving out the terminal and side chats', async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-derived-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  const session = (entrypoint: string, text: string, customTitle?: string) => {
    const id = randomUUID();
    const uuid = randomUUID();
    const rows: object[] = [
      { type: 'user', uuid, parentUuid: null, sessionId: id, cwd: root, entrypoint, timestamp: new Date().toISOString(), message: { role: 'user', content: text } },
      { type: 'assistant', uuid: randomUUID(), parentUuid: uuid, sessionId: id, cwd: root, entrypoint, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ];
    if (customTitle) rows.push({ type: 'custom-title', customTitle, sessionId: id });
    // Large enough to be read as a full session, not as one that may hold no prompt.
    rows.push({ type: 'summary', summary: 'x'.repeat(20_000), leafUuid: uuid });
    writeFileSync(`${dir}/${id}.jsonl`, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    return id;
  };
  try {
    const plain = session('sdk-ts', 'a chat sent with no note open');
    const withContext = session('sdk-ts', '<obsidian_context>\nNote: a.md\n</obsidian_context>\n\nabout this note');
    const renamed = session('sdk-ts', 'first prompt', 'Renamed chat');
    const side = session('sdk-ts', 'a side chat');
    const terminal = session('cli', 'from the terminal');
    const items = await listHistory(root, [], false, new Set([side]));
    const byId = new Map(items.map((item) => [item.id, item]));
    assert.deepEqual([...byId.keys()].sort(), [plain, withContext, renamed].sort());
    assert.equal(byId.get(plain)?.title, 'a chat sent with no note open');
    assert.equal(byId.get(withContext)?.title, 'about this note');
    assert.equal(byId.get(renamed)?.title, 'Renamed chat');
    assert.ok(items.every((item) => item.fromPanel));
    const all = await listHistory(root, [], true, new Set([side]));
    assert.equal(all.find((item) => item.id === terminal)?.fromPanel, false);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
