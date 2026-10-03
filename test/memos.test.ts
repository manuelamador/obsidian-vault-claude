import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addMemoSources,
  chatLink,
  cleanTags,
  memoNoteMarkdown,
  memoNoteName,
  memoSuggestionPrompt,
  passageNeedle,
  readMemoSuggestion,
  type MemoSources,
} from '../src/memos';

const sources: MemoSources = {
  vault: 'Obsidian',
  chatId: 'chat-1',
  chatTitle: 'Debt model [draft]',
  date: '2026-10-03',
  passages: [
    { role: 'you', text: 'Does the result survive\nrecursive repayment?', needle: 'Does the result survive' },
    { role: 'claude', text: 'A possible mechanism: $q(b)$ falls.', needle: 'A possible mechanism:' },
  ],
};

test('a new memo note: frontmatter with its tags, title, description, and each passage with who wrote it and links back', () => {
  const note = memoNoteMarkdown({ title: 'Repayment timing may change equilibrium selection', description: 'Test it under other continuation choices.', tags: ['idea', 'read'], sources });
  assert.match(
    note,
    /^---\ntype: memo\ntags: \[memo, idea, read\]\ncreated: 2026-10-03\nupdated: 2026-10-03\nclaude_chats: \[chat-1\]\n---\n\n# Repayment timing may change equilibrium selection\n\nTest it under other continuation choices\.\n\n## Sources\n\n### Debt model draft · 2026-10-03\n/,
  );
  assert.ok(note.includes('**You** · [Go to the passage](obsidian://vault-claude?vault=Obsidian&chat=chat-1&find=Does%20the%20result%20survive)'));
  assert.ok(note.includes('> Does the result survive\n> recursive repayment?'));
  assert.ok(note.includes('**Claude** · '));
  assert.ok(note.includes('> A possible mechanism: $q(b)$ falls.'));
  assert.ok(note.endsWith('falls.\n'));
});

test('passages added later go at the end of the Sources section, before any section after it', () => {
  const note = memoNoteMarkdown({ title: 'Memo', description: '', tags: [], sources });
  const withNotes = `${note}\n## Notes\n\nMine.\n`;
  const added = addMemoSources(withNotes, { ...sources, chatId: 'chat-2', chatTitle: 'Follow-up', passages: [{ role: 'you', text: 'A refinement.', needle: 'A refinement.' }] });
  const follow = added.indexOf('### Follow-up · 2026-10-03');
  assert.ok(follow > added.indexOf('A possible mechanism'));
  assert.ok(follow < added.indexOf('## Notes'));
  assert.ok(added.endsWith('Mine.\n'));
  // A note whose Sources heading was removed gets one again.
  const bare = addMemoSources('# Memo\n\nJust a description.\n', sources);
  assert.ok(bare.includes('Just a description.\n\n## Sources\n\n### Debt model draft'));
});

test('tags as Obsidian takes them, each once', () => {
  assert.deepEqual(cleanTags(['#idea', ' to read ', 'todo', 'idea', '2026', '', 'econ/macro', 'a,b']), ['idea', 'to-read', 'todo', 'econ/macro', 'ab']);
});

test('links carry their values encoded, and leave out empty ones', () => {
  assert.equal(chatLink({ vault: 'My vault', chat: 'c1', quote: 'a & b = $x$' }), 'obsidian://vault-claude?vault=My%20vault&chat=c1&quote=a%20%26%20b%20%3D%20%24x%24');
  assert.equal(chatLink({ vault: 'V', chat: 'c1', find: '' }), 'obsidian://vault-claude?vault=V&chat=c1');
});

test('a passage is found by its first line of words, cut at a word', () => {
  assert.equal(passageNeedle('\n  Short line  \nnext'), 'Short line');
  assert.equal(passageNeedle('The repayment schedule interacts with the continuation value in a way that matters', 40), 'The repayment schedule interacts with');
  assert.equal(passageNeedle('\n\n'), '');
});

test("a memo's note name drops what file names cannot hold", () => {
  assert.equal(memoNoteName('Debt: timing / selection?'), 'Debt timing selection');
});

test('the suggestion request names who wrote each passage, and the reply is read from its JSON', () => {
  const prompt = memoSuggestionPrompt('Debt model', sources.passages);
  assert.ok(prompt.startsWith('Conversation: Debt model\n\nPassages, in order:\n\nThe researcher:\nDoes the result survive'));
  assert.ok(prompt.includes('The assistant:\nA possible mechanism: $q(b)$ falls.'));
  assert.deepEqual(readMemoSuggestion('Here it is:\n{"title": "Repayment timing and selection.", "description": "Asked whether $q(b)$ matters."}'), {
    title: 'Repayment timing and selection',
    description: 'Asked whether $q(b)$ matters.',
  });
  assert.equal(readMemoSuggestion('no json'), null);
  assert.equal(readMemoSuggestion('{"title": 3}'), null);
});
