import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TFile } from 'obsidian';
import {
  addMemoSources,
  chatLink,
  cleanTags,
  memoBaseYaml,
  retargetMemoBase,
  memoNoteMarkdown,
  memoNoteName,
  firstPassageTarget,
  freeMemoTitle,
  quickMemoTitle,
  memoSuggestionPrompt,
  pairChat,
  passageNeedle,
  readMemoSuggestion,
  type MemoSources,
} from '../src/memos';

const sources: MemoSources = {
  vault: 'Obsidian',
  chatId: 'chat-1',
  chatTitle: 'Debt model [draft]',
  date: '2026-10-03',
  passages: [
    { role: 'you', text: 'Does the result survive\nrecursive repayment?', needle: 'Does the result survive' },
    { role: 'claude', text: 'A possible mechanism: $q(b)$ falls.', needle: 'A possible mechanism:' },
  ],
};

test('a new memo note: frontmatter with its tags, title, description, and each passage with who wrote it and links back', () => {
  const note = memoNoteMarkdown({ title: 'Repayment timing may change equilibrium selection', description: 'Test it under other continuation choices.', tags: ['idea', 'read'], notes: ['[[Model setup]]'], sources });
  assert.match(
    note,
    /^---\ntype: memo\ntags: \[idea, read\]\ncreated: 2026-10-03\nupdated: 2026-10-03\nchats: \["Debt model \[draft\]"\]\nnotes: \["\[\[Model setup\]\]"\]\nsend: false\ndone: false\nclaude_chats: \[chat-1\]\n---\n\n# Repayment timing may change equilibrium selection\n\nTest it under other continuation choices\.\n\n## Sources\n\n### Debt model draft · 2026-10-03\n/,
  );
  assert.ok(note.includes('**You** · [Go to the passage](obsidian://vault-claude?vault=Obsidian&chat=chat-1&find=Does%20the%20result%20survive)'));
  assert.ok(note.includes('> Does the result survive\n> recursive repayment?'));
  assert.ok(note.includes('**Claude** · '));
  assert.ok(note.includes('> A possible mechanism: $q(b)$ falls.'));
  assert.ok(note.endsWith('falls.\n'));
});

test('passages added later go at the end of the Sources section, before any section after it', () => {
  const note = memoNoteMarkdown({ title: 'Memo', description: '', tags: [], notes: [], sources });
  const withNotes = `${note}\n## Notes\n\nMine.\n`;
  const added = addMemoSources(withNotes, { ...sources, chatId: 'chat-2', chatTitle: 'Follow-up', passages: [{ role: 'you', text: 'A refinement.', needle: 'A refinement.' }] });
  const follow = added.indexOf('### Follow-up · 2026-10-03');
  assert.ok(follow > added.indexOf('A possible mechanism'));
  assert.ok(follow < added.indexOf('## Notes'));
  assert.ok(added.endsWith('Mine.\n'));
  // A note whose Sources heading was removed gets one again.
  const bare = addMemoSources('# Memo\n\nJust a description.\n', sources);
  assert.ok(bare.includes('Just a description.\n\n## Sources\n\n### Debt model draft'));
});

test('tags as Obsidian takes them, each once', () => {
  assert.deepEqual(cleanTags(['#idea', ' to read ', 'todo', 'idea', '2026', '', 'econ/macro', 'a,b']), ['idea', 'to-read', 'todo', 'econ/macro', 'ab']);
});

test('links carry their values encoded, and leave out empty ones', () => {
  assert.equal(chatLink({ vault: 'My vault', chat: 'c1', quote: 'a & b = $x$' }), 'obsidian://vault-claude?vault=My%20vault&chat=c1&quote=a%20%26%20b%20%3D%20%24x%24');
  assert.equal(chatLink({ vault: 'V', chat: 'c1', find: '' }), 'obsidian://vault-claude?vault=V&chat=c1');
});

test('a passage is found by its first line of words, cut at a word', () => {
  assert.equal(passageNeedle('\n  Short line  \nnext'), 'Short line');
  assert.equal(passageNeedle('The repayment schedule interacts with the continuation value in a way that matters', 40), 'The repayment schedule interacts with');
  assert.equal(passageNeedle('\n\n'), '');
});

