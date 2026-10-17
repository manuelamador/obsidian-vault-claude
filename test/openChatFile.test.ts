import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { openChatFile, projectFolder } from '../src/history';

test('a long chat opens on its last messages, read from the end, and the whole chat comes after', async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-open-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const row = (type: string, uuid: string, content: string) => `${JSON.stringify({ type, uuid, message: { role: type, content } })}\n`;
  // Bookkeeping makes it long; it is passed over unparsed.
  const padding = `${JSON.stringify({ type: 'api-request', body: 'x'.repeat(5 * 1024 * 1024) })}\n`;
  const turns = Array.from({ length: 6 }, (_, i) => row('user', `p${i}`, `prompt ${i}`) + row('assistant', `a${i}`, `reply ${i}`)).join('');
  writeFileSync(`${dir}/s1.jsonl`, padding + turns);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    // Enough: two of your messages.
    const opened = await openChatFile('s1', root, (messages) => messages.filter((message) => message.type === 'user').length >= 2);
    assert.ok(opened?.rest);
    assert.deepEqual(opened.chat.transcript.map((message) => message.uuid), ['p4', 'a4', 'p5', 'a5']);
    assert.equal((await opened.rest).transcript.length, 12);
    // Read whole once: opened again from what is remembered, all of it at once.
    const again = await openChatFile('s1', root, () => true);
    assert.equal(again?.rest, null);
    assert.equal(again?.chat.transcript.length, 12);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
