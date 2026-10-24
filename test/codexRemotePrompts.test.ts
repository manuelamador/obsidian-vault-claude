import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexSession } from '../src/codexSession';

/** What the tests reach inside a session: its notifications, its requests and its turn. */
interface Inside {
  sessionId: string | null;
  turnId: string | null;
  turnMessages: string[];
  start(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
  onNotification(method: string, params: Record<string, unknown>): void;
  sending: Promise<void>;
}

/** A session on thread t1 that starts nothing, whose results the test collects. */
function session(): { s: CodexSession; inside: Inside; results: unknown[] } {
  const results: unknown[] = [];
  const s = new CodexSession({ codexPath: '/nonexistent', cwd: '/tmp', env: {} } as never, {
    onMessage: (message) => void results.push(message),
    onPermission: async () => ({ behavior: 'deny', message: '' }) as never,
    onEnd: () => undefined,
  });
  const inside = s as unknown as Inside;
  inside.sessionId = 't1';
  inside.start = async () => undefined;
  return { s, inside, results };
}

const userMessage = (id: string, clientId: string | null, text: string) => ({ threadId: 't1', item: { type: 'userMessage', id, clientId, content: [{ type: 'text', text }] } });

test("a message steered from the panel is never taken as sent from elsewhere, even when Codex reports it before the steer's answer", async () => {
  const { s, inside } = session();
  inside.turnId = 'turn1';
  inside.request = async (method, params) => {
    // Codex reports the steered message as it takes it, before answering the request.
    if (method === 'turn/steer') inside.onNotification('item/started', userMessage('item-1', (params as { clientUserMessageId: string }).clientUserMessageId, 'mine'));
    return {};
  };
  s.send('mine', undefined, 'panel-uuid');
  await inside.sending;
  assert.deepEqual(s.takeRemotePrompts(), []);
});

test('a message from the phone steered into a turn is offered to the panel at once, and none is left over once the turn ends', () => {
  const { s, inside } = session();
  let called = 0;
  s.onRemotePrompts = () => (called += 1);
  inside.turnId = 'turn1';
  inside.turnMessages = ['panel-uuid'];
  inside.onNotification('item/started', userMessage('item-2', null, 'from the phone'));
  assert.equal(called, 1);
  // Not taken by the panel (a turn with nothing drawn): let go of when the turn ends.
  inside.onNotification('item/started', userMessage('item-3', 'phone-client', 'again'));
  assert.equal(called, 2);
  inside.onNotification('turn/completed', { threadId: 't1', turn: { id: 'turn1', status: 'completed' } });
  assert.deepEqual(s.takeRemotePrompts(), []);
});

test('a turn started from the phone keeps its message, with its client id, until the panel takes it', () => {
  const { s, inside } = session();
  inside.onNotification('item/started', userMessage('item-4', 'phone-client', 'hello'));
  const taken = s.takeRemotePrompts();
  assert.equal(taken.length, 1);
  assert.equal(taken[0]?.id, 'item-4');
  assert.equal(taken[0]?.clientId, 'phone-client');
  assert.deepEqual(s.takeRemotePrompts(), []);
});
