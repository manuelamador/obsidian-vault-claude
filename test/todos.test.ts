import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTaskDate, todoLine, withTodo } from '../src/todos';

test('a todo goes at the end of its section, in the Tasks format', () => {
  const note = '# Todo\n\n## Open\n\n- [ ] one\n- [ ] two 📅 2026-10-20\n\n## Done\n\n- [x] old\n';
  const line = todoLine('Reply to Ana:  the visit', '2026-10-21');
  assert.equal(line, '- [ ] Reply to Ana: the visit 📅 2026-10-21');
  assert.equal(withTodo(note, line, 'Open'), '# Todo\n\n## Open\n\n- [ ] one\n- [ ] two 📅 2026-10-20\n- [ ] Reply to Ana: the visit 📅 2026-10-21\n\n## Done\n\n- [x] old\n');
});

test('a note without the section gets it at its end; dates are checked', () => {
  assert.equal(withTodo('# Todo\n', '- [ ] x', 'Open'), '# Todo\n\n## Open\n\n- [ ] x\n');
  assert.equal(withTodo('', '- [ ] x', 'Open'), '## Open\n\n- [ ] x\n');
  assert.equal(withTodo('## Open\n', '- [ ] x', 'Open'), '## Open\n- [ ] x\n');
  assert.equal(isTaskDate('2026-10-21'), true);
  assert.equal(isTaskDate('21/10/2026'), false);
});
