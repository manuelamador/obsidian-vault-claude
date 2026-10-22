import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daysText, readRetention, retentionText, writeRetention } from '../src/chatRetention';

async function inTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'retention-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a missing file or key is the default', () =>
  inTemp(async (dir) => {
    const file = join(dir, 'settings.json');
    assert.deepEqual(await readRetention(file), { days: null });
    await writeFile(file, '{"model": "opus"}');
    assert.deepEqual(await readRetention(file), { days: null });
    assert.match(retentionText({ days: null }), /^30 days/);
  }));

test('writing sets the key and keeps the rest, with the file\'s indentation', () =>
  inTemp(async (dir) => {
    const file = join(dir, 'settings.json');
    await writeFile(file, '{\n    "model": "opus",\n    "cleanupPeriodDays": 30\n}\n');
    assert.equal(await writeRetention(file, 36500), null);
    assert.equal(await readFile(file, 'utf8'), '{\n    "model": "opus",\n    "cleanupPeriodDays": 36500\n}\n');
    assert.deepEqual(await readRetention(file), { days: 36500 });
  }));

test('a missing file is created', () =>
  inTemp(async (dir) => {
    const file = join(dir, 'sub', 'settings.json');
    assert.equal(await writeRetention(file, 36500), null);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { cleanupPeriodDays: 36500 });
  }));

test('a file that is not a JSON object is left alone', () =>
  inTemp(async (dir) => {
    const file = join(dir, 'settings.json');
    await writeFile(file, '{ "model": "opus", // a comment\n}');
    assert.ok('error' in (await readRetention(file)));
    assert.ok(await writeRetention(file, 36500));
    assert.equal(await readFile(file, 'utf8'), '{ "model": "opus", // a comment\n}');
    await writeFile(file, '[1]');
    assert.ok(await writeRetention(file, 36500));
  }));

test('a linked settings file stays linked', () =>
  inTemp(async (dir) => {
    const real = join(dir, 'real.json');
    const link = join(dir, 'settings.json');
    await writeFile(real, '{}');
    await symlink(real, link);
    assert.equal(await writeRetention(link, 36500), null);
    assert.deepEqual(JSON.parse(await readFile(real, 'utf8')), { cleanupPeriodDays: 36500 });
  }));

test('days in words', () => {
  assert.equal(daysText(36500), '100 years');
  assert.equal(daysText(365), '1 year');
  assert.equal(daysText(90), '90 days');
  assert.equal(daysText(1), '1 day');
});
