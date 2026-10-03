import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteControlServer } from '../src/remoteControl';

/** The server's output read in `chunks`, as its process writes it; how many times listeners heard of a change. */
function read(chunks: string[]) {
  const server = new RemoteControlServer();
  let changes = 0;
  server.onChange(() => (changes += 1));
  const parse = (server as unknown as { parse(chunk: string): void }).parse.bind(server);
  for (const chunk of chunks) parse(chunk);
  return { status: server.status, changes };
}

test('a link and a status split between two reads are still found', () => {
  const { status } = read(['Connecting…\nhttps://claude.ai/code?envir', 'onment=env_abc-123\nConnec', 'ted · Capacity: 2/32\n']);
  assert.equal(status.url, 'https://claude.ai/code?environment=env_abc-123');
  assert.equal(status.state, 'connected');
  assert.equal(status.activeSessions, 2);
});

test('the latest status wins, and output read again reports nothing new', () => {
  const { status, changes } = read(['Connected · Capacity: 1/32\n', 'Reconnecting…\n', 'tick\n', 'tick\n']);
  assert.equal(status.state, 'starting');
  // Connected with its capacity, then reconnecting; the ticks change nothing.
  assert.equal(changes, 2);
});

test('a link cut off at the end of a read is not reported until it is finished', () => {
  const server = new RemoteControlServer();
  const parse = (server as unknown as { parse(chunk: string): void }).parse.bind(server);
  parse('Connecting…\nhttps://claude.ai/code?environment=env_');
  assert.equal(server.status.url, null);
  parse('abc-123\n');
  assert.equal(server.status.url, 'https://claude.ai/code?environment=env_abc-123');
});
