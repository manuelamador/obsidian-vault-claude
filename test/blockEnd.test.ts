import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockEnd } from '../src/readingSelection';

const note = [
  'Intro paragraph.',                    // 1
  '',                                    // 2
  '> [!abstract] Results at a glance',   // 3
  '> - The first job is convenience.',   // 4
  '> - The second matters for one number.', // 5
  '',                                    // 6
  '| a | b |',                           // 7
  '| - | - |',                           // 8
  '| 1 | 2 |',                           // 9
  '',                                    // 10
  'After.',                              // 11
];

test('a callout runs to its last quoted line', () => {
  assert.equal(blockEnd(note, 3), 5);
  assert.equal(blockEnd(note, 4), 5);
});

test('a table runs to its last row', () => {
  assert.equal(blockEnd(note, 7), 9);
});

test('an ordinary line is its own block', () => {
  assert.equal(blockEnd(note, 1), 1);
  assert.equal(blockEnd(note, 11), 11);
});

test('display math runs to its closing $$', () => {
  const math = ['Text.', '$$', 'x = 1', 'y = 2', '$$', 'After.', '$$z$$'];
  assert.equal(blockEnd(math, 2), 5);
  // Opened and closed on one line: that line alone.
  assert.equal(blockEnd(math, 7), 7);
});
