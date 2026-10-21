import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailMarkdown, threadMarkdown } from '../src/emailCards';
import { emailMessages } from '../src/emailMessages';
import { plainEmailText } from '../src/emailSafety';
import { cut, dropScripts, mimeFiles, stripTags } from '../src/emailText';
import { gmailBody } from '../src/gmailAdapter';
import { neutralizeRemoteMedia } from '../src/safeMarkdown';

/** Milliseconds `run` takes. */
const time = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

const html = (content: string) => ({ mime_type: 'text/html', body: { content } });

test("an email's HTML is reduced to text as before", () => {
  assert.equal(gmailBody(html('<style>p { color: red }</style><p>Hello <b>Ann</b>,</p><SCRIPT type="x">alert(1)</script ><div>See you<br/>soon</div>')), 'Hello Ann,\nSee you\nsoon');
  // An element never closed loses its tag only; a `<` with no `>` after it stays.
  assert.equal(dropScripts('a<style>b'), 'a<style>b');
  assert.equal(gmailBody(html('a<style>b')), 'ab');
  assert.equal(stripTags('x <a <b> y < z'), 'x  y < z');
  assert.equal(stripTags('a < b and <i>c</i>', true), 'a < b and c');
  assert.equal(plainEmailText('Re: <b>Budget</b> a < b'), 'Re: Budget a < b');
});

test('unclosed tags take linear time, not a rescan from every `<`', () => {
  const tags = '<a'.repeat(150_000);
  const styles = '<style>'.repeat(50_000);
  const scripts = '<script'.repeat(50_000);
  for (const input of [tags, styles, scripts, `${scripts}>`]) {
    assert.ok(time(() => gmailBody(html(input))) < 200);
    assert.ok(time(() => plainEmailText(input)) < 200);
  }
  assert.equal(gmailBody(html(tags)), tags);
  assert.equal(gmailBody(html(styles)), '');
});

test('unclosed HTML comments in Markdown take linear time; a closed one still goes', () => {
  const comments = '<!-- x '.repeat(50_000);
  let out = '';
  assert.ok(time(() => { out = neutralizeRemoteMedia(comments); }) < 200);
  assert.ok(!out.includes('<!--'));
  assert.equal(neutralizeRemoteMedia('a <!-- b --> c <!-- d'), 'a  c &lt;!-- d');
});

test("a line break spelled in a subject or sender cannot end a saved note's quote", () => {
  const text = JSON.stringify({ messages: [{ sender: 'Ann&#13;&#10;- [ ] Pay #task', subject: 'Invoice&#10;- [ ] Wire #task', toRecipients: ['b@example.com\n- [ ] x'], snippet: 'Hi', attachments: [{ filename: 'a&#10;- [ ] f.pdf', mimeType: 'application/pdf' }] }] });
  const messages = emailMessages('mcp__claude_ai_Gmail__get_thread', text)!;
  assert.equal(messages[0].subject, 'Invoice - [ ] Wire #task');
  for (const saved of [emailMarkdown(messages[0]), threadMarkdown(messages), threadMarkdown([{ ...messages[0], subject: 'Invoice\n- [ ] Wire #task' }])]) {
    assert.ok(!/^\s*- \[ \]/m.test(saved), saved);
  }
});

test('the shared helpers', () => {
  assert.equal(cut('abcdef', 3), 'abc…');
  assert.equal(cut('abc', 3), 'abc');
  assert.deepEqual(mimeFiles({ parts: [{ filename: 'a.pdf', mime_type: 'application/pdf' }, { filename: 7 }, { parts: [{ filename: 'b.txt' }] }] }), [{ name: 'a.pdf', type: 'application/pdf' }, { name: 'b.txt', type: '' }]);
});
