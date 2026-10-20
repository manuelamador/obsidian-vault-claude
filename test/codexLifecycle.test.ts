import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { codexAccessModes, codexTurnAccess, readCodexChoices } from '../src/codexAccess';
import { readClaudeChoices } from '../src/chatChoices';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { CodexConnection } from '../src/codexConnection';
import { unframe } from '../src/codexSocket';
import { contextApart, CodexSession, runCodexOneShot, stopCodexReader } from '../src/codexSession';

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

test('a Codex chat sends its permissions with each turn (the sandbox, when it asks, who answers), its fast mode and its message id', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
  try {
    let ended: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (ended = resolve));
    const handlers = { onMessage: () => undefined, onEnd: () => ended(), onPermission: async () => ({ behavior: 'deny' as const, message: '' }) };
    const session = new CodexSession({ ...launchIn(dir), access: 'readOnly' }, handlers as never);
    session.setAccess('ask');
    await session.setFastMode(true);
    session.send('hello', undefined, 'panel-uuid-1');
    await done;
    const params = JSON.parse(readFileSync(`${dir}/turn.json`, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(params.sandboxPolicy, { type: 'workspaceWrite', networkAccess: false });
    assert.equal(params.approvalPolicy, 'untrusted');
    assert.equal(params.approvalsReviewer, 'user');
    // Fast mode asks for Codex's fast tier for the turn; the message goes with the id the panel drew it under.
    assert.equal(params.serviceTierForTurn, 'priority');
    assert.equal(params.clientUserMessageId, 'panel-uuid-1');
    session.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a connector's confirmation (Gmail sending, say) reaches the approval card, and its answer goes back to Codex", async () => {
  for (const allow of [true, false]) {
    const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
    try {
      let ended: () => void = () => undefined;
      const done = new Promise<void>((resolve) => (ended = resolve));
      const asked: { toolName: string; title?: string; input: Record<string, unknown> }[] = [];
      const handlers = {
        onMessage: () => undefined,
        onEnd: () => ended(),
        onPermission: async (request: { toolName: string; title?: string; input: Record<string, unknown> }) => {
          asked.push(request);
          return allow ? { behavior: 'allow' as const, updatedInput: {} } : { behavior: 'deny' as const, message: '' };
        },
      };
      const session = new CodexSession(launchIn(dir, 'elicit'), handlers as never);
      session.send('send it');
      await done;
      assert.equal(asked[0]?.toolName, 'mcp__gmail');
      assert.equal(asked[0]?.title, 'gmail asks for your confirmation');
      assert.equal(asked[0]?.input.description, 'Send this email?');
      const answer = JSON.parse(readFileSync(`${dir}/answer.json`, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(answer, allow ? { action: 'accept', content: { note: 'ok' } } : { action: 'decline' });
      session.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

test("a Claude chat's choices are read back as kept: never Plan, and null for Claude Code's own model", () => {
  assert.deepEqual(readClaudeChoices({ model: 'sonnet', effort: 'high', mode: 'acceptEdits' }), { model: 'sonnet', effort: 'high', mode: 'acceptEdits' });
  assert.deepEqual(readClaudeChoices({ model: null, effort: 'huge', mode: 'plan' }), { model: null });
  assert.deepEqual(readClaudeChoices({}), {});
});

test("a Codex chat kept out of Codex's lists is unarchived before it resumes; a shared one whose daemon cannot be reached runs a process of its own", async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
  try {
    let ended: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (ended = resolve));
    const handlers = { onMessage: () => undefined, onEnd: () => ended(), onPermission: async () => ({ behavior: 'deny' as const, message: '' }) };
    const session = new CodexSession({ ...launchIn(dir), resume: 't1', hidden: true, shared: true, socketPath: `${dir}/no-daemon.sock` }, handlers as never);
    session.send('hello');
    await done;
    const methods = readFileSync(`${dir}/methods.log`, 'utf8').trim().split('\n');
    assert.ok(methods.indexOf('thread/unarchive') >= 0 && methods.indexOf('thread/unarchive') < methods.indexOf('thread/resume'), methods.join(','));
    assert.equal(readFileSync(`${dir}/started`, 'utf8'), 'app-server');
    session.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hidden Codex chat is archived when the panel lets go of it", async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
  try {
    const handlers = { onMessage: () => undefined, onEnd: () => undefined, onPermission: async () => ({ behavior: 'deny' as const, message: '' }) };
    // 'ask' keeps the turn open, so the session is still running when it is closed.
    const session = new CodexSession({ ...launchIn(dir, 'ask'), hidden: true }, handlers as never);
    session.send('hello');
    for (let i = 0; i < 100 && !existsSync(`${dir}/turn.json`); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    session.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(readFileSync(`${dir}/methods.log`, 'utf8').includes('thread/archive'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Codex connection to the shared app-server speaks WebSocket over its socket: the upgrade, then JSON-RPC in text messages", async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
  const path = `${dir}/daemon.sock`;
  const seen: string[] = [];
  // A stand-in daemon: answers the upgrade, then each request with its method's name.
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /sec-websocket-key:\s*(\S+)/i.exec(buffer.subarray(0, end).toString())?.[1] ?? '';
        buffer = buffer.subarray(end + 4);
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
      }
      for (let parsed = unframe(buffer); parsed; parsed = unframe(buffer)) {
        buffer = buffer.subarray(parsed.length);
        if (parsed.opcode !== 1) continue;
        const message = JSON.parse(parsed.payload.toString()) as { id?: number; method?: string };
        seen.push(message.method ?? '');
        if (message.id === undefined) continue;
        // thread/list answers a large message, sent in small pieces, as a long thread's would come.
        const result = message.method === 'thread/list' ? { method: message.method, big: 'x'.repeat(200_000) } : { method: message.method };
        const reply = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        const head = reply.length < 126 ? Buffer.from([0x81, reply.length]) : Buffer.from([0x81, 127, 0, 0, 0, 0, (reply.length >>> 24) & 255, (reply.length >>> 16) & 255, (reply.length >>> 8) & 255, reply.length & 255]);
        const whole = Buffer.concat([head, reply]);
        for (let at = 0; at < whole.length; at += 4096) socket.write(whole.subarray(at, at + 4096));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    const connection = new CodexConnection({ codexPath: '/nonexistent', cwd: dir, env: {}, shared: true, socketPath: path }, {}, { timeoutMs: 1500 });
    await connection.ready;
    const listed = (await connection.request('thread/list', {})) as { method: string; big: string };
    assert.equal(listed.method, 'thread/list');
    assert.equal(listed.big.length, 200_000);
    connection.stop();
    assert.deepEqual(seen.slice(0, 3), ['initialize', 'initialized', 'thread/list']);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Codex message's context goes to the model apart, so the message reads as typed in Codex's app", async () => {
  assert.equal(contextApart('', 'just a question'), null);
  assert.deepEqual(contextApart('<project_context>p</project_context>', '<obsidian_context>\nNote attached to this chat: a.md\n</obsidian_context>\n\nwhat now?'), {
    context: '<project_context>p</project_context>\n\n<obsidian_context>\nNote attached to this chat: a.md\n</obsidian_context>',
    content: 'what now?',
  });
  // Nothing typed and no image: the context stays with the message, which would otherwise be empty.
  assert.equal(contextApart('', '<obsidian_context>x</obsidian_context>\n\n'), null);
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-`);
  try {
    let ended: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (ended = resolve));
    const handlers = { onMessage: () => undefined, onEnd: () => ended(), onPermission: async () => ({ behavior: 'deny' as const, message: '' }) };
    const session = new CodexSession(launchIn(dir), handlers as never);
    session.send('<obsidian_context>\nNote attached to this chat: a.md\n</obsidian_context>\n\nwhat now?');
    await done;
    const methods = readFileSync(`${dir}/methods.log`, 'utf8').trim().split('\n');
    assert.ok(methods.indexOf('thread/inject_items') >= 0 && methods.indexOf('thread/inject_items') < methods.indexOf('turn/start'), methods.join(','));
    const params = JSON.parse(readFileSync(`${dir}/turn.json`, 'utf8')) as { input: { text: string }[] };
    assert.equal(params.input[0].text, 'what now?');
    session.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
