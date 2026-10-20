import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentKind, decodeEntities, emailDraft, emailMessages, readsMail, resultText, readsThread } from '../src/emailMessages';

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

test('messages carry their thread id, and get_thread reads a thread', () => {
  const search = JSON.stringify({ threads: [{ id: 't1', messageCount: 2, messages: [{ sender: 'a', subject: 's', threadId: 't1' }, { sender: 'b', subject: 's', threadId: 't1' }] }] });
  assert.equal(emailMessages('mcp__claude_ai_Gmail__search_threads', search)?.[0].threadId, 't1');
  assert.equal(readsThread('mcp__claude_ai_Gmail__get_thread'), true);
  assert.equal(readsThread('mcp__claude_ai_Gmail__search_threads'), false);
  assert.equal(readsThread('mcp__other__get_thread'), false);
});

test('a draft written or changed shows what the call set, and where Gmail opens it', () => {
  const draft = emailDraft('mcp__claude_ai_Gmail__create_draft', { to: ['a@b.c'], cc: ['d@e.f'], subject: 'Visit', body: 'Dear A,\r\n\r\nYes.' }, JSON.stringify({ id: 'r-1', viewUrl: 'https://mail.google.com/x' }));
  assert.deepEqual(draft, { id: 'r-1', updated: false, to: ['a@b.c'], cc: ['d@e.f'], subject: 'Visit', body: 'Dear A,\n\nYes.', url: 'https://mail.google.com/x' });
  assert.equal(emailDraft('mcp__claude_ai_Gmail__update_draft', { body: 'x' }, JSON.stringify({ id: 'r-1' }))?.updated, true);
  assert.equal(emailDraft('mcp__claude_ai_Gmail__create_draft', {}, 'Error'), null);
  assert.equal(emailDraft('mcp__claude_ai_Gmail__get_thread', {}, '{"id":"x"}'), null);
});

test("a message's attachments are kept by name and type; a message without any has none", () => {
  const text = JSON.stringify({ messages: [
    { sender: 'a@b.c', subject: 'Report', plaintextBody: 'See attached.', attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', id: 'x' }, { filename: 'logo.png', mimeType: 'image/png', id: 'y' }, { filename: '', mimeType: 'text/plain' }] },
    { sender: 'a@b.c', subject: 'Plain', plaintextBody: 'Nothing.' },
  ] });
  const [withFiles, without] = emailMessages('mcp__claude_ai_Gmail__get_thread', text) ?? [];
  assert.deepEqual(withFiles.attachments, [{ name: 'report.pdf', type: 'application/pdf' }, { name: 'logo.png', type: 'image/png' }]);
  // With the message's id, the account and the part: a link to the attachment itself.
  const linked = emailMessages('mcp__claude_ai_Gmail__get_message', JSON.stringify({ id: '1a145af88756fee5', sender: 'a@b.c', subject: 'S', viewUrl: 'https://mail.google.com/mail/?authuser=me@example.com#all/thread-f:1|msg-f:1', attachments: [{ filename: 'draft.pdf', mimeType: 'application/pdf', partId: '2' }] })) ?? [];
  assert.equal(linked[0].attachments?.[0].url, 'https://mail.google.com/mail/?authuser=me@example.com&ui=2&view=att&th=1a145af88756fee5&attid=0.2&disp=safe');
  // One attachment: no zip of them all; two: Gmail's Download all.
  assert.equal(linked[0].attachmentsZip, undefined);
  const two = emailMessages('mcp__claude_ai_Gmail__get_message', JSON.stringify({ id: 'abc', sender: 'a@b.c', subject: 'S', viewUrl: 'https://mail.google.com/mail/?authuser=me@example.com#x', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', partId: '1' }, { filename: 'b.pdf', mimeType: 'application/pdf', partId: '2' }] })) ?? [];
  assert.equal(two[0].attachmentsZip, 'https://mail.google.com/mail/?authuser=me@example.com&ui=2&view=att&th=abc&attid=0&disp=zip&zw');
  assert.equal(without.attachments, undefined);
  assert.deepEqual(['application/pdf', 'image/jpeg', 'text/calendar', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'].map(attachmentKind), ['PDF', 'image', 'calendar', 'Word', 'zip']);
});

test('a draft sent or deleted by its id is told apart from other Gmail calls', async () => {
  const { draftEnded } = await import('../src/emailMessages');
  assert.deepEqual(draftEnded('mcp__claude_ai_Gmail__send_message', { draftId: 'r-1' }), { id: 'r-1', outcome: 'sent' });
  assert.deepEqual(draftEnded('mcp__claude_ai_Gmail__delete_draft', { draftId: 'r-1' }), { id: 'r-1', outcome: 'deleted' });
  assert.equal(draftEnded('mcp__claude_ai_Gmail__send_message', { to: ['a@example.com'] }), null);
  assert.equal(draftEnded('mcp__claude_ai_Gmail__get_draft', { draftId: 'r-1' }), null);
});

test('a thread read without its subject is named by its sender, and takes the subject another read gave', async () => {
  const { mailThreadTitle } = await import('../src/emailMessages');
  const VaultClaudePlugin = (await import('../src/main')).default;
  assert.equal(mailThreadTitle({ subject: '', from: 'Anna <anna@example.com>' }), 'From Anna <anna@example.com>');
  assert.equal(mailThreadTitle({ subject: '' }), 'Email thread');
  const p = new (VaultClaudePlugin as unknown as new () => InstanceType<typeof VaultClaudePlugin>)();
  p.saveSettings = async () => undefined;
  (p as unknown as { app: unknown }).app = { workspace: { getLeavesOfType: () => [] } };
  // A search for metadata only, then a read that gave the subject; and another chat's placeholder.
  p.recordMail('a', [{ threadId: 't1', subject: '', sender: 'Anna', time: 1 }]);
  p.recordMail('a', [{ threadId: 't1', subject: 'Plans', sender: 'Anna', time: 1 }]);
  p.chatMail.b = [{ id: 't1', subject: '(no subject)', at: 1 }];
  assert.deepEqual(p.mailOfChats(['b', 'a']).map((thread) => thread.subject), ['Plans']);
  p.recordMail('a', [{ threadId: 't1', subject: '', time: 2 }]);
  assert.equal(p.chatMail.a[0].subject, 'Plans');
});
