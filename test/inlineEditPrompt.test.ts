import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanReplacement, inlineEditPrompt } from '../src/inlineEditPrompt';

test('cleanReplacement strips a fence or tag around the answer and keeps the original padding', () => {
  assert.equal(cleanReplacement('```\nfixed text\n```', '  old text\n\n'), '  fixed text\n\n');
  assert.equal(cleanReplacement('<selection>fixed</selection>', 'old'), 'fixed');
});

test('cleanReplacement keeps a fence the original had, and a plain answer as it is', () => {
  assert.equal(cleanReplacement('```js\nx = 1\n```', '```js\nx=1\n```'), '```js\nx = 1\n```');
  assert.equal(cleanReplacement('written here', ''), 'written here');
});

test('inlineEditPrompt marks the selection within its context and ends with the instruction', () => {
  const prompt = inlineEditPrompt({ path: 'A.md', original: 'teh', before: 'x ', after: ' y' }, 'fix');
  assert.ok(prompt.includes('<context>x <selection>teh</selection> y</context>'));
  assert.ok(prompt.endsWith('Instruction: fix'));
});
