import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { entryBefore, lastMessages } from '../src/history';

/** A session file of `rows` for chat `id` in vault `root`, under a Claude Code config dir of the test's own. */
function session(rows: { uuid: string; parentUuid: string | null; type?: string; text?: string }[]) {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-entry-`);
  const root = '/vault';
  const dir = `${config}/projects/-vault`;
  mkdirSync(dir, { recursive: true });
  const lines = rows.map(({ uuid, parentUuid, type = 'user', text = uuid }) =>
    JSON.stringify({ type, uuid, parentUuid, sessionId: 'chat', message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] } }),
  );
  writeFileSync(`${dir}/chat.jsonl`, `${lines.join('\n')}\n`);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  return {
    root,
    done() {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
      rmSync(config, { recursive: true, force: true });
    },
  };
}

test('entryBefore: the entry before the earliest prompt found, null for the first turn, the last entry when none is there', async () => {
  const { root, done } = session([
    { uuid: 'u1', parentUuid: null },
    { uuid: 'a1', parentUuid: 'u1', type: 'assistant' },
    { uuid: 'n1', parentUuid: 'a1', type: 'attachment' },
    { uuid: 'u2', parentUuid: 'n1' },
    { uuid: 'u3', parentUuid: 'u2' },
    { uuid: 'a2', parentUuid: 'u3', type: 'assistant' },
    // Rows that are not entries of the chain come last in a file: a title, say.
    { uuid: '', parentUuid: null, type: 'ai-title' },
  ]);
  try {
    assert.equal(await entryBefore('chat', root, ['u3', 'u2']), 'n1');
    assert.equal(await entryBefore('chat', root, ['u3']), 'u2');
    assert.equal(await entryBefore('chat', root, ['u1']), null);
    assert.equal(await entryBefore('chat', root, ['u2', 'not-there']), 'n1');
    // Not written yet: the chat as it stands.
    assert.equal(await entryBefore('chat', root, ['not-there']), 'a2');
    assert.equal(await entryBefore('chat', root, []), 'a2');
    assert.equal(await entryBefore('no-such-chat', root, ['u1']), undefined);
  } finally {
    done();
  }
});

test('entryBefore and lastMessages read back past the first 256 KB, across a line split between reads', async () => {
  const long = 'x'.repeat(200 * 1024);
  const { root, done } = session([
    { uuid: 'u1', parentUuid: null },
    { uuid: 'a1', parentUuid: 'u1', type: 'assistant' },
    { uuid: 'u2', parentUuid: 'a1', text: 'the prompt' },
    { uuid: 'a2', parentUuid: 'u2', type: 'assistant', text: long },
    { uuid: 'a3', parentUuid: 'a2', type: 'assistant', text: long },
  ]);
  try {
    assert.equal(await entryBefore('chat', root, ['u2']), 'a1');
    // Further back than the search goes: the chat as it stands.
    assert.equal(await entryBefore('chat', root, ['u2'], 300 * 1024), 'a3');
    const prompts = await lastMessages('chat', root, (message) => message.type === 'user', 2);
    assert.deepEqual(
      prompts.map((message) => message.uuid),
      ['u1', 'u2'],
    );
  } finally {
    done();
  }
});
