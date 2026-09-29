import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineTarget, locateLine, type EditLine } from '../src/editDiff';

const lines: EditLine[] = [
  { kind: 'same', text: 'intro', no: 4 },
  { kind: 'del', text: 'old line', no: 5, at: 5 },
  { kind: 'ins', text: 'new line', no: 5 },
  { kind: 'same', text: 'outro', no: 6 },
  { kind: 'gap', text: '' },
  { kind: 'same', text: 'before', no: 20 },
  { kind: 'del', text: 'dropped at the end', no: 22, at: 21 },
];

test('a kept or added line points at itself', () => {
  assert.deepEqual(lineTarget(lines, 0), { text: 'intro', hint: 4 });
  assert.deepEqual(lineTarget(lines, 2), { text: 'new line', hint: 5 });
});

test('a removed line points at the next line kept after it in its hunk, else the one before', () => {
  assert.deepEqual(lineTarget(lines, 1), { text: 'new line', hint: 5 });
  // Nothing after it before the end: the line before, not across the gap.
  assert.deepEqual(lineTarget(lines, 6), { text: 'before', hint: 20 });
});

test('a removed line alone in its hunk falls back to where it was removed', () => {
  assert.deepEqual(lineTarget([{ kind: 'del', text: 'x', no: 3, at: 3 }], 0), { text: '', hint: 3 });
});

test('the occurrence of the text nearest the recorded number wins', () => {
  const file = ['a', 'target', 'b', 'c', 'd', 'target', 'e'].join('\n');
  assert.equal(locateLine(file, 'target', 5), 6);
  assert.equal(locateLine(file, 'target', 1), 2);
  assert.equal(locateLine(file, 'target'), 2);
});

test('text no longer in the file, or blank, falls back to the recorded number, within the file', () => {
  const file = 'a\nb\nc';
  assert.equal(locateLine(file, 'gone', 2), 2);
  assert.equal(locateLine(file, '', 9), 3);
  assert.equal(locateLine(file, 'gone'), null);
});
