import { chmodSync, writeFileSync } from 'node:fs';

/**
 * A stand-in for `codex app-server` in `dir`: it notes that it started, answers the handshake and
 * the thread's start (writing each turn's params to `turn.json`, its arguments to `started` and every
 * request's method to `methods.log`), and then as `mode` says: `exit`, asked to start a turn, answers and exits
 * without finishing it; `silent`, answers nothing after the handshake; `die`, exits as soon as the
 * thread has started; `ask`, having started a turn, asks the panel a question and finishes the turn
 * only once it is answered (or refused); `elicit`, asks a connector's confirmation and exits once it is
 * answered, keeping the answer in `answer.json`; `elicitResolved`, asks it and then says it was resolved
 * elsewhere, exiting soon after; `elicitOther`, asks it for another thread; `threads`, lists two
 * threads the panel started, one page each; `turns`, finishes each turn at once and stays up
 * (the second only for the first page's `nextCursor`), and none archived; `stall`, starts a turn and never finishes it.
 * Run as `codex app-server daemon …`, it notes the command in `daemon.log` and exits: `start` puts the
 * shared app-server's socket and record under CODEX_HOME (see launchIn), or fails when `daemon-fails`
 * is in `dir`; `stop` takes them away.
 */
export function fakeCodex(dir: string, mode: 'exit' | 'silent' | 'die' | 'ask' | 'elicit' | 'elicitResolved' | 'elicitOther' | 'threads' | 'turns' | 'stall' = 'exit'): string {
  const file = `${dir}/codex`;
  writeFileSync(
    file,
    `#!/usr/bin/env node
if (process.argv[3] === 'daemon') {
  const fs = require('fs');
  const home = process.env.CODEX_HOME;
  fs.appendFileSync(${JSON.stringify(`${dir}/daemon.log`)}, process.argv.slice(4).join(' ') + '\\n');
  if (process.argv[4] === 'start') {
    if (fs.existsSync(${JSON.stringify(`${dir}/daemon-fails`)})) {
      process.stderr.write('the daemon could not start\\n');
      process.exit(1);
    }
    fs.mkdirSync(home + '/app-server-control', { recursive: true });
    fs.mkdirSync(home + '/app-server-daemon', { recursive: true });
    fs.writeFileSync(home + '/app-server-control/app-server-control.sock', '');
    fs.writeFileSync(home + '/app-server-daemon/daemon.pid', JSON.stringify({ pid: 4242, processStartTime: Date.now() }));
  } else if (process.argv[4] === 'stop') {
    fs.rmSync(home + '/app-server-control/app-server-control.sock', { force: true });
    fs.rmSync(home + '/app-server-daemon/daemon.pid', { force: true });
  }
  process.exit(0);
}
require('fs').writeFileSync(${JSON.stringify(`${dir}/started`)}, process.argv.slice(2).join(' '));
const mode = ${JSON.stringify(mode)};
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    // An answer (or refusal) to its question: the turn finishes.
    if (message.id === 'q1' && message.method === undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn1', status: 'completed' } } }) + '\\n');
      continue;
    }
    if (message.method) require('fs').appendFileSync(${JSON.stringify(`${dir}/methods.log`)}, message.method + '\\n');
    if (message.id === undefined) continue;
    // The panel's answer to the confirmation asked in 'elicit' mode: kept, and the turn ends.
    if (!message.method && message.id === 'e1') {
      require('fs').writeFileSync(${JSON.stringify(`${dir}/answer.json`)}, JSON.stringify(message.result ?? message.error));
      setTimeout(() => process.exit(0), 20);
      continue;
    }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    if (message.method === 'initialize') reply({});
    else if (mode === 'silent') continue;
    else if (message.method === 'thread/list') {
      const thread = (id, name) => ({ id, name, originator: 'vault-claude', updatedAt: 1790000000, preview: '' });
      if (message.params.archived) reply({ data: [], nextCursor: null });
      else if (message.params.cursor === 'page-2') reply({ data: [thread('p2', 'Second')], nextCursor: null });
      else reply({ data: [thread('p1', 'First')], nextCursor: 'page-2' });
    } else if (message.method === 'thread/start') {
      reply({ thread: { id: 't1' } });
      if (mode === 'die') setTimeout(() => process.exit(3), 20);
    } else if (message.method === 'turn/start') {
      require('fs').writeFileSync(${JSON.stringify(`${dir}/turn.json`)}, JSON.stringify(message.params));
      reply({ turn: { id: 'turn1' } });
      if (mode.startsWith('elicit')) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'e1', method: 'mcpServer/elicitation/request', params: { threadId: mode === 'elicitOther' ? 'other' : 't1', turnId: 'turn1', serverName: 'gmail', mode: 'form', _meta: null, message: 'Send this email?', requestedSchema: { type: 'object', properties: { note: { type: 'string', default: 'ok' } } } } }) + '\\n');
        if (mode === 'elicitResolved') {
          setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 'e1' } }) + '\\n'), 50);
          setTimeout(() => process.exit(0), 400);
        }
      } else if (mode === 'turns') {
        setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn1', status: 'completed' } } }) + '\\n'), 10);
      } else if (mode === 'ask') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'q1', method: 'item/tool/requestUserInput', params: { threadId: 't1' } }) + '\\n');
      else if (mode !== 'stall') setTimeout(() => process.exit(0), 20);
    } else reply({});
  }
});
`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** How to run the stand-in: node found on PATH by its first line, this one's folder first, and `dir` as Codex's home, so that no test reaches the shared app-server of the computer it runs on. */
export function launchIn(dir: string, mode?: 'exit' | 'silent' | 'die' | 'ask' | 'elicit' | 'elicitResolved' | 'elicitOther' | 'threads' | 'turns' | 'stall') {
  return { codexPath: fakeCodex(dir, mode), cwd: dir, env: { ...process.env, CODEX_HOME: dir, PATH: `${process.execPath.replace(/\/node$/, '')}:${process.env.PATH ?? ''}` } };
}
