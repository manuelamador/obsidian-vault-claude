// A chat run by Codex (`codex app-server`, JSON-RPC over stdio) in place of Claude Code: the same
// outward shape as ClaudeSession, so that the panel drives either. Codex's events are turned into the
// messages the panel draws (see codexEvents.ts); its approval requests go to the panel's approval
// cards. Codex runs with its own settings (~/.codex/config.toml): model, sandbox and approvals.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codexInit, codexItemCompleted, codexItemStarted, codexTurnResult, type CodexItem, type CodexUsage } from './codexEvents';
import { log } from './log';
import type { SessionHandlers, UserContent } from './session';

export interface CodexSessionConfig {
  cwd: string;
  codexPath: string;
  /** A Codex thread to carry on (see thread/resume); none starts a new one. */
  resume?: string;
  /** Instructions added to Codex's own (as the panel's system prompt addition is for Claude). */
  developerInstructions?: string;
}

/** Where the ChatGPT app installs the Codex CLI, besides PATH and Homebrew. */
export function codexCandidates(): string[] {
  const home = os.homedir();
  return [path.join(home, '.codex', 'plugins', '.plugin-appserver', 'codex-cli', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
}

/** The Codex CLI to run: `configured` when set, else the first found on PATH or where it is usually installed; null when there is none. */
export function findCodex(configured: string): string | null {
  if (configured.trim()) return fs.existsSync(configured.trim()) ? configured.trim() : null;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const candidate of [...dirs.map((dir) => path.join(dir, 'codex')), ...codexCandidates()]) if (fs.existsSync(candidate)) return candidate;
  return null;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class CodexSession {
  /** The Codex thread's id, once started: the chat's id, as a Claude session's is. */
  sessionId: string | null = null;
  readonly ended: Promise<void>;
  private markEnded: () => void = () => undefined;
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private stderrLines: string[] = [];
  /** The turn running, and the messages of yours it answers. */
  private turnId: string | null = null;
  private turnMessages: string[] = [];
  private usage: CodexUsage | null = null;
  private model: string | null = null;

  constructor(
    private readonly config: CodexSessionConfig,
    private handlers: SessionHandlers,
  ) {
    this.ended = new Promise((resolve) => (this.markEnded = resolve));
  }

  setHandlers(handlers: SessionHandlers): void {
    this.handlers = handlers;
  }

  /** Sends a message of yours: a new turn, or, while one runs, added to it (Codex's steering). */
  send(content: UserContent, _priority?: unknown, uuid?: string): void {
    if (this.closed) return;
    void this.start()
      .then(async () => {
        const input = codexInput(content);
        if (this.turnId) {
          await this.request('turn/steer', { threadId: this.sessionId, expectedTurnId: this.turnId, input });
          if (uuid) this.turnMessages.push(uuid);
          return;
        }
        if (uuid) this.turnMessages = [uuid];
        const started = (await this.request('turn/start', { threadId: this.sessionId, input })) as { turn?: { id?: string } };
        this.turnId ??= started.turn?.id ?? null;
      })
      .catch((error: unknown) => this.fail(error));
  }

  ensureStarted(): void {
    void this.start().catch((error: unknown) => this.fail(error));
  }

  async interrupt(): Promise<void> {
    if (!this.turnId || !this.sessionId) return;
    await this.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }).catch((error: unknown) => log('interrupting codex failed', error));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error('the Codex session was closed'));
    this.pending.clear();
    if (this.child) this.child.kill();
    else this.markEnded();
  }

  // What Claude Code offers and Codex does not, or not yet here: nothing to do, or nothing to read.
  addContext(): void {}
  waitingContext(): Set<string> {
    return new Set();
  }
  withdrawContext(): void {}
  async stopTask(): Promise<void> {}
  contextUsage(): null {
    return null;
  }
  planUsage(): null {
    return null;
  }
  supportedModels(): null {
    return null;
  }
  supportedCommands(): null {
    return null;
  }
  async setModel(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async setFastMode(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async enableRemoteControl(): Promise<unknown> {
    throw new Error('Codex chats cannot be put on the phone.');
  }

  /** Starts Codex's app-server, once: the handshake, then the thread, new or carried on. */
  private start(): Promise<void> {
    this.starting ??= (async () => {
      log('starting codex', { cwd: this.config.cwd, codexPath: this.config.codexPath, resume: this.config.resume ?? null });
      const child = spawn(this.config.codexPath, ['app-server'], { cwd: this.config.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onData(chunk));
      child.stderr.on('data', (chunk: string) => {
        this.stderrLines.push(...chunk.split('\n').filter(Boolean));
        if (this.stderrLines.length > 40) this.stderrLines = this.stderrLines.slice(-40);
      });
      child.on('error', (error) => this.fail(error));
      child.on('exit', (code, signal) => {
        log('codex exited', { code, signal });
        this.child = null;
        this.markEnded();
        for (const { reject } of this.pending.values()) reject(new Error('Codex exited'));
        this.pending.clear();
        this.handlers.onEnd(this.closed || code === 0 ? undefined : new Error(`Codex exited with code ${code ?? signal}`), this.stderrLines.join('\n'));
      });
      await this.request('initialize', { clientInfo: { name: 'vault-claude', title: 'Vault Claude', version: '1' }, capabilities: null });
      this.notify('initialized');
      const params = { cwd: this.config.cwd, ...(this.config.developerInstructions ? { developerInstructions: this.config.developerInstructions } : {}) };
      const opened = (await this.request(this.config.resume ? 'thread/resume' : 'thread/start', this.config.resume ? { ...params, threadId: this.config.resume } : params)) as { thread?: { id?: string }; model?: string };
      this.sessionId = opened.thread?.id ?? this.config.resume ?? null;
      this.model = opened.model ?? null;
      if (!this.sessionId) throw new Error('Codex started no thread');
      log('codex session started', { sessionId: this.sessionId });
      this.handlers.onMessage(codexInit(this.sessionId, this.model, this.config.cwd) as never);
    })();
    return this.starting;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('Codex is not running'));
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  private respond(id: number | string, result: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
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
      if (message.method && message.id !== undefined) void this.onServerRequest(message.id, message.method, message.params ?? {});
      else if (message.method) this.onNotification(message.method, message.params ?? {});
      else if (typeof message.id === 'number') {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message ?? 'Codex refused the request'));
        else waiting?.resolve(message.result);
      }
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const id = this.sessionId;
    if (!id || (typeof params.threadId === 'string' && params.threadId !== id)) return;
    switch (method) {
      case 'turn/started':
        this.turnId = (params.turn as { id?: string } | undefined)?.id ?? this.turnId;
        break;
      case 'item/started':
        for (const message of codexItemStarted(id, params.item as CodexItem, this.config.cwd)) this.handlers.onMessage(message as never);
        break;
      case 'item/completed':
        for (const message of codexItemCompleted(id, params.item as CodexItem)) this.handlers.onMessage(message as never);
        break;
      case 'thread/tokenUsage/updated': {
        const last = (params.tokenUsage as { last?: CodexUsage } | undefined)?.last;
        if (last) this.usage = last;
        break;
      }
      case 'turn/completed': {
        const turn = (params.turn ?? {}) as { status: string; error?: { message?: string } | null; durationMs?: number | null };
        this.turnId = null;
        const sent = this.turnMessages;
        this.turnMessages = [];
        log('codex turn ended', { status: turn.status });
        this.handlers.onMessage(codexTurnResult(id, turn, this.usage, sent) as never);
        this.usage = null;
        break;
      }
      default:
        break;
    }
  }

  /** Codex asks to run a command or change files: the panel's approval card answers. */
  private async onServerRequest(requestId: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    const command = method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval';
    const files = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval';
    if (!command && !files) {
      // Requests the panel has no card for are declined rather than left waiting.
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, error: { code: -32601, message: `${method} is not supported by this client` } })}\n`);
      return;
    }
    const controller = new AbortController();
    const reason = typeof params.reason === 'string' ? params.reason : undefined;
    const input: Record<string, unknown> = command ? { command: typeof params.command === 'string' ? params.command : Array.isArray(params.command) ? params.command.join(' ') : '', ...(reason ? { description: reason } : {}) } : { file_path: typeof params.grantRoot === 'string' ? params.grantRoot : '', ...(reason ? { description: reason } : {}) };
    try {
      const answer = await this.handlers.onPermission({ toolName: command ? 'Bash' : 'Edit', input, signal: controller.signal, title: command ? 'Codex wants to run a command' : 'Codex wants to change files', decisionReason: reason });
      this.respond(requestId, { decision: answer.behavior === 'allow' ? 'accept' : 'decline' });
    } catch (error) {
      log('answering codex failed', error);
      this.respond(requestId, { decision: 'decline' });
    }
  }

  private fail(error: unknown): void {
    log('codex failed', error);
    if (this.closed) return;
    this.closed = true;
    this.child?.kill();
    if (!this.child) {
      this.markEnded();
      this.handlers.onEnd(error instanceof Error ? error : new Error(String(error)), this.stderrLines.join('\n'));
    }
  }
}

/** A message of yours as Codex takes it: its text, and its images as data URLs. */
export function codexInput(content: UserContent): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content, text_elements: [] }];
  return content.flatMap((block): unknown[] => {
    if (block.type === 'text') return [{ type: 'text', text: block.text, text_elements: [] }];
    if (block.type === 'image' && block.source.type === 'base64') return [{ type: 'image', url: `data:${block.source.media_type};base64,${block.source.data}` }];
    return [];
  });
}
