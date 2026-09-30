import assert from 'node:assert/strict';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';

/** A plugin with two chats about Note.md: `a` changed it, was sent it and mentioned it; `b` changed it. */
function setup() {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  p.vaultRoot = () => null;
  (p as unknown as { app: unknown }).app = {
    workspace: { getLeavesOfType: () => [] },
    // A saved chat note of `a`'s, as its frontmatter names it.
    metadataCache: { getFileCache: () => ({ frontmatter: { claude_session: 'a' } }) },
  };
  p.chats = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ];
  p.noteChats = { 'Note.md': ['a', 'b'] };
  p.noteRefs = { 'Note.md': ['a'] };
  p.noteMentions = { 'Note.md': ['a'] };
  return p;
}

const note = { path: 'Note.md' } as never;

test('a chat taken off a note is no longer offered for it or listed under it', () => {
  const p = setup();
  p.removeNoteChat('Note.md', 'a', 'A');
  assert.deepEqual([p.noteChats, p.noteRefs, p.noteMentions, p.noteRemoved], [{ 'Note.md': ['b'] }, {}, {}, { 'Note.md': ['a'] }]);
  // Not even as the chat a saved chat note came from.
  assert.deepEqual(p.noteChatEntries(note).map((entry) => entry.id), ['b']);
});

test('drawing the chat again does not link it again; a new edit, or sending it the note, does', () => {
  const p = setup();
  p.removeNoteChat('Note.md', 'a', 'A');
  p.linkNoteChat('Note.md', 'a', false);
  p.linkNoteMention('Note.md', 'a');
  assert.deepEqual([p.noteChats, p.noteMentions], [{ 'Note.md': ['b'] }, {}]);
  p.linkNoteChat('Note.md', 'a');
  assert.deepEqual([p.noteChats, p.noteRemoved], [{ 'Note.md': ['a', 'b'] }, {}]);
  p.removeNoteChat('Note.md', 'a', 'A');
  p.linkNoteRef('Note.md', 'a');
  assert.deepEqual([p.noteRefs, p.noteRemoved], [{ 'Note.md': ['a'] }, {}]);
});

test('a note that moves takes its removals along', () => {
  const p = setup();
  p.removeNoteChat('Note.md', 'a', 'A');
  p.noteMoved('Note.md', 'Moved.md');
  assert.deepEqual(p.noteRemoved, { 'Moved.md': ['a'] });
});
