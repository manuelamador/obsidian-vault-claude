import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAP_NOTES, chatMap, projectMap, radialLayout, shortLabel } from '../src/connections';
import { chatLink, linkedChatIds, removeChatLinks } from '../src/memos';

const weighted = new Map([
  ['me', new Map([['A/one.md', 3], ['A/two.md', 1], ['B/three.md', 2]])],
  ['x', new Map([['A/one.md', 2], ['B/three.md', 3]])],
  ['y', new Map([['A/two.md', 1]])],
  ['z', new Map([['C/other.md', 3]])],
]);

test("a chat's map: its notes, strongest first; chats sharing them, those linked first", () => {
  const map = chatMap('me', weighted, ['z', 'gone'], (id) => ({ x: 1, y: 2 })[id] ?? 0);
  assert.deepEqual(map.notes.map((note) => note.path), ['A/one.md', 'B/three.md', 'A/two.md']);
  assert.deepEqual(map.chats.map((chat) => [chat.id, chat.shared.length, chat.linked]), [['z', 0, true], ['gone', 0, true], ['x', 2, false], ['y', 1, false]]);
  assert.equal(map.moreNotes, 0);
  const many = new Map([['me', new Map(Array.from({ length: MAP_NOTES + 3 }, (_, i) => [`n${i}.md`, 1] as [string, number]))]]);
  assert.equal(chatMap('me', many, [], () => 0).moreNotes, 3);
});

test('the radial layout: notes on the inner ring, folders together; chats outside, towards their notes, spread apart', () => {
  const { notes, chats } = radialLayout(['B/b.md', 'A/a.md', 'A/c.md'], [{ id: 'x', shared: ['A/a.md'] }, { id: 'y', shared: ['A/a.md'] }], 100, 200);
  const radius = (point: { x: number; y: number }) => Math.round(Math.hypot(point.x, point.y));
  assert.equal(radius(notes.get('A/a.md') ?? { x: 0, y: 0 }), 100);
  // A/a.md first, at the top.
  assert.ok(Math.abs(notes.get('A/a.md')?.x ?? 1) < 1e-9);
  assert.equal(radius(chats.get('x') ?? { x: 0, y: 0 }), 200);
  const angle = (p?: { x: number; y: number }) => Math.atan2(p?.x ?? 0, -(p?.y ?? 0));
  assert.ok(Math.abs(angle(chats.get('y')) - angle(chats.get('x'))) >= 0.44);
});

test("a project's map: its chats, the notes most of them share, and who worked on what", () => {
  const map = projectMap(['x', 'me'], weighted);
  assert.deepEqual(map.notes, ['A/one.md', 'B/three.md', 'A/two.md']);
  assert.deepEqual(map.links.filter(([id]) => id === 'x'), [['x', 'A/one.md', 2], ['x', 'B/three.md', 3]]);
});

test('chats linked in a message are found by their links, each once', () => {
  const link = chatLink({ vault: 'V', chat: 'abc-1' });
  assert.deepEqual(linkedChatIds(`From [T](${link}), its memos:\n> x\nand ${link} and ${chatLink({ vault: 'V', chat: 'def', msg: 'm' })}`), ['abc-1', 'def']);
  assert.deepEqual(linkedChatIds('no links'), []);
  assert.equal(shortLabel('abcdef', 4), 'abc…');
});

test("a chat's links are taken out of a message, the others kept", () => {
  const a = chatLink({ vault: 'V', chat: 'a' });
  const b = chatLink({ vault: 'V', chat: 'b' });
  assert.equal(removeChatLinks(`see [A](${a}) and [B](${b}) now`, 'a'), `see and [B](${b}) now`);
});
