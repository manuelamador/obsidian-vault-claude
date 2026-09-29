import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, timeLeft, turnStats } from '../src/usageDisplay';

test('turnStats counts cached and written input with the rest', () => {
  const stats = turnStats({
    duration_ms: 12_400,
    duration_api_ms: 11_000,
    num_turns: 3,
    usage: { input_tokens: 1_200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 820 },
  } as never);
  assert.equal(stats.text, '12s · 43k in · 820 out');
});

test('formatDuration in seconds, minutes and hours', () => {
  assert.deepEqual(
    [4_200, 42_000, 192_000, 3_900_000].map((ms) => formatDuration(ms, true)),
    ['4.2s', '42s', '3m 12s', '1h 05m'],
  );
});

test('timeLeft in days, hours and minutes; nothing once passed', () => {
  const hour = 3_600_000;
  assert.deepEqual(
    [3 * 24 * hour + 8 * hour, 24 * hour + 5 * hour, 24 * hour, 2 * hour + 600_000, 45 * 60_000, -1].map(timeLeft),
    ['3d', '1d 5h', '1d', '2h', '45m', ''],
  );
});
