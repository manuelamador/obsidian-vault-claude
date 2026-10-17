import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { loadChat, projectFolder } from '../src/history';

test('a long chat opened again reads only what was added; a file rewritten since is read whole', async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-reread-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/s1.jsonl`;
  const row = (uuid: string, content: string) => `${JSON.stringify({ type: 'user', uuid, message: { role: 'user', content } })}\n`;
  // Bookkeeping rows make it long enough to be remembered; they are skipped, not drawn.
  const padding = `${JSON.stringify({ type: 'api-request', body: 'x'.repeat(5 * 1024 * 1024) })}\n`;
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  const texts = async () => (await loadChat('s1', root, true)).transcript.map((message) => (message.message as { content: unknown }).content);
  try {
    writeFileSync(file, row('u1', 'first') + padding + row('u2', 'second'));
    assert.deepEqual(await texts(), ['first', 'second']);
    // A row added, and one still being written: the whole one is read, the other waits.
    appendFileSync(file, row('u3', 'third') + '{"type":"user","uuid":"u4"');
    assert.deepEqual(await texts(), ['first', 'second', 'third']);
    appendFileSync(file, `,"message":{"role":"user","content":"fourth"}}\n`);
    assert.deepEqual(await texts(), ['first', 'second', 'third', 'fourth']);
    // Two reads at once, after a row was added: each sees it once.
    appendFileSync(file, row('u5', 'fifth'));
    const [a, b] = await Promise.all([texts(), texts()]);
    assert.deepEqual(a, ['first', 'second', 'third', 'fourth', 'fifth']);
    assert.deepEqual(b, a);
    // Rewritten (a chat cut, say), even to a longer file: read again from the start.
    writeFileSync(file, row('v1', 'other') + padding + row('v2', 'rows') + row('v3', 'here') + row('v4', 'now') + row('v5', 'longer'));
    assert.deepEqual(await texts(), ['other', 'rows', 'here', 'now', 'longer']);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
