import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, SCRATCH_IDLE_CHOICES, idleLabel } from '../src/settings';

test('the scratch chat idle times read as words, and the default is one of them', () => {
  assert.deepEqual(SCRATCH_IDLE_CHOICES.map(idleLabel), ['1 hour', '4 hours', '12 hours', '24 hours', '3 days', '1 week']);
  assert.equal(idleLabel(336), '2 weeks');
  assert.ok(SCRATCH_IDLE_CHOICES.includes(DEFAULT_SETTINGS.scratchIdleHours));
});
