import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { listHistory, projectFolder } from '../src/history';

test("a chat is dated by its last prompt or reply, not by rows added to its file afterwards", async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-active-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  // Each message follows the last one written, as Claude Code chains them.
  const last = new Map<string, string>();
  const row = (id: string, type: 'user' | 'assistant', at: string, text: string, extra: object = {}) => {
    const uuid = randomUUID();
    const line = JSON.stringify({ type, uuid, parentUuid: last.get(id) ?? null, sessionId: id, cwd: root, timestamp: at, message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] }, ...extra });
    last.set(id, uuid);
    return line;
  };
  // What is added to a session that is not a prompt or reply: rows with no time, as Claude Code exits or
  // the desktop app starts, and a timed one, as Remote Control starts.
  const bookkeeping = (id: string) =>
    [
      { type: 'system', subtype: 'bridge_status', content: '/remote-control is active', isMeta: false, timestamp: new Date().toISOString(), uuid: randomUUID(), sessionId: id },
      { type: 'bridge-session', sessionId: id, bridgeSessionId: 'cse_x' },
      { type: 'last-prompt', lastPrompt: 'hi', sessionId: id },
    ]
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join('');
  const session = (at: string, reply = 'ok') => {
    const id = randomUUID();
    writeFileSync(`${dir}/${id}.jsonl`, `${row(id, 'user', at, 'hi')}\n${row(id, 'assistant', at, reply)}\n${bookkeeping(id)}`);
    return id;
  };
  const dates = async () => new Map((await listHistory(root, [], true)).map((item) => [item.id, new Date(item.updatedAt).toISOString()]));
  try {
    const older = session('2026-09-01T10:00:00.000Z');
    const newer = session('2026-09-10T10:00:00.000Z');
    // A last reply longer than the first read of the file's end.
    const long = session('2026-09-05T10:00:00.000Z', 'x'.repeat(200 * 1024));
    // A copy of a chat, as the SDK writes one: every row keeps its original's time but the last,
    // which has the time of copying, here the end of a turn.
    const copy = randomUUID();
    const copied = { forkedFrom: { sessionId: older, messageUuid: randomUUID() } };
    const turnEnd = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1000, uuid: randomUUID(), parentUuid: null, sessionId: copy, timestamp: '2026-09-25T10:00:00.000Z', ...copied });
    writeFileSync(
      `${dir}/${copy}.jsonl`,
      `${row(copy, 'user', '2026-09-02T10:00:00.000Z', 'hi', copied)}\n${row(copy, 'assistant', '2026-09-02T10:00:00.000Z', 'ok', copied)}\n${turnEnd}\n${bookkeeping(copy)}`,
    );
    // All four files were written just now; the chats keep their own dates, newest first.
    assert.deepEqual([...(await dates()).entries()], [
      [copy, '2026-09-25T10:00:00.000Z'],
      [newer, '2026-09-10T10:00:00.000Z'],
      [long, '2026-09-05T10:00:00.000Z'],
      [older, '2026-09-01T10:00:00.000Z'],
    ]);
    // More bookkeeping later changes nothing; a new reply does.
    appendFileSync(`${dir}/${older}.jsonl`, bookkeeping(older));
    assert.equal((await dates()).get(older), '2026-09-01T10:00:00.000Z');
    appendFileSync(`${dir}/${older}.jsonl`, `${row(older, 'assistant', '2026-09-20T10:00:00.000Z', 'later')}\n`);
    assert.equal((await dates()).get(older), '2026-09-20T10:00:00.000Z');
    // A file whose time and size are as they were is not read again.
    const file = `${dir}/${newer}.jsonl`;
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('2026-09-10', '2026-09-11'));
    utimesSync(file, 1_790_000_000, 1_790_000_000);
    assert.equal((await dates()).get(newer), '2026-09-11T10:00:00.000Z');
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('2026-09-11', '2026-09-12'));
    utimesSync(file, 1_790_000_000, 1_790_000_000);
    assert.equal((await dates()).get(newer), '2026-09-11T10:00:00.000Z');
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
