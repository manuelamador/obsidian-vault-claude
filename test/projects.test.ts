import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bubbleOf } from '../src/chatText';
import { stripContext } from '../src/history';
import { chatEdits, contextHash, guideLine, homeOf, linkedChatsBlock, projectContextBlock, projectNoteMarkdown, projectParts, readGuideProposals, withGenerated, withGuideLines } from '../src/projects';
import { message, prompt } from './transcript';

const note = projectNoteMarkdown({ name: 'Tariffs', folder: 'Research/Tariffs', added: ['a', 'b'], date: '2026-10-06' });

test('a new project note has its folder, chats added by hand, empty sections and generated lists', () => {
  assert.match(note, /^---\ntype: project\n/);
  assert.match(note, /folder: "Research\/Tariffs"/);
  assert.match(note, /added: \["a", "b"\]/);
  assert.deepEqual(projectParts(note), { instructions: '', guide: '' });
});

test('the generated lists are rewritten between their markers only', () => {
  const edited = note.replace('## Guide\n', '## Guide\n\n- kept\n').replace('yours to write. Nothing generated changes this section.', 'yours to write. Nothing generated changes this section.\n\nUse $\\LaTeX$.');
  const once = withGenerated(withGenerated(edited, 'Chats', '- [one](x)'), 'Key notes', '- [[Note]]');
  assert.match(once, /## Chats\n\n<!-- BEGIN GENERATED -->\n- \[one\]\(x\)\n<!-- END GENERATED -->/);
  assert.match(once, /## Key notes\n\n<!-- BEGIN GENERATED -->\n- \[\[Note\]\]\n<!-- END GENERATED -->/);
  assert.deepEqual(projectParts(once), { instructions: 'Use $\\LaTeX$.', guide: '- kept' });
  assert.equal(withGenerated(withGenerated(once, 'Chats', '- [two](y)'), 'Chats', '- [two](y)'), withGenerated(once, 'Chats', '- [two](y)'));
  // A section without markers is left as it is.
  assert.equal(withGenerated('## Chats\n\nby hand\n', 'Chats', 'x'), '## Chats\n\nby hand\n');
});

test('guide lines go at the end of the Guide, before the next section', () => {
  const added = withGuideLines(note, ['- one', '- two']);
  assert.match(added, /## Guide\n\n- one\n- two\n\n## Chats/);
  assert.match(withGuideLines(added, ['- three']), /- two\n\n- three\n\n## Chats/);
  assert.equal(projectParts(added).guide, '- one\n- two');
});

test('the context block holds the home Instructions and Guide, and connected Guides', () => {
  assert.equal(projectContextBlock([{ name: 'A', note: 'P/A.md', role: 'home' }]), '');
  const block = projectContextBlock([
    { name: 'A', note: 'P/A.md', instructions: 'Be brief.', guide: '- g', role: 'home' },
    { name: 'B', note: 'P/B.md', guide: '- h', role: 'connected' },
  ]);
  assert.match(block, /^<project_context>\n<project name="A" role="home" note="P\/A.md">\nInstructions:\nBe brief\.\n\nGuide/);
  assert.match(block, /<project name="B" role="connected" note="P\/B.md">\nGuide/);
});

test('a prompt with project context shows its text, with a chip for each project', () => {
  const block = projectContextBlock([{ name: 'A', note: 'P/A.md', instructions: 'Be brief.', role: 'parent' }]);
  const raw = `${block}\n\n<obsidian_context>\nNote attached to this chat: x.md\n</obsidian_context>\n\nhello`;
  assert.equal(stripContext(raw), 'hello');
  assert.deepEqual(bubbleOf(prompt(raw)), { text: 'hello', chips: [{ label: 'A', icon: 'folder-kanban' }] });
  assert.equal(stripContext(`${block}\n\nhi`), 'hi');
});

test('proposals are kept only from chats given, with text', () => {
  const reply = 'Here:\n{"items": [{"text": "Prefers Julia.", "kind": "finding", "source": "a", "conflicts": ""}, {"text": "x", "source": "zzz"}, {"text": " ", "source": "a"}, {"text": "Why?", "kind": "question", "source": "b", "conflicts": "- old"}]}';
  assert.deepEqual(readGuideProposals(reply, ['a', 'b']), [
    { text: 'Prefers Julia.', kind: 'finding', source: 'a', conflicts: '' },
    { text: 'Why?', kind: 'question', source: 'b', conflicts: '- old' },
  ]);
  assert.equal(readGuideProposals('no json', ['a']), null);
});

test('a guide line names its kind and links its chat', () => {
  assert.equal(guideLine({ text: 'Why\nnot?', kind: 'question' }, { title: 'A [chat]', link: 'obsidian://x' }, '2026-10-06'), '- **Open question:** Why not? ([A chat](obsidian://x), 2026-10-06)');
});

test('edits are read as before and after', () => {
  const edits = chatEdits([message('assistant', [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/v/a.md', old_string: 'x', new_string: 'y' } }])]);
  assert.equal(edits, 'In a.md:\nBefore: x\nAfter: y');
  assert.equal(chatEdits([message('user', 'hi')]), '');
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
  // Mentions alone: a folder counts once they weigh enough.
  assert.equal(homeOf('c', { notes: notes([['Teaching/x.md', 1], ['Teaching/y.md', 1]]) }, projects), null);
  assert.deepEqual(homeOf('c', { notes: notes([['Teaching/x.md', 1], ['Teaching/y.md', 1], ['Teaching/z.md', 1]]) }, projects), { key: 'P/C.md', why: 'notes', count: 3 });
});

test('the fingerprint changes with the Instructions or Guide', () => {
  const a = contextHash({ instructions: 'x', guide: 'y' });
  assert.equal(a, contextHash({ instructions: 'x', guide: 'y' }));
  assert.notEqual(a, contextHash({ instructions: 'x', guide: 'y2' }));
  assert.notEqual(contextHash({ instructions: 'xy', guide: '' }), contextHash({ instructions: 'x', guide: 'y' }));
});

test('a prompt with linked chats shows its text, with a chip for each chat included', () => {
  const linked = linkedChatsBlock([{ id: 'c1', title: 'Tariff "war" notes', digest: 'Found X.' }]);
  assert.match(linked, /<linked_chat title="Tariff 'war' notes" id="c1">\nFound X\.\n<\/linked_chat>/);
  const block = projectContextBlock([{ name: 'A', note: 'P/A.md', instructions: 'Be brief.', role: 'home' }]);
  const raw = `${block}\n\n${linked}\n\n<obsidian_context>\nNote attached to this chat: x.md\n</obsidian_context>\n\nhello`;
  assert.equal(stripContext(raw), 'hello');
  assert.deepEqual(bubbleOf(prompt(raw))?.chips, [{ label: 'A', icon: 'folder-kanban' }, { label: "Tariff 'war' notes", icon: 'link' }]);
  assert.equal(linkedChatsBlock([]), '');
});
