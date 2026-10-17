// A chat run by Codex (`codex app-server`, JSON-RPC over stdio) in place of Claude Code: the same
// outward shape as ClaudeSession, so that the panel drives either. Codex's events are turned into the
// messages the panel draws (see codexEvents.ts); its approval requests go to the panel's approval
// cards. Codex runs with its own settings (~/.codex/config.toml): model, sandbox and approvals.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codexInit, codexItemCompleted, codexItemStarted, codexTurnResult, type CodexItem, type CodexUsage } from './codexEvents';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { log } from './log';
import { contextBlock, type ContextPart } from './projects';
import type { SessionHandlers, UserContent } from './session';

/** How to run Codex: the executable, the vault folder, and the environment (PATH fixed as for Claude Code; see claudeEnv). */
export interface CodexLaunch {
  cwd: string;
  codexPath: string;
  env: Record<string, string | undefined>;
}

export interface CodexSessionConfig extends CodexLaunch {
  /** A Codex thread to carry on (see thread/resume); none starts a new one. */
  resume?: string;
  /** A Codex thread to start from, as a copy Codex does not save (see thread/fork): a side chat's. */
  fork?: string;
  /** Codex only reads (a read-only sandbox, never asking), and the thread is not saved: a side chat's. */
  readOnly?: boolean;
  /** Instructions added to Codex's own (as the panel's system prompt addition is for Claude). */
  developerInstructions?: string;
  /** The model and reasoning effort to run; none uses Codex's own settings. */
  model?: string;
  effort?: string;
  /** The panel's deny rules (see sessionDenyRules): a command they match is refused without asking. */
  denyRules?: string[];
}

/**
 * Whether command `command` is refused by `rules`: a `Bash(prefix:*)` rule matches the prefix at the
 * start of any part of it (after `&&`, `;`, `|`, a subshell, or a shell's `-c '…'`), as Claude Code's
 * rules do for its Bash tool.
 */
