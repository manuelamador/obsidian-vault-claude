import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { agentDiffs } from '../src/editDiff';
import { agentTranscript } from '../src/history';

const row = (type: 'user' | 'assistant', content: unknown, extra: object = {}) => JSON.stringify({ type, isSidechain: true, message: { role: type, content }, ...extra });

const transcript = [
  row('user', 'Write the note'),
  row('assistant', [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/v/Ideas/New idea.md', content: 'one\ntwo' } }]),
  row('user', [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }], { toolUseResult: { type: 'create', filePath: '/v/Ideas/New idea.md', structuredPatch: [] } }),
  row('assistant', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/v/Ideas.md', old_string: 'a', new_string: 'b' } }]),
  row('user', [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }]),
  row('assistant', [{ type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: '/v/Failed.md', old_string: 'a', new_string: 'b' } }]),
  row('user', [{ type: 'tool_result', tool_use_id: 'e2', content: 'no', is_error: true }]),
  'not json',
].join('\n');

test("an agent's changes, from its transcript: a note made, a note edited, and not a failed edit", () => {
  const diffs = agentDiffs(transcript);
  assert.deepEqual(
    diffs.map((diff) => `${diff.file} +${diff.added} −${diff.removed}${diff.created ? ' new' : ''}`),
    ['/v/Ideas/New idea.md +2 −0 new', '/v/Ideas.md +1 −1'],
  );
});

test("an agent's transcript is read through its task's output file, else where the chat keeps it; another task's output is not read", async () => {
  const dir = mkdtempSync(`${tmpdir()}/vault-claude-agent-`);
  try {
    writeFileSync(`${dir}/agent-a1.jsonl`, transcript);
    symlinkSync(`${dir}/agent-a1.jsonl`, `${dir}/a1.output`);
    writeFileSync(`${dir}/b2.output`, 'shell output');
    assert.equal(await agentTranscript(`${dir}/a1.output`), transcript);
    assert.equal(await agentTranscript(`${dir}/gone.output`, `${dir}/agent-a1.jsonl`), transcript);
    assert.equal(await agentTranscript(`${dir}/b2.output`, `${dir}/agent-a1.jsonl`), null);
    assert.equal(await agentTranscript(`${dir}/gone.output`), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
