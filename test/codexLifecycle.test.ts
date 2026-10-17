import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
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
