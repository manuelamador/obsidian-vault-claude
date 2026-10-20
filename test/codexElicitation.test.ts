import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readElicitation } from '../src/codexSession';

test('an empty form is a plain confirmation, its message whole and as written', () => {
  // The sample request of a bug report (2026-10-20), with markup in its message left as text.
  const message = 'Send the attached test PDF to recipient@example.com?\n<b>Two attachments</b>';
  const { connector, content } = readElicitation({ threadId: 't', turnId: 'u', serverName: 'gmail', mode: 'form', message, requestedSchema: { type: 'object', properties: {} } });
  assert.deepEqual(connector, { message, fields: [], allowKey: `gmail:message:${message}` });
  assert.deepEqual(content, {});
});

test("a form's defaults are sent and shown; a required field with none, or a form it cannot read, cannot be answered", () => {
  const schema = {
    type: 'object',
    properties: { copy: { type: 'boolean', title: 'Send me a copy', default: true }, labels: { type: 'array', default: ['a', 'b'] }, note: { type: 'string' } },
  };
  const read = readElicitation({ mode: 'openai/form', message: 'Send?', requestedSchema: schema });
  assert.deepEqual(read.content, { copy: true, labels: ['a', 'b'] });
  assert.deepEqual(read.connector.fields, [
    { label: 'Send me a copy', value: 'yes' },
    { label: 'labels', value: 'a, b' },
    { label: 'note', value: '(left empty)' },
  ]);
  assert.equal(read.connector.cannotAnswer, undefined);
  const required = readElicitation({ mode: 'form', message: 'Send?', requestedSchema: { ...schema, required: ['note'] } });
  assert.equal(required.connector.cannotAnswer, 'It asks for information the panel cannot collect: note.');
  const nested = readElicitation({ mode: 'openaiForm', message: 'Send?', requestedSchema: { type: 'object', properties: { to: { type: 'object' } } } });
  assert.equal(nested.connector.cannotAnswer, 'It asks for a form the panel cannot read (to).');
  assert.equal(readElicitation({ mode: 'form', message: 'x', requestedSchema: 'nonsense' }).connector.cannotAnswer, 'It asks for a form the panel cannot read.');
});

test('a link is offered only if http or https; another way of asking cannot be answered', () => {
  assert.equal(readElicitation({ mode: 'url', message: 'Sign in', url: 'https://example.com/auth', elicitationId: 'e' }).connector.url, 'https://example.com/auth');
  const unsafe = readElicitation({ mode: 'url', message: 'Open', url: 'javascript:alert(1)' }).connector;
  assert.equal(unsafe.url, undefined);
  assert.equal(unsafe.cannotAnswer, 'It asks to open a link the panel does not open: javascript:alert(1)');
  assert.equal(readElicitation({ mode: 'openai/userVerification', message: 'Verify' }).connector.cannotAnswer, 'It asks in a way the panel does not support (openai/userVerification).');
});

test('a request naming the tool it runs is allowed for a chat by that tool and connector', () => {
  const asked = (serverName: string, tool: string) => readElicitation({ serverName, mode: 'form', message: `Allow Gmail to run tool "${tool}"?`, requestedSchema: { type: 'object', properties: {} } }).connector.allowKey;
  assert.equal(asked('codex_apps', 'gmail.archive_emails'), 'codex_apps:tool:gmail.archive_emails');
  // Another connector's tool of the same name is allowed apart.
  assert.notEqual(asked('other', 'gmail.archive_emails'), asked('codex_apps', 'gmail.archive_emails'));
});
