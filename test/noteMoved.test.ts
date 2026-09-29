import assert from 'node:assert/strict';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';
import { ChatView } from '../src/view';

function plugin() {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  (p as unknown as { app: unknown }).app = { workspace: { getLeavesOfType: () => [] } };
  return p;
}

test('a note that moves takes along the chats that changed it or were sent it, and the chats it is attached to', () => {
  const p = plugin();
  p.noteChats = { 'Old.md': ['a'] };
  p.noteRefs = { 'Old.md': ['b'] };
  p.drafts = { a: { note: 'Old.md', text: 'typed' }, c: { note: 'Other.md' } };
  p.noteMoved('Old.md', 'New.md');
  assert.deepEqual(p.noteChats, { 'New.md': ['a'] });
  assert.deepEqual(p.noteRefs, { 'New.md': ['b'] });
  assert.deepEqual(p.drafts, { a: { note: 'New.md', text: 'typed' }, c: { note: 'Other.md' } });
});

test('a deleted note lets its chats go, and is no longer attached: a draft keeps its text, one with nothing else goes', () => {
  const p = plugin();
  p.noteChats = { 'Gone.md': ['a'], 'Kept.md': ['a'] };
  p.noteRefs = { 'Gone.md': ['b'] };
  p.drafts = { a: { note: 'Gone.md', text: 'typed' }, b: { note: 'Gone.md' }, c: { note: 'Kept.md' } };
  p.noteMoved('Gone.md', null);
  assert.deepEqual(p.noteChats, { 'Kept.md': ['a'] });
  assert.deepEqual(p.noteRefs, {});
  assert.deepEqual(p.drafts, { a: { text: 'typed' }, c: { note: 'Kept.md' } });
});

test('open panels follow the notes they hold too', () => {
  const p = plugin();
  const calls: string[] = [];
  const view = Object.create(ChatView.prototype) as ChatView;
  view.followNote = (from, to) => void calls.push(`${from}->${to}`);
  (p as unknown as { app: unknown }).app = { workspace: { getLeavesOfType: () => [{ view }] } };
  p.noteMoved('A.md', 'B.md');
  p.noteMoved('B.md', null);
  assert.deepEqual(calls, ['A.md->B.md', 'B.md->null']);
});

test('a burst of moves (a folder, one event per file) is saved once', async () => {
  const p = plugin();
  let saves = 0;
  p.saveSettings = async () => void (saves += 1);
  p.noteChats = { 'F/A.md': ['a'], 'F/B.md': ['b'], 'F/C.md': ['c'] };
  for (const name of ['A', 'B', 'C']) p.noteMoved(`F/${name}.md`, `G/${name}.md`);
  assert.equal(saves, 0);
  await p.flushSave();
  assert.equal(saves, 1);
  // Nothing is left waiting.
  await p.flushSave();
  assert.equal(saves, 1);
  assert.deepEqual(Object.keys(p.noteChats).sort(), ['G/A.md', 'G/B.md', 'G/C.md']);
});

test('a burst of note links (a turn editing many notes) is saved once', async () => {
  const p = plugin();
  let saves = 0;
  p.saveSettings = async () => void (saves += 1);
  for (const name of ['A', 'B', 'C', 'D']) p.linkNoteChat(`${name}.md`, 'chat');
  p.linkNoteRef('E.md', 'chat');
  assert.equal(saves, 0);
  await p.flushSave();
  assert.equal(saves, 1);
  assert.deepEqual(Object.keys(p.noteChats).sort(), ['A.md', 'B.md', 'C.md', 'D.md']);
  assert.deepEqual(p.noteRefs, { 'E.md': ['chat'] });
});

test('a waiting save is made on its own, once, without a flush', async () => {
  const p = plugin();
  let saves = 0;
  p.saveSettings = async () => void (saves += 1);
  p.linkNoteChat('A.md', 'chat');
  p.linkNoteChat('B.md', 'chat');
  for (const end = Date.now() + 5000; saves === 0 && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(saves, 1);
  await p.flushSave();
  assert.equal(saves, 1);
});

test('renames and deletions reach noteMoved, and quitting starts the waiting save', () => {
  const p = plugin();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const on = (name: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(name, handler);
    return {};
  };
  (p as unknown as { app: unknown }).app = { vault: { on }, workspace: { on, getLeavesOfType: () => [] } };
  const calls: string[] = [];
  p.noteMoved = (from, to) => void calls.push(`${from}->${to}`);
  p.flushSave = async () => void calls.push('flush');
  p.registerNoteEvents();
  handlers.get('rename')?.({ path: 'New.md' }, 'Old.md');
  handlers.get('delete')?.({ path: 'Gone.md' });
  handlers.get('quit')?.({});
  assert.deepEqual(calls, ['Old.md->New.md', 'Gone.md->null', 'flush']);
});
