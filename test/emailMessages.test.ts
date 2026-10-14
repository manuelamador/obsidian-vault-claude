import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEntities, emailMessages, readsMail, resultText } from '../src/emailMessages';

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

test('a thread keeps each message\'s whole text, with its paragraphs; a search has none', () => {
  const thread = emailMessages('mcp__claude_ai_Gmail__get_thread', JSON.stringify({ messages: [msg({ plaintextBody: 'Dear Tim,\r\n\r\n\r\nA quick update.\r\nSee you.' })] }));
  assert.equal(thread?.[0].body, 'Dear Tim,\n\nA quick update.\nSee you.');
  assert.equal(thread?.[0].text, 'Hi there');
  const search = emailMessages('mcp__claude_ai_Gmail__search_threads', JSON.stringify({ threads: [{ messages: [msg()] }] }));
  assert.equal(search?.[0].body, undefined);
});

test('Gmail\'s HTML escapes in snippets and subjects become characters', () => {
  assert.equal(decodeEntities('Kehoe &lt;tkehoe@umn.edu&gt; wrote: it&#39;s &amp; &quot;ok&quot; &#x27;x&#x27; &bogus;'), 'Kehoe <tkehoe@umn.edu> wrote: it\'s & "ok" \'x\' &bogus;');
  const one = emailMessages('mcp__claude_ai_Gmail__get_message', JSON.stringify(msg({ snippet: 'a &lt;b&gt;', subject: 'R&amp;D' })));
  assert.equal(one?.[0].text, 'a <b>');
  assert.equal(one?.[0].subject, 'R&D');
});

test('a metadata-only search leaves the subject empty; a message without one says so', () => {
  const meta = emailMessages('mcp__claude_ai_Gmail__search_threads', JSON.stringify({ threads: [{ messages: [msg({ subject: undefined, snippet: undefined })] }] }));
  assert.equal(meta?.[0].subject, '');
  assert.equal(meta?.[0].text, '');
  assert.equal(emailMessages('mcp__claude_ai_Gmail__get_message', JSON.stringify(msg({ subject: '' })))?.[0].subject, '(no subject)');
});
