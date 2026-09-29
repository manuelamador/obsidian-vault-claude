import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyParts, turnStarts } from '../src/earlierTurns';
import { answer, call, prompt, result } from './transcript';

test('turns start at your prompts, not at tool results', () => {
  const transcript = [prompt('p1'), call('t1'), result('t1'), answer('a1'), prompt('p2'), answer('a2')];
  assert.deepEqual(turnStarts(transcript), [0, 4]);
});

test('a prompt that arrives while a call waits for its result is not a cut; an interrupted call holds nothing back', () => {
  // p2 was queued while t1 ran; t9 was interrupted and never answered.
  const transcript = [prompt('p1'), call('t1'), prompt('p2'), result('t1'), answer('a'), call('t9'), prompt('p3'), answer('b')];
  assert.deepEqual(turnStarts(transcript), [0, 6]);
});

test('a short chat is drawn whole', () => {
  const transcript = [prompt('p1'), answer('a1'), prompt('p2'), answer('a2')];
  const { tail, earlier } = historyParts(transcript, 10);
  assert.equal(tail, transcript);
  assert.deepEqual(earlier, []);
});

test('a long chat: the last turns at once, then the earlier turns one by one, newest first', () => {
  const transcript = [answer('before any prompt'), ...Array.from({ length: 6 }, (_, i) => [prompt(`p${i}`), call(`t${i}`), result(`t${i}`), answer(`a${i}`)]).flat()];
  const { tail, earlier } = historyParts(transcript, 3);
  assert.deepEqual(tail.map((m) => m.uuid).filter(Boolean), ['p3', 'p4', 'p5']);
  assert.deepEqual(
    earlier.map((turn) => turn.map((m) => m.uuid).filter(Boolean)),
    [['p2'], ['p1'], ['p0']],
  );
  // What came before the first prompt goes with the first turn, and nothing is lost.
  assert.equal(earlier[2].length, 5);
  assert.equal(earlier.flat().length + tail.length, transcript.length);
});
