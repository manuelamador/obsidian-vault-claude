import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { test } from 'node:test';
import type { CodexLaunch } from '../src/codexSession';
import VaultClaudePlugin from '../src/main';
import { fakeCodex } from './fakeCodex';

/** A view as the plugin's daemon code sees it: how often it was told the shared app-server changed. */
interface FakeView {
  codexDaemonStarting: boolean;
  changed: number;
  updatePhoneButton(): void;
  codexDaemonChanged(): Promise<void>;
}

/**
 * A plugin whose Codex is the stand-in in a folder of its own, which is also Codex's home (so that no
 * test reaches the shared app-server of the computer it runs on), with one panel.
 */
function pluginIn(dir: string, phoneCodex: boolean): { p: VaultClaudePlugin; view: FakeView; daemonLog: () => string[]; socket: string } {
  process.env.CODEX_HOME = dir;
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  p.settings.codexPath = fakeCodex(dir);
  p.settings.extraPath = dirname(process.execPath);
  p.settings.phoneCodex = phoneCodex;
  p.vaultRoot = () => dir;
  const view: FakeView = {
    codexDaemonStarting: false,
    changed: 0,
    updatePhoneButton: () => undefined,
    codexDaemonChanged: async () => {
      view.changed += 1;
    },
  };
  (p as unknown as { chatViews(): FakeView[] }).chatViews = () => [view];
  const daemonLog = () => (existsSync(`${dir}/daemon.log`) ? readFileSync(`${dir}/daemon.log`, 'utf8').trim().split('\n') : []);
  return { p, view, daemonLog, socket: `${dir}/app-server-control/app-server-control.sock` };
}

test("a Codex chat or read starts Codex's shared app-server, without remote control while Codex on the phone is off, and then goes through it", async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-daemon-`);
  try {
    const { p, view, daemonLog } = pluginIn(dir, false);
    assert.equal((p.codexLaunch() as CodexLaunch).shared, undefined);
    // Two at once share the one start.
    const [first, second] = await Promise.all([p.ensureCodexDaemon(), p.ensureCodexDaemon()]);
    assert.equal(first, null);
    assert.equal(second, null);
    assert.deepEqual(daemonLog(), ['start', 'disable-remote-control']);
    const launch = await p.codexLaunchReady();
    assert.equal(typeof launch === 'string' ? launch : launch.shared, true);
    // Running already: nothing more is run.
    assert.deepEqual(daemonLog(), ['start', 'disable-remote-control']);
    // The panels are told, so that a chat idle in a process of its own moves onto it.
    assert.equal(view.changed, 1);
    assert.equal(p.startedCodexDaemon, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex on the phone turns remote control on and off, starting the shared app-server if none runs, and never stops it', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-phone-`);
  try {
    const { p, view, daemonLog, socket } = pluginIn(dir, false);
    await p.setPhoneCodex(true);
    // Started for the switch: its start turns remote control on, once.
    assert.deepEqual(daemonLog(), ['start', 'enable-remote-control']);
    assert.equal(p.settings.phoneCodex, true);
    assert.equal(view.codexDaemonStarting, false);
    const changedBefore = view.changed;
    await p.setPhoneCodex(false);
    await p.setPhoneCodex(true);
    assert.deepEqual(daemonLog(), ['start', 'enable-remote-control', 'disable-remote-control', 'enable-remote-control']);
    // Still running, and the chats are not moved: the panels only hear of it (their phone buttons).
    assert.ok(existsSync(socket));
    assert.equal((p.codexLaunch() as CodexLaunch).shared, true);
    assert.equal(view.changed, changedBefore + 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when the shared app-server cannot start, Codex chats run in processes of their own, and it is not tried again at once", async () => {
  const dir = mkdtempSync(`${tmpdir()}/vc-codex-fallback-`);
  try {
    const { p, view, daemonLog } = pluginIn(dir, false);
    writeFileSync(`${dir}/daemon-fails`, '');
    assert.equal(await p.ensureCodexDaemon(), 'the daemon could not start');
    const launch = await p.codexLaunchReady();
    assert.notEqual(typeof launch, 'string');
    assert.equal((launch as CodexLaunch).shared, undefined);
    assert.deepEqual(daemonLog(), ['start']);
    assert.equal(view.changed, 0);
    // Codex on the phone turned on tries again, and stays off when it fails.
    await p.setPhoneCodex(true);
    assert.deepEqual(daemonLog(), ['start', 'start']);
    assert.equal(p.settings.phoneCodex, false);
    // Once it can start, turning it on starts it.
    rmSync(`${dir}/daemon-fails`);
    await p.setPhoneCodex(true);
    assert.deepEqual(daemonLog(), ['start', 'start', 'start', 'enable-remote-control']);
    assert.equal(((await p.codexLaunchReady()) as CodexLaunch).shared, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
