import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexItemCompleted, codexToolUse, codexTranscript } from '../src/codexEvents';
import { draftEnded, emailDraft, emailMessages, readsThread } from '../src/emailMessages';
import { gmailBody } from '../src/gmailAdapter';

// As the app-server names the call (tool `gmail.create_draft` of server `codex_apps`), recorded 2026-10-20.
const name = 'mcp__codex_apps__gmail.create_draft';
const input = { to: 'self@example.com', subject: 'Vault Claude email test', payload: { mime_type: 'text/html', body: { content: '<p>Test &amp; review.</p><p>Not sent.</p>' } } };
// The actual result's shape, with IDs and addresses replaced.
const result = { content: [{ type: 'text', text: 'Action completed.' }], structuredContent: { id: 'r-test', message: { id: 'm-test', thread_id: 't-test', label_ids: ['DRAFT'], payload: null } }, isError: false };

test('Codex Gmail draft cards use structured results and the original MIME input', () => {
  const draft = emailDraft(name, input, JSON.stringify(result));
  assert.deepEqual(draft, { id: 'r-test', connector: 'codex', updated: false, to: ['self@example.com'], cc: [], bcc: [], subject: input.subject, body: 'Test & review.\nNot sent.', threadId: 't-test' });
  assert.deepEqual(emailDraft(name, input, 'Action completed.', result.structuredContent), draft);
  assert.equal(emailDraft('mcp__other__gmail_create_draft', input, JSON.stringify(result)), null);
});

test('Codex live events and saved transcript replay reconstruct the same draft card', () => {
  const item = { type: 'mcpToolCall', id: 'call1', server: 'codex_apps', tool: 'gmail.create_draft', arguments: input, result, status: 'completed' };
  const tool = codexToolUse(item)!;
  const live = codexItemCompleted('session', item)[0];
  const replay = codexTranscript('session', [{ items: [item] }]).transcript;
  const content = (row: typeof live) => (row.message as { content: { content: string }[] }).content[0].content;
  assert.deepEqual(emailDraft(String(tool.name), input, content(live)), emailDraft(String(tool.name), input, content(replay[1])));
  assert.equal(emailDraft(String(tool.name), input, content(live))?.id, 'r-test');
});

test('failed MCP responses produce no draft and are marked failed for the renderer', () => {
  const error = { ...result, isError: true };
  assert.equal(emailDraft(name, input, JSON.stringify(error)), null);
  const row = codexItemCompleted('s', { type: 'mcpToolCall', id: 'bad', status: 'completed', result: error })[0];
  assert.equal((row.message as { content: { is_error: boolean }[] }).content[0].is_error, true);
  for (const text of ['Action completed.', '{}', '{"id":null}', '{"id":{}}']) assert.equal(emailDraft(name, input, text), null);
});

test('MCP text JSON results are accepted without assuming the status text is message content', () => {
  assert.equal(emailDraft(name, input, JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result.structuredContent) }] }))?.id, 'r-test');
  assert.equal(emailDraft(name, input, JSON.stringify({ content: [{ type: 'text', text: 'Action completed.' }] })), null);
});

test('sparse Codex updates leave omitted subject and body absent', () => {
  const draft = emailDraft('mcp__codex_apps__gmail.update_draft', { draft_id: 'r-test', subject: 'Revised' }, JSON.stringify(result));
  assert.equal(draft?.updated, true);
  assert.equal(draft?.subject, 'Revised');
  assert.equal(draft?.body, undefined);
  assert.deepEqual(draftEnded('mcp__codex_apps__gmail.send_draft', { draft_id: 'r-test' }), { id: 'r-test', outcome: 'sent' });
  assert.equal(draftEnded('mcp__codex_apps__gmail.send_email', { draft_id: 'r-test' }), null);
});

