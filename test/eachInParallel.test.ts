import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PARALLEL_READS, eachInParallel } from '../src/history';

test('works through every item, PARALLEL_READS at a time, undefined ones included', async () => {
  let running = 0;
  let most = 0;
  const seen: unknown[] = [];
  const items = [1, undefined, ...Array.from({ length: 2 * PARALLEL_READS }, (_, i) => i + 3)];
  await eachInParallel(items, async (item) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(item);
    running -= 1;
  });
  assert.equal(most, PARALLEL_READS);
  assert.equal(seen.length, items.length);
  assert.ok(seen.includes(undefined));
  await eachInParallel([], async () => assert.fail('no items, no work'));
});
