import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens, formatBytes, formatTokens, mentionTargets } from '../src/contextSize';

test('mentions: notes and files by link text, folders by path, headings and aliases dropped', () => {
  assert.deepEqual(mentionTargets('See @[[Model setup]], @[[Equilibrium#Debt|eq]] and @[[Data/ ]] but not [[Plain]]'), [
    'Model setup',
    'Equilibrium',
    'Data/',
  ]);
});

test('token estimates are rounded as estimates', () => {
  assert.equal(estimateTokens(9600), 2400);
  assert.equal(formatTokens(2400), '~2,400 tokens');
  assert.equal(formatTokens(2449), '~2,400 tokens');
  assert.equal(formatTokens(12_345), '~12,000 tokens');
  assert.equal(formatTokens(3), '~10 tokens');
});

test('sizes in bytes, kilobytes and megabytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(430_080), '420 KB');
  assert.equal(formatBytes(1_258_291), '1.2 MB');
});

test("each attachment's chip says on hover what goes with the message", async () => {
  const { chipFor } = await import('../src/chip');
  assert.equal(chipFor({ kind: 'file', name: 'references.bib', path: '/v/references.bib' }).tooltip, 'references.bib: only its path goes; Claude reads the file if it needs to');
  assert.equal(
    chipFor({ kind: 'selection', name: 'Equilibrium', path: 'Equilibrium.md', fromLine: 40, toLine: 65, text: 'x'.repeat(1400) }).tooltip,
    'Equilibrium, lines 40–65: the selected text goes with the message (~400 tokens)',
  );
  assert.equal(chipFor({ kind: 'image', name: 'diagram.png', mediaType: 'image/png', data: 'A'.repeat(573_440) }).tooltip, 'diagram.png: the image goes with the message (420 KB)');
});
