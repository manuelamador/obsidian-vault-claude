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
