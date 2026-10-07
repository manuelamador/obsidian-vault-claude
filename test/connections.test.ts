import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HUB_CHATS, HUB_WEIGHT, MAP_NOTES, chatAngles, chatMap, hubNotes, withoutHubs, onMap, placeLabels, polar, projectMap, ringLayout, shortLabel } from '../src/connections';
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

test('the ring: notes grouped by folder under arcs, a gap between groups; chats towards their notes, spread apart', () => {
  const { angles, arcs } = ringLayout(['B/b.md', 'A/a.md', 'A/c.md']);
  assert.deepEqual(arcs.map((arc) => arc.folder), ['A', 'B']);
  assert.equal(angles.get('A/a.md'), 0);
  assert.ok((angles.get('A/c.md') ?? 0) < (angles.get('B/b.md') ?? 0));
  // Each arc spans its notes, half a place either side, and the arcs do not overlap.
  assert.ok(arcs[0].end < arcs[1].start);
  assert.ok(arcs[0].start < 0 && arcs[0].end > (angles.get('A/c.md') ?? 0));
  const chats = chatAngles([{ id: 'x', shared: ['A/a.md'] }, { id: 'y', shared: ['A/a.md'] }], angles);
  assert.ok(Math.abs((chats.get('y') ?? 0) - (chats.get('x') ?? 0)) >= 0.44);
  const point = polar(Math.PI / 2, 100);
  assert.ok(Math.abs(point.x - 100) < 1e-9 && Math.abs(point.y) < 1e-9);
});

test('labels go outside the ring; of two that would overlap, the shorter is cut further', () => {
  const labels = placeLabels([{ key: 'a', angle: Math.PI / 2, text: 'A long note name here' }, { key: 'b', angle: Math.PI / 2 + 0.01, text: 'Shorter name' }, { key: 'c', angle: -Math.PI / 2, text: 'Left' }], 100, 18, 6);
  const byKey = new Map(labels.map((label) => [label.key, label]));
  assert.equal(byKey.get('a')?.text, 'A long note name …');
  assert.equal(byKey.get('b')?.text, 'Short…');
  assert.equal(byKey.get('a')?.side, 'right');
  assert.equal(byKey.get('c')?.side, 'left');
});

test("a chat's map counts the folders of all its notes, the busiest first", () => {
  assert.deepEqual(chatMap('me', weighted, [], () => 0).folders, [{ folder: 'A', count: 2 }, { folder: 'B', count: 1 }]);
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

test('CLAUDE.md files stay off both maps and tie no chats together', () => {
  assert.equal(onMap('CLAUDE.md'), false);
  assert.equal(onMap('Apps/CLAUDE.local.md'), false);
  assert.equal(onMap('Notes/About CLAUDE.md files.md'), true);
  const both = new Map([
    ['me', new Map([['CLAUDE.md', 3], ['A/one.md', 2]])],
    ['w', new Map([['CLAUDE.md', 3]])],
  ]);
  const map = chatMap('me', both, [], () => 0);
  assert.deepEqual(map.notes.map((note) => note.path), ['A/one.md']);
  assert.deepEqual(map.chats, []);
  assert.deepEqual(projectMap(['me', 'w'], both).notes, ['A/one.md']);
});

test('ringLayout keeps an enclosing folder together and spans its subfolders', () => {
  const holder = (path: string) => (path.startsWith('P/') ? 'P' : null);
  const { arcs, spans } = ringLayout(['P/hub.md', 'O/x.md', 'P/T/a.md', 'P/R/b.md', 'Q.md'], undefined, 0.8, holder);
  const order = arcs.map((arc) => arc.folder);
  const inP = order.filter((folder) => folder === 'P' || folder.startsWith('P/'));
  assert.deepEqual(order.slice(order.indexOf(inP[0]), order.indexOf(inP[0]) + 3), inP);
  assert.equal(spans.length, 1);
  const held = arcs.filter((arc) => arc.outer === 'P');
  assert.ok(spans[0].start < Math.min(...held.map((arc) => arc.start)));
  assert.ok(spans[0].end > Math.max(...held.map((arc) => arc.end)));
});

test('hubs: notes linked to many chats join no chats on the map, and weigh little toward a project', () => {
  const many = new Map(Array.from({ length: HUB_CHATS }, (_, i) => [`c${i}`, new Map([['Hub.md', 3], [`own${i}.md`, 3]])] as [string, Map<string, number>]));
  many.set('c0', new Map([['Hub.md', 3], ['Shared.md', 2]]));
  many.set('c1', new Map([['Hub.md', 3], ['Shared.md', 2]]));
  const hubs = hubNotes(many);
  assert.deepEqual([...hubs], ['Hub.md']);
  const map = chatMap('c0', many, [], () => 0, false, hubs);
  assert.deepEqual(map.chats.map((chat) => [chat.id, chat.shared]), [['c1', ['Shared.md']]]);
  assert.deepEqual([...(withoutHubs(new Map([['Hub.md', 3], ['A.md', 2]]), hubs) ?? [])], [['Hub.md', 3 * HUB_WEIGHT], ['A.md', 2]]);
});
