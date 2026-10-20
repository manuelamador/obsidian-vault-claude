import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailMarkdown } from '../src/emailCards';
import { inertEmailText, safeGmailUrl } from '../src/emailSafety';

test('only Gmail addresses are kept as links', () => {
  assert.equal(safeGmailUrl('https://mail.google.com/mail/?authuser=x#all/1'), 'https://mail.google.com/mail/?authuser=x#all/1');
  for (const url of ['javascript:alert(1)', 'http://mail.google.com/', 'https://mail.google.com.evil.com/', 'https://user@mail.google.com/', 'https://mail.google.com:8443/', 'not a url', 42]) assert.equal(safeGmailUrl(url), undefined);
});

test("an email saved or quoted loads nothing: its images and HTML are text, its links stay", () => {
  assert.equal(inertEmailText('![](https://t.example/p.png) <img src="https://t.example/q.png"> ![[x.png]] [site](https://example.com)'), '\\![](https://t.example/p.png) &lt;img src="https://t.example/q.png"&gt; \\![[x.png]] [site](https://example.com)');
  const saved = emailMarkdown({ sender: 'A <a@example.com>', to: ['b@example.com'], cc: ['c@example.com'], subject: 'Hi <b>there</b>', time: NaN, text: '', body: 'See ![](https://t.example/p.png)', unread: false, url: 'javascript:alert(1)' });
  assert.ok(saved.includes('See \\![](https://t.example/p.png)'));
  assert.ok(!saved.includes('<b>') && !saved.includes('javascript:'));
  assert.ok(saved.includes('Cc c@example.com'));
});
