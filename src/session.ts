import { query, resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import type {
  EffortLevel,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKMessage,
  SDKUserMessage,
  Settings,
  SlashCommand,
  SpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from './log';

/** A user message: plain text, or content blocks (text and images). */
export type UserContent = SDKUserMessage['message']['content'];

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];
  title?: string;
  decisionReason?: string;
  blockedPath?: string;
}

export interface SessionConfig {
  cwd: string;
  claudePath: string;
  extraPath: string[];
  permissionMode: PermissionMode;
  model?: string;
  effort?: EffortLevel;
  appendSystemPrompt?: string;
  resume?: string;
  /** Launch with bypass allowed, so the chat can start in or switch to `bypassPermissions`. */
  allowBypass?: boolean;
  /** Permission deny rules such as `Bash(git reset:*)`; they apply in every mode, bypass included. */
  denyRules?: string[];
  /** Claude may ask multiple-choice questions (its AskUserQuestion tool), which reach onPermission to be answered. */
  askQuestions?: boolean;
  /** With `resume`, continue in a new session that starts as a copy, leaving the original untouched. */
  forkSession?: boolean;
  /** The new session's id, chosen here rather than by Claude Code; not with `resume` unless forking. */
  sessionId?: string;
  /** With `resume`, only the chat up to and including this entry. */
  resumeSessionAt?: string;
  /** Ask Claude Code for a summary of Claude's thinking (thinking blocks are empty otherwise). */
  showThinking?: boolean;
  /** Start in fast mode. */
  fastMode?: boolean;
  /** More CLI flags, e.g. `{ 'remote-control': 'name' }`. */
  extraArgs?: Record<string, string | null>;
  /** Settings for this session's flag layer (the `--settings` CLI flag). */
  settings?: Settings;
}

/** Where and with what Claude Code runs: the vault's folder, the `claude` executable, extra PATH entries. */
export type ClaudeLaunch = Pick<SessionConfig, 'cwd' | 'claudePath' | 'extraPath'>;

export interface SessionHandlers {
  onMessage(message: SDKMessage): void;
  onPermission(request: PermissionRequest): Promise<PermissionResult>;
  onEnd(error?: Error, stderrTail?: string): void;
}

const IS_WINDOWS = process.platform === 'win32';

/** Where the native installer (and, on macOS, Homebrew) puts Claude Code. */
function claudeCandidates(): string[] {
  const home = os.homedir();
  if (IS_WINDOWS) return [path.join(home, '.local', 'bin', 'claude.exe')];
  return [
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.claude', 'local', 'claude'),
  ];
}

function onPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0);
  return dirs.map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate)) ?? null;
}

export interface ConfiguredDefaults {
  model?: string;
  effort?: EffortLevel;
  /** Per-model effort from `modelSettings`, keyed by model ID (e.g. `claude-fable-5-1`). */
  modelEfforts?: Record<string, EffortLevel>;
}

/** Model and effort set in the user, project and local Claude Code settings for `cwd`. */
export async function configuredDefaults(cwd: string): Promise<ConfiguredDefaults> {
  try {
    const { effective } = await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] });
    const modelSettings = (effective as { modelSettings?: Record<string, { effortLevel?: EffortLevel } | null> }).modelSettings ?? {};
    const modelEfforts: Record<string, EffortLevel> = {};
    for (const [id, value] of Object.entries(modelSettings)) {
      if (value?.effortLevel) modelEfforts[id] = value.effortLevel;
    }
    return {
      model: typeof effective.model === 'string' && effective.model ? effective.model : undefined,
      effort: effective.effortLevel ?? undefined,
      modelEfforts,
    };
  } catch (error) {
    log('resolveSettings failed', error);
    return {};
  }
}

export function detectClaudePath(): string | null {
  return claudeCandidates().find((candidate) => fs.existsSync(candidate)) ?? onPath(IS_WINDOWS ? 'claude.exe' : 'claude');
}

/**
 * The Claude Code executable to run: the configured path, else the detected one. On Windows,
 * npm's `claude.cmd` is refused: Node starts .cmd files only through cmd.exe, whose quoting
 * rules would apply to the prompts and system prompt passed as arguments.
 */
