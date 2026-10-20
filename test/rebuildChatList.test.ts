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
  // And one the listing does not have (its session deleted since): the first to go past the cap.
  p.chats = [{ id: 'gone', title: 'Session deleted' }, ...old.map(({ id, title }) => ({ id, title })), { id: 'cx', title: 'Codex', engine: 'codex' as const, at: 1 }];
  const items: HistoryItem[] = [...fresh, ...old];
  p.listChats = async () => items;
  await p.rebuildChatList(true);
  const claude = p.chats.filter((chat) => chat.engine !== 'codex');
  assert.equal(claude.length, 500);
  assert.deepEqual(claude.slice(0, 3).map((chat) => chat.id), ['new0', 'new1', 'new2']);
  // The unlisted record and the two oldest went to make room.
  assert.equal(claude.some((chat) => ['gone', 'old498', 'old497'].includes(chat.id)), false);
  assert.ok(claude.some((chat) => chat.id === 'old496'));
  assert.ok(p.chats.some((chat) => chat.id === 'cx'));
  // Run again: nothing new to record.
  const before = p.chats.map((chat) => chat.id).join();
  await p.rebuildChatList(true);
  assert.equal(p.chats.map((chat) => chat.id).join(), before);
});
