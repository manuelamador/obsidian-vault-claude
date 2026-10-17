import assert from 'node:assert/strict';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';

test('a Claude chat record past the limit goes alone: its note links, draft and pin stay; a Codex record is never dropped', () => {
  const plugin = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  plugin.saveSettings = async () => undefined;
  plugin.chats = [...Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}` })), { id: 'x', title: 'Codex chat', engine: 'codex' as const, at: 1 }];
  plugin.noteChats = { 'Note.md': ['c0', 'c499'], 'Old.md': ['c499'] };
  plugin.drafts = { c499: { text: 'unsent' } };
  plugin.pinned = ['c499'];
  plugin.recordChat('new', 'New chat');
  assert.equal(plugin.chats.some((chat) => chat.id === 'c499'), false);
  assert.equal(plugin.chats.filter((chat) => chat.engine !== 'codex').length, 500);
  assert.equal(plugin.isCodexChat('x'), true);
  assert.deepEqual(plugin.noteChats, { 'Note.md': ['c0', 'c499'], 'Old.md': ['c499'] });
  assert.deepEqual(plugin.drafts.c499, { text: 'unsent' });
  assert.deepEqual(plugin.pinned, ['c499']);
});
