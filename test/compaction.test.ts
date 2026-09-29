import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compactionText } from '../src/chatText';
import { lastMessages, loadTranscript } from '../src/history';
import { startsTurn } from '../src/chatText';

test('the compaction line says how and at what size the context was compacted', () => {
  assert.equal(compactionText('auto', 968287), `Context compacted automatically at ${(968287).toLocaleString()} tokens`);
  assert.equal(compactionText('manual', 0), 'Context compacted on request');
  assert.equal(compactionText(undefined, undefined), 'Context compacted');
});

test('a reopened chat keeps the compaction boundary in place and leaves out the summary', async () => {
  const config = await mkdtemp(path.join(tmpdir(), 'vc-compaction-'));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const dir = '/vault';
    await mkdir(path.join(config, 'projects', '-vault'), { recursive: true });
    const rows = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
      { type: 'system', subtype: 'compact_boundary', uuid: 's1', compactMetadata: { trigger: 'auto', preTokens: 900000 } },
      { type: 'user', uuid: 'u2', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } },
      { type: 'user', uuid: 'u3', message: { role: 'user', content: 'second' } },
    ];
    await writeFile(path.join(config, 'projects', '-vault', 'chat.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
    const transcript = await loadTranscript('chat', dir);
    assert.deepEqual(
      transcript.map((message) => message.uuid),
      ['u1', 'a1', 's1', 'u3'],
    );
    assert.equal(transcript[2].type, 'system');
    assert.deepEqual(transcript[2].message, { subtype: 'compact_boundary', trigger: 'auto', preTokens: 900000 });
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    await rm(config, { recursive: true, force: true });
  }
});

test('prompts are read from the end of a long session file, the part read growing as needed', async () => {
  const config = await mkdtemp(path.join(tmpdir(), 'vc-tail-'));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    await mkdir(path.join(config, 'projects', '-vault'), { recursive: true });
    const row = (type: string, uuid: string, content: unknown) => JSON.stringify({ type, uuid, message: { role: type, content } });
    // About a megabyte of replies, of two-byte characters, so windows start mid-line and mid-character.
    const filler = Array.from({ length: 2000 }, (_, i) => row('assistant', `f${i}`, [{ type: 'text', text: 'é'.repeat(250) }]));
    const file = path.join(config, 'projects', '-vault', 'long.jsonl');
    const last = async (...args: [((m: Parameters<typeof startsTurn>[0]) => boolean)?, number?, number?]) =>
      (await lastMessages('long', '/vault', args[0] ?? startsTurn, args[1], args[2])).map((m) => m.uuid).join(',');
    // The latest prompt, near the end.
    await writeFile(file, [row('user', 'p1', 'first'), ...filler, row('user', 'p2', 'latest'), row('assistant', 'a', [{ type: 'text', text: 'ok' }])].join('\n'));
    assert.equal(await last(), 'p2');
    // A prompt longer than the first part read (a large screenshot) is still found at the end.
    const screenshot = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(600_000) } }, { type: 'text', text: 'see this' }];
    await writeFile(file, [row('user', 'p1', 'first'), ...filler, row('user', 'big', screenshot)].join('\n'));
    assert.equal(await last(), 'big');
    // Far back: found once the part read reaches it.
    await writeFile(file, [row('user', 'p1', 'first'), ...filler].join('\n'));
    assert.equal(await last(), 'p1');
    // By uuid, several in the order written; a uuid not in the file stops at maxBytes rather than reading on.
    await writeFile(file, [row('user', 'p1', 'first'), ...filler, row('user', 'q1', 'one'), row('user', 'q2', 'two')].join('\n'));
    const wanted = new Set(['q1', 'q2']);
    assert.equal(await last((m) => wanted.has(m.uuid), 2), 'q1,q2');
    assert.equal(await last((m) => m.uuid === 'p1', 1, 256 * 1024), '');
    // The cap holds for the total read, not only before each read: a prompt about 400 KB from the
    // end is past a 300 KB cap, although the second read (twice the first) would reach it.
    const tail400 = filler.slice(-700);
    await writeFile(file, [row('user', 'p1', 'first'), ...filler.slice(0, 100), row('user', 'far', 'far back'), ...tail400].join('\n'));
    assert.equal(await last((m) => m.uuid === 'far', 1, 300 * 1024), '');
    assert.equal(await last((m) => m.uuid === 'far', 1), 'far');
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    await rm(config, { recursive: true, force: true });
  }
});
