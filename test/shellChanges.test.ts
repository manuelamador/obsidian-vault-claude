import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashEditDiffs, commandNames, isOwnChange } from '../src/editDiff';

const result = (files: string[]) => ({ bashEditDiff: { files: files.map((filePath) => ({ filePath, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] })) } });

test("a shell command's change is its own when the command names the file: its path, name, or name without .md", () => {
  assert.equal(commandNames("python3 - <<'PY'\np = Path('/v/Notes/Tax at Lambda One.md')\nPY", '/v/Notes/Tax at Lambda One.md'), true);
  assert.equal(commandNames("sed -i '' 's/a/b/' 'Timeline — Bank Regulation.md'", '/v/R/Timeline — Bank Regulation.md'), true);
  assert.equal(commandNames("name = 'No Fundamental Shocks'; open(f'{name}.md')", '/v/T/No Fundamental Shocks.md'), true);
  assert.equal(commandNames('grep -rl foo . | xargs sed -i s/a/b/', '/v/T/No Fundamental Shocks.md'), false);
  // A short name alone is too common to count.
  assert.equal(commandNames('echo abcd', '/v/abcd.md'), true);
  assert.equal(commandNames('echo abc', '/v/abc.md'), false);
  // A Windows path: its name is after the last backslash.
  assert.equal(commandNames("Set-Content 'Tax at Lambda One.md' x", 'C:\\v\\Notes\\Tax at Lambda One.md'), true);
  assert.equal(commandNames('echo Lambda', 'C:\\v\\Notes\\Tax at Lambda One.md'), false);
});

test("only a shell command's changes to files it names link their notes; an edit always does", () => {
  const diffs = bashEditDiffs(result(['/v/Named.md', '/v/Other note.md']), "cat > '/v/Named.md'");
  assert.deepEqual(diffs.map((diff) => [diff.file, isOwnChange(diff)]), [['/v/Named.md', true], ['/v/Other note.md', false]]);
  assert.equal(isOwnChange({ file: '/v/x.md', lines: [], added: 1, removed: 0, created: false }), true);
});
