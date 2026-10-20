// A chat run by Codex (`codex app-server`, JSON-RPC over stdio) in place of Claude Code: the same
// outward shape as ClaudeSession, so that the panel drives either. Codex's events are turned into the
// messages the panel draws (see codexEvents.ts); its approval requests go to the panel's approval
// cards. Codex runs with its own settings (~/.codex/config.toml): model, sandbox and approvals.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexConnection, type CodexLaunch } from './codexConnection';
import { codexInit, codexItemCompleted, codexItemStarted, codexTurnResult, type CodexItem, type CodexUsage } from './codexEvents';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { splitContext } from './history';
import { log } from './log';
import { contextBlock, type ContextPart } from './projects';
import { CONNECTOR_DECLINED, type ConnectorRequest, type SessionHandlers, type UserContent } from './session';
import { codexTurnAccess, type CodexAccess } from './codexAccess';

export type { CodexLaunch } from './codexConnection';

export interface CodexSessionConfig extends CodexLaunch {
  /** A Codex thread to carry on (see thread/resume); none starts a new one. */
  resume?: string;
  /** A Codex thread to start from, as a copy Codex does not save (see thread/fork): a side chat's. */
  fork?: string;
  /** Codex only reads (a read-only sandbox, never asking), and the thread is not saved: a side chat's. */
  readOnly?: boolean;
  /** Kept out of Codex's own lists (the app, the phone): archived when the session ends, unarchived before it resumes. */
  hidden?: boolean;
  /**
   * The connector requests allowed for the rest of a chat (see ConnectorRequest.allowKey), by thread:
   * kept by the panel, so that they outlive this process (one let go of when idle, say).
   */
  connectorAllowances?: { allowed(threadId: string, key: string): boolean; allow(threadId: string, key: string): void };
  /** Hidden, the thread copied (see fork) is archived again once copied, when this says nothing else has it open. */
  forkLetGo?: () => boolean;
  /** Instructions added to Codex's own (as the panel's system prompt addition is for Claude). */
  developerInstructions?: string;
  /** The model and reasoning effort to run; none uses Codex's own settings. */
  model?: string;
  effort?: string;
  /** What it may do without asking (see codexAccess.ts), sent with each turn; none leaves Codex's own settings (a side chat's thread is read-only already). */
  access?: CodexAccess;
  /** Fast mode: each turn asks for Codex's fast tier; off, the thread's own tier (Codex's settings). */
  fast?: boolean;
  /** The panel's deny rules (see denyRuleList): a command they match is refused without asking. */
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

/** How long a request to a chat's Codex is given (it answers at once, a turn's work coming as notifications), and how long Stop waits for a turn still starting. */
const REQUEST_TIMEOUT_MS = 60_000;
const INTERRUPT_WAIT_MS = 5_000;

export class CodexSession {
  /** The Codex thread's id, once started: the chat's id, as a Claude session's is. */
  sessionId: string | null = null;
  readonly ended: Promise<void>;
  private markEnded: () => void = () => undefined;
  private connection: CodexConnection | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
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
  /** A hidden chat's thread archived after its last reply, and the archiving under way (see archiveAfterTurn). */
  private archivedAfterTurn = false;
  private archiving: Promise<void> | null = null;
  /** Connectors' requests waiting on their cards, by request id (see onElicitation). */
  private readonly elicitations = new Map<string, AbortController>();
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
      this.handlers.onEnd(this.failure ?? new Error('The Codex session has ended.'), this.connection?.stderr() ?? '');
      return;
    }
    this.sending = this.sending
      // Closed while earlier sends were waiting: nothing is started for it.
      .then(() => (this.closed ? Promise.reject(new Error('the Codex session was closed')) : this.start()))
      .then(async () => {
        // The context waiting goes before the message, as Claude Code's hook adds it (see ClaudeSession.addContext).
        const context = this.pendingContext.splice(0);
        const block = contextBlock(context.flatMap((each) => each.parts));
        const input = [...(block.text ? codexInput(block.text) : []), ...codexInput(content)];
        // Starting a turn, the context (the projects', the attached note, mentions) goes to the model on
        // its own (see contextApart), so the message reads as typed in Codex's app and on the phone.
        const apart = this.turnId ? null : contextApart(block.text, content);
        const went = new Set(block.keys);
        const delivered = () => {
          for (const each of context) each.delivered(this.sessionId, each.parts.map((part) => part.key).filter((key) => went.has(key)));
        };
        if (this.turnId) {
          try {
            await this.request('turn/steer', { threadId: this.sessionId, expectedTurnId: this.turnId, input, ...(uuid ? { clientUserMessageId: uuid } : {}) });
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
        const access = this.config.access ? codexTurnAccess(this.config.access) : {};
        // Saved with the message (its clientId), by which the panel finds its turn again (see codexTurnHolding).
        const client = uuid ? { clientUserMessageId: uuid } : {};
        // For this turn only: off again, the next turn takes the thread's own tier.
        const tier = this.config.fast ? { serviceTierForTurn: CODEX_FAST_TIER } : {};
        let turnInput = input;
        if (apart) {
          try {
            await this.request('thread/inject_items', { threadId: this.sessionId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: apart.context }] }] });
            turnInput = codexInput(apart.content);
          } catch (error) {
            // A Codex without it: the context stays in the message, as before.
            log('codex took no context apart; sent with the message', error);
          }
        }
        // Hidden from Codex's lists, and archived after its last reply (see archiveAfterTurn): listed again to take a turn.
        if (this.hidesThread() && this.sessionId) {
          const threadId = this.sessionId;
          await this.archiving;
          if (this.archivedAfterTurn) {
            await unarchiveQuietly((method, params) => this.request(method, params), threadId);
            this.archivedAfterTurn = false;
          }
        }
        const started = (await this.request('turn/start', { threadId: this.sessionId, input: turnInput, ...choice, ...access, ...client, ...tier })) as { turn?: { id?: string } };
        this.turnId ??= started.turn?.id ?? null;
        delivered();
      })
      .catch((error: unknown) => this.fail(error));
  }

  ensureStarted(): void {
    void this.start().catch((error: unknown) => this.fail(error));
  }

  async interrupt(): Promise<void> {
    // A turn still starting is stopped once Codex has said which it is, if it says so soon.
    await Promise.race([this.sending, new Promise((resolve) => setTimeout(resolve, INTERRUPT_WAIT_MS))]);
    if (!this.turnId || !this.sessionId) return;
    await this.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }).catch((error: unknown) => log('interrupting codex failed', error));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.endCompaction();
    this.withdrawApprovals();
    const connection = this.connection;
    if (!connection) return this.markEnded();
    // Archived after its last reply, or being archived now (see archiveAfterTurn): stopped once that is done.
    if (this.hidesThread() && this.archiving) {
      const stop = () => connection.stop();
      const timer = setTimeout(stop, 2000);
      void this.archiving.finally(() => {
        clearTimeout(timer);
        stop();
      });
      return;
    }
    // Hidden from Codex's lists: archived as it is let go of (given a moment, then stopped regardless),
    // unless its last reply left it so (see archiveAfterTurn).
    if (this.hidesThread() && !this.archivedAfterTurn) {
      const stop = () => connection.stop();
      const timer = setTimeout(stop, 2000);
      void connection.request('thread/archive', { threadId: this.sessionId }).catch((error: unknown) => log('archiving the codex thread failed', error)).finally(() => {
        clearTimeout(timer);
        stop();
      });
      return;
    }
    connection.stop();
  }

  /** Whether this chat's thread is kept out of Codex's lists (see CodexSessionConfig.hidden): one of its own, saved, on a live connection. */
  private hidesThread(): boolean {
    return this.config.hidden === true && !this.config.readOnly && this.sessionId !== null && this.connection?.open === true;
  }

  /**
   * A hidden chat's thread archived as each reply ends, not only as the chat is let go of (see close):
   * so that one open when Obsidian quits, which waits for nothing (see VaultClaudePlugin's quit), is
   * archived already. Unarchived again before the next turn (see send).
   */
  private archiveAfterTurn(): void {
    if (!this.hidesThread() || !this.sessionId) return;
    const threadId = this.sessionId;
    this.archiving = this.request('thread/archive', { threadId })
      .then(
        () => {
          this.archivedAfterTurn = true;
        },
        (error: unknown) => log('archiving the codex thread failed', error),
      )
      .finally(() => {
        this.archiving = null;
      });
  }

  /** The usage limits of the account, read through this session's own app-server (see readCodexLimits). */
  async readLimits(): Promise<CodexLimits | null> {
    if (this.closed || !this.connection?.open) return null;
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
  /** Codex runs no background tasks (see TasksModal). */
  async taskOutput(): Promise<null> {
    return null;
  }
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
  /**
   * Compacts the conversation now (`thread/compact/start`), as Claude Code's `/compact` does: Codex
   * runs it as a turn, whose end ends the panel's (see turn/completed). A message sent meanwhile
   * waits for that end, rather than steering the compaction or starting a turn beside it.
   */
  compact(): void {
    this.sending = this.sending
      .then(() => (this.closed ? Promise.reject(new Error('the Codex session was closed')) : this.start()))
      .then(async () => {
        this.turnMessages = [];
        const ended = new Promise<void>((resolve) => (this.compacting = resolve));
        await this.request('thread/compact/start', { threadId: this.sessionId });
        await ended;
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => this.endCompaction());
  }

  /** Ends the wait on a compaction (see compact): its turn ended, or the session did. */
  private compacting: (() => void) | null = null;

  private endCompaction(): void {
    const ended = this.compacting;
    this.compacting = null;
    ended?.();
  }

  /** Not closed nor ended: still usable. */
  get live(): boolean {
    return !this.closed;
  }

  /** Whether it runs through Codex's shared app-server, where Codex's phone app shares its thread (see CodexConnection.shared). */
  get shared(): boolean {
    return this.connection?.shared === true;
  }

  /** What it may do without asking, from the next turn (a turn running keeps what it started with). */
  setAccess(access: CodexAccess): void {
    this.config.access = access;
  }
  /** Fast mode for the next turns (see CodexSessionConfig.fast). */
  async setFastMode(on: boolean): Promise<void> {
    this.config.fast = on;
  }
  async setPermissionMode(): Promise<void> {}
  async enableRemoteControl(): Promise<unknown> {
    throw new Error('Codex chats cannot be put on the phone.');
  }

  /** Starts Codex's app-server, once: the handshake, then the thread, new or carried on. */
  private start(): Promise<void> {
    this.starting ??= (async () => {
      if (this.closed) throw new Error('the Codex session was closed');
      log('starting codex', { cwd: this.config.cwd, codexPath: this.config.codexPath, resume: this.config.resume ?? null });
      this.connection = new CodexConnection(
        this.config,
        {
          onNotification: (method, params) => this.onNotification(method, params),
          onRequest: (id, method, params) => void this.onServerRequest(id, method, params),
          // Closed by the panel: no error; failed: why; else why Codex ended.
          onEnd: (error, stderr) => {
            const reason = this.failure ?? (this.closed ? undefined : error);
            // It cannot go on: a message sent after is told so (see send), not left waiting.
            this.failure ??= error ?? null;
            this.closed = true;
            this.withdrawApprovals();
            this.endCompaction();
            this.markEnded();
            this.handlers.onEnd(reason, stderr);
          },
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      await this.connection.ready;
      const params = {
        cwd: this.config.cwd,
        ...(this.config.developerInstructions ? { developerInstructions: this.config.developerInstructions } : {}),
        ...(this.config.readOnly ? { sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true } : {}),
      };
      const { resume, fork } = this.config;
      // Kept archived (see hidden): Codex resumes or copies only a thread that is not.
      const archived = resume ?? fork;
      // Copies of one thread made at once (side chats in two panels): only the last to finish archives it again.
      const copying = fork && !resume ? forksUnderWay.get(fork) ?? { count: 0, unarchived: false } : null;
      if (copying && fork) {
        copying.count++;
        forksUnderWay.set(fork, copying);
      }
      // One archiving it again as this one joins (see below) is let finish, then it is unarchived afresh.
      if (copying?.archiving) {
        await copying.archiving;
        copying.unarchived = false;
      }
      const unarchived = this.config.hidden && archived ? await unarchiveQuietly((method, params) => this.request(method, params), archived) : false;
      if (copying && unarchived) copying.unarchived = true;
      let opened: { thread?: { id?: string }; model?: string };
      try {
        opened = (await (resume
          ? this.request('thread/resume', { ...params, threadId: resume })
          : fork
            ? this.request('thread/fork', { ...params, threadId: fork, excludeTurns: true })
            : this.request('thread/start', params))) as typeof opened;
      } finally {
        // A resumed one is archived again as it is let go of (see close). A copied one (a side chat's)
        // goes back at once, copied or not, unless its own chat has it open, which archives it as it lets go.
        if (copying && fork && --copying.count === 0) {
          // Kept listed until archived: a copy starting meanwhile joins it rather than having it archived under it.
          if (copying.unarchived && this.config.forkLetGo?.()) {
            copying.archiving = this.request('thread/archive', { threadId: fork }).then(
              () => undefined,
              () => undefined,
            );
            await copying.archiving;
            copying.archiving = undefined;
          }
          if (copying.count === 0) forksUnderWay.delete(fork);
        }
      }
      this.sessionId = opened.thread?.id ?? resume ?? null;
      this.model = opened.model ?? null;
      if (!this.sessionId) throw new Error('Codex started no thread');
      log('codex session started', { sessionId: this.sessionId });
      this.handlers.onMessage(codexInit(this.sessionId, this.model, this.config.cwd) as never);
    })();
    return this.starting;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.connection ? this.connection.request(method, params) : Promise.reject(new Error('Codex is not running'));
  }

  private respond(id: number | string, result: unknown): void {
    this.connection?.respond(id, result);
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const id = this.sessionId;
    if (!id || (typeof params.threadId === 'string' && params.threadId !== id)) return;
    switch (method) {
      case 'serverRequest/resolved': {
        // A connector's request answered or ended elsewhere: its card withdrawn, with no answer of ours.
        const key = String(params.requestId);
        const waiting = this.elicitations.get(key);
        if (!waiting) break;
        this.elicitations.delete(key);
        waiting.abort();
        break;
      }
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
        this.endCompaction();
        this.archiveAfterTurn();
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
    if (method === 'mcpServer/elicitation/request') return this.onElicitation(requestId, params);
    const command = method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval';
    const files = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval';
    if (!command && !files) {
      // Requests the panel has no card for are declined rather than left waiting.
      this.connection?.refuse(requestId, `${method} is not supported by this client`);
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

  /**
   * A tool of an MCP server (a connector: Gmail sending a message, say) asks for a confirmation before
   * it acts, or for a link to be opened: the panel's connector card answers it (see readElicitation),
   * showing the whole message and the values a form's answer carries. Allow accepts; Decline refuses;
   * anything else (Cancel, Esc, the turn or chat ending, a request the panel cannot answer) cancels. A
   * request for another thread, or one Codex says was resolved elsewhere, opens no card or is withdrawn
   * without an answer. Answered once.
   */
  private async onElicitation(requestId: number | string, params: Record<string, unknown>): Promise<void> {
    const reply = (action: 'accept' | 'decline' | 'cancel', content: unknown = null) => this.respond(requestId, { action, content, _meta: null });
    if (typeof params.threadId === 'string' && this.sessionId && params.threadId !== this.sessionId) {
      log('codex elicitation for another thread refused', { threadId: params.threadId });
      return reply('cancel');
    }
    const { connector, content } = readElicitation(params);
    // Named by the app it is for ("Allow Gmail to run tool …"), else by its server (codex_apps).
    const server = connectorApp(connector.message) ?? (typeof params.serverName === 'string' ? params.serverName : 'a connector');
    // Allowed for this chat already: answered without a card.
    const allowances = this.config.connectorAllowances;
    if (connector.allowKey && !connector.cannotAnswer && !connector.url && this.sessionId && allowances?.allowed(this.sessionId, connector.allowKey)) {
      log('codex elicitation allowed for this chat', { key: connector.allowKey });
      return reply('accept', content);
    }
    const controller = new AbortController();
    const key = String(requestId);
    this.elicitations.set(key, controller);
    this.approvals.add(controller);
    try {
      const answer = await this.handlers.onPermission({
        toolName: `mcp__${server}`,
        input: { description: connector.message || `${server} asks to go ahead`, ...(connector.url ? { url: connector.url } : {}) },
        signal: controller.signal,
        title: connector.cannotAnswer ? `${server} asks for what the panel cannot give` : connector.url ? `${server} asks you to open a link` : `${server} asks for your confirmation`,
        connector,
      });
      // Resolved elsewhere (see serverRequest/resolved): nothing to answer.
      if (!this.elicitations.has(key)) return;
      if (answer.behavior === 'allow' && !connector.cannotAnswer) {
        // "Allow for this chat": the same request goes through without a card from now on in this chat.
        if (answer.decisionClassification === 'user_permanent' && connector.allowKey && this.sessionId) allowances?.allow(this.sessionId, connector.allowKey);
        reply('accept', connector.url ? null : content);
      }
      else reply(answer.behavior === 'deny' && answer.message === CONNECTOR_DECLINED ? 'decline' : 'cancel');
    } catch (error) {
      log('answering a codex elicitation failed', error);
      if (this.elicitations.has(key)) reply('cancel');
    } finally {
      this.elicitations.delete(key);
      this.approvals.delete(controller);
    }
  }

  /** The session cannot go on: Codex is stopped, and the panel told why once it has exited. */
  private fail(error: unknown): void {
    log('codex failed', error);
    this.endCompaction();
    if (this.closed) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    // Running: stopped, and its end (see start) tells the panel why; never started, told now.
    if (this.connection?.open) {
      this.connection.stop(this.failure);
      return;
    }
    if (this.connection) return;
    this.withdrawApprovals();
    this.markEnded();
    this.handlers.onEnd(this.failure, '');
  }
}

/**
 * The context a message carries (`projects`, the projects' block, and what the panel prepends to the
 * message's text: see splitContext) apart from what was typed, for Codex to take it as a developer
 * message of its own (`thread/inject_items`): the model reads the same, and the message, in Codex's
 * own lists and its phone app, is what was typed. Null when there is none, or nothing would be left of the message.
 */
export function contextApart(projects: string, content: UserContent): { context: string; content: UserContent } | null {
  const text = typeof content === 'string' ? content : content.find((block) => block.type === 'text')?.text ?? '';
  const { context, rest } = splitContext(text);
  const all = [projects, context].filter(Boolean).join('\n\n');
  const images = typeof content === 'string' ? 0 : content.filter((block) => block.type === 'image').length;
  if (!all || (!rest.trim() && images === 0)) return null;
  if (typeof content === 'string') return { context: all, content: rest };
  let replaced = false;
  const blocks = content.map((block) => {
    if (block.type !== 'text' || replaced) return block;
    replaced = true;
    return { ...block, text: rest };
  });
  return { context: all, content: blocks.filter((block) => block.type !== 'text' || block.text.trim()) as UserContent };
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
  /** It offers Codex's fast tier (`priority`): faster output, using more of the plan (see fast mode). */
  fast: boolean;
}

/** Codex's fast service tier, as its models list it ("Fast": faster output, more of the plan used). */
const CODEX_FAST_TIER = 'priority';

/** How long a read is given before the reader is stopped, and how long an idle reader is kept (see withAppServer). */
const APP_SERVER_TIMEOUT_MS = 20_000;
const APP_SERVER_IDLE_MS = 10 * 60_000;

/** A Codex app-server kept for reads (threads, models, limits, small jobs): started once, stopped after APP_SERVER_IDLE_MS unused. */
class CodexReader {
  private readonly connection: CodexConnection;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private users = 0;
  /** What hears Codex's notifications: a one-off request's text as it comes (see runCodexOneShot). */
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  readonly ready: Promise<void>;
  dead = false;

  /** Whether reads can go to it: not let go of, and its connection not stopped (a read it did not answer stops it). */
  get usable(): boolean {
    return !this.dead && this.connection.open;
  }

  constructor(
    readonly key: string,
    launch: CodexLaunch,
    private readonly gone: (reader: CodexReader) => void,
  ) {
    this.connection = new CodexConnection(
      launch,
      {
        onNotification: (method, params) => {
          for (const listener of [...this.listeners]) listener(method, params);
        },
        onEnd: (error) => this.ended(error),
      },
      // A read Codex does not answer leaves the reader no use: it is stopped, and started afresh next time.
      { timeoutMs: APP_SERVER_TIMEOUT_MS, stopOnTimeout: true },
    );
    this.ready = this.connection.ready;
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.connection.request(method, params);
  }

  /** `listener` hears each notification until the returned function is called. */
  listen(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** In use: not stopped meanwhile. */
  hold(): void {
    this.users += 1;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  /** No longer in use: stopped once idle for APP_SERVER_IDLE_MS. */
  release(): void {
    this.users -= 1;
    if (this.users > 0 || this.dead) return;
    this.idle = setTimeout(() => this.stop(), APP_SERVER_IDLE_MS);
  }

  stop(): void {
    this.connection.stop();
    // Let go of at once, not at its exit: the next read starts a reader of its own.
    this.ended(new Error('Codex was stopped'));
  }

  private ended(error: Error | undefined): void {
    if (this.dead) return;
    this.dead = true;
    if (this.idle) clearTimeout(this.idle);
    // What waits on a turn's notifications hears that none will come (see runCodexOneShot).
    for (const listener of [...this.listeners]) listener(READER_STOPPED, { error: error?.message ?? 'Codex stopped' });
    this.listeners.clear();
    this.gone(this);
  }
}

/** The notification a reader's listeners get when it stops (see CodexReader.stop). */
const READER_STOPPED = 'vault-claude/stopped';

let reader: CodexReader | null = null;

/** Stops the reader kept for reads (see CodexReader): when the plugin unloads. */
export function stopCodexReader(): void {
  reader?.stop();
}

/** Starts the reader kept for reads (see CodexReader) ahead of a read, so that the read does not wait for Codex to start. */
export function warmCodexReader(launch: CodexLaunch): void {
  void withAppServer(launch, async () => undefined).catch((error: unknown) => log('starting the codex reader failed', error));
}

/** Runs `use` against the Codex app-server kept for reads (see CodexReader), started for `launch` if need be. */
async function withAppServer<T>(launch: CodexLaunch, use: (request: (method: string, params: unknown) => Promise<unknown>, reader: CodexReader) => Promise<T>): Promise<T> {
  const key = JSON.stringify([launch.codexPath, launch.cwd, launch.env.PATH, launch.shared === true]);
  if (reader && (!reader.usable || reader.key !== key)) reader.stop();
  const current = reader?.usable ? reader : new CodexReader(key, launch, (gone) => {
    if (reader === gone) reader = null;
  });
  reader = current;
  current.hold();
  try {
    await current.ready;
    return await use((method, params) => current.request(method, params), current);
  } finally {
    current.release();
  }
}

/** The models Codex offers (`model/list`), as the model menu lists them. */
export async function listCodexModels(launch: CodexLaunch): Promise<CodexModel[]> {
  return withAppServer(launch, async (request) => {
    const listed = (await request('model/list', {})) as { data?: { id: string; model?: string; displayName?: string; hidden?: boolean; supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[]; defaultReasoningEffort?: string; isDefault?: boolean; serviceTiers?: { id?: string }[] | null }[] };
    return (listed.data ?? [])
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.model ?? model.id,
        name: model.displayName ?? model.model ?? model.id,
        efforts: (model.supportedReasoningEfforts ?? []).map((effort) => ({ value: effort.reasoningEffort, description: effort.description ?? '' })),
        defaultEffort: model.defaultReasoningEffort ?? '',
        isDefault: model.isDefault === true,
        fast: (model.serviceTiers ?? []).some((tier) => tier.id === CODEX_FAST_TIER),
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

/** Archives Codex thread `threadId` (`thread/archive`): out of Codex's history, as a scratch chat let go of is. */
export async function archiveCodexThread(launch: CodexLaunch, threadId: string): Promise<void> {
  await withAppServer(launch, (request) => request('thread/archive', { threadId }));
}

/** The app a connector's request is for, from its message ("Allow Gmail to run tool …"); undefined when it does not say. */
function connectorApp(message: string): string | undefined {
  return /^Allow (.+?) to run tool\b/.exec(message)?.[1];
}

/**
 * What "Allow for this chat" allows for a request (see ConnectorRequest.allowKey): the tool it names,
 * else its whole message, of its connector (`server`), so that one's allowance covers no other's.
 */
function allowKeyOf(server: string, message: string): string | undefined {
  const tool = /\brun tool "([^"]+)"/.exec(message)?.[1];
  return tool ? `${server}:tool:${tool}` : message.trim() ? `${server}:message:${message.trim()}` : undefined;
}

/** The ways a connector asks with a form (see readElicitation), as Codex's app-server names them. */
const FORM_MODES = new Set(['form', 'openai/form', 'openaiForm']);

/** A value as the connector card shows it. */
function shownValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.map(String).join(', ') || '(none)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A connector's request (an MCP elicitation's params) as its card shows it, and the content Allow
 * sends. A form is answered with its fields' defaults, each shown; one with a required field that has
 * none, or not a flat object of simple fields, cannot be answered from the panel, which collects no
 * input. A link is opened only if it is http or https. Any other way of asking cannot be answered.
 */
export function readElicitation(params: Record<string, unknown>): { connector: ConnectorRequest; content: Record<string, unknown> } {
  const message = typeof params.message === 'string' ? params.message : '';
  const mode = typeof params.mode === 'string' ? params.mode : 'form';
  const allowKey = allowKeyOf(typeof params.serverName === 'string' ? params.serverName : 'connector', message);
  const connector: ConnectorRequest = { message, fields: [], ...(allowKey ? { allowKey } : {}) };
  const content: Record<string, unknown> = {};
  if (mode === 'url') {
    const url = typeof params.url === 'string' ? params.url : '';
    if (/^https?:\/\//i.test(url)) connector.url = url;
    else connector.cannotAnswer = url ? `It asks to open a link the panel does not open: ${url}` : 'It asks to open a link, and gives none.';
    return { connector, content };
  }
  if (!FORM_MODES.has(mode)) {
    connector.cannotAnswer = `It asks in a way the panel does not support (${mode}).`;
    return { connector, content };
  }
  const schema = params.requestedSchema;
  if (schema === undefined || schema === null) return { connector, content };
  const { type, properties, required } = schema as { type?: unknown; properties?: unknown; required?: unknown };
  if (typeof schema !== 'object' || (type !== undefined && type !== 'object') || (properties !== undefined && (typeof properties !== 'object' || properties === null))) {
    connector.cannotAnswer = 'It asks for a form the panel cannot read.';
    return { connector, content };
  }
  const needed = new Set(Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : []);
  const missing: string[] = [];
  for (const [name, field] of Object.entries((properties ?? {}) as Record<string, unknown>)) {
    const spec = field && typeof field === 'object' ? (field as { title?: unknown; default?: unknown; type?: unknown }) : null;
    const label = typeof spec?.title === 'string' && spec.title.trim() ? spec.title : name;
    if (!spec || !['string', 'number', 'integer', 'boolean', 'array'].includes(String(spec.type ?? 'string'))) {
      connector.cannotAnswer = `It asks for a form the panel cannot read (${label}).`;
      return { connector, content };
    }
    if (spec.default !== undefined && spec.default !== null) {
      content[name] = spec.default;
      connector.fields.push({ label, value: shownValue(spec.default) });
    } else if (needed.has(name)) missing.push(label);
    else connector.fields.push({ label, value: '(left empty)' });
  }
  if (missing.length > 0) connector.cannotAnswer = `It asks for information the panel cannot collect: ${missing.join(', ')}.`;
  return { connector, content };
}

/** Codex threads being copied now (see CodexSession.start), how many copies, and whether one of them unarchived it. */
const forksUnderWay = new Map<string, { count: number; unarchived: boolean; archiving?: Promise<void> }>();

/** Unarchives thread `threadId`, if it is archived: Codex answers an error for one that is not, which is no failure here. */

export async function unarchiveQuietly(request: (method: string, params: unknown) => Promise<unknown>, threadId: string): Promise<boolean> {
  return request('thread/unarchive', { threadId }).then(
    () => true,
    () => false,
  );
}

/** Names Codex thread `threadId` (`thread/name/set`): the title Codex's own lists show, the app and the phone, rather than the first message. */
export async function nameCodexThread(launch: CodexLaunch, threadId: string, name: string): Promise<void> {
  await withAppServer(launch, (request) => request('thread/name/set', { threadId, name }));
}

/** A thread's turn as `thread/read` gives it: its id and items. */
interface CodexTurn {
  id?: string;
  items?: { id?: string; type?: string; clientId?: string | null }[];
}

/**
 * The turn of `turns` holding item `itemId`: a message of yours by its id or by the id the panel sent
 * it with (its clientId), else any item by its id. The panel's ids for a call and its results carry
 * a suffix after the item's (`id:use`, `id:0`), left off here.
 */
export function codexTurnHolding(turns: CodexTurn[], itemId: string): CodexTurn | undefined {
  const bare = itemId.replace(/:(use|\d+)$/, '');
  return turns.find((turn) => (turn.items ?? []).some((item) => item.id === itemId || item.id === bare || (item.type === 'userMessage' && item.clientId === itemId)));
}

/**
 * Removes from Codex thread `threadId` the turn holding message `messageId` of yours and every turn
 * after it (`thread/revert`): the conversation only, not the files those turns changed. Codex keeps
 * no copy of what it removed. The chat's own Codex process must have ended first (see removeCodexFrom).
 */
export async function revertCodexThread(launch: CodexLaunch, threadId: string, messageId: string, hidden = false): Promise<void> {
  await withAppServer(launch, async (request) => {
    if (hidden) await unarchiveQuietly(request, threadId);
    // Archived again whatever happens after, a removal refused or failed as well (see CodexSessionConfig.hidden).
    try {
      const read = (await request('thread/read', { threadId, includeTurns: true })) as { thread?: { turns?: CodexTurn[] } };
      const turn = codexTurnHolding(read.thread?.turns ?? [], messageId);
      if (!turn?.id) throw new Error('that message was not found in the Codex conversation');
      // Codex removes whole turns: a message sent while it worked shares its turn with the one before.
      const first = (turn.items ?? []).find((item) => item.type === 'userMessage');
      if (first && first.id !== messageId && first.clientId !== messageId) throw new Error('this message was sent while Codex worked, in the same turn as the one before it. Remove from that one instead');
      // Codex reverts only a thread loaded in its process, and keeps it loaded until let go of.
      await request('thread/resume', { threadId, cwd: launch.cwd, excludeTurns: true });
      try {
        await request('thread/revert', { threadId, beforeTurnId: turn.id });
      } finally {
        await request('thread/unsubscribe', { threadId }).catch(() => undefined);
      }
    } finally {
      if (hidden) await request('thread/archive', { threadId }).catch(() => undefined);
    }
  });
}

/**
 * A copy of Codex thread `threadId` that Codex saves (`thread/fork`): up to and including the turn
 * holding item `upTo`, or all of it. The copy's id.
 */
export async function forkCodexThread(launch: CodexLaunch, threadId: string, upTo?: string, hidden = false): Promise<string> {
  return withAppServer(launch, async (request) => {
    // Codex copies only a thread that is not archived (see CodexSessionConfig.hidden): one that was is archived again after.
    const wasArchived = hidden && (await unarchiveQuietly(request, threadId));
    try {
      let lastTurnId: string | undefined;
      if (upTo) {
        const read = (await request('thread/read', { threadId, includeTurns: true })) as { thread?: { turns?: CodexTurn[] } };
        lastTurnId = codexTurnHolding(read.thread?.turns ?? [], upTo)?.id;
        if (!lastTurnId) throw new Error('that reply was not found in the Codex conversation');
      }
      const forked = (await request('thread/fork', { threadId, cwd: launch.cwd, excludeTurns: true, ...(lastTurnId ? { lastTurnId } : {}) })) as { thread?: { id?: string } };
      const id = forked.thread?.id;
      if (!id) throw new Error('Codex made no copy');
      // Loaded here by the fork; the chat that opens it loads it in its own process.
      await request('thread/unsubscribe', { threadId: id }).catch(() => undefined);
      return id;
    } finally {
      if (wasArchived) await request('thread/archive', { threadId }).catch(() => undefined);
    }
  });
}

/**
 * A saved Codex thread's turns, read through a short-lived app-server (`thread/read`): how a Codex
 * chat is drawn when opened from the history. The plugin reads no Codex file itself.
 */
export async function readCodexThread(launch: CodexLaunch, threadId: string): Promise<{ turns: { items?: unknown[] }[]; updatedAt?: number }> {
  return withAppServer(launch, async (request) => {
    const read = (await request('thread/read', { threadId, includeTurns: true })) as { thread?: { turns?: { items?: unknown[] }[]; updatedAt?: unknown } };
    const updatedAt = read.thread?.updatedAt;
    return { turns: read.thread?.turns ?? [], ...(typeof updatedAt === 'number' ? { updatedAt } : {}) };
  });
}

/** When Codex thread `threadId` last changed, read without its turns: whether a copy read before still holds (see loadAnyChat). */
/**
 * When the vault's Codex threads last changed (ms), by id, the most recently changed `limit` of each
 * kind: those in Codex's lists and those kept out of them (archived; see CodexSessionConfig.hidden).
 * Turns written elsewhere (Codex's app, the phone) count, which the panel's own records do not see.
 */
/** One of the vault's Codex threads, as `thread/list` gives it. */
export interface CodexThreadSummary {
  id: string;
  /** When it last changed, in ms. */
  updatedAt: number;
  archived: boolean;
  /** Started by the panel (`originator` vault-claude, see CodexConnection), and saved. */
  fromPanel: boolean;
  /** Its name in Codex's lists, else the start of its first message. */
  title: string;
}

/** The most pages read of one `thread/list` listing: a guard against a cursor that never ends. */
const THREAD_LIST_PAGES = 100;

/** Every page of `thread/list` with `params`, following `nextCursor` to the end. */
async function listAllThreads(request: (method: string, params: unknown) => Promise<unknown>, params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const threads: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < THREAD_LIST_PAGES; page += 1) {
    const listed = (await request('thread/list', { ...params, ...(cursor ? { cursor } : {}) })) as { data?: Record<string, unknown>[]; nextCursor?: unknown };
    threads.push(...(listed.data ?? []));
    if (typeof listed.nextCursor !== 'string' || !listed.nextCursor || listed.nextCursor === cursor) return threads;
    cursor = listed.nextCursor;
  }
  log('codex thread list cut at its page limit', { pages: THREAD_LIST_PAGES });
  return threads;
}

/**
 * The vault's Codex threads, archived ones included, every page of them: which says when each Codex
 * chat last changed, and lists the panel's Codex chats from Codex's own store, should the plugin's
 * records be lost.
 */
export async function readCodexThreads(launch: CodexLaunch, pageSize = 100): Promise<CodexThreadSummary[]> {
  return withAppServer(launch, async (request) => {
    const threads: CodexThreadSummary[] = [];
    for (const archived of [false, true]) {
      for (const thread of await listAllThreads(request, { cwd: launch.cwd, archived, sortKey: 'updated_at', limit: pageSize })) {
        if (typeof thread.id !== 'string' || typeof thread.updatedAt !== 'number') continue;
        const title = typeof thread.name === 'string' && thread.name.trim() ? thread.name : typeof thread.preview === 'string' ? thread.preview : '';
        threads.push({ id: thread.id, updatedAt: thread.updatedAt * 1000, archived, fromPanel: thread.originator === 'vault-claude' && thread.ephemeral !== true, title });
      }
    }
    return threads;
  });
}

export async function readCodexThreadStamp(launch: CodexLaunch, threadId: string): Promise<number | undefined> {
  return withAppServer(launch, async (request) => {
    const read = (await request('thread/read', { threadId, includeTurns: false })) as { thread?: { updatedAt?: unknown } };
    const updatedAt = read.thread?.updatedAt;
    return typeof updatedAt === 'number' ? updatedAt : undefined;
  });
}

/**
 * One request to Codex with no tools to use, as the panel's small jobs make them (summaries, memo
 * suggestions, inline edits): on a thread Codex does not save, in a read-only sandbox, never asking.
 * `onText` gets the reply so far as it comes; resolves to the whole reply.
 */
export async function runCodexOneShot(
  launch: CodexLaunch,
  request: { system: string; prompt: string; model?: string; effort?: string },
  onText: (text: string) => void,
  signal: AbortSignal,
): Promise<string> {
  // Given up before it began: nothing is started.
  if (signal.aborted) return '';
  return withAppServer(launch, async (call, reader) => {
    const opened = (await call('thread/start', { cwd: launch.cwd, developerInstructions: request.system, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true })) as { thread?: { id?: string } };
    const threadId = opened.thread?.id;
    if (!threadId) throw new Error('Codex started no thread');
    if (signal.aborted) return '';
    let streamed = '';
    let answer = '';
    let turnId: string | null = null;
    let cleanup = () => undefined as void;
    const finished = new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        // Stopped as soon as Codex says which turn it is, if it has not yet.
        if (turnId) void call('turn/interrupt', { threadId, turnId }).catch(() => undefined);
        resolve();
      };
      const stop = reader.listen((method, params) => {
        // The reader stopped (Codex exited, or did not answer in time): no more will come.
        if (method === READER_STOPPED) {
          cleanup();
          reject(new Error(typeof params.error === 'string' ? params.error : 'Codex stopped'));
          return;
        }
        if (params.threadId !== threadId) return;
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          streamed += params.delta;
          onText(streamed);
        } else if (method === 'item/completed') {
          const item = params.item as CodexItem | undefined;
          if (item?.type === 'agentMessage' && item.text) answer = item.text;
        } else if (method === 'turn/completed') {
          cleanup();
          const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
          if (turn?.status === 'failed') reject(new Error(turn.error?.message ?? 'Codex stopped with an error'));
          else resolve();
        }
      });
      cleanup = () => {
        stop();
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // Rejected while turn/start is still awaited: handled below, by the await, not left unhandled meanwhile.
    finished.catch(() => undefined);
    const effort = request.effort ? { effort: request.effort } : {};
    try {
      const started = (await call('turn/start', { threadId, input: codexInput(request.prompt), ...(request.model ? { model: request.model } : {}), ...effort })) as { turn?: { id?: string } };
      turnId = started.turn?.id ?? null;
    } catch (error) {
      cleanup();
      throw error;
    }
    if (signal.aborted && turnId) void call('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    await finished;
    return answer || streamed;
  });
}
