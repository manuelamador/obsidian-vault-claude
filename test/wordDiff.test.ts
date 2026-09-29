import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineDiff, wordDiff } from '../src/wordDiff';

test('wordDiff rebuilds both texts and marks the changed words', () => {
  const diff = wordDiff('the quick brown fox jumps', 'the slow brown dog jumps');
  const join = (types: string[]) => diff.filter((part) => types.includes(part.type)).map((part) => part.text).join('');
  assert.equal(join(['same', 'del']), 'the quick brown fox jumps');
  assert.equal(join(['same', 'ins']), 'the slow brown dog jumps');
  assert.deepEqual(diff.filter((part) => part.type === 'del').map((part) => part.text), ['quick', 'fox']);
});

test('lineDiff keeps unchanged lines once', () => {
  const diff = lineDiff('one\ntwo\nthree', 'one\n2\nthree');
  assert.deepEqual(
    diff.map((part) => `${part.type}:${part.text}`),
    ['same:one', 'del:two', 'ins:2', 'same:three'],
  );
});
