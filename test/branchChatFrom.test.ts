import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { branchChatFrom, cutChat, cutSessionText, projectFolder, uncutChat } from '../src/history';

/** A chat of three exchanges in vault `root`, under a Claude Code config dir of the test's own. */
function chat() {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-from-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const [u1, a1, u2, a2, u3, a3] = Array.from({ length: 6 }, () => randomUUID());
  let parent: string | null = null;
  const row = (uuid: string, type: 'user' | 'assistant', text: string) => {
    const line = JSON.stringify({ type, uuid, parentUuid: parent, sessionId: id, cwd: root, timestamp: new Date().toISOString(), message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] } });
    parent = uuid;
    return line;
  };
  const rows = [row(u1, 'user', 'first'), row(a1, 'assistant', 'one'), row(u2, 'user', 'second'), row(a2, 'assistant', 'two'), row(u3, 'user', 'third'), row(a3, 'assistant', 'three')];
  writeFileSync(`${dir}/${id}.jsonl`, `${rows.join('\n')}\n`);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  return {
    root,
    dir,
    id,
    uuids: { u1, a1, u2, a2, u3, a3 },
    done() {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
      rmSync(config, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const texts = (messages: { message: unknown }[]) =>
  messages.map((message) => {
    const content = (message.message as { content: unknown }).content;
    return typeof content === 'string' ? content : (content as { text: string }[])[0].text;
  });

test('a copy from a message on starts with it, keeps its title, and leaves the chat copied as it was', async () => {
  const { root, dir, id, uuids, done } = chat();
  try {
    const original = readFileSync(`${dir}/${id}.jsonl`, 'utf8');
    const copy = await branchChatFrom(id, root, 'From the second', uuids.u2);
    assert.deepEqual(texts(await getSessionMessages(copy, { dir: root })), ['second', 'two', 'third', 'three']);
    const rows = readFileSync(`${dir}/${copy}.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows[0].parentUuid, null);
    assert.equal(rows[0].forkedFrom.messageUuid, uuids.u2);
    assert.ok(rows.some((row) => row.type === 'custom-title' && row.customTitle === 'From the second'));
    assert.equal(readFileSync(`${dir}/${id}.jsonl`, 'utf8'), original);
    // Up to a reply as well: the middle exchange alone.
    const middle = await branchChatFrom(id, root, 'Middle', uuids.u2, uuids.a2);
    assert.deepEqual(texts(await getSessionMessages(middle, { dir: root })), ['second', 'two']);
  } finally {
    done();
  }
});

test('a copy from a message not in the chat fails, and leaves no copy behind', async () => {
  const { root, dir, id, done } = chat();
  try {
    await assert.rejects(branchChatFrom(id, root, 'Nowhere', randomUUID()), /not in the saved conversation/);
    assert.deepEqual(readdirSync(dir), [`${id}.jsonl`]);
  } finally {
    done();
  }
});

test('a chat cut at a message keeps what came before, and its title and mode rows after', () => {
  const rows = [
    { type: 'user', uuid: 'u1', parentUuid: null },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
    { type: 'user', uuid: 'u2', parentUuid: 'a1' },
    { type: 'custom-title', customTitle: 'T' },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
    { type: 'last-prompt', lastPrompt: 'x' },
  ];
  const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const result = cutSessionText(text, 'u2');
  assert.ok(result);
  assert.deepEqual(result.kept.trim().split('\n').map((line) => JSON.parse(line).uuid ?? JSON.parse(line).type), ['u1', 'a1', 'custom-title']);
  assert.deepEqual(result.cut.trim().split('\n').map((line) => JSON.parse(line).uuid ?? JSON.parse(line).type), ['u2', 'a2', 'last-prompt']);
  assert.equal(cutSessionText(text, 'nope'), null);
});

test('a saved chat cut at a message keeps its id and reads up to there; undo puts it back unless it changed', async () => {
  const { root, dir, id, uuids, done } = chat();
  try {
    const cut = await cutChat(id, root, uuids.u2);
    const left = (await getSessionMessages(id, { dir: root })).map((message) => message.uuid);
    assert.deepEqual(left, [uuids.u1, uuids.a1]);
    assert.equal(await uncutChat(id, root, cut), true);
    assert.equal((await getSessionMessages(id, { dir: root })).length, 6);
    // Something added since the cut: not put back.
    const again = await cutChat(id, root, uuids.u3);
    writeFileSync(`${dir}/${id}.jsonl`, `${readFileSync(`${dir}/${id}.jsonl`, 'utf8')}${JSON.stringify({ type: 'mode', mode: 'plan' })}\n`);
    assert.equal(await uncutChat(id, root, again), false);
    await assert.rejects(cutChat(id, root, 'not-there'));
  } finally {
    done();
  }
});