export function deniedCommand(rules: string[], command: string): boolean {
  return rules.some((rule) => {
    const prefix = /^Bash\((.+?)(?::\*)?\)$/.exec(rule.trim())?.[1]?.trim();
    if (!prefix) return false;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[;&|('"\\s])${escaped}(\\s|$|['"])`).test(command);
  });
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
  /** The thread's context as Codex last reported it: what the last request held, and the model's window. */
  private context: { used: number; window: number } | null = null;
  private model: string | null = null;
  /** Why the session ended, when it failed: shown once Codex has exited (see fail). */
  private failure: Error | null = null;
  /** Sends one after the other, so that a message sent while a turn starts steers it rather than starting another. */
  private sending: Promise<void> = Promise.resolve();
  /** The approval cards shown, withdrawn when the turn or the session ends. */
  private readonly approvals = new Set<AbortController>();
  /** Context given to go with the next message (see addContext): a project's notes, included chats. */
  private pendingContext: { parts: ContextPart[]; delivered: (sessionId: string | null, keys: string[]) => void }[] = [];
  /** The files each change in this turn touches, by item: what its approval card names. */
  private readonly changes = new Map<string, string[]>();

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
    if (this.closed) {
      // Ended already (it failed to start, say): the turn the panel began is ended with the reason.
      this.handlers.onEnd(this.failure ?? new Error('The Codex session has ended.'), this.stderrLines.join('\n'));
      return;
    }
    this.sending = this.sending
      .then(() => this.start())
      .then(async () => {
        // The context waiting goes before the message, as Claude Code's hook adds it (see ClaudeSession.addContext).
        const context = this.pendingContext.splice(0);
        const block = contextBlock(context.flatMap((each) => each.parts));
        const input = [...(block.text ? codexInput(block.text) : []), ...codexInput(content)];
        const went = new Set(block.keys);
        const delivered = () => {
          for (const each of context) each.delivered(this.sessionId, each.parts.map((part) => part.key).filter((key) => went.has(key)));
        };
        if (this.turnId) {
          try {
            await this.request('turn/steer', { threadId: this.sessionId, expectedTurnId: this.turnId, input });
            if (uuid) this.turnMessages.push(uuid);
            delivered();
            return;
          } catch (error) {
            // The turn ended as the message went: it starts the next one instead.
            log('steering codex failed; starting a turn', error);
            this.turnId = null;
          }
        }
        if (uuid) this.turnMessages = [uuid];
        // The model and effort chosen in the panel, when any; thinking summaries asked for, to be shown.
        const choice = { ...(this.config.model ? { model: this.config.model } : {}), ...(this.config.effort ? { effort: this.config.effort } : {}), summary: 'auto' };
        const started = (await this.request('turn/start', { threadId: this.sessionId, input, ...choice })) as { turn?: { id?: string } };
        this.turnId ??= started.turn?.id ?? null;
        delivered();
      })
      .catch((error: unknown) => this.fail(error));
  }

  ensureStarted(): void {
    void this.start().catch((error: unknown) => this.fail(error));
  }

  async interrupt(): Promise<void> {
    // A turn still starting is stopped once Codex has said which it is.
    await this.sending;
    if (!this.turnId || !this.sessionId) return;
    await this.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }).catch((error: unknown) => log('interrupting codex failed', error));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.withdrawApprovals();
    for (const { reject } of this.pending.values()) reject(new Error('the Codex session was closed'));
    this.pending.clear();
    if (this.child) this.child.kill();
    else this.markEnded();
  }

  /** The usage limits of the account, read through this session's own app-server (see readCodexLimits). */
  async readLimits(): Promise<CodexLimits | null> {
    if (this.closed || !this.child) return null;
    return limitsOf(await this.request('account/rateLimits/read', {}));
  }

  private withdrawApprovals(): void {
    for (const controller of this.approvals) controller.abort();
    this.approvals.clear();
  }

  /** Context to go with the next message: given with it to Codex, then marked delivered. */
  addContext(parts: ContextPart[], delivered: (sessionId: string | null, keys: string[]) => void): void {
    if (parts.length > 0) this.pendingContext.push({ parts, delivered });
  }

  /** What context is waiting to go (see addContext). */
  waitingContext(): Set<string> {
    return new Set(this.pendingContext.flatMap((each) => each.parts.map((part) => part.key)));
  }

  withdrawContext(unwanted: (key: string) => boolean): void {
    for (const each of this.pendingContext) each.parts = each.parts.filter((part) => !unwanted(part.key));
  }

  // What Claude Code offers and Codex does not, or not yet here: nothing to do, or nothing to read.
  async stopTask(): Promise<void> {}
  /** The context meter's reading, in the shape Claude Code's gives it (see contextFigures); null before Codex reports one. */
  contextUsage(): SDKControlGetContextUsageResponse | null {
    if (!this.context) return null;
    return { totalTokens: this.context.used, maxTokens: this.context.window, rawMaxTokens: this.context.window, model: this.model ?? undefined } as unknown as SDKControlGetContextUsageResponse;
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
  /** The model for the next turns; none returns to Codex's own setting. */
  async setModel(model?: string): Promise<void> {
    this.config.model = model || undefined;
  }

  /** The reasoning effort for the next turns; none returns to the model's default. */
  async setEffort(effort?: string | null): Promise<void> {
    this.config.effort = effort || undefined;
  }
  async setFastMode(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async enableRemoteControl(): Promise<unknown> {
    throw new Error('Codex chats cannot be put on the phone.');
  }

  /** Starts Codex's app-server, once: the handshake, then the thread, new or carried on. */
  private start(): Promise<void> {
    this.starting ??= (async () => {
      log('starting codex', { cwd: this.config.cwd, codexPath: this.config.codexPath, resume: this.config.resume ?? null });
      const child = spawn(this.config.codexPath, ['app-server'], { cwd: this.config.cwd, env: this.config.env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      // A write to a Codex that has just exited: reported by the exit, not thrown.
      child.stdin.on('error', (error) => log('writing to codex failed', error));
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onData(chunk));
      child.stderr.on('data', (chunk: string) => {
        this.stderrLines.push(...chunk.split('\n').filter(Boolean));
        if (this.stderrLines.length > 40) this.stderrLines = this.stderrLines.slice(-40);
      });
      let exited = false;
      const ended = (error: Error | undefined) => {
        if (exited) return;
        exited = true;
        this.child = null;
        this.withdrawApprovals();
        this.markEnded();
        for (const { reject } of this.pending.values()) reject(error ?? new Error('Codex exited'));
        this.pending.clear();
        this.handlers.onEnd(error, this.stderrLines.join('\n'));
      };
      child.on('error', (error) => {
        this.failure ??= error;
        this.closed = true;
        // Not started at all (not found, not executable): no exit follows.
        if (child.pid === undefined) ended(error);
        else child.kill();
      });
      child.on('exit', (code, signal) => {
        log('codex exited', { code, signal });
        // Closed by the panel: no error; failed: why; else an exit nobody asked for.
        ended(this.failure ?? (this.closed || code === 0 ? undefined : new Error(`Codex exited with code ${code ?? signal}`)));
      });
      await this.request('initialize', { clientInfo: { name: 'vault-claude', title: 'Vault Claude', version: '1' }, capabilities: null });
      this.notify('initialized');
      const params = {
        cwd: this.config.cwd,
        ...(this.config.developerInstructions ? { developerInstructions: this.config.developerInstructions } : {}),
        ...(this.config.readOnly ? { sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true } : {}),
      };
      const { resume, fork } = this.config;
      const opened = (await (resume
        ? this.request('thread/resume', { ...params, threadId: resume })
        : fork
          ? this.request('thread/fork', { ...params, threadId: fork, excludeTurns: true })
          : this.request('thread/start', params))) as { thread?: { id?: string }; model?: string };
      this.sessionId = opened.thread?.id ?? resume ?? null;
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
      case 'item/started': {
        const item = params.item as CodexItem;
        if (item.type === 'fileChange') this.changes.set(item.id, (item.changes ?? []).map((change) => change.path));
        for (const message of codexItemStarted(id, item, this.config.cwd)) this.handlers.onMessage(message as never);
        break;
      }
      case 'item/completed':
        for (const message of codexItemCompleted(id, params.item as CodexItem)) this.handlers.onMessage(message as never);
        break;
      case 'thread/tokenUsage/updated': {
        const tokenUsage = params.tokenUsage as { last?: CodexUsage & { totalTokens?: number }; modelContextWindow?: number | null } | undefined;
        const last = tokenUsage?.last;
        if (last) this.usage = last;
        if (last && tokenUsage?.modelContextWindow) this.context = { used: last.totalTokens ?? last.inputTokens + last.outputTokens, window: tokenUsage.modelContextWindow };
        break;
      }
      case 'turn/completed': {
        const turn = (params.turn ?? {}) as { status: string; error?: { message?: string } | null; durationMs?: number | null };
        this.turnId = null;
        this.withdrawApprovals();
        this.changes.clear();
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
    // The older requests take the older answers.
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
    const decision = (allow: boolean) => (legacy ? (allow ? 'approved' : 'denied') : allow ? 'accept' : 'decline');
    const reason = typeof params.reason === 'string' ? params.reason : undefined;
    const commandText = typeof params.command === 'string' ? params.command : Array.isArray(params.command) ? params.command.join(' ') : '';
    // Refused by the panel's deny rules, as Claude Code refuses them: not offered at all.
    if (command && deniedCommand(this.config.denyRules ?? [], commandText)) {
      log('codex command refused by a deny rule', commandText.slice(0, 200));
      this.respond(requestId, { decision: decision(false) });
      return;
    }
    const changed = this.changes.get(typeof params.itemId === 'string' ? params.itemId : '') ?? [];
    const absolute = (file: string) => (/^([/\\]|[A-Za-z]:)/.test(file) ? file : path.join(this.config.cwd, file));
    const input: Record<string, unknown> = command
      ? { command: commandText, ...(reason ? { description: reason } : {}) }
      : { file_path: changed[0] ? absolute(changed[0]) : typeof params.grantRoot === 'string' ? params.grantRoot : '', ...(changed.length > 1 ? { changes: changed } : {}), ...(reason ? { description: reason } : {}) };
    const controller = new AbortController();
    this.approvals.add(controller);
    try {
      const answer = await this.handlers.onPermission({ toolName: command ? 'Bash' : 'Edit', input, signal: controller.signal, title: command ? 'Codex wants to run a command' : changed.length > 1 ? `Codex wants to change ${changed.length} files` : 'Codex wants to change a file', decisionReason: reason });
      if (!controller.signal.aborted) this.respond(requestId, { decision: decision(answer.behavior === 'allow') });
    } catch (error) {
      log('answering codex failed', error);
      if (!controller.signal.aborted) this.respond(requestId, { decision: decision(false) });
    } finally {
      this.approvals.delete(controller);
    }
  }

  /** The session cannot go on: Codex is stopped, and the panel told why once it has exited. */
  private fail(error: unknown): void {
    log('codex failed', error);
    if (this.closed) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    if (this.child) {
      this.child.kill();
      return;
    }
    this.withdrawApprovals();
    this.markEnded();
    this.handlers.onEnd(this.failure, this.stderrLines.join('\n'));
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

/** A Codex model, as the model menu offers it: its id, name, the reasoning efforts it supports and its default one. */
export interface CodexModel {
  id: string;
  name: string;
  efforts: { value: string; description: string }[];
  defaultEffort: string;
  isDefault: boolean;
}

/** How long a short-lived app-server is given before it is stopped (see withAppServer). */
const APP_SERVER_TIMEOUT_MS = 20_000;

/** Runs `use` against a short-lived Codex app-server, after its handshake, then stops it; given up after APP_SERVER_TIMEOUT_MS. */
async function withAppServer<T>(launch: CodexLaunch, use: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
  const child = spawn(launch.codexPath, ['app-server'], { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  // Read and dropped, so that a chatty stderr never fills its pipe; writes after an exit are not thrown.
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  const pending = new Map<number, (message: { result?: unknown; error?: { message?: string } }) => void>();
  let buffer = '';
  let next = 0;
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: { message?: string } };
        if (typeof message.id === 'number' && !message.method) pending.get(message.id)?.(message);
      } catch {
        // Not JSON: nothing waits on it.
      }
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<never>((_, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`Codex exited with code ${code}`)));
    timer = setTimeout(() => reject(new Error('Codex did not answer in time')), APP_SERVER_TIMEOUT_MS);
  });
  // Rejected after `use` is done (the stop below): nobody waits on it then.
  exited.catch(() => undefined);
  const request = (method: string, params: unknown) =>
    Promise.race([
      new Promise<unknown>((resolve, reject) => {
        const id = ++next;
        pending.set(id, (message) => (message.error ? reject(new Error(message.error.message ?? 'Codex refused the request')) : resolve(message.result)));
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      }),
      exited,
    ]);
  try {
    await request('initialize', { clientInfo: { name: 'vault-claude', title: 'Vault Claude', version: '1' }, capabilities: null });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    return await use(request);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

/** The models Codex offers (`model/list`), as the model menu lists them. */
export async function listCodexModels(launch: CodexLaunch): Promise<CodexModel[]> {
  return withAppServer(launch, async (request) => {
    const listed = (await request('model/list', {})) as { data?: { id: string; model?: string; displayName?: string; hidden?: boolean; supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[]; defaultReasoningEffort?: string; isDefault?: boolean }[] };
    return (listed.data ?? [])
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.model ?? model.id,
        name: model.displayName ?? model.model ?? model.id,
        efforts: (model.supportedReasoningEfforts ?? []).map((effort) => ({ value: effort.reasoningEffort, description: effort.description ?? '' })),
        defaultEffort: model.defaultReasoningEffort ?? '',
        isDefault: model.isDefault === true,
      }));
  });
}

/** Codex's usage limits, as `account/rateLimits/read` gives them: the plan, and each window's share used. */
export interface CodexLimits {
  planType: string | null;
  windows: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }[];
}

/** The usage limits of the account Codex is signed in with, read through a short-lived app-server. */
export async function readCodexLimits(launch: CodexLaunch): Promise<CodexLimits | null> {
  return withAppServer(launch, async (request) => limitsOf(await request('account/rateLimits/read', {})));
}

/** The limits in an `account/rateLimits/read` answer. */
function limitsOf(answer: unknown): CodexLimits | null {
  type Window = { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null } | null | undefined;
  const limits = (answer as { rateLimits?: { planType?: string | null; primary?: Window; secondary?: Window } | null } | null)?.rateLimits;
  if (!limits) return null;
  const windows = [limits.primary, limits.secondary].flatMap((window) =>
    window && typeof window.usedPercent === 'number' ? [{ usedPercent: window.usedPercent, windowDurationMins: window.windowDurationMins ?? null, resetsAt: window.resetsAt ?? null }] : [],
  );
  return { planType: limits.planType ?? null, windows };
}

/**
 * A saved Codex thread's turns, read through a short-lived app-server (`thread/read`): how a Codex
 * chat is drawn when opened from the history. The plugin reads no Codex file itself.
 */
export async function readCodexThread(launch: CodexLaunch, threadId: string): Promise<{ items?: unknown[] }[]> {
  return withAppServer(launch, async (request) => {
    const read = (await request('thread/read', { threadId, includeTurns: true })) as { thread?: { turns?: { items?: unknown[] }[] } };
    return read.thread?.turns ?? [];
  });
}