test("a memo's note name drops what file names cannot hold", () => {
  assert.equal(memoNoteName('Debt: timing / selection?'), 'Debt timing selection');
  assert.equal(memoNoteName('Prices & signals: 50% + noise'), 'Prices signals 50 noise');
});

test('the suggestion request names who wrote each passage, and the reply is read from its JSON', () => {
  const prompt = memoSuggestionPrompt('Debt model', sources.passages);
  assert.ok(prompt.startsWith('Conversation: Debt model\n\nPassages, in order:\n\nThe researcher:\nDoes the result survive'));
  assert.ok(prompt.includes('The assistant:\nA possible mechanism: $q(b)$ falls.'));
  assert.deepEqual(readMemoSuggestion('Here it is:\n{"title": "Repayment timing and selection.", "description": "Asked whether $q(b)$ matters."}'), {
    title: 'Repayment timing and selection',
    description: 'Asked whether $q(b)$ matters.',
  });
  assert.equal(readMemoSuggestion('no json'), null);
  assert.equal(readMemoSuggestion('{"title": 3}'), null);
});

test("the Memos base opens on the chat's memos, then all, those about the note in front, and each kind", () => {
  const base = memoBaseYaml('chat-1', 'Debt model [v2] #draft', 'My vault');
  const views = [...base.matchAll(/^    name: "(.*)"$/gm)].map((match) => match[1]);
  assert.deepEqual(views, ['Chat: Debt model v2 draft', 'All memos', 'About this note', 'To do', 'To read', 'To explore', 'Ideas', 'Bookmarks', 'By chat', 'By note', 'Done']);
  // Finished memos only in Done.
  assert.equal(base.split('"done != true"').length - 1, 10);
  assert.ok(base.includes('        - "done == true"'));
  assert.ok(base.includes('    groupBy:\n      property: chats\n      direction: ASC'));
  assert.ok(base.includes('    groupBy:\n      property: notes\n      direction: ASC'));
  assert.ok(base.includes('        - "claude_chats.contains(\\"chat-1\\")"'));
  assert.ok(base.includes('        - "file.hasLink(this.file)"'));
  // Memos wherever they are, by their type; their chats as links that open them.
  assert.ok(!base.includes('inFolder'));
  assert.ok(base.startsWith('formulas:\n  chat: "claude_chats.map(link(\\"obsidian://vault-claude?vault=My%20vault&chat=\\" + value + \\"&memo=\\" + file.name, chats[index]))"'));
  assert.ok(base.includes('      - formula.chat'));
});

test("turning the base to another chat changes its chat view only, and keeps what was changed in the table", () => {
  const base = {
    properties: { send: { displayName: 'Send to chat' } },
    views: [
      { type: 'table', name: 'Chat: First', filters: { and: ['type == "memo"', 'claude_chats.contains("chat-1")'] }, order: ['file.name'], columnSize: { 'file.name': 320 } },
      { type: 'table', name: 'My own view', filters: { and: ['file.hasTag("todo")'] } },
    ],
  };
  const turned = retargetMemoBase(base, 'chat-2', 'Second', 'V') as { views: { name: string; filters: unknown; columnSize?: unknown; order?: string[] }[]; properties: Record<string, unknown>; formulas: Record<string, string> };
  assert.equal(turned.views[0].name, 'Chat: Second');
  assert.deepEqual(turned.views[0].filters, { and: ['type == "memo"', 'claude_chats.contains("chat-2")', 'done != true'] });
  assert.deepEqual(turned.views[0].columnSize, { 'file.name': 320 });
  assert.equal(turned.views[1].name, 'My own view');
  assert.deepEqual(turned.properties.send, base.properties.send);
  // A base from before chats were links gets the formula, and its views the column.
  assert.ok(turned.formulas.chat.startsWith('claude_chats.map(link('));
  assert.deepEqual(turned.views[0].order, ['file.name']);
  // A base whose chat view was removed gets one again, first; something else is not a base.
  const without = retargetMemoBase({ views: [{ name: 'Only mine', order: ['chats'] }] }, 'chat-3', 'Third', 'V') as { views: { name: string; order?: string[]; filters?: { and: string[] } }[] };
  assert.deepEqual(without.views.map((view) => view.name), ['Chat: Third', 'Only mine', 'Done']);
  // The chat view it gets leaves finished memos out once, not twice.
  assert.equal(without.views[0].filters?.and.filter((filter) => filter === 'done != true').length, 1);
  assert.deepEqual(without.views[1].order, ['formula.chat']);
  assert.equal(retargetMemoBase('not a base', 'c', 't', 'V'), null);
});

