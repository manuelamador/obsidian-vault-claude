import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailMarkdown } from '../src/emailCards';
import { inertEmailText, plainEmailText, safeGmailUrl } from '../src/emailSafety';

test('only Gmail addresses are kept as links', () => {
  assert.equal(safeGmailUrl('https://mail.google.com/mail/?authuser=x#all/1'), 'https://mail.google.com/mail/?authuser=x#all/1');
  for (const url of ['javascript:alert(1)', 'http://mail.google.com/', 'https://mail.google.com.evil.com/', 'https://user@mail.google.com/', 'https://mail.google.com:8443/', 'not a url', 42]) assert.equal(safeGmailUrl(url), undefined);
});

test("an email saved or quoted loads nothing: its images and HTML are text, its links stay", () => {
  assert.equal(inertEmailText('![](https://t.example/p.png) <img src="https://t.example/q.png"> ![[x.png]] [site](https://example.com)'), '&#33;[](https://t.example/p.png) &lt;img src="https://t.example/q.png"> &#33;[[x.png]] [site](https://example.com)');
  // A backslash before an image cannot bring it back: an escape could be undone, the entity cannot.
  assert.equal(inertEmailText('\\![](https://t.example/p.png)'), '\\&#33;[](https://t.example/p.png)');
  // A comparison is not a tag.
  assert.equal(inertEmailText('if (a < b) and c > d'), 'if (a < b) and c > d');
  const saved = emailMarkdown({ sender: 'A <a@example.com>', to: ['b@example.com'], cc: ['c@example.com'], subject: 'Hi <b>there</b>', time: NaN, text: '', body: 'See ![](https://t.example/p.png)', unread: false, url: 'javascript:alert(1)' });
  assert.ok(saved.includes('See &#33;[](https://t.example/p.png)'));
  assert.ok(!saved.includes('<b>') && !saved.includes('javascript:'));
  assert.ok(saved.includes('Cc c@example.com'));
});

test('a quote inside a saved email cannot become a live callout', () => {
  assert.equal(inertEmailText('> [!danger] Your account is locked\n  > nested'), '&gt; [!danger] Your account is locked\n  &gt; nested');
});

test("a todo from an email is plain words: no images, tags or Tasks markers of the sender's", () => {
  assert.equal(plainEmailText('Reply to Ann: Re: <b>Budget</b> ![x](https://t.example/p.png) 📅 2026-10-21 🔁 every day ⏫ ^gcal-1'), 'Reply to Ann: Re: Budget [x](https://t.example/p.png) 2026-10-21 every day');
  assert.equal(plainEmailText('Reply to Ann: a < b'), 'Reply to Ann: a < b');
});
