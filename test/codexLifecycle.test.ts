import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { codexAccessModes, codexTurnAccess, readCodexChoices } from '../src/codexAccess';
import { CodexSession, runCodexOneShot, stopCodexReader } from '../src/codexSession';

import { launchIn } from './fakeCodex';

test('a one-off request to Codex ends when Codex exits mid-turn, rather than waiting for ever', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
  try {
    await assert.rejects(runCodexOneShot(launchIn(dir), { system: 's', prompt: 'p' }, () => undefined, new AbortController().signal));
    // It did start: what ended it was Codex exiting mid-turn.
    assert.equal(existsSync(`${dir}/started`), true);
  } finally {
    stopCodexReader();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a one-off request given up before it began starts nothing', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
  try {
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(await runCodexOneShot(launchIn(dir), { system: 's', prompt: 'p' }, () => undefined, aborted.signal), '');
    assert.equal(existsSync(`${dir}/started`), false);
  } finally {
    stopCodexReader();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex chat closed right after a message is sent starts no Codex', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
  try {
    const handlers = { onMessage: () => undefined, onEnd: () => undefined, onPermission: async () => ({ behavior: 'deny' as const, message: '' }) };
    const session = new CodexSession(launchIn(dir), handlers as never);
    session.send('hello');
    session.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(`${dir}/started`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a one-off request to Codex is not held up by a question Codex asks: it is refused, and the turn goes on', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
  try {
    assert.equal(await runCodexOneShot(launchIn(dir, 'ask'), { system: 's', prompt: 'p' }, () => undefined, new AbortController().signal), '');
  } finally {
    stopCodexReader();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex chat sends its permissions with each turn: the sandbox, when it asks, and who answers', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
  try {
    let ended: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (ended = resolve));
    const handlers = { onMessage: () => undefined, onEnd: () => ended(), onPermission: async () => ({ behavior: 'deny' as const, message: '' }) };
    const session = new CodexSession({ ...launchIn(dir), access: 'readOnly' }, handlers as never);
    session.setAccess('ask');
    session.send('hello');
    await done;
    const params = JSON.parse(readFileSync(`${dir}/turn.json`, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(params.sandboxPolicy, { type: 'workspaceWrite', networkAccess: false });
    assert.equal(params.approvalPolicy, 'untrusted');
    assert.equal(params.approvalsReviewer, 'user');
    session.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex permissions: each choice as Codex takes it, and Full access only when bypass is offered', () => {
  assert.deepEqual(codexTurnAccess('readOnly'), { sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
  assert.equal(codexTurnAccess('default').approvalPolicy, 'on-request');
  assert.equal(codexTurnAccess('autoReview').approvalsReviewer, 'auto_review');
  assert.deepEqual(codexTurnAccess('full'), { sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' });
  assert.deepEqual(Object.keys(codexAccessModes(false)), ['readOnly', 'ask', 'default', 'autoReview']);
  assert.equal('full' in codexAccessModes(true), true);
});

test("a Codex chat's choices are read back as kept, what is not one left out", () => {
  assert.deepEqual(readCodexChoices({ model: 'gpt-5.5', effort: 'high', access: 'ask' }), { model: 'gpt-5.5', effort: 'high', access: 'ask' });
  assert.deepEqual(readCodexChoices({ model: '', effort: 3, access: 'everything' }), {});
  assert.equal(readCodexChoices(null), undefined);
});