test("a memo's Send box puts it in the input when ticked, takes it out when cleared, and only a change counts", async () => {
  const { default: VaultClaudePlugin } = await import('../src/main');
  const p = new (VaultClaudePlugin as unknown as new () => InstanceType<typeof VaultClaudePlugin>)();
  const attached: string[] = [];
  (p as unknown as { app: unknown }).app = { workspace: { getLeavesOfType: () => [] } };
  p.attachToClaude = async (items) => void attached.push(...items.map((item) => item.path));
  const memo = { path: 'Claude chats/Memos/A memo.md' } as never;
  await p.followMemoBox(memo, true);
  // Another edit of the memo, its box still ticked: nothing more.
  await p.followMemoBox(memo, true);
  await p.followMemoBox(memo, false);
  assert.deepEqual(attached, ['Claude chats/Memos/A memo.md']);
});

test('a Memos base open in a tab follows the chat on the panel; one closed is left alone', async () => {
  const { default: VaultClaudePlugin } = await import('../src/main');
  const { TFile } = await import('obsidian');
  const p = new (VaultClaudePlugin as unknown as new () => InstanceType<typeof VaultClaudePlugin>)();
  p.settings = { ...p.settings, memosFolder: 'Claude chats/Memos' };
  const base = Object.assign(new TFile(), { path: 'Claude chats/Memos/Memos.base' });
  let text = 'old';
  let open = false;
  // A tab showing the base, on the view of the chat it was opened for.
  let tabState = { type: 'bases', state: { file: base.path, viewName: 'Chat: First chat' } };
  const tab = { view: { file: base }, getViewState: () => tabState, setViewState: async (state: typeof tabState) => void (tabState = state) };
  (p as unknown as { app: unknown }).app = {
    workspace: { getLeavesOfType: (type: string) => (type === 'bases' && open ? [tab] : []) },
    vault: {
      getName: () => 'Obsidian',
      getAbstractFileByPath: (path: string) => (path === base.path ? base : { path }),
      read: async () => text,
      modify: async (_file: unknown, value: string) => void (text = value),
    },
  };
  await p.followChatMemos('chat-2', 'Second chat');
  assert.equal(text, 'old');
  open = true;
  await p.followChatMemos('chat-2', 'Second chat');
  assert.ok(text.includes('name: "Chat: Second chat"'));
  assert.ok(text.includes('claude_chats.contains(\\"chat-2\\")'));
  // The open tab follows its view to the new name, instead of finding it gone.
  assert.equal(tabState.state.viewName, 'Chat: Second chat');
});

test('a link from a memo opens its chat, then finds the passage or quotes it; a chat gone says so', async () => {
  const { default: VaultClaudePlugin } = await import('../src/main');
  const p = new (VaultClaudePlugin as unknown as new () => InstanceType<typeof VaultClaudePlugin>)();
  const done: string[] = [];
  const view = { quote: (text: string) => void done.push(`quote ${text}`), findPassage: async (text: string) => void done.push(`find ${text}`) };
  p.chats = [{ id: 'c1', title: 'Debt model' }];
  p.openChatById = async (id: string, title: string) => {
    done.push(`open ${id} ${title}`);
    return id === 'gone' ? null : (view as never);
  };
  const open = (params: Record<string, string>) => (p as unknown as { openChatLink(params: Record<string, string>): Promise<void> }).openChatLink(params);
  await open({ chat: 'c1', find: 'A mechanism:' });
  await open({ chat: 'c1', quote: 'A mechanism: $q(b)$' });
  await open({ chat: 'gone', find: 'x' });
  await open({ find: 'no chat' });
  // From the table: the memo's first passage from that chat.
  (p as unknown as { app: unknown }).app = {
    vault: {
      getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path }),
      cachedRead: async () => '**You** · [Go to the passage](obsidian://vault-claude?vault=V&chat=c1&find=First%20words)',
    },
  };
  await open({ chat: 'c1', memo: 'Claude chats/Memos/M.md' });
  assert.deepEqual(done, ['open c1 Debt model', 'find A mechanism:', 'open c1 Debt model', 'quote A mechanism: $q(b)$', 'open gone Chat', 'open c1 Debt model', 'find First words']);
});

