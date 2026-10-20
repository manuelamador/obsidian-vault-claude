import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryItem } from '../src/history';
import VaultClaudePlugin from '../src/main';

test('rebuilding keeps at most 500 Claude records, the most recent first, and counts only those kept', async () => {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  p.vaultRoot = () => null;
  // 499 recorded, oldest; three found without records, newest; and a Codex record, never dropped.
  const old = Array.from({ length: 499 }, (_, i) => ({ id: `old${i}`, title: `Old ${i}`, updatedAt: 1000 - i, fromPanel: true }));
  const fresh = ['new0', 'new1', 'new2'].map((id, i) => ({ id, title: id, updatedAt: 5000 - i, fromPanel: true }));
  // And one just recorded, which the listing does not have yet: kept, whatever the cap.
  p.chats = [{ id: 'just', title: 'Just started' }, ...old.map(({ id, title }) => ({ id, title })), { id: 'cx', title: 'Codex', engine: 'codex' as const, at: 1 }];
  const items: HistoryItem[] = [...fresh, ...old];
  p.listChats = async () => items;
  await p.rebuildChatList(true);
  const claude = p.chats.filter((chat) => chat.engine !== 'codex');
  assert.equal(claude.length, 500);
  assert.deepEqual(claude.slice(0, 4).map((chat) => chat.id), ['just', 'new0', 'new1', 'new2']);
  // The three oldest records went to make room.
  assert.equal(claude.some((chat) => ['old498', 'old497', 'old496'].includes(chat.id)), false);
  assert.ok(p.chats.some((chat) => chat.id === 'cx'));
  // Run again: nothing new to record.
  const before = p.chats.map((chat) => chat.id).join();
  await p.rebuildChatList(true);
  assert.equal(p.chats.map((chat) => chat.id).join(), before);
});
