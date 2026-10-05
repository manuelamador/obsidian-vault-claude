import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPlainText } from '../src/plainText';

const plain = isPlainText;

test('plain sentences skip the renderer', () => {
  assert.ok(plain('Let me check the three-economy table first.'));
  assert.ok(plain('Done: the figure is saved, and the thread now records it.'));
  assert.ok(plain('First line.\n\nSecond paragraph, no markup at all.'));
});

test('anything Obsidian would render goes to the renderer', () => {
  for (const text of [
    'A **bold** claim',
    'a `code` span',
    'see [[Some Note]]',
    'math $x = 1$',
    '# Heading',
    '- a list',
    '1. a numbered list',
    '> a quote',
    'a [link](https://a.test)',
    'bare https://a.test link',
    'www.example.test',
    'an <b>html</b> tag',
    'a | table | row',
    'under_scored_words',
    'a ~~strikethrough~~',
  ]) {
    assert.equal(plain(text), false, text);
  }
});

test('text the renderer draws otherwise goes to it: single line breaks, a rule, a link in parentheses', () => {
  assert.ok(!plain('Files:\na.md\nb.md'));
  assert.ok(!plain('Done.\n\n---\n\nAfter.'));
  assert.ok(!plain('See the paper (https://example.org/p).'));
  assert.ok(plain('Done.\n'.trim()));
});
