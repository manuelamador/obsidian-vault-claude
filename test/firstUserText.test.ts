import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { firstUserText, listHistory, projectFolder } from '../src/history';

/** firstUserText as it was: the SDK's reader, asked for the first three messages. */
async function oldFirstUserText(id: string, dir: string): Promise<string | null> {
  const messages = await getSessionMessages(id, { dir, limit: 3 });
  for (const message of messages) {
    if (message.type !== 'user') continue;
    const content = (message.message as { content?: unknown } | null)?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const block = (content as { type?: string; text?: string }[]).find((item) => item.type === 'text');
      return block?.text ?? '';
    }
  }
  return null;
}

/** A fake vault and Claude Code config folder, with a way to write sessions into it. */
function setUp() {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-first-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const folder = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(folder, { recursive: true });
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  return {
    root,
    folder,
    done() {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
      rmSync(config, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Rows chained by parentUuid, as Claude Code writes them; rows with no uuid are left out of the chain. */
function chain(id: string, root: string, rows: object[]): object[] {
  let parent: string | null = null;
  return rows.map((row) => {
    if (!('message' in row)) return { sessionId: id, ...row };
    const uuid = randomUUID();
    const chained = { parentUuid: parent, uuid, sessionId: id, cwd: root, timestamp: '2026-01-01T00:00:00.000Z', ...row };
    if (!(row as { isSidechain?: boolean }).isSidechain) parent = uuid;
    return chained;
  });
}

const user = (content: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const reply = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('the first prompt read from the start of the file is what the SDK reader gave', async () => {
  const { root, folder, done } = setUp();
  try {
    const big = 'x'.repeat(200 * 1024);
    const cases: Record<string, { rows: object[]; newline?: boolean }> = {
      plain: { rows: [user('hello there'), reply('hi')] },
      'context block first': { rows: [user('<obsidian_context>\nnote.md\n</obsidian_context>\n\nsummarise this'), reply('ok')] },
      'image then text': { rows: [user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what is this' }]), reply('a square')] },
      'image alone': { rows: [user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]), reply('a square')] },
      'meta row before the prompt': { rows: [user('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }), user('the real prompt'), reply('ok')] },
      'bookkeeping rows before': {
        rows: [
          { type: 'file-history-snapshot', messageId: 'm', snapshot: { trackedFileBackups: {} } },
          { type: 'progress', uuid: randomUUID(), data: {} },
          { type: 'system', subtype: 'informational', uuid: randomUUID(), content: 'note' },
          user('after the bookkeeping'),
          reply('ok'),
        ],
      },
      'side chain first': { rows: [user('a subagent prompt', { isSidechain: true }), user('the chat prompt'), reply('ok')] },
      'three replies first': { rows: [reply('one'), reply('two'), reply('three'), user('too late')] },
      'tool result first': { rows: [user([{ type: 'tool_result', tool_use_id: 't1', content: 'done' }]), reply('ok')] },
      'no messages': { rows: [{ type: 'ai-title', aiTitle: 'A title' }, { type: 'last-prompt', lastPrompt: 'earlier' }] },
      'long row before the prompt': { rows: [{ type: 'file-history-snapshot', messageId: 'm', snapshot: { padding: big } }, user('past a long row ünïcödé ✓'), reply('ok')] },
      'multibyte across reads': { rows: [user(`${'é'.repeat(40 * 1024)} end`), reply('ok')] },
      'no newline at the end': { rows: [user('last line unterminated')], newline: false },
    };
    for (const [name, { rows, newline = true }] of Object.entries(cases)) {
      const id = randomUUID();
      const lines = chain(id, root, rows).map((row) => JSON.stringify(row));
      writeFileSync(`${folder}/${id}.jsonl`, lines.join('\n') + (newline ? '\n' : ''));
      assert.deepEqual(await firstUserText(id, root), await oldFirstUserText(id, root), name);
    }
    // A row still being written at the end is passed over, as the SDK passes it over.
    const partial = randomUUID();
    writeFileSync(`${folder}/${partial}.jsonl`, '{"type":"user","message":{"role":"us');
    assert.equal(await firstUserText(partial, root), null);
    // Not a session id: nothing read.
    assert.equal(await firstUserText('../elsewhere', root), null);
  } finally {
    done();
  }
});

test('a session with no prompt is left out until its file changes', async () => {
  const { root, folder, done } = setUp();
  try {
    const id = randomUUID();
    const file = `${folder}/${id}.jsonl`;
    writeFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Nothing yet', sessionId: id })}\n`);
    utimesSync(file, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    assert.deepEqual((await listHistory(root, [], true)).map((item) => item.id), []);
    assert.deepEqual((await listHistory(root, [], true)).map((item) => item.id), []);
    appendFileSync(file, `${chain(id, root, [user('now a prompt')]).map((row) => JSON.stringify(row)).join('\n')}\n`);
    assert.deepEqual((await listHistory(root, [], true)).map((item) => item.id), [id]);
  } finally {
    done();
  }
});
