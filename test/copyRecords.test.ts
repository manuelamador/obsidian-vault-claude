import assert from 'node:assert/strict';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';
import type { HistoryItem } from '../src/history';

/** A plugin whose last listing holds a chat from outside the panel and one copy of it. */
function setup() {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  const copy: HistoryItem = { id: 'c1', title: 'Papers', updatedAt: 1, fromPanel: true, copied: true };
  const original: HistoryItem = { id: 'desk', title: 'Papers', updatedAt: 2, fromPanel: false, copies: [copy] };
  const internals = p as unknown as { lastListing: HistoryItem[] | null; unlist(id: string): void };
  internals.lastListing = [original, copy];
  return { p, original, internals };
}

test('a copy made in the panel names its original, and is offered with it at once', () => {
  const { p, original } = setup();
  p.recordChat('c2', 'Papers', 'desk');
  assert.deepEqual(p.chats[0], { id: 'c2', title: 'Papers', copyOf: 'desk' });
  assert.deepEqual(original.copies?.map((item) => item.id), ['c2', 'c1']);
  // Any other chat records no original.
  p.recordChat('new', 'New chat');
  assert.deepEqual(p.chats[0], { id: 'new', title: 'New chat' });
});

test("a deleted copy leaves its original's copies, in the lists the history's rows share", () => {
  const { original, internals } = setup();
  const row = { ...original };
  internals.unlist('c1');
  assert.deepEqual([original.copies?.length, row.copies?.length], [0, 0]);
});

test('a chat opened by its id (a kept side chat whose panel closed) is opened as listed, with its copies', async () => {
  const { p, original } = setup();
  const opened: HistoryItem[] = [];
  (p as unknown as { activateView(): Promise<unknown> }).activateView = async () => ({ openChat: async (item: HistoryItem) => void opened.push(item) });
  await p.openChatById('desk', 'Papers (renamed)');
  await p.openChatById('elsewhere', 'Other');
  assert.deepEqual(opened[0].copies, original.copies);
  assert.equal(opened[0].title, 'Papers (renamed)');
  assert.equal(opened[1].copies, undefined);
});

test('a record keeps the original it names when loaded, and drops the dates it no longer keeps', async () => {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  (p as unknown as { loadData(): Promise<unknown> }).loadData = async () => ({
    chats: [
      { id: 'a', title: 'A', copyOf: 'desk', createdAt: 1, updatedAt: 2 },
      { id: 'b', title: 'B', copyOf: 5 },
    ],
  });
  await p.loadSettings();
  assert.deepEqual(p.chats, [
    { id: 'a', title: 'A', copyOf: 'desk' },
    { id: 'b', title: 'B' },
  ]);
});
