import assert from 'node:assert/strict';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';

test('a chat record that drops off the history takes its note links with it', () => {
  const plugin = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  plugin.saveSettings = async () => undefined;
  const now = Date.now();
  plugin.chats = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}`, createdAt: now - i, updatedAt: now - i }));
  plugin.noteChats = { 'Note.md': ['c0', 'c499'], 'Old.md': ['c499'] };
  plugin.noteRefs = { 'Sent.md': ['c499', 'c1'] };
  plugin.recordChat('new', 'New chat');
  assert.equal(plugin.chats.length, 500);
  assert.equal(plugin.chats.some((chat) => chat.id === 'c499'), false);
  assert.deepEqual(plugin.noteChats, { 'Note.md': ['c0'] });
  assert.deepEqual(plugin.noteRefs, { 'Sent.md': ['c1'] });
});