export function findClaude(configured: string): { path: string; error?: undefined } | { path?: undefined; error: string } {
  const candidate = configured.trim() || detectClaudePath();
  const npmShim = IS_WINDOWS && (candidate ? /\.(cmd|bat)$/i.test(candidate) : onPath('claude.cmd') !== null);
  if (npmShim) {
    return {
      error:
        'Claude Code installed with npm (claude.cmd) cannot be started by the plugin. Install it with the native Windows installer, which provides claude.exe.',
    };
  }
  if (!candidate) return { error: 'Claude Code executable not found. Set its path in the Vault Claude settings.' };
  return { path: candidate };
}

// Obsidian started from the macOS Dock inherits launchd's PATH (/usr/bin:/bin:...), so
// the Bash tool would not find Homebrew or ~/.local/bin binaries without this.
function buildPath(claudePath: string, extraPath: string[]): string {
  const unixDirs = (dirs: string[]) => (IS_WINDOWS ? [] : dirs);
  const entries = [
    path.dirname(claudePath),
    ...extraPath,
    ...unixDirs([path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']),
    ...(process.env.PATH ?? '').split(path.delimiter),
    ...unixDirs(['/usr/bin', '/bin', '/usr/sbin', '/sbin']),
  ];
  return [...new Set(entries.filter((entry) => entry.length > 0))].join(path.delimiter);
}

/**
 * Environment for a Claude process: Obsidian's, with PATH replaced. Windows spells the key
 * `Path`; it is dropped rather than left beside `PATH`, where the two would conflict.
 */
export function claudeEnv(claudePath: string, extraPath: string[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'PATH') env[key] = value;
  }
  env.PATH = buildPath(claudePath, extraPath);
  return env;
}

/** Async iterable fed by `push`: the SDK's streaming-input mode keeps one Claude process for the whole chat. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
    } else {
      this.items.push(message);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export class ClaudeSession {
  sessionId: string | null = null;
  /**
   * Resolves once the session has ended: its process gone (at once for one never started). Claude
   * Code writes to the session's file as its process exits, so a file is deleted only after this.
   */
  readonly ended: Promise<void>;
  private markEnded: () => void = () => undefined;
  private readonly input = new InputQueue();
  private readonly abortController = new AbortController();
  private stream: Query | null = null;
  private stderrLines: string[] = [];
  private closed = false;

  private handlers: SessionHandlers;
  private fastMode: boolean;

  constructor(
    private readonly config: SessionConfig,
    handlers: SessionHandlers,
  ) {
    this.handlers = handlers;
    this.fastMode = config.fastMode === true;
    this.ended = new Promise((resolve) => (this.markEnded = resolve));
  }

  /** Routes this session's messages and permission requests elsewhere, e.g. while it runs in the background. */
  setHandlers(handlers: SessionHandlers): void {
    this.handlers = handlers;
  }

  /**
   * Queues a user message. `uuid`, when given, is echoed back in `user_message_uuids` on the
   * result of the turn that consumed the message.
   */
  send(content: UserContent, priority?: SDKUserMessage['priority'], uuid?: SDKUserMessage['uuid']): void {
    // Closed: a message arriving late (the chat was switched while it was being prepared) must not
    // start a process that nothing would close.
    if (this.closed) {
      log('a message for a closed session was dropped');
      return;
    }
    if (!this.stream) {
      try {
        this.start();
      } catch (error) {
        log('query() failed to start', error);
        this.markEnded();
        this.handlers.onEnd(error instanceof Error ? error : new Error(String(error)), this.stderrLines.join('\n'));
        return;
      }
    }
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
      ...(uuid ? { uuid } : {}),
    };
    this.input.push(message);
  }

  /** Starts the Claude process (resuming the chat, if any) without sending a message. */
  ensureStarted(): void {
    if (!this.stream && !this.closed) this.start();
  }

  async interrupt(): Promise<void> {
    await this.stream?.interrupt();
  }

  /** Stops one background task — a subagent or a shell command Claude sent to the background. */
  async stopTask(taskId: string): Promise<void> {
    await this.stream?.stopTask(taskId);
  }

  /** Context-window fill, from the last response's usage (no extra token-count calls). */
  contextUsage(): Promise<SDKControlGetContextUsageResponse> | null {
    return this.stream ? this.stream.getContextUsage({ detail: 'summary' }) : null;
  }

  /** Plan rate-limit windows. The SDK marks this method experimental; the SDK version is pinned. */
  planUsage(): Promise<SDKControlGetUsageResponse> | null {
    return this.stream ? this.stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) : null;
  }

  supportedModels(): Promise<ModelInfo[]> | null {
    return this.stream ? this.stream.supportedModels() : null;
  }

  /** Slash commands and skills available in this session. */
  supportedCommands(): Promise<SlashCommand[]> | null {
    return this.stream ? this.stream.supportedCommands() : null;
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.stream?.setModel(model);
  }

  /**
   * Turns Remote Control on or off for this session, so it can be continued from the Claude app
   * or claude.ai/code. Uses the SDK's `enableRemoteControl` (a `remote_control` control request),
   * which is present in the SDK's code but absent from its type definitions.
   */
  async enableRemoteControl(enabled: boolean, name?: string): Promise<unknown> {
    const stream = this.stream as unknown as { enableRemoteControl?: (enabled: boolean, name?: string) => Promise<unknown> } | null;
    if (!stream) throw new Error('The chat has not started yet');
    if (typeof stream.enableRemoteControl !== 'function') throw new Error('This SDK version has no Remote Control support');
    return stream.enableRemoteControl(enabled, name);
  }

  /** Effort for the rest of the session; `null` returns to the model's default. */
  async setEffort(level: EffortLevel | null): Promise<void> {
    await this.stream?.applyFlagSettings({ effortLevel: level });
  }

  /**
   * Fast mode for the rest of the session. Agent SDK sessions must opt in through the `fastMode`
   * flag setting; whether it then runs is reported in `fast_mode_state` on the next result.
   */
  async setFastMode(on: boolean): Promise<void> {
    this.fastMode = on;
    await this.stream?.applyFlagSettings({ fastMode: on });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.stream?.setPermissionMode(mode);
  }

  close(): void {
    this.closed = true;
    this.input.close();
    this.abortController.abort();
    if (!this.stream) this.markEnded();
  }

  private start(): void {
    const { config } = this;
    log('starting query', {
      cwd: config.cwd,
      claudePath: config.claudePath,
      permissionMode: config.permissionMode,
      model: config.model ?? null,
      effort: config.effort ?? null,
      resume: config.resume ?? null,
    });
    this.stream = query({
      prompt: this.input,
      options: {
        cwd: config.cwd,
        pathToClaudeCodeExecutable: config.claudePath,
        env: claudeEnv(config.claudePath, config.extraPath),
        // The flag sets only what is shown of Claude's thinking, not how Claude thinks.
        extraArgs: { ...(config.showThinking ? { 'thinking-display': 'summarized' } : {}), ...config.extraArgs },
        settings: config.settings,
        // Without these two, the SDK runs a bare agent: no CLAUDE.md, no user
        // settings, commands or skills, and no Claude Code system prompt.
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: config.appendSystemPrompt },
        permissionMode: config.permissionMode,
        allowDangerouslySkipPermissions: config.allowBypass === true,
        model: config.model,
        effort: config.effort,
        resume: config.resume,
        forkSession: config.resume ? config.forkSession === true : undefined,
        sessionId: config.sessionId,
        resumeSessionAt: config.resume ? config.resumeSessionAt : undefined,
        includePartialMessages: true,
        abortController: this.abortController,
        // Without a way to answer multiple-choice questions, Claude asks in plain text instead.
        disallowedTools: [...(config.askQuestions ? [] : ['AskUserQuestion']), ...(config.denyRules ?? [])],
        canUseTool: (toolName, input, options) =>
          this.handlers.onPermission({
            toolName,
            input,
            signal: options.signal,
            suggestions: options.suggestions,
            title: options.title,
            decisionReason: options.decisionReason,
            blockedPath: options.blockedPath,
          }),
        spawnClaudeCodeProcess: (options) =>
          spawnClaudeProcess(options, (lines) => {
            this.stderrLines.push(...lines);
            if (this.stderrLines.length > 40) this.stderrLines = this.stderrLines.slice(-40);
          }),
      },
    });
    // Sent before the first message, like the other settings the chat starts with.
    if (this.fastMode) void this.stream.applyFlagSettings({ fastMode: true }).catch((error: unknown) => log('turning on fast mode failed', error));
    void this.pump(this.stream);
  }

  private async pump(stream: Query): Promise<void> {
    try {
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
          this.sessionId = message.session_id;
          log('session started', { sessionId: message.session_id, model: message.model, version: message.claude_code_version });
        } else if (message.type === 'result') {
          log('turn ended', { subtype: message.subtype, isError: message.is_error });
        }
        this.handlers.onMessage(message);
      }
      log('query stream closed');
      this.markEnded();
      this.handlers.onEnd();
    } catch (error) {
      this.markEnded();
      if (this.closed) {
        log('query stream closed');
        this.handlers.onEnd();
      } else {
        log('query stream failed', error);
        this.handlers.onEnd(error instanceof Error ? error : new Error(String(error)), this.stderrLines.join('\n'));
      }
    }
  }

}

