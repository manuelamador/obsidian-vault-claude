import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { readPlanFile } from '../src/history';

test("a plan is read only from a Markdown file in Claude Code's plans folder", async () => {
  const config = mkdtempSync(`${tmpdir()}/vault-claude-plans-`);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  mkdirSync(`${config}/plans`);
  writeFileSync(`${config}/plans/tidy-plan.md`, '# Plan\n\n1. List the notes.');
  writeFileSync(`${config}/secret.md`, 'not a plan');
  writeFileSync(`${config}/plans/notes.txt`, 'not Markdown');
  try {
    assert.equal(await readPlanFile(`${config}/plans/tidy-plan.md`), '# Plan\n\n1. List the notes.');
    // Not yet written: nothing, to be read again.
    assert.equal(await readPlanFile(`${config}/plans/not-yet.md`), null);
    for (const file of [`${config}/plans/../secret.md`, `${config}/secret.md`, `${config}/plans/notes.txt`, 'tidy-plan.md', undefined, 5]) {
      assert.equal(await readPlanFile(file), null, String(file));
    }
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
  }
});