test("a memo's Send box cleared in the base takes its mention out of every panel's input", async () => {
  const { default: VaultClaudePlugin } = await import('../src/main');
  const { ChatView } = await import('../src/view');
  const p = new (VaultClaudePlugin as unknown as new () => InstanceType<typeof VaultClaudePlugin>)();
  const taken: string[] = [];
  const panel = (name: string) =>
    Object.assign(Object.create(ChatView.prototype) as InstanceType<typeof ChatView>, {
      mentions: () => true,
      unmention: (path: string) => void taken.push(`${name}: ${path}`),
    });
  const leaves = [{ view: panel('first') }, { view: panel('second') }];
  (p as unknown as { app: unknown }).app = { workspace: { getLeavesOfType: () => leaves } };
  p.attachToClaude = async () => undefined;
  const memo = { path: 'Claude chats/Memos/A memo.md' } as never;
  await p.followMemoBox(memo, true);
  await p.followMemoBox(memo, false);
  assert.deepEqual(taken, ['first: Claude chats/Memos/A memo.md', 'second: Claude chats/Memos/A memo.md']);
  // While another panel still mentions it, a panel that lets it go leaves the box ticked.
  assert.equal(p.mentionedElsewhere('Claude chats/Memos/A memo.md', leaves[0].view), true);
});

test("a memo's chats stay paired: a new chat comes with its title, a known one has its title updated", () => {
  // Two chats of the same title, and a list of titles shorter than the ids (a memo from before titles).
  assert.deepEqual(pairChat(['a'], ['Debt model'], 'b', 'Debt model'), { ids: ['a', 'b'], titles: ['Debt model', 'Debt model'] });
  assert.deepEqual(pairChat(['a', 'b'], ['First'], 'b', 'Renamed'), { ids: ['a', 'b'], titles: ['First', 'Renamed'] });
  assert.deepEqual(pairChat([], [], 'a', 'New'), { ids: ['a'], titles: ['New'] });
});

test("the table upgrades to chat links once, keeps its own formula on this vault, and leaves a formula of the user's", () => {
  const upgraded = retargetMemoBase({ views: [{ name: 'Mine', order: ['chats'] }] }, 'c', 'T', 'Old vault') as { formulas: { chat: string }; views: { order: string[] }[] };
  assert.deepEqual(upgraded.views[1].order, ['formula.chat']);
  // Later: a chats column put back by the user stays; the formula follows the vault's name.
  const later = retargetMemoBase({ formulas: upgraded.formulas, views: [{ name: 'Mine', order: ['chats'] }] }, 'c', 'T', 'New vault') as { formulas: { chat: string }; views: { order: string[] }[] };
  assert.deepEqual(later.views[1].order, ['chats']);
  assert.ok(later.formulas.chat.includes('vault=New%20vault'));
  const theirs = retargetMemoBase({ formulas: { chat: 'chats' }, views: [] }, 'c', 'T', 'V') as { formulas: { chat: string } };
  assert.equal(theirs.formulas.chat, 'chats');
});

test("renaming a chat renames it in the memos saved from it", async () => {
  const { default: VaultClaudePlugin } = await import('../src/main');
  const p = new (VaultClaudePlugin as unknown as new () => InstanceType<typeof VaultClaudePlugin>)();
  const frontmatter: Record<string, unknown> = { claude_chats: ['a', 'b'], chats: ['First', 'Old title'] };
  (p as unknown as { app: unknown }).app = {
    workspace: { getLeavesOfType: () => [] },
    fileManager: { processFrontMatter: async (_file: unknown, change: (fm: Record<string, unknown>) => void) => change(frontmatter) },
  };
  p.renameChat = () => undefined;
  p.vaultRoot = () => null;
  p.memoNotes = (chat?: string) => (chat === 'b' ? [{ path: 'Claude chats/Memos/M.md' } as never] : []);
  await p.renameChatTitle('b', 'New title');
  assert.deepEqual(frontmatter.chats, ['First', 'New title']);
});

