import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frontmatterPrompt, readEdited, readFrontmatterSuggestions, valueText } from '../src/frontmatterSuggest';

test('proposals: one per key, with reasons; none for updated or for a value unchanged; null when not JSON', () => {
  const current = { status: 'old', groups: ['A', 'B'], updated: '2026-01-01' };
  const reply = 'Sure:\n{"fields": [{"key": "status", "value": "new", "reason": "The thread says so."}, {"key": "status", "value": "again"}, {"key": "updated", "value": "2026-10-07"}, {"key": "groups", "value": ["A", "B"]}, {"key": "next", "value": "Write it up"}]}';
  assert.deepEqual(readFrontmatterSuggestions(reply, current), [
    { key: 'status', value: 'new', reason: 'The thread says so.' },
    { key: 'next', value: 'Write it up', reason: '' },
  ]);
  assert.equal(readFrontmatterSuggestions('no', current), null);
});

test('values are edited as text and read back in the shape proposed', () => {
  assert.equal(valueText(['A', 'B']), 'A\nB');
  assert.deepEqual(readEdited('A\n\n C \n', ['x']), ['A', 'C']);
  assert.equal(readEdited('true', false), true);
  assert.equal(readEdited(' 3 ', 1), 3);
  assert.equal(readEdited(' text ', 'x'), 'text');
  assert.deepEqual(readEdited('{"a":1}', { b: 2 }), { a: 1 });
});

test('the request carries the note, its neighbours, the chats and the guidance', () => {
  const prompt = frontmatterPrompt({ path: 'P/Hub.md', text: '---\nstatus: x\n---\nBody', neighbours: [{ path: 'P/T.md', frontmatter: { status: 'open' }, modified: '2026-10-07' }], chats: [{ title: 'Chat', date: '2026-10-06' }], guidance: 'status ≤ 80' });
  assert.match(prompt, /^Note: P\/Hub\.md\n<note>\n---\nstatus: x/);
  assert.match(prompt, /- P\/T\.md \(2026-10-07\): \{"status":"open"\}/);
  assert.match(prompt, /- 2026-10-06: Chat/);
  assert.match(prompt, /Guidance from the user: status ≤ 80$/);
});
