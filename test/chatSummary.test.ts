import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summaryNote, summaryPrompt, trimTranscript } from '../src/chatSummary';

test('summaryNote unwraps a fenced answer that has its own frontmatter', () => {
  const note = summaryNote('```markdown\n---\ntags: [x]\n---\n\n# T\n\nBody\n```', { date: '2026-09-15', sessionId: 's1' });
  assert.equal(note, '---\ntags: [x]\n---\n\n# T\n\nBody\n');
});

test('summaryNote adds frontmatter to a bare answer', () => {
  const note = summaryNote('# T\n\nBody', { date: '2026-09-15', sessionId: 's1' });
  assert.ok(note.startsWith('---\ntags: [claude-chat]\nupdated: 2026-09-15\nclaude_session: s1\n---\n\n# T'));
});

test('trimTranscript cuts the middle of a long chat and says how much', () => {
  const trimmed = trimTranscript('a'.repeat(1000) + 'b'.repeat(1000), 1000);
  assert.ok(trimmed.startsWith('a'.repeat(150)));
  assert.ok(trimmed.endsWith('b'.repeat(850)));
  assert.ok(trimmed.includes('1,000 characters from the middle'));
});

test('summaryPrompt names the model and ends with the conversation', () => {
  const request = summaryPrompt({ title: 'T — summary', date: '2026-09-15', sessionId: 's1', model: 'Opus 5', transcript: 'hello' });
  assert.ok(request.includes('Model writing this note: Opus 5'));
  assert.ok(request.endsWith('<conversation>\nhello\n</conversation>'));
});
