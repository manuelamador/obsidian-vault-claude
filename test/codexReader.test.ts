import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { CodexConnection } from '../src/codexConnection';
import { readCodexThreads, runCodexOneShot, stopCodexReader } from '../src/codexSession';
import { StderrTail } from '../src/stderrTail';
import { launchIn } from './fakeCodex';

const until = async (done: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('a one-off request whose turn never ends fails at its time limit, and its turn is interrupted', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-stall-`);
  try {
    await assert.rejects(
      runCodexOneShot(launchIn(dir, 'stall'), { system: '', prompt: 'hi' }, () => undefined, new AbortController().signal, 1500),
      /did not finish the request in time/,
    );
    await until(() => existsSync(`${dir}/methods.log`) && readFileSync(`${dir}/methods.log`, 'utf8').includes('turn/interrupt'));
  } finally {
    stopCodexReader();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a read for another launch does not cut off a one-off request running on the reader it replaces', async () => {
  const first = mkdtempSync(`${tmpdir()}/vc-codex-held-`);
  const second = mkdtempSync(`${tmpdir()}/vc-codex-other-`);
  const controller = new AbortController();
  try {
    const job = runCodexOneShot(launchIn(first, 'stall'), { system: '', prompt: 'hi' }, () => undefined, controller.signal);
    const settled = job.then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    await until(() => existsSync(`${first}/turn.json`));
    const threads = await readCodexThreads(launchIn(second, 'threads'));
    assert.equal(threads.length, 2);
    // Still running: given up by its own signal, not stopped by the other read.
    controller.abort();
    assert.deepEqual(await settled, { value: '' });
  } finally {
    stopCodexReader();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('a stderr line split across chunks is kept whole, and only the last lines are kept', () => {
  const tail = new StderrTail(2);
  assert.deepEqual(tail.push('first li'), []);
  assert.deepEqual(tail.push('ne\n\nsecond\nthi'), ['first line', 'second']);
  assert.equal(tail.text(), 'second\nthi');
  tail.push('rd\n');
  assert.equal(tail.text(), 'second\nthird');
});

test("Codex's messages are read whole across chunks, several in one chunk", () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-lines-`);
  const heard: string[] = [];
  const connection = new CodexConnection(launchIn(dir, 'silent'), { onNotification: (method) => heard.push(method) }, { timeoutMs: 5000 });
  try {
    const feed = (chunk: string) => (connection as unknown as { onData(chunk: string): void }).onData(chunk);
    const big = JSON.stringify({ jsonrpc: '2.0', method: 'big', params: { text: 'x'.repeat(100_000) } });
    feed(big.slice(0, 10));
    feed(big.slice(10, 50_000));
    feed(`${big.slice(50_000)}\n{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0",`);
    feed('"method":"b"}\n');
    assert.deepEqual(heard, ['big', 'a', 'b']);
  } finally {
    connection.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
