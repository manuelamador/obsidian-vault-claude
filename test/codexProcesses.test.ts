import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatGptAndDaemonAges } from '../src/codexProcesses';

const chatGpt = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled';
const daemon = '/Users/someone/.codex/packages/app-server-daemon/releases/local-abc/bin/codex app-server --remote-control --listen unix:// --managed-daemon';

test('the ChatGPT app and the shared app-server, by how long each has run', () => {
  assert.deepEqual(chatGptAndDaemonAges(`   09:24 ${chatGpt}\n   08:42 ${daemon}\n 1-02:03:04 /usr/bin/other app-server-ish\n`), { chatGpt: 564, daemon: 522 });
  assert.deepEqual(chatGptAndDaemonAges(` 19:33:26 ${daemon}\n   07:24 ${chatGpt}\n`), { chatGpt: 444, daemon: 70406 });
});

test('null when either is not running', () => {
  assert.equal(chatGptAndDaemonAges(`   09:24 ${chatGpt}\n`), null);
  assert.equal(chatGptAndDaemonAges(`   08:42 ${daemon}\n`), null);
  assert.equal(chatGptAndDaemonAges(''), null);
});
