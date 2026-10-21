import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { findRanges } from '../src/findBar';

test('find stops at the most matches it is asked for, in the order they are shown', () => {
  const { window } = new JSDOM('<div id="root"><p>e e e</p><p style="display: none">e</p><p>see the tree</p></div>');
  const root = window.document.getElementById('root') as unknown as HTMLElement;
  // Every shown match without a cap: three, then five in "see the tree"; the hidden paragraph is passed over.
  assert.equal(findRanges(root, 'e').length, 8);
  const first = findRanges(root, 'E', 4);
  assert.equal(first.length, 4);
  assert.deepEqual(
    first.map((range) => [range.startContainer.textContent, range.startOffset]),
    [
      ['e e e', 0],
      ['e e e', 2],
      ['e e e', 4],
      ['see the tree', 1],
    ],
  );
  assert.equal(findRanges(root, 'e', 0).length, 0);
  assert.equal(findRanges(root, '', 4).length, 0);
});
