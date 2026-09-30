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
    const newer = session(
      prompt,
      '2026-09-28T10:00:00.000Z',
      Array.from({ length: 3 }, () => ({ type: 'attachment', cwd: root, attachment: { type: 'note', content: 'x'.repeat(40 * 1024) } })),
    );
    // A side chat still open on the original is neither a copy nor a second original.
    const side = session(prompt, '2026-09-29T10:00:00.000Z');
    // A chat forked in the desktop app shares its original's first prompt: an older copy of either
    // is marked as a copy but credited to neither, while one that names its original is credited.
    const forked = randomUUID();
    const desktop = session(forked, '2026-09-05T10:00:00.000Z');
    const desktopFork = session(forked, '2026-09-06T10:00:00.000Z');
    const unnamed = session(forked, '2026-09-07T10:00:00.000Z');
    const named = session(forked, '2026-09-08T10:00:00.000Z');
    // Two of the panel's own chats that share a first prompt (a kept side chat, say) are neither.
    const shared = randomUUID();
    const chat = session(shared, '2026-09-10T10:00:00.000Z');
    const kept = session(shared, '2026-09-11T10:00:00.000Z');
    const other = session(randomUUID(), '2026-09-12T10:00:00.000Z');
    // A copy listed while its first rows are still being written is matched once they are.
    const late = randomUUID();
    writeFileSync(`${dir}/${late}.jsonl`, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Papers database', sessionId: late })}\n`);
    const records: ChatRecord[] = [older, newer, unnamed, chat, kept, other, late].map((id) => ({ id, title: 'A chat' }));
    records.push({ id: named, title: 'A chat', copyOf: desktopFork });
    const list = async () => new Map((await listHistory(root, records, true, new Set([side]))).map((item) => [item.id, item]));
    const first = await list();
    const lateBefore = first.get(late)?.copied;
    writeFileSync(`${dir}/${late}.jsonl`, `${JSON.stringify({ type: 'user', uuid: prompt, parentUuid: null, sessionId: late, cwd: root, timestamp: '2026-09-14T13:54:15.000Z', message: { role: 'user', content: 'Build the papers database' } })}\n`, { flag: 'a' });
    const items = await list();
    const ids = (item: string) => items.get(item)?.copies?.map((copy) => copy.id);
    assert.equal(lateBefore, undefined);
    assert.deepEqual(ids(original), [newer, older, late]);
    assert.deepEqual([ids(desktop), ids(desktopFork)], [undefined, [named]]);
    assert.deepEqual(
      [older, newer, late, unnamed, named].map((id) => items.get(id)?.copied),
      [true, true, true, true, true],
    );
    for (const id of [side, chat, kept, other]) assert.deepEqual([items.get(id)?.copied, items.get(id)?.copies], [undefined, undefined]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
