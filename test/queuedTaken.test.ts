import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { projectFolder, queuedTaken } from '../src/history';

test('a queued message taken up mid-turn is read from the end of the chat file, by its text', async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-queued-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'queue-operation', operation: 'enqueue', content: 'and then this' },
    { type: 'attachment', uuid: 'a1', attachment: { type: 'queued_command', prompt: 'and then this' } },
    { type: 'attachment', uuid: 'a2', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: '<obsidian_context>…</obsidian_context>\n\nwith a note' }] } },
  ];
  writeFileSync(`${dir}/s1.jsonl`, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const taken = await queuedTaken('s1', root);
    assert.equal(taken.length, 2);
    assert.ok(taken.some((prompt) => prompt === 'and then this'));
    assert.ok(taken.some((prompt) => prompt.includes('with a note')));
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
