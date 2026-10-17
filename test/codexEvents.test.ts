import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexItemCompleted, codexItemStarted, codexTranscript, codexTurnResult, diffHunks } from '../src/codexEvents';
import { codexInput, deniedCommand } from '../src/codexSession';

test('a Codex command is drawn as a Bash call and its output as the result', () => {
  const started = codexItemStarted('t', { type: 'commandExecution', id: 'c1', command: 'ls' });
  assert.deepEqual((started[0].message as { content: unknown[] }).content, [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }]);
  const done = codexItemCompleted('t', { type: 'commandExecution', id: 'c1', aggregatedOutput: 'a\nb\n', exitCode: 0, status: 'completed' });
  assert.deepEqual((done[0].message as { content: unknown[] }).content, [{ type: 'tool_result', tool_use_id: 'c1', content: 'a\nb\n', is_error: false }]);
  const failed = codexItemCompleted('t', { type: 'commandExecution', id: 'c2', aggregatedOutput: '', exitCode: 2, status: 'failed' });
  assert.equal(((failed[0].message as { content: { is_error: boolean }[] }).content)[0].is_error, true);
});

test('a reply is drawn as text; a turn ends as a result with its tokens and the messages it answered', () => {
  const reply = codexItemCompleted('t', { type: 'agentMessage', id: 'm1', text: 'ok' });
  assert.deepEqual((reply[0].message as { content: unknown[] }).content, [{ type: 'text', text: 'ok' }]);
  assert.deepEqual(codexItemCompleted('t', { type: 'userMessage', id: 'u' }), []);
  const result = codexTurnResult('t', { status: 'completed', durationMs: 1200 }, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 5 }, ['u1']);
  assert.equal(result.subtype, 'success');
  assert.deepEqual(result.usage, { input_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, output_tokens: 5 });
  assert.deepEqual(result.user_message_uuids, ['u1']);
  assert.equal(codexTurnResult('t', { status: 'failed', error: { message: 'boom' } }, null, []).result, 'boom');
});

test('a message goes to Codex as text and data-URL images', () => {
  assert.deepEqual(codexInput('hi'), [{ type: 'text', text: 'hi', text_elements: [] }]);
  assert.deepEqual(codexInput([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'see' }]), [{ type: 'image', url: 'data:image/png;base64,AAA' }, { type: 'text', text: 'see', text_elements: [] }]);
});

test('a Codex file change is drawn as an edit per file, with its hunks for the changed-files card', () => {
  const item = { type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: '/v/a.md', kind: { type: 'update' }, diff: '@@ -1,2 +1,2 @@\n line\n-old\n+new\n' }, { path: '/v/b.md', kind: { type: 'add' }, diff: 'hello\nworld\n' }] };
  const started = codexItemStarted('t', item);
  assert.deepEqual(((started[0].message as { content: { id: string; name: string }[] }).content).map((use) => [use.id, use.name]), [['f:0', 'Edit'], ['f:1', 'Write']]);
  const done = codexItemCompleted('t', item);
  assert.equal(done.length, 2);
  assert.deepEqual((done[0].tool_use_result as { structuredPatch: unknown }).structuredPatch, [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' line', '-old', '+new'] }]);
  assert.deepEqual((done[1].tool_use_result as { structuredPatch: { lines: string[] }[] }).structuredPatch[0].lines, ['+hello', '+world']);
  assert.deepEqual(diffHunks('', 'update'), []);
  // Lines inside a hunk that look like file headers are content.
  assert.deepEqual(diffHunks('--- a/n.md\n+++ b/n.md\n@@ -1 +1 @@\n--- old\n+++ new\n', 'update')[0].lines, ['--- old', '+++ new']);
  // A new note's own lines, frontmatter fences and bullets included, kept as they are.
  assert.deepEqual(diffHunks('---\ntags: [a]\n---\n- item\n+ plus\n', 'add')[0].lines, ['+---', '+tags: [a]', '+---', '+- item', '++ plus']);
});

test("Codex commands refused by the panel's deny rules", () => {
  const rules = ['Bash(git checkout:*)', 'Bash(rm -rf:*)', 'mcp__claude_ai_Gmail__send_message'];
  assert.equal(deniedCommand(rules, 'git checkout -- Note.md'), true);
  assert.equal(deniedCommand(rules, "/bin/zsh -lc 'cd x && git checkout main'"), true);
  assert.equal(deniedCommand(rules, 'rm -rf tmp'), true);
  assert.equal(deniedCommand(rules, 'git status'), false);
  assert.equal(deniedCommand(rules, 'git checkoutx'), false);
});

test('a saved Codex thread is drawn as its messages, with its file changes kept for the cards', () => {
  const turns = [{ items: [
    { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'fix it' }] },
    { type: 'agentMessage', id: 'm1', text: 'Done.' },
    { type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'a.md', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] },
  ] }];
  const { transcript, edits } = codexTranscript('t', turns as never, '/v');
  assert.deepEqual(transcript.map((message) => message.type), ['user', 'assistant', 'assistant', 'user']);
  assert.equal((transcript[0].message as { content: string }).content, 'fix it');
  assert.equal(((transcript[2].message as { content: { input: { file_path: string } }[] }).content)[0].input.file_path, '/v/a.md');
  assert.ok(edits.has('f:0'));
});
