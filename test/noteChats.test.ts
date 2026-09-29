import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followDraftNotes, followNote, forgetChat, linkNote, movedPath, noteChatEntries, type NoteChats } from '../src/noteChats';

test('a note keeps every chat, newest first, and follows a rename; a deleted chat is dropped', () => {
  const index: NoteChats = {};
  for (const id of ['a', 'b', 'c', 'd', 'e', 'b']) linkNote(index, 'Note.md', id);
  assert.deepEqual(index['Note.md'], ['b', 'e', 'd', 'c', 'a']);
  assert.equal(followNote(index, 'Note.md', 'Moved.md'), true);
  assert.equal(forgetChat(index, 'c'), true);
  assert.deepEqual(index, { 'Moved.md': ['b', 'e', 'd', 'a'] });
});

test('linking the newest chat again changes nothing', () => {
  const index: NoteChats = { 'Note.md': ['a'] };
  assert.equal(linkNote(index, 'Note.md', 'a'), false);
});

test('chats a note was sent with come after those that changed it; a chat in both is listed once, as changed', () => {
  const entries = noteChatEntries([{ id: 'a', title: 'Edited it' }], 'src', [
    { id: 'a', title: 'Edited it' },
    { id: 'b', title: 'Asked about it' },
  ]);
  assert.deepEqual(
    entries.map((entry) => `${entry.id}:${entry.why}`),
    ['a:changed', 'src:changed', 'b:sent'],
  );
});

test('an edit seen again in a saved chat fills in a missing link at the end, and never moves the chat ahead', () => {
  const index: NoteChats = { 'Note.md': ['new', 'old'] };
  assert.equal(linkNote(index, 'Note.md', 'old', false), false);
  assert.equal(linkNote(index, 'Note.md', 'older', false), true);
  assert.deepEqual(index['Note.md'], ['new', 'old', 'older']);
  assert.equal(linkNote(index, 'Note.md', 'oldest', false), true);
  assert.deepEqual(index['Note.md'], ['new', 'old', 'older', 'oldest']);
  assert.equal(linkNote(index, 'Other.md', 'old', false), true);
  assert.deepEqual(index['Other.md'], ['old']);
});

test('a note moved onto one with chats joins them, its own first', () => {
  const index: NoteChats = { 'Old.md': ['a', 'b'], 'New.md': ['b', 'c'] };
  assert.equal(followNote(index, 'Old.md', 'New.md'), true);
  assert.deepEqual(index, { 'New.md': ['a', 'b', 'c'] });
});

test('a deleted note, or a deleted folder\'s notes, lose their chats; a note that only shares a prefix keeps them', () => {
  const index: NoteChats = { 'Draft.md': ['a'], 'Notes/One.md': ['b'], 'Notes/Deep/Two.md': ['c'], 'Notes2/Three.md': ['d'] };
  assert.equal(followNote(index, 'Draft.md', null), true);
  assert.equal(followNote(index, 'Notes', null), true);
  assert.equal(followNote(index, 'Gone.md', null), false);
  assert.deepEqual(index, { 'Notes2/Three.md': ['d'] });
});

test('a folder that moves takes its notes’ chats along, and a note beside it with a like name keeps its own', () => {
  const index: NoteChats = { 'Notes/One.md': ['a'], 'Notes/Deep/Two.md': ['b'], 'Notes2/Three.md': ['c'] };
  assert.equal(followNote(index, 'Notes', 'Archive/Notes'), true);
  assert.deepEqual(index, { 'Archive/Notes/One.md': ['a'], 'Archive/Notes/Deep/Two.md': ['b'], 'Notes2/Three.md': ['c'] });
});

test('movedPath: the new path for a moved note or a note in a moved folder, null when deleted, undefined when not affected', () => {
  assert.equal(movedPath('A.md', 'A.md', 'B.md'), 'B.md');
  assert.equal(movedPath('F/A.md', 'F', 'G'), 'G/A.md');
  assert.equal(movedPath('F/A.md', 'F', null), null);
  assert.equal(movedPath('F2/A.md', 'F', 'G'), undefined);
});

test('followDraftNotes: a draft’s note follows a move; deleted, the draft keeps its text, or goes when it has none', () => {
  const drafts = new Map<string, { text?: string; note?: string }>([
    ['a', { note: 'F/A.md', text: 'typed' }],
    ['b', { note: 'F/B.md', text: '  ' }],
    ['c', { note: 'Other.md' }],
  ]);
  assert.equal(followDraftNotes(drafts, 'F', 'G', (key) => drafts.delete(key)), true);
  assert.deepEqual([...drafts.values()].map((d) => d.note), ['G/A.md', 'G/B.md', 'Other.md']);
  assert.equal(followDraftNotes(drafts, 'G', null, (key) => drafts.delete(key)), true);
  assert.deepEqual(Object.fromEntries(drafts), { a: { text: 'typed' }, c: { note: 'Other.md' } });
  assert.equal(followDraftNotes(drafts, 'Nothing.md', null, (key) => drafts.delete(key)), false);
});
