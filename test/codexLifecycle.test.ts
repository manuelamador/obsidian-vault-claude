import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { CodexSession, runCodexOneShot, stopCodexReader } from '../src/codexSession';

/**
 * A stand-in for `codex app-server`: it notes that it started, answers the handshake and the
 * thread's start, and, asked to start a turn, answers and then exits without finishing it.
 */
function fakeCodex(dir: string): string {
  const file = `${dir}/codex`;
  writeFileSync(
    file,
    `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(`${dir}/started`)}, '');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    if (message.method === 'thread/start') reply({ thread: { id: 't1' } });
    else if (message.method === 'turn/start') {
      reply({ turn: { id: 'turn1' } });
      setTimeout(() => process.exit(0), 20);
    } else reply({});
  }
});
`,
  );
  chmodSync(file, 0o755);
  return file;
}

// node found on PATH by the stand-in's first line: this one's folder first.
const launchIn = (dir: string) => ({ codexPath: fakeCodex(dir), cwd: dir, env: { ...process.env, PATH: `${process.execPath.replace(/\/node$/, '')}:${process.env.PATH ?? ''}` } });

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
