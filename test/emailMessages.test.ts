import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailMessages, readsMail, resultText } from '../src/emailMessages';

const msg = (over: Record<string, unknown> = {}) => ({ sender: 'a@b.c', subject: 'Hello', date: '2026-09-24T17:28:34Z', snippet: 'Hi there', toRecipients: ['me@x.y'], labelIds: ['UNREAD'], viewUrl: 'https://mail.google.com/x', ...over });

test('a Gmail search shows each thread by its last message, with the thread size', () => {
  const text = JSON.stringify({ threads: [{ messageCount: 3, messages: [msg({ subject: 'first' }), msg({ subject: 'last', labelIds: [] })] }] });
  const messages = emailMessages('mcp__claude_ai_Gmail__search_threads', text);
  assert.ok(messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subject, 'last');
  assert.equal(messages[0].count, 3);
  assert.equal(messages[0].unread, false);
});

test('a thread shows every message; a message shows itself, its body when it has no snippet', () => {
  assert.equal(emailMessages('mcp__claude_ai_Gmail__get_thread', JSON.stringify({ messages: [msg(), msg()] }))?.length, 2);
  const one = emailMessages('mcp__claude_ai_Gmail__get_message', JSON.stringify(msg({ snippet: undefined, plaintextBody: 'Body\n\ntext' })));
  assert.equal(one?.[0].text, 'Body text');
  assert.equal(one?.[0].unread, true);
});

test('other tools, and results that are not JSON, show no cards', () => {
  assert.equal(readsMail('mcp__claude_ai_Gmail__create_draft'), false);
  assert.equal(emailMessages('Read', '{}'), null);
  assert.equal(emailMessages('mcp__claude_ai_Gmail__get_thread', 'Error: not found'), null);
  assert.equal(resultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
});
