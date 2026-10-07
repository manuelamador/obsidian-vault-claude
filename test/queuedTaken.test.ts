import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { loadChat, projectFolder, queuedTaken } from '../src/history';

test('a queued message taken up mid-turn is read from the end of the chat file, by its text and its uuid', async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-queued-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'queue-operation', operation: 'enqueue', content: 'and then this' },
    { type: 'attachment', uuid: 'a1', attachment: { type: 'queued_command', prompt: 'and then this' } },
    { type: 'attachment', uuid: 'a2', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: '<obsidian_context>…</obsidian_context>\n\nwith a note' }] } },
    // One whose own row is too large to read (an image in it): known by the small row saying it was taken up.
    { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', commandUuid: 'sent-uuid' },
  ];
  writeFileSync(`${dir}/s1.jsonl`, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const taken = await queuedTaken('s1', root);
    assert.equal(taken.texts.length, 2);
    assert.ok(taken.texts.some((prompt) => prompt === 'and then this'));
    assert.ok(taken.texts.some((prompt) => prompt.includes('with a note')));
    assert.ok(taken.uuids.has('sent-uuid'));
    // Drawn again from the file, the messages taken up mid-turn are there, in their place.
    const { transcript } = await loadChat('s1', root);
    assert.deepEqual(
      transcript.map((message) => (message.message as { content: unknown }).content),
      ['first', 'and then this', [{ type: 'text', text: '<obsidian_context>…</obsidian_context>\n\nwith a note' }]],
    );
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a queued message that became a message of its own is drawn once', async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-queued-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'attachment', uuid: 'a1', attachment: { type: 'queued_command', prompt: 'later', source_uuid: 'm2' } },
    { type: 'user', uuid: 'm2', message: { role: 'user', content: 'later' } },
  ];
  writeFileSync(`${dir}/s2.jsonl`, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const { transcript } = await loadChat('s2', root);
    assert.deepEqual(transcript.map((message) => message.uuid), ['m2']);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
