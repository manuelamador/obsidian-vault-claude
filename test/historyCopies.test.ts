import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { listHistory, projectFolder, type ChatRecord } from '../src/history';

test('a chat started outside the panel is linked to the copies of it the panel made, which share its first prompt', async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-copies-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  /** A session whose first prompt has uuid `first`, answered at `at`; `lead` goes before it. */
  const session = (first: string, at: string, lead: object[] = []) => {
    const id = randomUUID();
    const reply = randomUUID();
    const rows = [
      ...lead,
      { type: 'user', uuid: first, parentUuid: null, sessionId: id, cwd: root, timestamp: '2026-09-14T13:54:15.000Z', message: { role: 'user', content: `Build the papers database ${'y'.repeat(20 * 1024)}` } },
      { type: 'assistant', uuid: reply, parentUuid: first, sessionId: id, cwd: root, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
      // The title Claude Code writes, which lists a session whose first prompt is too far in for the SDK to see.
      { type: 'ai-title', aiTitle: 'Papers database', sessionId: id },
    ];
    writeFileSync(`${dir}/${id}.jsonl`, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    return id;
  };
  try {
    const prompt = randomUUID();
    const original = session(prompt, '2026-09-20T10:00:00.000Z');
    const older = session(prompt, '2026-09-17T10:00:00.000Z');
    // Its first prompt starts after the first read of the file, and runs past the second's end.
    const newer = session(prompt, '2026-09-28T10:00:00.000Z', Array.from({ length: 3 }, () => ({ type: 'attachment', cwd: root, attachment: { type: 'note', content: 'x'.repeat(40 * 1024) } })));
    // Two of the panel's own chats that share a first prompt (a kept side chat, say) are neither.
    const shared = randomUUID();
    const chat = session(shared, '2026-09-10T10:00:00.000Z');
    const kept = session(shared, '2026-09-11T10:00:00.000Z');
    const other = session(randomUUID(), '2026-09-12T10:00:00.000Z');
    const records: ChatRecord[] = [older, newer, chat, kept, other].map((id) => ({ id, title: 'A chat' }));
    const items = new Map((await listHistory(root, records, true)).map((item) => [item.id, item]));
    assert.deepEqual(
      items.get(original)?.copies?.map((copy) => copy.id),
      [newer, older],
    );
    assert.deepEqual([items.get(older)?.copyOf, items.get(newer)?.copyOf], [original, original]);
    for (const id of [chat, kept, other]) assert.deepEqual([items.get(id)?.copyOf, items.get(id)?.copies], [undefined, undefined]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
