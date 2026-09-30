import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';
import { projectFolder } from '../src/history';
import { ChatView } from '../src/view';

/** A plugin whose scratch chat has a saved session, in a vault and Claude Code config dir of the test's own. */
function setup() {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-clear-`);
  const root = mkdtempSync(`${tmpdir()}/vault-claude-vault-`);
  const dir = `${config}/projects/${projectFolder(root)}`;
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const file = `${dir}/${id}.jsonl`;
  writeFileSync(file, `${JSON.stringify({ type: 'user', uuid: randomUUID(), parentUuid: null, sessionId: id, message: { role: 'user', content: 'hi' } })}\n`);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  p.vaultRoot = () => root;
  p.scratch = { id, usedAt: Date.now() };
  const views: ChatView[] = [];
  (p as unknown as { app: unknown }).app = { workspace: { getLeavesOfType: () => views.map((view) => ({ view })) } };
  /** A panel, showing the scratch chat or not, whose process takes `endMs` to end once it starts over. */
  const panel = (shows: boolean, endMs = 0) => {
    const view = Object.create(ChatView.prototype) as ChatView;
    const calls: string[] = [];
    let showing = shows;
    view.isScratchChat = () => showing;
    view.holdsChat = () => showing;
    view.closeBackgroundChat = (chat) => void calls.push(`background ${chat === id}`);
    view.keepAsChat = (chat) => void calls.push(`kept as a chat ${chat === id}`);
    view.startScratchOver = () => {
      calls.push('started over');
      showing = false;
      p.processEnding(id, new Promise((resolve) => setTimeout(resolve, endMs)));
    };
    views.push(view);
    return { view, calls };
  };
  return {
    p,
    file,
    panel,
    done() {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
      rmSync(config, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('clearing the scratch chat starts the panels showing it over, and deletes its session once their processes have ended', async () => {
  const { p, file, panel, done } = setup();
  const showing = panel(true, 80);
  const other = panel(false);
  const id = p.scratch!.id;
  p.ticks[id] = { r: [1] };
  p.drafts[id] = { text: 'unsent' };
  try {
    const clearing = p.clearScratchChat();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The process is still ending: the file stays until it has, or its exit would write it again.
    assert.equal(existsSync(file), true);
    await clearing;
    assert.equal(existsSync(file), false);
    assert.equal(p.scratch, null);
    // What it left goes with it.
    assert.deepEqual([p.ticks[id], p.drafts[id]], [undefined, undefined]);
    assert.deepEqual(showing.calls, ['started over', 'background true']);
    assert.deepEqual(other.calls, ['background true']);
  } finally {
    done();
  }
});

test('with no vault folder, deleting a chat says it could not and forgets nothing', async () => {
  const { p, done } = setup();
  p.vaultRoot = () => null;
  p.chats = [{ id: 'c', title: 'C' }];
  try {
    assert.equal(await p.deleteChat('c'), false);
    assert.equal(p.chats.length, 1);
  } finally {
    done();
  }
});

test('opening a chat does not wait for its closed process to exit; deleting it does', async () => {
  const { p, done } = setup();
  let exited = false;
  p.processEnding(
    'closed',
    new Promise((resolve) =>
      setTimeout(() => {
        exited = true;
        resolve();
      }, 60),
    ),
  );
  try {
    await p.sessionEnded('closed');
    assert.equal(exited, false);
    await (p as unknown as { processesEnded(id: string): Promise<void> }).processesEnded('closed');
    assert.equal(exited, true);
  } finally {
    done();
  }
});

test('a scratch chat another panel still shows is let go of, not deleted under it', async () => {
  const { p, file, panel, done } = setup();
  const holder = panel(true);
  const asking = panel(false);
  const id = p.scratch!.id;
  p.drafts[id] = { text: 'unsent' };
  try {
    await p.clearScratch(asking.view);
    // It goes on as a chat, its unsent text with it.
    assert.equal(p.drafts[id]?.text, 'unsent');
    assert.equal(p.scratch, null);
    assert.equal(existsSync(file), true);
    // It goes on there as an ordinary chat.
    assert.deepEqual(holder.calls, ['kept as a chat true']);
  } finally {
    done();
  }
});
