// One `codex app-server` process and the JSON-RPC over its stdio, one JSON object a line: the
// handshake, requests and their answers (each given up after a time), the notifications Codex sends,
// the requests it makes of the panel, and its end. Both a Codex chat (see CodexSession) and the
// reader kept for threads, models and small jobs (see CodexReader) run on it, so that the process is
// started, stopped and reported ended in one way.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { log } from './log';

/** How to run Codex: the executable, the vault folder, and the environment (PATH fixed as for Claude Code; see claudeEnv). */
export interface CodexLaunch {
  cwd: string;
  codexPath: string;
  env: Record<string, string | undefined>;
}

export interface CodexConnectionHandlers {
  /** A notification: a turn's events, token counts, its end. */
  onNotification?(method: string, params: Record<string, unknown>): void;
  /** A request Codex makes of the panel (an approval); answered with respond or refuse. */
  onRequest?(id: number | string, method: string, params: Record<string, unknown>): void;
  /**
   * The connection has ended, once: `error` says why when it was not stopped on purpose (it would
   * not start, it exited, or it was stopped for a reason; see stop); `stderr` is what it last wrote.
   */
  onEnd?(error: Error | undefined, stderr: string): void;
}

export interface CodexConnectionOptions {
  /** How long a request is given before it is given up. */
  timeoutMs: number;
  /** Whether a request given up stops the connection (a reader stuck on it is no use) rather than failing alone. */
  stopOnTimeout?: boolean;
}

/** How long a Codex asked to stop is given before it is killed outright. */
const KILL_AFTER_MS = 3_000;
/** How many of its last stderr lines are kept, for the error shown when it ends. */
const STDERR_LINES = 40;

export class CodexConnection {
  /** The handshake done: requests may be made. Rejected when it ends first. */
  readonly ready: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private next = 0;
  private buffer = '';
  private stderrLines: string[] = [];
  /** Stopped (see stop), with the reason when there is one. */
  private stopping: { reason?: Error } | null = null;
  private done = false;

  constructor(
    launch: CodexLaunch,
    private readonly handlers: CodexConnectionHandlers,
    private readonly options: CodexConnectionOptions,
  ) {
    const child = spawn(launch.codexPath, ['app-server'], { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    // A write to a Codex that has just exited: reported by its end, not thrown.
    child.stdin.on('error', (error) => log('writing to codex failed', error));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line) this.stderrLines.push(line);
      if (this.stderrLines.length > STDERR_LINES) this.stderrLines = this.stderrLines.slice(-STDERR_LINES);
    });
    child.on('error', (error) => {
      // Not started at all (not found, not executable): no exit follows.
      if (child.pid === undefined) this.end(error);
      else this.stop(error);
    });
    child.on('exit', (code, signal) => {
      log('codex exited', { code, signal });
      // Stopped on purpose: its reason, if any; else an exit nobody asked for.
      this.end(this.stopping ? this.stopping.reason : code === 0 ? undefined : new Error(`Codex exited with code ${code ?? signal}`));
    });
    this.ready = this.request('initialize', { clientInfo: { name: 'vault-claude', title: 'Vault Claude', version: '1' }, capabilities: null }).then(() => this.notify('initialized'));
    // Awaited by whoever uses it; not left unhandled when it ends before anyone has.
    this.ready.catch(() => undefined);
  }

  /** Whether it can still be used: not stopped, not ended. */
  get open(): boolean {
    return !this.stopping && !this.done;
  }

  /** What Codex last wrote to stderr. */
  stderr(): string {
    return this.stderrLines.join('\n');
  }

  /** A request to Codex, given up after the connection's timeout. */
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.open) return Promise.reject(this.stopping?.reason ?? new Error('Codex is not running'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Codex did not answer ${method} in time`);
        if (this.options.stopOnTimeout) this.stop(error);
        else {
          this.pending.delete(id);
          reject(error);
        }
      }, this.options.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /** Answers request `id` that Codex made of the panel. */
  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  /** Declines request `id` that Codex made of the panel, as one the panel does not take. */
  refuse(id: number | string, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }

  /**
   * Stops Codex: what waits on it is given up at once, and it is asked to exit, then killed if it has
   * not within KILL_AFTER_MS. `reason`: why, when it is a failure, given to onEnd; none, stopped on purpose.
   */
  stop(reason?: Error): void {
    if (this.done) return;
    if (!this.stopping) this.stopping = { reason };
    this.rejectPending(reason ?? new Error('Codex was stopped'));
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, KILL_AFTER_MS);
    child.once('exit', () => clearTimeout(timer));
  }

  private end(error: Error | undefined): void {
    if (this.done) return;
    this.done = true;
    this.rejectPending(error ?? new Error('Codex exited'));
    this.handlers.onEnd?.(error, this.stderr());
  }

  private rejectPending(error: Error): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) reject(error);
  }

  private write(message: Record<string, unknown>): void {
    if (this.done) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      let message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        log('codex sent a line that is not JSON', line.slice(0, 200));
        continue;
      }
      if (message.method && message.id !== undefined) this.handlers.onRequest?.(message.id, message.method, message.params ?? {});
      else if (message.method) this.handlers.onNotification?.(message.method, message.params ?? {});
      else if (typeof message.id === 'number') {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message ?? 'Codex refused the request'));
        else waiting?.resolve(message.result);
      }
    }
  }
}
