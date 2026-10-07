import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderUp, folderView, notesByChat, readFolderQuery, suggestFolder } from '../src/chatFolders';

const notes = notesByChat(
  { 'A/B/one.md': ['x', 'y'], 'A/B/C/two.md': ['x'], 'A/three.md': ['z'] },
  { 'top.md': ['y'], 'A/B/one.md': ['x'] },
);

test("each chat's notes, from every index, once", () => {
  assert.deepEqual([...(notes.get('x') ?? [])].sort(), ['A/B/C/two.md', 'A/B/one.md']);
  assert.deepEqual([...(notes.get('y') ?? [])].sort(), ['A/B/one.md', 'top.md']);
});

test('a folder query: the folder up to its last slash, then words; up one level', () => {
  assert.deepEqual(readFolderQuery('Research Projects/Tariffs/ wars TRADE'), { folder: 'Research Projects/Tariffs', words: ['wars', 'trade'] });
  assert.deepEqual(readFolderQuery('res'), { folder: '', words: ['res'] });
  assert.equal(folderUp('A/B/'), 'A/');
  assert.equal(folderUp('A/'), '');
});

test('the folders view: folders in the one gone into, then every chat below it; at the top, chats with notes there', () => {
  const when = new Map([
    ['x', { updatedAt: 3, title: 'Ex' }],
    ['y', { updatedAt: 2, title: 'Why' }],
    ['z', { updatedAt: 1, title: 'Zed' }],
  ]);
  const top = folderView(notes, when, '', []);
  assert.deepEqual(top.folders.map((row) => [row.path, row.chats.sort().join()]), [['A', 'x,y,z']]);
  assert.deepEqual(top.chats, ['y']);
  const inA = folderView(notes, when, 'A', []);
  assert.deepEqual(inA.folders.map((row) => row.path), ['A/B']);
  assert.deepEqual(inA.chats, ['x', 'y', 'z']);
  assert.deepEqual(folderView(notes, when, 'A', ['zed']), { folders: [], chats: ['z'] });
  assert.deepEqual(folderView(notes, new Map([['z', { updatedAt: 1, title: 'Zed' }]]), 'A/B', []), { folders: [], chats: [] });
});

test('the folder suggested: the deepest holding most notes; none from skipped folders or for one note', () => {
  assert.deepEqual(suggestFolder(['A/B/one.md', 'A/B/C/two.md', 'A/three.md'], () => false), { folder: 'A/B', count: 2, total: 3 });
  assert.deepEqual(suggestFolder(['A/B/one.md', 'A/B/C/two.md', 'Claude chats/x.md'], (folder) => folder.startsWith('Claude chats')), { folder: 'A/B', count: 2, total: 2 });
  assert.equal(suggestFolder(['top.md', 'other.md', 'A/x.md'], () => false), null);
  assert.equal(suggestFolder(['A/one.md'], () => false), null);
});