test('a table from before the Done box gets it once: the column, the filter in its memo views, a Done view', () => {
  const old = {
    formulas: { chat: 'claude_chats.map(link("obsidian://vault-claude?vault=V&chat=" + value, chats[index]))' },
    properties: { send: { displayName: 'Send to chat' } },
    views: [
      { type: 'table', name: 'Chat: A', filters: { and: ['type == "memo"', 'claude_chats.contains("a")'] }, order: ['send', 'file.name'] },
      { type: 'table', name: 'Mine', filters: { and: ['file.hasTag("x")'] }, order: ['file.name'] },
    ],
  };
  const once = retargetMemoBase(old, 'a', 'A', 'V') as { properties: Record<string, unknown>; views: { name: string; order: string[]; filters: { and: string[] } }[] };
  assert.deepEqual(once.views.map((view) => view.name), ['Chat: A', 'Mine', 'Done']);
  assert.deepEqual(once.views[0].order, ['send', 'done', 'file.name']);
  assert.ok(once.views[0].filters.and.includes('done != true'));
  assert.deepEqual(once.views[1].filters.and, ['file.hasTag("x")']);
  // Again: nothing more is added.
  const twice = retargetMemoBase(once, 'a', 'A', 'V') as { views: { name: string; order: string[] }[] };
  assert.deepEqual(twice.views.map((view) => view.name), ['Chat: A', 'Mine', 'Done']);
  assert.deepEqual(twice.views[0].order, ['send', 'done', 'file.name']);
});

test("a link from the table finds the memo's first passage from its chat", () => {
  const note = memoNoteMarkdown({ title: 'Memo', description: '', tags: [], notes: [], sources });
  assert.deepEqual(firstPassageTarget(note, 'chat-1'), { find: 'Does the result survive' });
  assert.equal(firstPassageTarget(note, 'other-chat'), null);
  // A passage that recorded its message: the link goes to it, and to the words in it.
  const withMessage = memoNoteMarkdown({
    title: 'Memo',
    description: '',
    tags: [],
    notes: [],
    sources: { ...sources, passages: [{ ...sources.passages[1], message: 'uuid-7#2' }] },
  });
  assert.ok(withMessage.includes('[Go to the passage](obsidian://vault-claude?vault=Obsidian&chat=chat-1&msg=uuid-7%232&find=A%20possible%20mechanism%3A)'));
  assert.deepEqual(firstPassageTarget(withMessage, 'chat-1'), { msg: 'uuid-7#2', find: 'A possible mechanism:' });
  const base = memoBaseYaml('chat-1', 'Debt model', 'V');
  assert.ok(base.includes('+ \\"&memo=\\" + file.name, chats[index]'));
});

test("a bookmark's title: its first words, from the first passage with any; a name taken gets the date and time", () => {
  assert.equal(quickMemoTitle([{ role: 'you', text: '$x$', needle: '' }, { role: 'claude', text: 'Long', needle: 'The price: q(b) falls' }]), '$x$');
  assert.equal(quickMemoTitle([{ role: 'claude', text: 'Long', needle: 'The price: q(b) falls' }]), 'The price: q(b) falls');
  assert.equal(quickMemoTitle([{ role: 'claude', text: '', needle: '' }]), 'Bookmark');
  const taken = new Set(['Price', 'Price 2026-10-03 1432']);
  assert.equal(freeMemoTitle('New', '2026-10-03 1432', (name) => taken.has(name)), 'New');
  assert.equal(freeMemoTitle('Price', '2026-10-03 1432', (name) => taken.has(name)), 'Price 2026-10-03 1432 2');
  assert.equal(freeMemoTitle('Price', '2026-10-03 1433', (name) => taken.has(name)), 'Price 2026-10-03 1433');
});

test('a link keeps working when its words hold an unmatched parenthesis', () => {
  const link = chatLink({ vault: 'V', chat: 'c', msg: 'u#1', find: 'His CV (fetched 2026' });
  assert.equal(link, 'obsidian://vault-claude?vault=V&chat=c&msg=u%231&find=His%20CV%20%28fetched%202026');
  const note = `**Claude** · [Go to the passage](${link}) · [Continue](${chatLink({ vault: 'V', chat: 'c', quote: 'on [0,1)' })})`;
  assert.deepEqual(firstPassageTarget(note, 'c'), { msg: 'u#1', find: 'His CV (fetched 2026' });
});
