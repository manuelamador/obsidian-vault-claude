import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { savedChangedFiles } from '../src/editDiff';
import { answer, message, prompt } from './transcript';

const use = (id: string, name: string, input: Record<string, unknown>) => message('assistant', [{ type: 'tool_use', id, name, input }]);
const done = (id: string, isError = false) => message('user', [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }]);

test("a saved chat's changed files: its own edits', each once, in the order first changed; not a shell command's reported changes", () => {
  const transcript = [
    prompt('make a note'),
    use('w1', 'Write', { file_path: '/v/New note.md', content: 'hello' }),
    done('w1'),
    use('e1', 'Edit', { file_path: '/v/Index.md', old_string: 'a', new_string: 'b' }),
    done('e1'),
    use('e2', 'Edit', { file_path: '/v/New note.md', old_string: 'hello', new_string: 'hello there' }),
    done('e2'),
    use('b1', 'Bash', { command: 'sed -i …' }),
    done('b1'),
    answer('Done.'),
  ];
  const edits = new Map<string, unknown>([['b1', { bashEditDiff: { files: [{ filePath: '/v/Other.md', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, lines: ['-x', '+y'] }] }] } }]]);
  assert.deepEqual(savedChangedFiles(transcript, edits), ['/v/New note.md', '/v/Index.md']);
});

test('a failed call, a read, and a subagent’s own edits change nothing', () => {
  const subagent = { ...use('s1', 'Write', { file_path: '/v/Sub.md', content: 'x' }), parent_tool_use_id: 'task' } as SessionMessage;
  const transcript = [
    use('w1', 'Write', { file_path: '/v/Failed.md', content: 'x' }),
    done('w1', true),
    use('r1', 'Read', { file_path: '/v/Read.md' }),
    done('r1'),
    subagent,
    { ...done('s1'), parent_tool_use_id: 'task' } as SessionMessage,
  ];
  assert.deepEqual(savedChangedFiles(transcript, new Map()), []);
});
