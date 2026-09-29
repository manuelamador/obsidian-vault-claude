import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenPaths } from '../src/pathFilter';

const hidden = hiddenPaths('*attachments/*\n# a comment\nDrafts/*.md');

test('patterns leave paths out; * spans folders', () => {
  assert.ok(hidden('Research/attachments/figure.png'));
  assert.ok(hidden('attachments/figure.png'));
  assert.ok(hidden('Drafts/note.md'));
  assert.ok(hidden('Drafts/deep/note.md'));
});

test('everything that is not a note is left out', () => {
  assert.ok(hidden('Research/script.py'));
  assert.ok(hidden('Projects/data.csv'));
});

test('other notes stay, including names that only resemble a pattern', () => {
  assert.ok(!hidden('Research/Note.md'));
  assert.ok(!hidden('Notes/attachment-list.md'));
});
