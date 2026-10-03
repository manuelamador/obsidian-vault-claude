import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addIdeaSources, chatLink, ideaNoteMarkdown, ideaNoteName, passageNeedle, type IdeaSources } from '../src/ideas';

const sources: IdeaSources = {
  vault: 'Obsidian',
  chatId: 'chat-1',
  chatTitle: 'Debt model [draft]',
  date: '2026-10-03',
  excerpts: [
    { role: 'you', text: 'Does the result survive\nrecursive repayment?', needle: 'Does the result survive' },
    { role: 'claude', text: 'A possible mechanism: $q(b)$ falls.', needle: 'A possible mechanism:' },
  ],
};

test('a new idea note: frontmatter, title, description, and each passage with who wrote it and links back', () => {
  const note = ideaNoteMarkdown({ title: 'Repayment timing may change equilibrium selection', description: 'Test it under other continuation choices.', sources });
  assert.match(note, /^---\ntype: idea\ntags: \[idea\]\ncreated: 2026-10-03\nupdated: 2026-10-03\nclaude_chats: \[chat-1\]\n---\n\n# Repayment timing may change equilibrium selection\n\nTest it under other continuation choices\.\n\n## Sources\n\n### Debt model draft · 2026-10-03\n/);
  assert.ok(note.includes('**You** · [Go to the passage](obsidian://vault-claude?vault=Obsidian&chat=chat-1&find=Does%20the%20result%20survive)'));
  assert.ok(note.includes('> Does the result survive\n> recursive repayment?'));
  assert.ok(note.includes('**Claude** · '));
  assert.ok(note.includes('> A possible mechanism: $q(b)$ falls.'));
  assert.ok(note.endsWith('falls.\n'));
});

test('passages added later go at the end of the Sources section, before any section after it', () => {
  const note = ideaNoteMarkdown({ title: 'Idea', description: '', sources });
  const withNotes = `${note}\n## Notes\n\nMine.\n`;
  const added = addIdeaSources(withNotes, { ...sources, chatId: 'chat-2', chatTitle: 'Follow-up', excerpts: [{ role: 'you', text: 'A refinement.', needle: 'A refinement.' }] });
  const follow = added.indexOf('### Follow-up · 2026-10-03');
  assert.ok(follow > added.indexOf('A possible mechanism'));
  assert.ok(follow < added.indexOf('## Notes'));
  assert.ok(added.endsWith('Mine.\n'));
  // A note whose Sources heading was removed gets one again.
  const bare = addIdeaSources('# Idea\n\nJust a description.\n', sources);
  assert.ok(bare.includes('Just a description.\n\n## Sources\n\n### Debt model draft'));
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

test("an idea's note name drops what file names cannot hold", () => {
  assert.equal(ideaNoteName('Debt: timing / selection?'), 'Debt timing selection');
});
