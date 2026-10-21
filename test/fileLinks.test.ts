import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { linkFileNames } from '../src/fileLinks';

const vault = new Map([
  ['Harvest Plan.md', 'Garden Notes/Harvest Plan.md'],
  ['Todo.md', 'Todo.md'],
  ['Reading List.md', 'Reading List.md'],
]);

function linked(html: string): string[] {
  const el = new JSDOM(`<div>${html}</div>`).window.document.body.firstElementChild as HTMLElement;
  linkFileNames(el, (name) => vault.get(name) ?? null);
  return [...el.querySelectorAll<HTMLElement>('.vc-file-link')].map((node) => `${node.tagName.toLowerCase()}:${node.dataset.path}`);
}

test('bold or code text that names a vault file becomes a link to it', () => {
  assert.deepEqual(linked('<p><strong>Harvest Plan.md</strong> — new, untracked. <code>Todo.md</code> changed.</p>'), [
    'strong:Garden Notes/Harvest Plan.md',
    'code:Todo.md',
  ]);
});

test('other bold and code text is left alone: no extension, no such file, a code block, a link, or more than a name', () => {
  assert.deepEqual(
    linked(
      '<p><strong>Note is done</strong> <strong>Missing.md</strong> <strong>see Todo.md</strong></p><pre><code>Todo.md</code></pre><p><a href="x"><strong>Todo.md</strong></a></p>',
    ),
    [],
  );
});

test('a name in code inside bold is linked once, as the bold text', () => {
  assert.deepEqual(linked('<p><strong><code>Reading List.md</code></strong></p>'), ['strong:Reading List.md']);
});

test('a full path on disk is told apart: inside the vault its note, outside it a file, anything else a link', async () => {
  const { diskPath } = await import('../src/fileLinks');
  const path = await import('node:path');
  const posix = path.posix as unknown as typeof path;
  assert.deepEqual(diskPath('/Users/me/Vault/Notes/A.md', '/Users/me/Vault', '/Users/me', posix), { vault: 'Notes/A.md' });
  assert.deepEqual(diskPath('/Users/me/Github/repo/README.md', '/Users/me/Vault', '/Users/me', posix), { file: '/Users/me/Github/repo/README.md' });
  assert.deepEqual(diskPath('~/Github/repo/src/main.ts:120', '/Users/me/Vault', '/Users/me', posix), { file: '/Users/me/Github/repo/src/main.ts' });
  assert.deepEqual(diskPath('/Users/me/Github/my%20repo/README.md', '/Users/me/Vault', '/Users/me', posix), { file: '/Users/me/Github/my repo/README.md' });
  assert.equal(diskPath('Notes/A.md', '/Users/me/Vault', '/Users/me', posix), null);
  assert.equal(diskPath('Some Note', '/Users/me/Vault', '/Users/me', posix), null);
});

test('code naming a file outside the vault by its full path links it as a file, not as a note', () => {
  const { document } = new JSDOM('<p><code>/Users/me/Github/repo/README.md</code> and <code>Notes/A.md</code></p>').window;
  const p = document.querySelector('p') as unknown as HTMLElement;
  linkFileNames(p, (name) => (name === 'Notes/A.md' ? 'Notes/A.md' : null), (name) => (name.startsWith('/Users/me/Github/') ? name : null));
  const [outside, inside] = Array.from(p.querySelectorAll('code')) as unknown as HTMLElement[];
  assert.equal(outside.dataset.file, '/Users/me/Github/repo/README.md');
  assert.equal(outside.dataset.path, undefined);
  assert.equal(inside.dataset.path, 'Notes/A.md');
});