// The SDK's default spawn hands its AbortSignal to Node's spawn(), which rejects
// signals created in Obsidian's renderer realm. Abort is wired up by hand here.
function spawnClaudeProcess(options: SpawnOptions, onStderr: (lines: string[]) => void): SpawnedProcess {
  log('spawning', options.command, options.args.join(' '));
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', (error) => log('spawn error', error));
  child.on('exit', (code, signal) => log('claude exited', { code, signal }));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    const lines = chunk.split('\n').filter((line) => line.trim().length > 0);
    for (const line of lines) log('stderr', line);
    onStderr(lines);
  });
  const kill = () => {
    if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
  };
  if (options.signal.aborted) kill();
  else options.signal.addEventListener('abort', kill, { once: true });
  return child as unknown as SpawnedProcess;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A one-off request (inline edit, chat summary): a single request with no tools and none of the Claude Code settings files
 * (the caller puts the vault's CLAUDE.md in `system`), not saved as a session. `onText` gets
 * the answer so far while it streams; resolves to the whole answer.
 */
export async function runOneShot(
  config: ClaudeLaunch,
  request: { system: string; prompt: string; model?: string; effort?: EffortLevel },
  onText: (text: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const stream = query({
    prompt: request.prompt,
    options: {
      cwd: config.cwd,
      pathToClaudeCodeExecutable: config.claudePath,
      env: claudeEnv(config.claudePath, config.extraPath),
      settingSources: [],
      systemPrompt: request.system,
      tools: [],
      maxTurns: 1,
      model: request.model,
      effort: request.effort ?? 'low',
      persistSession: false,
      includePartialMessages: true,
      abortController,
      spawnClaudeCodeProcess: (options) => spawnClaudeProcess(options, () => undefined),
    },
  });
  let streamed = '';
  let answer = '';
  try {
    for await (const message of stream) {
      if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
        const { event } = message;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          streamed += event.delta.text;
          onText(streamed);
        }
      } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        for (const block of message.message.content) if (block.type === 'text') answer += block.text;
      } else if (message.type === 'result') {
        if (message.subtype !== 'success') throw new Error(message.errors.join('; ') || message.subtype);
        if (message.is_error) throw new Error(message.result || 'Claude Code reported an error');
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return answer || streamed;
}

export interface ProbeResult {
  models: ModelInfo[];
  commands: SlashCommand[];
  plan: SDKControlGetUsageResponse | null;
}

/**
 * Starts Claude Code without sending a prompt, asks for its model list and plan usage,
 * then shuts it down. `persistSession: false` keeps the probe out of the session history.
 */
export async function probeClaude(
  config: ClaudeLaunch,
  timeoutMs = 20_000,
): Promise<ProbeResult> {
  const input = new InputQueue();
  const abortController = new AbortController();
  const stream = query({
    prompt: input,
    options: {
      cwd: config.cwd,
      pathToClaudeCodeExecutable: config.claudePath,
      env: claudeEnv(config.claudePath, config.extraPath),
      settingSources: ['user', 'project', 'local'],
      persistSession: false,
      abortController,
      spawnClaudeCodeProcess: (options) => spawnClaudeProcess(options, () => undefined),
    },
  });
  // Keep the message stream drained while the control request is answered.
  void (async () => {
    try {
      for await (const message of stream) void message;
    } catch {
      // Closed below.
    }
  })();
  try {
    const models = await withTimeout(stream.supportedModels(), timeoutMs, 'the model list');
    let commands: SlashCommand[] = [];
    try {
      commands = await withTimeout(stream.supportedCommands(), timeoutMs, 'the command list');
    } catch (error) {
      log('probe: command list failed', error);
    }
    let plan: SDKControlGetUsageResponse | null = null;
    try {
      plan = await withTimeout(
        stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        timeoutMs,
        'plan usage',
      );
    } catch (error) {
      log('probe: plan usage failed', error);
    }
    return { models, commands, plan };
  } finally {
    input.close();
    abortController.abort();
  }
}
