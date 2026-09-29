// Runs `claude remote-control` in the vault, so the Claude mobile app (or claude.ai/code) can
// start Claude Code sessions there. The server needs no terminal, but it only runs in a folder
// Claude Code already trusts. Kept free of `obsidian` imports so the smoke test can use it.
import { spawn, type ChildProcess } from 'child_process';
import { log } from './log';
import { claudeEnv } from './session';

export type RemoteState = 'stopped' | 'starting' | 'connected' | 'error';

export interface RemoteStatus {
  state: RemoteState;
  /** claude.ai/code link for this environment, once connected. */
  url: string | null;
  /** Sessions currently running through the server ("Capacity: n/32"). */
  activeSessions: number | null;
  error: string | null;
}

export interface RemoteOptions {
  cwd: string;
  claudePath: string;
  extraPath: string[];
  name: string;
  permissionMode: string;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export class RemoteControlServer {
  status: RemoteStatus = { state: 'stopped', url: null, activeSessions: null, error: null };
  private child: ChildProcess | null = null;
  private stopping = false;
  private lastStderr = '';
  private readonly listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  start(options: RemoteOptions): void {
    if (this.child) return;
    const args = ['remote-control', '--name', options.name, '--permission-mode', options.permissionMode];
    log('remote control: starting', { cwd: options.cwd, name: options.name, permissionMode: options.permissionMode });
    this.stopping = false;
    this.lastStderr = '';
    const child = spawn(options.claudePath, args, {
      cwd: options.cwd,
      env: claudeEnv(options.claudePath, options.extraPath),
      // stdin stays open: the server reads single keys (QR code, spawn mode) but needs none.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.update({ state: 'starting', url: null, activeSessions: null, error: null });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.parse(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.replace(ANSI, '').trim();
      if (!text) return;
      this.lastStderr = text;
      log('remote control stderr', text);
    });
    child.on('error', (error) => {
      log('remote control: spawn error', error);
      // A process that never started (e.g. a wrong executable path) emits 'error' and 'close'
      // but no 'exit', so it is released here or phone access would stay "running".
      if (child.pid === undefined && this.child === child) this.child = null;
      this.update({ state: 'error', url: null, activeSessions: null, error: error.message });
    });
    child.on('exit', (code, signal) => {
      log('remote control: exited', { code, signal });
      if (this.child === child) this.child = null;
      if (this.stopping || code === 0) {
        this.update({ state: 'stopped', url: null, activeSessions: null, error: null });
      } else {
        this.update({ state: 'error', url: null, activeSessions: null, error: this.lastStderr || `exited with code ${code}` });
      }
    });
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
  }

  private parse(chunk: string): void {
    const text = chunk.replace(ANSI, '');
    const patch: Partial<RemoteStatus> = {};
    if (/Connected ·/.test(text)) patch.state = 'connected';
    else if (/(Connecting|Reconnecting)/.test(text)) patch.state = 'starting';
    const url = text.match(/https:\/\/claude\.ai\/code\?environment=[\w-]+/)?.[0];
    if (url) patch.url = url;
    const capacity = text.match(/Capacity: (\d+)\/\d+/);
    if (capacity) patch.activeSessions = Number(capacity[1]);
    if (Object.keys(patch).length === 0) return;
    if (patch.state === 'connected' && this.status.state !== 'connected') log('remote control: connected', { url: patch.url ?? this.status.url });
    this.update(patch);
  }

  private update(patch: Partial<RemoteStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
}
