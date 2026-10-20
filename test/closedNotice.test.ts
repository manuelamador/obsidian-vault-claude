import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closedNotice } from '../src/view';

test('closing the panel tells chats taken off the phone from work stopped', () => {
  assert.equal(closedNotice(0, 0, 0), null);
  assert.equal(closedNotice(0, 0, 2), 'Closing the panel took 2 chats off your phone. They were idle, so nothing was lost: reopen one from the history to carry on.');
  assert.equal(closedNotice(0, 0, 1), 'Closing the panel took a chat off your phone. It was idle, so nothing was lost: reopen it from the history to carry on.');
  assert.equal(
    closedNotice(2, 3, 1),
    'Closing the panel stopped 2 chats and 3 background tasks, and took a chat off your phone. The conversations are saved: reopen one from the history to carry on.',
  );
  assert.equal(closedNotice(2, 3, 0), 'Closing the panel stopped 2 chats and 3 background tasks. The conversations are saved: reopen one from the history to carry on.');
});

test('an @ starts a mention only where it starts a word, not inside an email address', async () => {
  const { startsWord } = await import('../src/view');
  assert.equal(startsWord('', 0), true);
  assert.equal(startsWord('see ', 4), true);
  assert.equal(startsWord('line\n', 5), true);
  assert.equal(startsWord('(', 1), true);
  assert.equal(startsWord('write to amador', 15), false);
  assert.equal(startsWord('x', 1), false);
});
