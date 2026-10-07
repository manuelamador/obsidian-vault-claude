import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptNotes, replyLinks, transcriptNotes } from '../src/rebuildLinks';

test('promptNotes reads the notes a context block sent', () => {
  const prompt = [
    '<obsidian_context>',
    'Note attached to this chat: A/one.md',
    'Mentioned note: /vault/B/two.md',
    '<note path="C/three.md">',
    'body mentioning Note attached to this chat: nothing',
    '</note>',
    '<selection note="D/four.md" lines="1–2">',
    'x',
    '</selection>',
    'Attached file: /tmp/x.pdf',
    '</obsidian_context>',
    '',
    'Mentioned note: not in the block.md',
  ].join('\n');
  assert.deepEqual(promptNotes(prompt).sort(), ['/vault/B/two.md', 'A/one.md', 'C/three.md', 'D/four.md']);
  assert.deepEqual(promptNotes('<obsidian_context>\nActive note in Obsidian: E/five.md\n</obsidian_context>'), ['E/five.md']);
  assert.deepEqual(promptNotes('no context'), []);
});

test('replyLinks reads wikilinks and links to notes', () => {
  assert.deepEqual(replyLinks('See [[Note A|alias]], [[Note B#Heading]] and [x](Folder/My%20Note.md), not [y](https://e.com).'), ['Note A', 'Note B', 'Folder/My Note.md']);
});

test('transcriptNotes skips a subagent’s messages', () => {
  const rows = [
    { type: 'user', message: { content: '<obsidian_context>\nNote attached to this chat: A.md\n</obsidian_context>\n\nhi' }, parent_tool_use_id: null },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done: [[B]]' }, { type: 'tool_use' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { content: [{ type: 'text', text: '[[C]]' }] }, parent_tool_use_id: 'tool-1' },
  ];
  assert.deepEqual(transcriptNotes(rows), { sent: ['A.md'], mentioned: ['B'] });
});
