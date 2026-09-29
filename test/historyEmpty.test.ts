import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { listHistory, projectFolder } from '../src/history';

test('the history leaves out a session with no messages, and keeps one that starts with an image alone', async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-empty-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  const session = (title: string, content?: unknown) => {
    const id = randomUUID();
    const rows: object[] = [];
    if (content !== undefined) {
      const uuid = randomUUID();
      rows.push({ type: 'user', uuid, parentUuid: null, sessionId: id, cwd: root, timestamp: new Date().toISOString(), message: { role: 'user', content } });
      rows.push({ type: 'assistant', uuid: randomUUID(), parentUuid: uuid, sessionId: id, cwd: root, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    }
    // What Claude Code writes as its process exits: no messages, a title among them.
    rows.push({ type: 'ai-title', aiTitle: title, sessionId: id }, { type: 'last-prompt', lastPrompt: 'earlier', sessionId: id });
    writeFileSync(`${dir}/${id}.jsonl`, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    return id;
  };
  try {
    const chat = session('A chat', 'hello');
    const image = session('An image', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }]);
    session('Left behind');
    const ids = (await listHistory(root, [], true)).map((item) => item.id).sort();
    assert.deepEqual(ids, [chat, image].sort());
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
