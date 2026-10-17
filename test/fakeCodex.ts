import { chmodSync, writeFileSync } from 'node:fs';

/**
 * A stand-in for `codex app-server` in `dir`: it notes that it started, answers the handshake and
 * the thread's start, and then as `mode` says: `exit`, asked to start a turn, answers and exits
 * without finishing it; `silent`, answers nothing after the handshake; `die`, exits as soon as the
 * thread has started.
 */
export function fakeCodex(dir: string, mode: 'exit' | 'silent' | 'die' = 'exit'): string {
  const file = `${dir}/codex`;
  writeFileSync(
    file,
    `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(`${dir}/started`)}, '');
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
    if (message.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    if (message.method === 'initialize') reply({});
    else if (mode === 'silent') continue;
    else if (message.method === 'thread/start') {
      reply({ thread: { id: 't1' } });
      if (mode === 'die') setTimeout(() => process.exit(3), 20);
    } else if (message.method === 'turn/start') {
      reply({ turn: { id: 'turn1' } });
      setTimeout(() => process.exit(0), 20);
    } else reply({});
  }
});
`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** How to run the stand-in: node found on PATH by its first line, this one's folder first. */
export function launchIn(dir: string, mode?: 'exit' | 'silent' | 'die') {
  return { codexPath: fakeCodex(dir, mode), cwd: dir, env: { ...process.env, PATH: `${process.execPath.replace(/\/node$/, '')}:${process.env.PATH ?? ''}` } };
}
