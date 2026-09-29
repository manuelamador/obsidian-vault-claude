import assert from 'node:assert/strict';
import { test } from 'node:test';
import { versionDrift } from '../src/version';

test('versionDrift is quiet within 20 patch releases', () => {
  assert.equal(versionDrift('2.1.267', '2.1.272'), null);
});

test('versionDrift gives a notice beyond 20 releases, or across minor versions', () => {
  assert.match(versionDrift('2.1.240', '2.1.272') ?? '', /older/);
  assert.match(versionDrift('2.2.0', '2.1.272') ?? '', /ahead/);
});

test('versionDrift is quiet for a version it cannot read', () => {
  assert.equal(versionDrift('unknown', '2.1.272'), null);
});