const message = { id: 'm', thread_id: 't', internal_date: '1700000000000', label_ids: ['UNREAD'], snippet: 'Preview', payload: { mime_type: 'multipart/mixed', headers: [{ name: 'From', value: 'Sender <sender@example.com>' }, { name: 'To', value: 'self@example.com' }, { name: 'Subject', value: 'Subject' }], parts: [{ mime_type: 'text/plain', body: { content: 'Full body' } }, { mime_type: 'application/pdf', filename: 'report.pdf', body: { attachment_id: 'att' } }] } };
test('Codex message/thread/search cards map Gmail API headers, MIME bodies and metadata', () => {
  for (const [tool, data] of [['read_email', message], ['read_email_thread', { messages: [message] }], ['search_emails', { messages: [message] }], ['batch_read_email', { emails: [message] }]] as const) {
    const cards = emailMessages(`mcp__codex_apps__gmail.${tool}`, JSON.stringify({ structuredContent: data }));
    assert.equal(cards?.length, 1);
    assert.equal(cards[0].body, 'Full body');
    assert.equal(cards[0].subject, 'Subject');
    assert.equal(cards[0].threadId, 't');
    assert.equal(cards[0].unread, true);
    assert.equal(cards[0].time, 1700000000000);
    assert.deepEqual(cards[0].attachments, [{ name: 'report.pdf', type: 'application/pdf' }]);
  }
  assert.equal(readsThread('mcp__codex_apps__gmail.read_email_thread'), true);
  assert.deepEqual(emailMessages('mcp__codex_apps__gmail.search_emails', '{"messages":[{"id":"only-id"},null]}'), []);
});

test('MIME alternatives show one body and exclude attachments and active HTML', () => {
  assert.equal(gmailBody({ mime_type: 'multipart/alternative', parts: [{ mime_type: 'text/html', body: { content: '<p>HTML copy</p>' } }, { mime_type: 'text/plain', body: { content: 'Plain copy' } }] }), 'Plain copy');
  assert.equal(gmailBody({ mime_type: 'text/html', body: { content: '<script>bad()</script><p>Safe</p><img src="https://example.com/tracker">' } }), 'Safe');
  assert.equal(gmailBody({ mime_type: 'text/plain', filename: 'private.txt', body: { content: 'not the body' } }), '');
});

test('the name Codex scripts use for the same tool is taken too, and no other server is', async () => {
  const { codexGmailTool } = await import('../src/gmailAdapter');
  assert.equal(codexGmailTool('mcp__codex_apps__gmail.create_draft'), 'create_draft');
  assert.equal(codexGmailTool('mcp__codex_apps__gmail_create_draft'), 'create_draft');
  assert.equal(codexGmailTool('mcp__other__gmail.create_draft'), null);
  assert.equal(codexGmailTool('mcp__codex_apps__gmailXcreate_draft'), null);
});

test("a draft's attachments are listed from either connector's call", () => {
  const codex = emailDraft(name, { ...input, payload: { mime_type: 'multipart/mixed', parts: [input.payload, { mime_type: 'text/plain', filename: 'notes.txt', content_disposition: 'attachment', body: { content: 'x' } }] } }, JSON.stringify(result));
  assert.deepEqual(codex?.attachments, [{ name: 'notes.txt', type: 'text/plain' }]);
  const claude = emailDraft('mcp__claude_ai_Gmail__create_draft', { to: ['a@example.com'], subject: 'S', body: 'B', attachments: [{ filename: 'paper.pdf', mimeType: 'application/pdf', content: 'AA==' }] }, JSON.stringify({ id: 'r-1' }));
  assert.deepEqual(claude?.attachments, [{ name: 'paper.pdf', type: 'application/pdf' }]);
  assert.equal(emailDraft(name, input, JSON.stringify(result))?.attachments, undefined);
});

test('copied and blind-copied recipients are read from either connector, and shown on one line', async () => {
  const { recipientsLine } = await import('../src/emailCards');
  const codexMessage = { ...message, payload: { ...message.payload, headers: [...message.payload.headers, { name: 'Cc', value: 'c@example.com' }, { name: 'Bcc', value: 'b@example.com' }] } };
  const [codexCard] = emailMessages('mcp__codex_apps__gmail.read_email', JSON.stringify({ structuredContent: codexMessage })) ?? [];
  assert.deepEqual([codexCard.cc, codexCard.bcc], [['c@example.com'], ['b@example.com']]);
  const [claudeCard] = emailMessages('mcp__claude_ai_Gmail__get_thread', JSON.stringify({ id: 't', messages: [{ id: 'm', threadId: 't', sender: 'a@example.com', toRecipients: ['x@example.com'], ccRecipients: ['c@example.com'], subject: 'S', snippet: 'x', plaintextBody: 'x' }] })) ?? [];
  assert.deepEqual(claudeCard.cc, ['c@example.com']);
  assert.equal(claudeCard.bcc, undefined);
  assert.equal(recipientsLine(['x@example.com'], ['c@example.com', 'd@example.com'], ['b@example.com']), 'To x@example.com · Cc c@example.com, d@example.com · Bcc b@example.com');
  assert.equal(recipientsLine([], ['c@example.com'], []), 'Cc c@example.com');
});
