import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bubbleOf } from '../src/chatText';
import { stripContext } from '../src/history';
import { contextHash, contextPrompt, homeOf, linkedChatsBlock, noteOpening, projectContextBlock, projectNoteMarkdown, projectParts, readContext, withContext, withGenerated } from '../src/projects';
import { prompt } from './transcript';

const note = projectNoteMarkdown({ name: 'Tariffs', folder: 'Research/Tariffs', added: ['a', 'b'], date: '2026-10-06' });

test('a new project note has its folder, chats added by hand, its Context, empty Instructions and generated lists', () => {
  assert.match(note, /^---\ntype: project\n/);
  assert.match(note, /folder: "Research\/Tariffs"/);
  assert.match(note, /added: \["a", "b"\]/);
  assert.deepEqual(projectParts(note), { context: '', instructions: '' });
  // A Context with headings of its own: read whole, and set again whole.
  const headed = withContext(note, readContext('## Summary\n\nAbout tariffs.\n\n## Data\n\nTables.'));
  assert.equal(projectParts(headed).context, 'About tariffs.\n\n### Data\n\nTables.');
  assert.equal(projectParts(withContext(headed, 'Short.')).context, 'Short.');
  assert.equal(projectParts(withContext(note, 'A\n\n## B\n\nc')).context, 'A\n\n## B\n\nc');
  assert.match(withContext(withContext(note, 'A\n\n## B\n\nc'), 'D'), /<!-- BEGIN GENERATED -->\nD\n<!-- END GENERATED -->\n\n## Instructions/);
});

test('the Context is set between its markers; a note without the section gets one', () => {
  const set = withContext(note, 'New summary.');
  assert.match(set, /## Context\n\n<!-- BEGIN GENERATED -->\nNew summary\.\n<!-- END GENERATED -->\n\n## Instructions/);
  assert.equal(projectParts(withContext(set, 'Again.')).context, 'Again.');
  const old = '---\ntype: project\n---\n\n# Old\n\n## Instructions\n\nBe brief.\n\n## Guide\n\n- found\n';
  assert.deepEqual(projectParts(old), { context: '', instructions: 'Be brief.' });
  const added = withContext(old, 'Summary.');
  assert.match(added, /# Old\n\n## Context\n\n<!-- BEGIN GENERATED -->\nSummary\.\n<!-- END GENERATED -->/);
  assert.equal(projectParts(added).context, 'Summary.');
  // Edited by hand without markers: its text replaced, the markers put back.
  const hand = '# H\n\n## Context\n\nby hand\n\n## Instructions\n\nx\n';
  assert.equal(projectParts(withContext(hand, 'Fresh.')).context, 'Fresh.');
});

test('the request carries the notes and chats; the reply is read without a heading or fence', () => {
  const request = contextPrompt({ name: 'P', folder: 'R/P' }, [{ path: 'R/P/Hub.md', properties: { status: 'open' }, opening: 'The hub.' }], [{ title: 'Chat', date: '2026-10-07', digest: 'You: hi' }]);
  assert.match(request, /<note path="R\/P\/Hub\.md">\nProperties: \{"status":"open"\}\nThe hub\.\n<\/note>/);
  assert.match(request, /<conversation title="Chat" date="2026-10-07">\nYou: hi/);
  assert.equal(readContext('```markdown\n## Context\n\nIt is.\n```'), 'It is.');
  assert.equal(noteOpening('---\na: 1\n---\nBody'), 'Body');
});

test('the generated lists are rewritten between their markers only', () => {
  const once = withGenerated(withGenerated(note, 'Chats', '- [one](x)'), 'Key notes', '- [[Note]]');
  assert.match(once, /## Chats\n\n<!-- BEGIN GENERATED -->\n- \[one\]\(x\)\n<!-- END GENERATED -->/);
  assert.match(once, /## Key notes\n\n<!-- BEGIN GENERATED -->\n- \[\[Note\]\]\n<!-- END GENERATED -->/);
  assert.equal(withGenerated(withGenerated(once, 'Chats', '- [two](y)'), 'Chats', '- [two](y)'), withGenerated(once, 'Chats', '- [two](y)'));
  // A section without markers is left as it is.
  assert.equal(withGenerated('## Chats\n\nby hand\n', 'Chats', 'x'), '## Chats\n\nby hand\n');
});

test('the context block holds an enclosing project\'s Instructions, then the home Context and Instructions', () => {
  assert.equal(projectContextBlock([{ name: 'A', note: 'P/A.md', role: 'home' }]), '');
  const block = projectContextBlock([
    { name: 'P', note: 'P.md', instructions: 'Cite sources.', role: 'parent' },
    { name: 'A', note: 'P/A.md', context: 'About A.', instructions: 'Be brief.', role: 'home' },
  ]);
  assert.match(block, /^<project_context>\n<project name="P" role="parent" note="P.md">\nInstructions \(the user's own\):\nCite sources\./);
  assert.match(block, /<project name="A" role="home" note="P\/A.md">\nContext \(a summary of the project, from its notes and chats\):\nAbout A\.\n\nInstructions/);
});

test('a prompt written with project context before the hook carried it shows only its text', () => {
  const block = projectContextBlock([{ name: 'A', note: 'P/A.md', instructions: 'Be brief.', role: 'parent' }]);
  const raw = `${block}\n\n<obsidian_context>\nNote attached to this chat: x.md\n</obsidian_context>\n\nhello`;
  assert.equal(stripContext(raw), 'hello');
  assert.deepEqual(bubbleOf(prompt(raw)), { text: 'hello', chips: [] });
  assert.equal(stripContext(`${block}\n\nhi`), 'hi');
});

test("a chat's home: added by hand; else its first note's folder; else the folder its notes weigh most in, the deeper on a tie; none once declined", () => {
  const projects = [
    { key: 'P/A.md', folder: 'Research', added: [] },
    { key: 'P/B.md', folder: 'Research/Tariffs', added: ['hand'] },
    { key: 'P/C.md', folder: 'Teaching', added: [] },
  ];
  const notes = (pairs: [string, number][]) => new Map(pairs);
  assert.deepEqual(homeOf('hand', { notes: notes([['Teaching/x.md', 3]]) }, projects), { key: 'P/B.md', why: 'added' });
  assert.deepEqual(homeOf('c', { start: 'Research/Tariffs/n.md', notes: notes([['Teaching/x.md', 3]]) }, projects), { key: 'P/B.md', why: 'start', note: 'Research/Tariffs/n.md' });
  assert.deepEqual(homeOf('c', { notes: notes([['Teaching/x.md', 2], ['Teaching/y.md', 2], ['Research/z.md', 3]]) }, projects), { key: 'P/C.md', why: 'notes', count: 2 });
  assert.deepEqual(homeOf('c', { notes: notes([['Research/Tariffs/x.md', 3], ['Teaching/y.md', 3]]) }, projects), { key: 'P/B.md', why: 'notes', count: 1 });
  assert.equal(homeOf('c', { notes: notes([['Other/x.md', 3]]), start: 'Other/x.md' }, projects), null);
  assert.equal(homeOf('c', { notes: notes([['Teaching/x.md', 3]]), declined: true }, projects), null);
  assert.deepEqual(homeOf('hand', { declined: true }, projects), { key: 'P/B.md', why: 'added' });
  // A note counts toward the deepest project holding it: an enclosing project does not gather its nested project's notes.
  assert.deepEqual(homeOf('c', { notes: notes([['Research/Tariffs/a.md', 3], ['Research/Tariffs/b.md', 3], ['Research/Tariffs/c.md', 3], ['Research/Other/d.md', 1]]) }, projects), { key: 'P/B.md', why: 'notes', count: 3 });
  // Mentions alone: a folder counts once they weigh enough.
  assert.equal(homeOf('c', { notes: notes([['Teaching/x.md', 1], ['Teaching/y.md', 1]]) }, projects), null);
  assert.deepEqual(homeOf('c', { notes: notes([['Teaching/x.md', 1], ['Teaching/y.md', 1], ['Teaching/z.md', 1]]) }, projects), { key: 'P/C.md', why: 'notes', count: 3 });
});

test('the fingerprint changes with the Context or Instructions', () => {
  const a = contextHash({ context: 'x', instructions: 'y' });
  assert.equal(a, contextHash({ context: 'x', instructions: 'y' }));
  assert.notEqual(a, contextHash({ context: 'x', instructions: 'y2' }));
  assert.notEqual(contextHash({ context: 'xy', instructions: '' }), contextHash({ context: 'x', instructions: 'y' }));
});

test('the linked chats block holds each digest; a prompt written with one before the hook shows only its text', () => {
  const linked = linkedChatsBlock([{ id: 'c1', title: 'Tariff "war" notes', digest: 'Found X.' }]);
  assert.match(linked, /<linked_chat title="Tariff 'war' notes" id="c1">\nFound X\.\n<\/linked_chat>/);
  const block = projectContextBlock([{ name: 'A', note: 'P/A.md', instructions: 'Be brief.', role: 'home' }]);
  const raw = `${block}\n\n${linked}\n\n<obsidian_context>\nNote attached to this chat: x.md\n</obsidian_context>\n\nhello`;
  assert.equal(stripContext(raw), 'hello');
  assert.deepEqual(bubbleOf(prompt(raw))?.chips, []);
  assert.equal(linkedChatsBlock([]), '');
});
