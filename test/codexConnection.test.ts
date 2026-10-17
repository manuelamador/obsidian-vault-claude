import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { CodexConnection } from '../src/codexConnection';
import { CodexSession } from '../src/codexSession';
import { launchIn } from './fakeCodex';

const inTemp = async (use: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(`${tmpdir()}/vc-conn-`);
  try {
    await use(dir);
  } finally {
    for (const connection of made.splice(0)) connection.stop();
    rmSync(dir, { recursive: true, force: true });
  }
};

/** A connection to the stand-in, with what it ended with, once ended. */
/** Connections made, stopped after each test whatever it did (a stand-in left running keeps the test runner waiting). */
const made: CodexConnection[] = [];

function connect(dir: string, mode: 'exit' | 'silent' | 'die', options = { timeoutMs: 1500 }) {
  const ends: (Error | undefined)[] = [];
  let ended: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (ended = resolve));
  const connection = new CodexConnection(launchIn(dir, mode), { onEnd: (error) => (ends.push(error), ended()) }, options);
  made.push(connection);
  return { connection, ends, done };
}

test('a request Codex does not answer fails alone; with stopOnTimeout it stops the connection, which ends with why', () =>
  inTemp(async (dir) => {
    const alone = connect(dir, 'silent');
    await alone.connection.ready;
    await assert.rejects(alone.connection.request('model/list', {}), /in time/);
    assert.equal(alone.connection.open, true);
    alone.connection.stop();
    await alone.done;
    assert.deepEqual(alone.ends, [undefined]);
    const stopping = connect(dir, 'silent', { timeoutMs: 1500, stopOnTimeout: true } as never);
    await stopping.connection.ready;
    await assert.rejects(stopping.connection.request('model/list', {}), /in time/);
    await stopping.done;
    assert.equal(stopping.ends.length, 1);
    assert.match(String(stopping.ends[0]), /in time/);
  }));

test('Codex exiting on its own ends the connection once, with an error, and fails what waits', () =>
  inTemp(async (dir) => {
    const { connection, ends, done } = connect(dir, 'die');
    await connection.ready;
    await connection.request('thread/start', {});
    await done;
    assert.equal(ends.length, 1);
    assert.match(String(ends[0]), /code 3/);
    await assert.rejects(connection.request('turn/start', {}));
  }));

test('a Codex that cannot start ends the connection, and its handshake fails', async () => {
  const ends: (Error | undefined)[] = [];
  const connection = new CodexConnection({ codexPath: '/nonexistent/codex', cwd: tmpdir(), env: process.env as Record<string, string> }, { onEnd: (error) => void ends.push(error) }, { timeoutMs: 1000 });
  await assert.rejects(connection.ready);
  assert.equal(ends.length, 1);
  assert.ok(ends[0]);
});

test('a Codex chat whose Codex died tells the panel at the next message, rather than leaving it waiting', () =>
  inTemp(async (dir) => {
    const endings: (Error | undefined)[] = [];
    const session = new CodexSession(launchIn(dir, 'die'), { onMessage: () => undefined, onEnd: (error: Error | undefined) => void endings.push(error), onPermission: async () => ({ behavior: 'deny', message: '' }) } as never);
    session.ensureStarted();
    await session.ended;
    assert.equal(endings.length, 1);
    session.send('hello');
    assert.equal(endings.length, 2);
    assert.ok(endings[1]);
  }));
