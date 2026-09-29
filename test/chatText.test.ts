import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bubbleOf, chatToMarkdown, messageSearchText, startsTurn, withQuote } from '../src/chatText';
import { promptSummary } from '../src/earlierTurns';
import { answer, message, prompt } from './transcript';

test('a message shows a bubble unless it is a tool result, command output, an interruption or a notice alone', () => {
  assert.deepEqual(bubbleOf(prompt('hello')), { text: 'hello', chips: [] });
  assert.equal(bubbleOf(message('user', [{ type: 'tool_result', tool_use_id: 't', content: 'x' }])), null);
  assert.equal(bubbleOf(prompt('<local-command-stdout>ok</local-command-stdout>')), null);
  assert.equal(bubbleOf(prompt('[Request interrupted by user]')), null);
  const notice = '<task-notification><task-id>1</task-id><status>completed</status><summary>done</summary></task-notification>';
  assert.equal(bubbleOf(prompt(notice)), null);
  assert.deepEqual(bubbleOf(prompt(`${notice}\nand a question`)), { text: 'and a question', chips: [] });
  assert.equal(bubbleOf(answer('hi')), null);
  // Text beside a tool result shows as a bubble, as the chat draws it, though it starts no turn.
  const mixed = message('user', [{ type: 'tool_result', tool_use_id: 't', content: 'x' }, { type: 'text', text: 'also this' }]);
  assert.deepEqual(bubbleOf(mixed), { text: 'also this', chips: [] });
  assert.equal(startsTurn(mixed), false);
  assert.equal(startsTurn(prompt('hello')), true);
});

test('a saved chat note keeps the question after a background-task notice, and marks an interruption', () => {
  const notice = '<task-notification><task-id>1</task-id><status>completed</status><summary>done</summary></task-notification>';
  const note = chatToMarkdown('T', 's', [prompt(`${notice}\nwhat next?`), answer('this'), prompt('[Request interrupted by user]')], '2026-09-25');
  assert.match(note, /> \*\*You\*\*\n>\n> what next\?/);
  assert.match(note, /this\n\n\*Stopped\.\*/);
  assert.doesNotMatch(note, /task-notification/);
});

test('a summary is the text on one line, cut to length, else the attachments', () => {
  assert.equal(promptSummary('  two\n lines ', [], 20), 'two lines');
  assert.equal(promptSummary('abcdefghij', [], 5), 'abcd…');
  assert.equal(promptSummary('', [{ label: 'a.png' }, { label: 'b.pdf' }], 20), 'a.png, b.pdf');
  assert.equal(promptSummary('', [], 20), 'Attachment');
});

test('the search text of a message is what the chat shows of it', () => {
  assert.equal(messageSearchText(prompt('<obsidian_context>note text</obsidian_context>\nthe question')), 'the question');
  assert.equal(messageSearchText(prompt('<local-command-stdout>hidden</local-command-stdout>')), '');
  assert.equal(messageSearchText(answer('a reply')), 'a reply');
  assert.equal(messageSearchText(message('user', [{ type: 'tool_result', tool_use_id: 't', content: 'tool output' }])), '');
});

test('withQuote adds a quote after what is typed, with a line to write on, cut unless told otherwise', () => {
  assert.equal(withQuote('', 'A line'), '> A line\n\n');
  assert.equal(withQuote('typed  \n', 'A line'), 'typed\n\n> A line\n\n');
  const long = `${'word '.repeat(200)}end`;
  assert.equal(withQuote('', long).includes('end'), false);
  assert.equal(withQuote('', long, Infinity).endsWith('end\n\n'), true);
});
