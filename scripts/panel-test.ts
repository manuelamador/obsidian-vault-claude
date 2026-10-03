// Opens the chat panel in jsdom with a stubbed `obsidian` module and reports whether onOpen()
// completes; prints the error and stack if it throws. Build with esbuild aliasing `obsidian`
// to scripts/obsidian-stub.ts (see the command in the README's test notes).
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'DocumentFragment', 'navigator', 'getComputedStyle', 'requestAnimationFrame']) {
  g[key] = (dom.window as unknown as Record<string, unknown>)[key];
}

async function main(): Promise<void> {
  const stub = await import('./obsidian-stub');
  stub.installDomHelpers(dom.window as unknown as Window & typeof globalThis);
  for (const key of ['createDiv', 'createFragment', 'activeDocument']) g[key] = (dom.window as unknown as Record<string, unknown>)[key];

  const { ChatView } = await import('../src/view');
  const { chatToMarkdown } = await import('../src/chatText');
  const { HistoryModal } = await import('../src/historyModal');
  const { FindBar, findRanges } = await import('../src/findBar');
  const { DEFAULT_SETTINGS } = await import('../src/settings');
  const { RemoteControlServer } = await import('../src/remoteControl');

  // Notes the stubbed vault holds, and those the tests threw away.
  const notesOnDisk = new Map<string, string>();
  const trashed: string[] = [];
  // Notes the panel linked to a chat because they went with a message.
  const noteRefCalls: string[] = [];
  // Page-preview requests the panel sends Obsidian, and notes it opens from a diff line.
  const hovers: { name: string; data: { source?: string; linktext?: string } }[] = [];
  const openedFiles: { path: string; state: unknown }[] = [];
  const leafStub: { view: unknown; openFile(file: { path: string }, state: unknown): Promise<void> } = {
    view: null,
    openFile: async (file, state) => void openedFiles.push({ path: file.path, state }),
  };
  const openedLinks: string[] = [];
  const app = {
    workspace: {
      on: () => ({}),
      trigger: (name: string, data: { source?: string; linktext?: string }) => void hovers.push({ name, data }),
      getLeaf: () => leafStub,
      openLinkText: async (link: string) => void openedLinks.push(link),
      getMostRecentLeaf: () => null,
      getActiveFile: () => null,
      onLayoutReady: (cb: () => void) => cb(),
      getLeavesOfType: () => [],
      revealLeaf: async () => undefined,
    },
    vault: {
      getName: () => 'Obsidian',
      getMarkdownFiles: () => [],
      getAbstractFileByPath: (path: string) =>
        path === 'Notes'
          ? Object.assign(new stub.TFolder(), { path: 'Notes' })
          : notesOnDisk.has(path)
            ? Object.assign(new stub.TFile(), { path, basename: path.split('/').pop()?.replace(/\.md$/, ''), extension: path.split('.').pop() })
            : null,
      read: async (file: { path: string }) => notesOnDisk.get(file.path) ?? '',
      on: () => ({}),
      cachedRead: async (file: { path: string }) => notesOnDisk.get(file.path) ?? '',
    },
    fileManager: {
      trashFile: async (file: { path: string }) => {
        notesOnDisk.delete(file.path);
        trashed.push(file.path);
      },
    },
    metadataCache: {
      getFirstLinkpathDest: (link: string) =>
        link === 'paper.pdf'
          ? { path: 'paper.pdf', extension: 'pdf' }
          : link === 'New.md' || link === 'Linked.md'
            ? Object.assign(new stub.TFile(), { path: link, basename: link.replace(/\.md$/, ''), extension: 'md' })
            : link.endsWith('.svg')
              ? Object.assign(new stub.TFile(), { path: link, extension: 'svg' })
              : null,
      fileToLinktext: (file: { basename: string }) => file.basename,
    },
  };
  const plugin = {
    settings: { ...DEFAULT_SETTINGS },
    models: [],
    configured: {},
    planUsage: null as unknown,
    planFetchedAt: 0,
    chats: [],
    remote: new RemoteControlServer(),
    phoneAccessName: () => 'Obsidian vault',
    vaultRoot: () => '/tmp',
    // As the plugin's, without looking for a `claude` on this machine.
    claudeLaunch(): { cwd: string; claudePath: string; extraPath: string[] } | string {
      return { cwd: this.vaultRoot(), claudePath: this.settings.claudePath || '/usr/local/bin/claude', extraPath: [] };
    },
    launchOrNotice() {
      const launch = this.claudeLaunch();
      return typeof launch === 'string' ? null : launch;
    },
    // As the plugin's, without the time limit.
    ending: new Map<string, Promise<void>>(),
    sessionEnding(id: string) {
      let ended = (): void => undefined;
      this.ending.set(id, new Promise<void>((resolve) => (ended = resolve)));
      return () => {
        this.ending.delete(id);
        ended();
      };
    },
    sessionEnded(id: string) {
      return this.ending.get(id) ?? Promise.resolve();
    },
    processEnding: () => undefined,
    loadConfigured: async () => undefined,
    refreshStatus: async () => undefined,
    startRemote: () => undefined,
    setModels: () => undefined,
    setPlanUsage: () => undefined,
    recordChat: () => undefined,
    sideSessions: [] as string[],
    holdSideSession(id: string) {
      if (!this.sideSessions.includes(id)) this.sideSessions.push(id);
    },
    releaseSideSession(id: string) {
      this.sideSessions = this.sideSessions.filter((held) => held !== id);
    },
    renameChat: () => undefined,
    commands: [
      { name: 'todosync', description: 'Sync todos with the calendar', argumentHint: '' },
      { name: 'idea', description: 'Capture a research idea', argumentHint: '<url>' },
      { name: 'todo', description: 'Add a todo', argumentHint: '<text>' },
    ],
    setCommands: () => undefined,
    scratch: null as { id: string; usedAt: number } | null,
    noteChats: {} as Record<string, string[]>,
    // Notes linked to a chat, and whether the link made the chat the note's newest.
    noteLinks: [] as string[],
    linkNoteChat(path: string, chatId: string, promote = true) {
      this.noteLinks.push(`${path}@${chatId}${promote ? '' : ' (kept back)'}`);
    },
    linkNoteRef: (path: string, chatId: string) => void noteRefCalls.push(`${path}@${chatId}`),
    // Notes a chat mentioned, as recorded.
    mentionLinks: [] as string[],
    linkNoteMention(path: string, chatId: string) {
      this.mentionLinks.push(`${path}@${chatId}`);
    },
    drafts: {} as Record<string, { text?: string; note?: string }>,
    planNotes: {} as Record<string, { path: string; plan: string }>,
    setPlanNote(id: string, path: string, plan: string) {
      this.planNotes[id] = { path, plan };
    },
    forgetPlanNote(path: string) {
      for (const id of Object.keys(this.planNotes)) if (this.planNotes[id].path === path) delete this.planNotes[id];
    },
    // As the plugin's: the note to the trash, through the app.
    async trashNote(path: string) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file) await app.fileManager.trashFile(file as never);
      return true;
    },
    unseen: {} as Record<string, 'done' | 'error'>,
    // The panel another one hands its running chats to when it closes; none by default.
    heir: null as { adoptBackground(entry: unknown): void } | null,
    otherChatView() {
      return this.heir;
    },
    markChatUnseen(id: string, outcome: 'done' | 'error') {
      this.unseen[id] = outcome;
    },
    markChatSeen(id: string) {
      delete this.unseen[id];
    },
    chatDraft(id: string) {
      return this.drafts[id] ?? {};
    },
    setChatDraft(id: string, draft: { text?: string; note?: string }) {
      if (draft.text?.trim() || draft.note) this.drafts[id] = { ...(draft.text?.trim() ? { text: draft.text } : {}), ...(draft.note ? { note: draft.note } : {}) };
      else delete this.drafts[id];
    },
    openChatIds: new Set<string>(),
    openChats() {
      return this.openChatIds;
    },
    noteChatEntries: (file: { path: string }) => (file.path === 'Note.md' ? [{ id: 'c1', title: 'About the note', why: 'changed' }] : []),
    sessionOfNote: () => null,
    openChatById: async () => undefined,
    chatHolder: () => null,
    scratchSession: () => null,
    scratchLeft: () => 0,
    setScratch: () => undefined,
    touchScratch: () => undefined,
    clearScratch: async () => undefined,
    clearScratchChat: async () => undefined,
    pinned: [] as string[],
    ticks: {} as Record<string, Record<string, number[]>>,
    toggledTicks(chat: string, replyKey: string): Set<number> {
      return new Set(this.ticks[chat]?.[replyKey] ?? []);
    },
    setTicks(chat: string, replyKey: string, toggled: ReadonlySet<number>): void {
      const chatTicks = (this.ticks[chat] ??= {});
      if (toggled.size > 0) chatTicks[replyKey] = [...toggled].sort((a, b) => a - b);
      else delete chatTicks[replyKey];
    },
  };
  const view = new ChatView({ app } as never, plugin as never);
  // A field in ChatView with the same name as one of ItemView's properties replaces it with
  // undefined (class fields are defined after super()), which breaks the view in Obsidian.
  const clobbered = stub.ITEM_VIEW_PROPERTIES.filter((name) => {
    const value = (view as unknown as Record<string, unknown>)[name];
    return value === undefined && name !== 'navigation' && name !== 'icon' && name !== 'scope' && name !== 'titleContainerEl' && name !== 'titleParentEl' && name !== 'actionsEl' && name !== 'iconEl';
  });
  if (clobbered.length > 0) {
    console.log(`ItemView properties overwritten by ChatView fields: ${clobbered.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('ItemView properties intact');
  }
  view.load();
  try {
    await view.onOpen();
    const root = view.contentEl;
    console.log(`onOpen completed; header children: ${root.querySelector('.vc-header')?.children.length}; title: ${root.querySelector('.vc-chat-title')?.textContent}`);
    // Under the input: model, effort and mode as short-label menu buttons, after the attach button.
    const headerLabels = [...root.querySelectorAll('.vc-actions .vc-menu-button-label')].map((el) => el.textContent).join(' | ');
    const modeTip = root.querySelectorAll('.vc-actions .vc-menu-button')[2]?.getAttribute('aria-label');
    const headerOrder = [...root.querySelectorAll('.vc-header > *')].map((el) => el.getAttribute('aria-label') ?? el.className).join(' | ');
    console.log(`top row: ${headerOrder}`);
    if (!/vc-chat-title.* \| vc-chat-title-actions \| .*Chat history \| New chat/.test(headerOrder) || root.querySelector('.vc-header .vc-menu-button')) process.exitCode = 1;
    console.log(`header buttons: ${headerLabels} (expected Default model | Effort | Ask); mode tooltip: ${modeTip}`);
    if (headerLabels !== 'Default model | Effort | Ask' || modeTip !== 'Permission mode: Ask first') process.exitCode = 1;

    // Branch points: after a reply's final text, never after a reply that ends on a tool call.
    const entry = (uuid: string, type: 'user' | 'assistant', content: unknown) =>
      ({ type, uuid, session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: type, content } });
    const internals = view as unknown as {
      renderTranscript(t: unknown[], options?: { running?: boolean }): void;
      setChatTitle(title: string | null): void;
      resumeId: string | null;
      messagesEl: HTMLElement;
      saveButton: HTMLElement;
    };
    const transcript = [
      entry('u1', 'user', 'first question'),
      entry('a1', 'assistant', [{ type: 'text', text: 'first answer' }]),
      entry('u2', 'user', 'second question'),
      entry('a2', 'assistant', [{ type: 'text', text: 'Let me check.' }]),
      entry('a3', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      entry('u3', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]),
      entry('a4', 'assistant', [{ type: 'text', text: 'done' }]),
      entry('u4', 'user', 'third question'),
      entry('a5', 'assistant', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/tmp/x' } }]),
    ];
    internals.renderTranscript(transcript);
    const points = [...root.querySelectorAll<HTMLElement>('.vc-turn.has-branch')].map((turn) => turn.dataset.branchUuid);
    const buttons = [...root.querySelectorAll('.vc-turn-actions button')].map((button) => button.getAttribute('aria-label'));
    console.log(`branch points: ${points.join(', ')} (expected a1, a4); buttons: ${buttons.join(', ')}`);
    if (points.join(',') !== 'a1,a4' || buttons.length !== 8) process.exitCode = 1;
    // Reply: the answer goes into the input as a quote, ready to be answered.
    const replyInput = (view as unknown as { inputEl: HTMLTextAreaElement }).inputEl;
    replyInput.value = '';
    (root.querySelectorAll<HTMLElement>('.vc-turn-actions button[aria-label="Reply to this"]')[1])?.click();
    const repliedOk = replyInput.value === '> Let me check.\n>\n> done\n\n';
    console.log(`reply button quotes the answer: ${JSON.stringify(replyInput.value)} -> ${repliedOk}`);
    if (!repliedOk) process.exitCode = 1;
    replyInput.value = '';
    // Copy: the second reply's text parts, as Markdown, joined.
    let copied = '';
    // Node 21+ has its own global navigator, which the jsdom one does not replace.
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: async (text: string) => void (copied = text) } });
    root.querySelectorAll<HTMLElement>('.vc-turn-actions button[aria-label="Copy reply"]')[1]?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    console.log(`copied: ${JSON.stringify(copied)} (expected "Let me check.\\n\\ndone")`);
    if (copied !== 'Let me check.\n\ndone') process.exitCode = 1;
    // What Claude wrote between steps stays visible: one tool call on its own is not folded away.
    const turnsNow = [...root.querySelectorAll<HTMLElement>('.vc-turn')];
    const spoken = [...turnsNow[1].querySelectorAll<HTMLElement>(':scope > .vc-text')].map((el) => el.textContent);
    const spokenOk = spoken.join('|') === 'Let me check.|done' && !turnsNow[1].querySelector('.vc-steps') && !!turnsNow[1].querySelector(':scope > .vc-tools');
    console.log(`messages between steps stay open: ${spoken.join(' | ')} -> ${spokenOk}`);
    if (!spokenOk) process.exitCode = 1;
    internals.messagesEl.empty();
    internals.renderTranscript(transcript.slice(0, 7), { running: true });
    const running = [...root.querySelectorAll<HTMLElement>('.vc-turn.has-branch')].map((turn) => turn.dataset.branchUuid);
    console.log(`while running: ${running.join(', ')} (expected a1)`);
    if (running.join(',') !== 'a1') process.exitCode = 1;
    console.log(`save button on a new chat: ${internals.saveButton.isShown()}`);
    internals.resumeId = 'x';
    internals.setChatTitle('Some chat');
    console.log(`save button on an opened chat: ${internals.saveButton.isShown()}; tab title: ${view.getDisplayText()}`);
    // A chat opened from history has no context reading yet: the label stays blank and the bar hidden.
    const contextLabel = root.querySelector('.vc-meter-context')?.textContent;
    const contextBarShown = (root.querySelector('.vc-meter-bar') as HTMLElement).isShown();
    console.log(`context label on an opened chat: "${contextLabel}" (expected ""); bar shown: ${contextBarShown}`);
    if (contextLabel !== '' || contextBarShown) process.exitCode = 1;
    // ↑ in an empty input recalls the last prompt (here from the transcript); with text in the input it does nothing.
    internals.messagesEl.empty();
    internals.renderTranscript(transcript);
    const recallInput = root.querySelector('.vc-input') as HTMLTextAreaElement;
    const key = (name: string) => recallInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    recallInput.value = '';
    key('ArrowUp');
    const recalled = recallInput.value;
    key('ArrowUp');
    const again = recallInput.value;
    recallInput.value = 'draft';
    key('ArrowUp');
    const draftKept = recallInput.value === 'draft';
    recallInput.value = '';
    console.log(`recall: ${JSON.stringify(recalled)}, pressed again: ${JSON.stringify(again)}; typed text kept: ${draftKept}`);
    if (recalled !== 'third question' || again !== 'third question' || !draftKept) process.exitCode = 1;

    // Slash-command suggestions: "/to" lists todo and todosync; ArrowDown then Enter picks todosync.
    const input = root.querySelector('.vc-input') as HTMLTextAreaElement;
    input.value = '/to';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new dom.window.Event('input'));
    const listed = [...root.querySelectorAll('.vc-suggest-item .vc-suggest-name')].map((el) => el.textContent);
    console.log(`suggestions for /to: ${listed.join(', ')} (expected /todo, /todosync)`);
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
    console.log(`after ArrowDown, Enter: ${JSON.stringify(input.value)} (expected "/todosync "); list shown: ${(root.querySelector('.vc-suggest') as HTMLElement).isShown()}`);
    if (listed.join(',') !== '/todo,/todosync' || input.value !== '/todosync ') process.exitCode = 1;
    input.value = '';

    // A selection from a note: a chip, and a tagged block in the prompt.
    const more = view as unknown as { attachments: unknown[]; buildContent(text: string, attachments: unknown[]): Promise<{ content: unknown }> };
    view.attachSelection({ kind: 'selection', name: 'Note', path: 'Notes/Note.md', fromLine: 3, toLine: 5, text: 'selected words' });
    const chip = root.querySelector('.vc-tray .vc-chip-label')?.textContent;
    const prompt = String((await more.buildContent('Explain this', more.attachments)).content);
    console.log(`selection chip: ${chip}; prompt has tag: ${prompt.includes('<selection note="Notes/Note.md" lines="3-5">\nselected words\n</selection>')}`);
    if (chip !== 'Note, lines 3–5' || !prompt.includes('<selection note="Notes/Note.md" lines="3-5">')) process.exitCode = 1;

    // Save chat as note: prompts as quotes, replies as text, no tool calls.
    const note = chatToMarkdown('Test chat', 'sess-1', [...transcript, entry('u5', 'user', prompt)] as never, '2026-09-14');
    const checks = {
      frontmatter: note.startsWith('---\ntags: [claude-chat]\nupdated: 2026-09-14\nclaude_session: sess-1\n---\n\n# Test chat'),
      prompt: note.includes('> **You**\n>\n> first question'),
      reply: note.includes('\n\nfirst answer\n\n'),
      joined: note.includes('Let me check.\n\ndone'),
      noTools: !note.includes('tool_use') && !note.includes('ls'),
      selection: note.includes('> Explain this\n>\n> *Attached: Note, lines 3–5*'),
    };
    console.log(`chat note: ${JSON.stringify(checks)}`);
    if (Object.values(checks).some((ok) => !ok)) {
      console.log(note);
      process.exitCode = 1;
    }

    // The note in front is offered, not attached; a click attaches it. The attached chip then follows
    // the selection in it: editing view, then reading view (kept after the click away).
    g.activeWindow = dom.window;
    const noteFile = { basename: 'Note', path: 'Note.md', extension: 'md' };
    const chipName = () => root.querySelector('.vc-context-chip.is-attached .vc-context-name')?.textContent;
    const ctx = view as unknown as { lastMarkdownView: unknown; onSelectionChange(): void; updateContextChip(): void };
    ctx.lastMarkdownView = Object.assign(Object.create(stub.MarkdownView.prototype), {
      file: noteFile,
      getMode: () => 'source',
      editor: { getSelection: () => 'selected words', getCursor: (which: string) => ({ line: which === 'from' ? 4 : 6, ch: 0 }) },
    });
    ctx.updateContextChip();
    const offerEl = root.querySelector('.vc-context-offer') as HTMLElement | null;
    // Every keystroke in a note is a selection change: when nothing the chips show has changed,
    // they are left as they are rather than rebuilt.
    ctx.updateContextChip();
    const chipKept = root.querySelector('.vc-context-offer') === offerEl;
    console.log(`note chip left alone when nothing changed: ${chipKept}`);
    if (!chipKept) process.exitCode = 1;
    const offeredFirst = !!offerEl && !root.querySelector('.vc-context-chip.is-attached') && offerEl.textContent === 'Note · lines 5–7';
    offerEl?.click();
    const attachedOnClick = !!root.querySelector('.vc-context-chip.is-attached') && !root.querySelector('.vc-context-offer');
    console.log(`note chip: offered, not attached ${offeredFirst}; attached on a click ${attachedOnClick}`);
    if (!offeredFirst || !attachedOnClick) process.exitCode = 1;
    const editingChip = chipName();
    const preview = document.createElement('div');
    const intro = preview.appendChild(document.createElement('p'));
    intro.textContent = 'An introductory paragraph about gardens.';
    const body = preview.appendChild(document.createElement('p'));
    body.textContent = 'The quick brown fox jumps over the lazy dog.';
    document.body.appendChild(preview);
    ctx.lastMarkdownView = Object.assign(Object.create(stub.MarkdownView.prototype), {
      file: noteFile,
      getMode: () => 'preview',
      previewMode: {
        containerEl: preview,
        renderer: { sections: [ { el: intro, lineStart: 4, lineEnd: 4 }, { el: body, lineStart: 6, lineEnd: 6 } ] },
      },
      getViewData: () => '---\ntags: [x]\n---\n\nAn introductory paragraph about gardens.\n\nThe quick brown fox jumps over the lazy dog.\n',
    });
    const range = document.createRange();
    range.setStart(body.firstChild as Node, 4);
    range.setEnd(body.firstChild as Node, 15);
    dom.window.getSelection()?.removeAllRanges();
    dom.window.getSelection()?.addRange(range);
    ctx.onSelectionChange();
    const readingChip = chipName();
    // A click into the panel's input moves the page selection; the kept one stays.
    const inputEl = root.querySelector('.vc-input') as HTMLTextAreaElement;
    dom.window.getSelection()?.removeAllRanges();
    dom.window.getSelection()?.collapse(inputEl, 0);
    ctx.onSelectionChange();
    const afterClick = chipName();
    const readingPrompt = String((await (view as unknown as { buildContent(t: string, a: unknown[]): Promise<{ content: unknown }> }).buildContent('Explain', [])).content);
    console.log(`chip: editing "${editingChip}", reading "${readingChip}", after clicking the input "${afterClick}"`);
    const chipOk =
      editingChip === 'Note · lines 5–7' &&
      readingChip === 'Note · line 7' &&
      afterClick === 'Note · line 7' &&
      readingPrompt.includes('Text selected in reading view, as rendered; it is within lines 7–7 of the note:\n<selection>\nquick brown\n</selection>');
    console.log(`reading-view prompt block correct: ${chipOk}`);
    if (!chipOk) process.exitCode = 1;
    // The × detaches it, and the note in front is offered again.
    (root.querySelector('.vc-context-remove') as HTMLElement).click();
    const detached = !root.querySelector('.vc-context-chip.is-attached') && !!root.querySelector('.vc-context-offer');
    console.log(`note chip: detached by the × ${detached}`);
    if (!detached) process.exitCode = 1;
    // Another kind of view in front in the main area (a canvas, a calendar) leaves no note in front;
    // a click into a Claude panel, in a sidebar or the main area, or into a sidebar keeps the note; a
    // note in front again brings it back, also when a tab shows it in place (announced by file-open only).
    {
      const front = view as unknown as { followFront(leaf: unknown): void; followActiveLeaf(): void; updateContextChip(): void };
      const noteView = Object.assign(Object.create(stub.MarkdownView.prototype), { file: noteFile, getMode: () => 'preview', previewMode: { containerEl: document.createElement('div') } });
      const mainArea = {};
      const sidebar = {};
      const workspace = app.workspace as Record<string, unknown>;
      workspace.rightSplit = sidebar;
      const leaf = (leafView: unknown, leafRoot: unknown) => ({ view: leafView, getRoot: () => leafRoot });
      const offered = () => root.querySelector('.vc-context-offer .vc-context-name')?.textContent ?? 'none';
      const show = (leafView: unknown, leafRoot: unknown) => {
        front.followFront(leaf(leafView, leafRoot));
        front.updateContextChip();
        return offered();
      };
      const seen = [show(noteView, mainArea), show({}, mainArea), show(view, sidebar), show(noteView, mainArea), show({}, sidebar), show(view, sidebar), show(view, mainArea)];
      // A canvas in front, then a note opened in the canvas's own tab: only file-open says so.
      show({}, mainArea);
      const canvasTab = leaf({}, mainArea);
      workspace.getActiveViewOfType = () => ({ leaf: canvasTab });
      canvasTab.view = noteView;
      front.followActiveLeaf();
      seen.push(offered());
      delete workspace.rightSplit;
      delete workspace.getActiveViewOfType;
      const frontOk = JSON.stringify(seen) === JSON.stringify(['Note', 'none', 'none', 'Note', 'Note', 'Note', 'Note', 'Note']);
      console.log(`note in front: a note, a canvas, the panel, a note, a sidebar, the panel, a Claude tab, a note shown in the canvas's tab -> ${seen.join(', ')} -> ${frontOk}`);
      if (!frontOk) process.exitCode = 1;
    }
    ctx.lastMarkdownView = null;

    // Mentions of a folder and of a non-note file go by path.
    const mentions = String((await more.buildContent('Compare @[[Notes/]] with @[[paper.pdf]]', [])).content);
    const mentionOk = mentions.includes('Mentioned folder: /tmp/Notes') && mentions.includes('Mentioned file: /tmp/paper.pdf');
    console.log(`mentions of a folder and a PDF: ${mentionOk}`);
    if (!mentionOk) process.exitCode = 1;



    // A long message folds with "Show all (N lines)"; the link unfolds it; a short one does not fold.
    const bubbles = view as unknown as { renderUserBubble(text: string, chips: unknown[]): HTMLElement };
    const longBubble = bubbles.renderUserBubble(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'), []);
    const shortBubble = bubbles.renderUserBubble('a short question', []);
    const foldToggle = longBubble.querySelector('.vc-user-toggle') as HTMLElement;
    const foldedFirst = longBubble.hasClass('is-collapsed') && foldToggle?.textContent === 'Show all (20 lines)';
    foldToggle.click();
    const unfolded = !longBubble.hasClass('is-collapsed') && foldToggle.textContent === 'Show less';
    const shortPlain = !shortBubble.hasClass('is-collapsed') && !shortBubble.querySelector('.vc-user-toggle');
    console.log(`long message folds: ${foldedFirst}; unfolds: ${unfolded}; short one plain: ${shortPlain}`);
    if (!foldedFirst || !unfolded || !shortPlain) process.exitCode = 1;

    longBubble.remove();
    shortBubble.remove();

    // Moving between sent messages, on its own layout: four messages at 100, 500, 900 and 1300 px
    // in a 1600 px chat seen through a 400 px window whose top edge is at 100 px.
    const { PromptNav } = await import('../src/promptNav');
    const wired = !!root.querySelector('.vc-messages-wrap > .vc-question-bar');
    const navHost = document.body.appendChild(document.createElement('div'));
    const scroller = navHost.appendChild(document.createElement('div'));
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 500, height: 400 }) as DOMRect;
    Object.defineProperty(scroller, 'clientHeight', { value: 400 });
    Object.defineProperty(scroller, 'scrollHeight', { value: 1600 });
    scroller.scrollTo = ((options: ScrollToOptions) => {
      scroller.scrollTop = options.top ?? 0;
    }) as typeof scroller.scrollTo;
    [100, 500, 900, 1300].forEach((y, i) => {
      const bubble = scroller.appendChild(document.createElement('div'));
      bubble.className = 'vc-user';
      const text = bubble.appendChild(document.createElement('div'));
      text.className = 'vc-user-text';
      text.textContent = `question ${i + 1}`;
      bubble.getBoundingClientRect = () => ({ top: 100 + y - scroller.scrollTop, bottom: 140 + y - scroller.scrollTop }) as DOMRect;
    });
    const nav = new PromptNav(navHost, scroller) as unknown as { update(): void; step(d: -1 | 1): void; shownText(): string; destroy(): void; target: unknown };
    const navLog: string[] = [];
    const go = (delta: -1 | 1, fresh = true) => {
      if (fresh) nav.target = null;
      nav.step(delta);
      navLog.push(String(scroller.scrollTop));
    };
    // Reading the reply to question 2: the bar shows it.
    scroller.scrollTop = 600;
    nav.update();
    const barText = nav.shownText();
    // ↑ goes back to question 2 (40 px below the top edge), ↑ again right away to question 1;
    // ↓ from there to 2, then 3, then quickly 4 and the end of the chat.
    go(-1);
    go(-1, false);
    go(1);
    go(1);
    go(1, false);
    go(1, false);
    // With question 2 just below the top edge the bar hides, unless the pointer is on it; the bar's ↑ arrow steps too.
    scroller.scrollTop = 460;
    nav.update();
    const hiddenAtMessage = nav.shownText() === '';
    scroller.scrollTop = 600;
    nav.update();
    const navBar = navHost.querySelector('.vc-question-bar') as HTMLElement;
    navBar.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
    nav.target = null;
    (navBar.querySelector('button[aria-label^="Previous message"]') as HTMLElement).click();
    nav.update();
    const keptOnHover = nav.shownText() === 'question 2' && scroller.scrollTop === 460;
    navBar.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
    nav.update();
    // The list: every message, the one being read marked; ↓ and Enter go to the next; Esc and a click elsewhere close it.
    scroller.scrollTop = 600;
    nav.update();
    const listButton = navHost.querySelector('.vc-question-bar button[aria-label="All your messages"]') as HTMLElement;
    const listEl = navHost.querySelector('.vc-message-list') as HTMLElement;
    const listKey = (key: string) => listEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, cancelable: true, bubbles: true }));
    listButton.click();
    const listItems = [...listEl.querySelectorAll<HTMLElement>('.vc-message-list-item')];
    const listShape =
      listItems.map((el) => el.textContent).join('|') === '1question 1|2question 2|3question 3|4question 4' &&
      listItems[1].hasClass('is-current') &&
      listItems[1].hasClass('is-selected');
    listKey('ArrowDown');
    listKey('Enter');
    const listJump = !listEl.isShown() && scroller.scrollTop === 860;
    listButton.click();
    listKey('Escape');
    const escCloses = !listEl.isShown();
    listButton.click();
    document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    const outsideCloses = !listEl.isShown();
    console.log(`message list: items and current ${listShape}; ↓ Enter goes to question 3 ${listJump}; Esc closes ${escCloses}; click elsewhere closes ${outsideCloses}`);
    if (!listShape || !listJump || !escCloses || !outsideCloses) process.exitCode = 1;
    scroller.scrollTop = 460;
    nav.update();
    const navOk =
      wired &&
      barText === 'question 2' &&
      navLog.join(',') === '460,60,460,860,1260,1600' &&
      hiddenAtMessage &&
      keptOnHover &&
      nav.shownText() === '';
    console.log(
      `message navigation: wired ${wired}; bar "${barText}"; steps ${navLog.join(',')} (expected 460,60,460,860,1260,1600); hidden at a message ${hiddenAtMessage}; kept on hover ${keptOnHover} -> ${navOk}`,
    );
    if (!navOk) process.exitCode = 1;
    nav.destroy();
    navHost.remove();




    // Find in chat: hidden text is skipped; Enter and Shift+Enter move; Esc closes.
    const findHost = document.createElement('div');
    const findRoot = findHost.appendChild(document.createElement('div'));
    findRoot.appendChild(document.createElement('p')).textContent = 'Alpha beta';
    findRoot.appendChild(document.createElement('p')).textContent = 'beta gamma BETA';
    const hiddenText = findRoot.appendChild(document.createElement('p'));
    hiddenText.textContent = 'beta';
    hiddenText.style.display = 'none';
    document.body.appendChild(findHost);
    const rangeCount = findRanges(findRoot, 'Beta').length;
    // Layout for the scroll: a 400 px tall chat; a match's line sits 10 px lower per character of offset.
    findRoot.getBoundingClientRect = () => ({ top: 0, height: 400 }) as DOMRect;
    const RangeProto = dom.window.Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect };
    RangeProto.getBoundingClientRect = function (this: Range) {
      return { top: 1000 + this.startOffset * 10 - findRoot.scrollTop, height: 10 } as DOMRect;
    };
    const bar = new FindBar(findHost, findRoot, findRoot);
    bar.open();
    const findInput = findHost.querySelector('.vc-find-input') as HTMLInputElement;
    findInput.value = 'beta';
    findInput.dispatchEvent(new dom.window.Event('input'));
    const findStates = [bar.state()];
    const scrolls = [findRoot.scrollTop];
    const press = (keyName: string, shiftKey = false) =>
      findInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, shiftKey, cancelable: true }));
    press('Enter');
    findStates.push(bar.state());
    scrolls.push(findRoot.scrollTop);
    press('Enter', true);
    findStates.push(bar.state());
    scrolls.push(findRoot.scrollTop);
    // Matches 2 and 3 share one text node, as in a long message; each is centred on its own line.
    press('Enter');
    press('Enter');
    scrolls.push(findRoot.scrollTop);
    press('Escape');
    delete RangeProto.getBoundingClientRect;
    const findOk =
      rangeCount === 3 &&
      findStates.map((s) => `${s.current}/${s.count}`).join(' ') === '1/3 2/3 1/3' &&
      scrolls.join(',') === '865,805,865,915' &&
      !bar.isOpen() &&
      bar.state().count === 0;
    console.log(`find in chat: ${findStates.map((s) => `${s.current}/${s.count}`).join(' ')}, scroll ${scrolls.join(',')} (expected 865,805,865,915), closed by Esc: ${!bar.isOpen()} -> ${findOk}`);
    if (!findOk) process.exitCode = 1;
    // Matches that appear after a query found none: the first Enter lands on the first of them.
    const lateRoot = findHost.createDiv();
    const lateBar = new FindBar(findHost, lateRoot, lateRoot);
    lateBar.open();
    const lateInput = findHost.querySelectorAll<HTMLInputElement>('.vc-find-input')[1];
    lateInput.value = 'gamma';
    lateInput.dispatchEvent(new dom.window.Event('input'));
    lateRoot.createDiv({ text: 'gamma and gamma' });
    lateInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    const lateOk = JSON.stringify(lateBar.state()) === JSON.stringify({ count: 2, current: 1, hidden: 0 });
    console.log(`find's first step after matches appear: ${JSON.stringify(lateBar.state())} -> ${lateOk}`);
    if (!lateOk) process.exitCode = 1;
    lateBar.close();
    findHost.remove();


    // Plan usage with the time left until each window resets.
    const hour = 3_600_000;
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    (view as unknown as { renderPlanUsage(usage: unknown): void }).renderPlanUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 4, resets_at: at(2 * hour + 600_000) },
        seven_day: { utilization: 51, resets_at: at(3 * 24 * hour + 8 * hour) },
        model_scoped: [{ display_name: 'Fable', utilization: 82, resets_at: at(3 * 24 * hour + 8 * hour) }],
      },
    });
    const planLine = root.querySelector('.vc-meter-plan')?.textContent;
    // Only the figure near its limit (82%) is coloured.
    const figureLevels = [...root.querySelectorAll('.vc-meter-plan .vc-meter-figure')].map((el) => el.className.replace('vc-meter-figure ', '')).join(',');
    console.log(`plan line: ${planLine}; colours: ${figureLevels} (expected is-normal,is-normal,is-warning)`);
    if (planLine !== '4%(2h) - 51%(3d) - 82%(3d)' || figureLevels !== 'is-normal,is-normal,is-warning') process.exitCode = 1;

    // The hover card, from the structured fields the usage call returns (as read on 2026-09-15).
    plugin.planUsage = {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 4, resets_at: at(2 * hour) },
        seven_day: { utilization: 51, resets_at: at(80 * hour) },
        limits: [
          { kind: 'session', percent: 4, severity: 'normal', resets_at: at(2 * hour), scope: null },
          { kind: 'weekly_all', percent: 51, severity: 'normal', resets_at: at(80 * hour), scope: null },
          { kind: 'weekly_scoped', percent: 82, severity: 'warning', resets_at: at(80 * hour), scope: { model: { display_name: 'Fable' } } },
        ],
        spend: {
          used: { amount_minor: 861, currency: 'USD', exponent: 2 },
          limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
          enabled: false,
          disabled_reason: 'out_of_credits',
        },
        seven_day_breakdown: { rows: [ { display_name: 'Claude Code', percent: 99 }, { display_name: 'Chats', percent: 1 }, { display_name: 'Cowork', percent: 0 } ] },
      },
    } as never;
    plugin.planFetchedAt = Date.now();
    const meter = root.querySelector('.vc-meter') as HTMLElement;
    meter.dispatchEvent(new dom.window.Event('mouseenter'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const card = root.querySelector('.vc-usage-card') as HTMLElement;
    const cardText = card.textContent ?? '';
    const cardOk =
      card.isShown() &&
      cardText.includes('Plan usage · Max') &&
      cardText.includes('Session (5 hours)4%') &&
      cardText.includes('All models, this week51%') &&
      cardText.includes('Fable, this week82%') &&
      card.querySelectorAll('.vc-usage-row.is-warning').length === 1 &&
      cardText.includes('This week by product: Claude Code 99%, Chats 1%') &&
      cardText.includes('Extra usage: $8.61 of $100.00 · off (out of credits)') &&
      cardText.includes('3d left');
    meter.dispatchEvent(new dom.window.Event('mouseleave'));
    console.log(`usage card: ${cardOk}; hidden after leaving: ${!card.isShown()}`);
    if (!cardOk || card.isShown()) {
      console.log(cardText);
      process.exitCode = 1;
    }

    // History search: pinned first; titles, then prompt and reply text with a snippet.
    const items = [
      { id: '1', title: 'Garden chat', updatedAt: 2, fromPanel: true },
      { id: '2', title: 'Other chat', updatedAt: 1, fromPanel: true, pinned: true },
    ];
    const texts: Record<string, string> = { '1': 'We discussed apples at length.', '2': 'Bananas, and the yield curve of the orchard.' };
    const picked: string[] = [];
    const historyActions = {
      pick: (item: { id: string }, newTab: boolean) => void picked.push(`${item.id}${newTab ? ' new tab' : ''}`),
      togglePin: () => true,
      stopTasks: () => undefined,
      rename: () => undefined,
      remove: async () => true,
      searchText: async (item: { id: string }) => texts[item.id],
      noteLinks: () => ({ changed: {}, sent: {}, mentioned: {} }),
      openNote: () => undefined,
    };
    /** Rows as ids: a chat's id (with how it is linked to the note above it), else the note's path. */
    type Row = Awaited<ReturnType<InstanceType<typeof HistoryModal>['getSuggestions']>>[number];
    const rowIds = (rows: Row[]) => rows.map((row) => (row.kind === 'chat' ? `${row.item.id}${row.why ? ` ${row.why}` : ''}` : `${row.kind} ${row.note.path}`));
    const modal = new HistoryModal({} as never, null, Promise.resolve(items), historyActions);
    const order = rowIds(await modal.getSuggestions('')).join(',');
    // The texts are read from the moment the history opens.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const byTitle = rowIds(await modal.getSuggestions('garden')).join(',');
    const byText = await modal.getSuggestions('yield curve');
    const snippet = byText[0]?.kind === 'chat' ? byText[0].snippet : undefined;
    console.log(`history: order ${order} (expected 2,1); "garden" -> ${byTitle} (expected 1); "yield curve" -> ${rowIds(byText).join()}: ${snippet}`);
    if (order !== '2,1' || byTitle !== '1' || byText.length !== 1 || !snippet?.includes('yield curve')) process.exitCode = 1;
    // A session started outside the panel reads muted; the panel's own and the scratch chat do not.
    const rowClass = (item: object) => {
      const row = document.createElement('div');
      modal.renderSuggestion({ kind: 'chat', item: { id: 'x', title: 'X', updatedAt: 1, ...item } } as never, row);
      return row.classList.contains('is-outside');
    };
    const mutedOk = rowClass({ fromPanel: false }) && !rowClass({ fromPanel: true }) && !rowClass({ fromPanel: true, scratch: true });
    // Where a chat comes from: started outside the panel, and how often copied, or a copy of one.
    const rowMeta = (item: object) => {
      const row = document.createElement('div');
      modal.renderSuggestion({ kind: 'chat', item: { id: 'x', title: 'X', updatedAt: 1, ...item } } as never, row);
      return row.querySelector('.vc-muted')?.textContent?.replace(/^\S+ \S+/, '') ?? '';
    };
    const copyRows = [
      rowMeta({ fromPanel: false, copies: [{}, {}] }),
      rowMeta({ fromPanel: false, copies: [{}] }),
      rowMeta({ fromPanel: false }),
      rowMeta({ fromPanel: true, copied: true }),
      rowMeta({ fromPanel: true }),
    ];
    const copyRowsOk =
      JSON.stringify(copyRows) ===
      JSON.stringify([' · outside the panel, opens as a copy · copied 2 times', ' · outside the panel, opens as a copy · copied once', ' · outside the panel, opens as a copy', ' · copy of a chat from outside the panel', '']);
    console.log(`copies in the history: ${JSON.stringify(copyRows)} -> ${copyRowsOk}`);
    if (!copyRowsOk) process.exitCode = 1;
    // Titles show at once while the texts are still being read; the search runs again once they are in.
    let release: () => void = () => undefined;
    const slowRead = new Promise<void>((resolve) => (release = resolve));
    const slow = new HistoryModal({} as never, items, Promise.resolve(null), {
      ...historyActions,
      searchText: async (item: { id: string }) => {
        await slowRead;
        return texts[item.id];
      },
    });
    const slowInput = (slow as unknown as { inputEl: { value: string; inputs: number } }).inputEl;
    slowInput.value = 'chat';
    const early = rowIds(await slow.getSuggestions('chat')).join(',');
    const rerunsBefore = slowInput.inputs;
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const later = rowIds(await slow.getSuggestions('yield curve')).join(',');
    const titlesFirst = early === '2,1' && slowInput.inputs > rerunsBefore && later === '2';
    console.log(`history search: titles at once ${early}, run again once the texts are in ${slowInput.inputs > rerunsBefore}, then text matches ${later} -> ${titlesFirst}`);
    if (!titlesFirst) process.exitCode = 1;
    console.log(`outside sessions muted in the history: ${mutedOk}`);
    if (!mutedOk) process.exitCode = 1;
    // Chats by note: Tab types "with:"; the notes whose path matches, newest first, with their chats
    // beneath, three at a time; Enter on "+N more" shows the rest, ⌘↵ on a note opens it.
    {
      const chats = [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, title: `Chat ${n}`, updatedAt: n, fromPanel: true }));
      const pruning = 'Projects/Orchard/Threads/Pruning.md';
      const opened: string[] = [];
      const byNote = new HistoryModal({} as never, chats, Promise.resolve(null), {
        ...historyActions,
        noteLinks: () => ({
          changed: { [pruning]: ['c4', 'c3', 'c1', 'c2', 'gone'] },
          sent: { [pruning]: ['c5', 'c4'], 'Reading/Novels.md': ['c2'] },
          mentioned: { [pruning]: ['c5'], 'Timeline — Garden.md': ['c3'] },
        }),
        openNote: (path: string) => void opened.push(path),
      });
      const keys = byNote as unknown as { scope: { keys: { key: string; run(evt: unknown): unknown }[] }; inputEl: { value: string }; instructions: { command: string }[] };
      await byNote.getSuggestions('');
      const chatKeys = keys.instructions.map((key) => key.command).join(' ');
      // The Tab hint is a button that switches views too.
      (byNote as unknown as { modalEl: HTMLElement }).modalEl.querySelector<HTMLElement>('.vc-history-switch')?.click();
      const clicked = keys.inputEl.value;
      keys.inputEl.value = 'orchard';
      keys.scope.keys.find((key) => key.key === 'Tab')?.run({});
      const tabbed = keys.inputEl.value;
      const orchard = await byNote.getSuggestions('with:orchard');
      const noteKeys = keys.instructions.map((key) => key.command).join(' ');
      const all = rowIds(await byNote.getSuggestions('with:')).filter((row) => row.startsWith('note'));
      byNote.selectSuggestion(orchard[orchard.length - 1], {} as never);
      const expanded = rowIds(await byNote.getSuggestions('with:orchard'));
      stub.Keymap.isModEvent = () => true;
      byNote.selectSuggestion(orchard[0], {} as never);
      // A chat with ⌘ opens in a new tab; without, here.
      byNote.selectSuggestion(orchard[1], {} as never);
      stub.Keymap.isModEvent = () => false;
      byNote.selectSuggestion(orchard[2], {} as never);
      const notesOk =
        chatKeys === '↵ ⌘ ↵ tab' &&
        clicked === 'with:' &&
        noteKeys === '↵ ⌘ ↵ tab' &&
        tabbed === 'with:orchard' &&
        rowIds(orchard).join() === `note ${pruning},c5 sent,c4 changed,c3 changed,more ${pruning}` &&
        all.join() === `note ${pruning},note Timeline — Garden.md,note Reading/Novels.md` &&
        rowIds(await byNote.getSuggestions('with:timeline')).join() === 'note Timeline — Garden.md,c3 mentioned' &&
        rowIds(await byNote.getSuggestions('With:orchard 5')).join() === `note ${pruning},c5 sent` &&
        // Every word in the path: all its chats, the note having been opened out above.
        rowIds(await byNote.getSuggestions('with:threads pruning')).length === 6 &&
        expanded.join() === `note ${pruning},c5 sent,c4 changed,c3 changed,c2 changed,c1 changed` &&
        JSON.stringify(opened) === JSON.stringify([pruning]) &&
        picked.join() === 'c5 new tab,c4';
      console.log(`chats by note: tab ${tabbed}; ${rowIds(orchard).join(' | ')}; all notes ${all.join(' | ')}; after "+N more" ${expanded.length - 1} chats; opened ${opened} -> ${notesOk}`);
      if (!notesOk) process.exitCode = 1;
    }
    // The chats as last listed show at once; a new listing replaces them only if something changed.
    let listNow: (value: typeof items) => void = () => undefined;
    const quick = new HistoryModal({} as never, [items[0]], new Promise((resolve) => (listNow = resolve)), historyActions);
    const atOnce = rowIds(await quick.getSuggestions('')).join(',');
    listNow(items);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const relisted = rowIds(await quick.getSuggestions('')).join(',');
    const reruns = (quick as unknown as { inputEl: { inputs: number } }).inputEl.inputs;
    const same = new HistoryModal({} as never, items, Promise.resolve(items.map((item) => ({ ...item }))), historyActions);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const untouched = (same as unknown as { inputEl: { inputs: number } }).inputEl.inputs === 0;
    const quickOk = atOnce === '1' && relisted === '2,1' && reruns === 1 && untouched;
    console.log(`history shown at once ${atOnce}, then ${relisted} after the listing (${reruns} redraw); an unchanged listing redraws nothing ${untouched} -> ${quickOk}`);
    if (!quickOk) process.exitCode = 1;

    // Tab state: working, then finished while hidden, then cleared once seen.
    const tab = view as unknown as {
      busy: boolean;
      unseen: string | null;
      isOnScreen(): boolean;
      markSeen(): void;
      leaf: { tabHeaderEl?: HTMLElement; updateHeader?: () => void };
    };
    const tabHeader = document.createElement('div');
    let headerUpdates = 0;
    tab.leaf.tabHeaderEl = tabHeader;
    tab.leaf.updateHeader = () => void (headerUpdates += 1);
    const states: string[] = [];
    const record = () => states.push(`${view.getIcon()}/${view.getDisplayText()}/${tabHeader.className}`);
    tab.busy = true;
    (view as unknown as { updateTab(): void }).updateTab();
    record();
    tab.busy = false;
    tab.isOnScreen = () => false;
    tab.unseen = 'done';
    (view as unknown as { updateTab(): void }).updateTab();
    record();
    tab.isOnScreen = () => true;
    tab.markSeen();
    record();
    console.log(`tab states: ${states.join(' | ')}; header updates: ${headerUpdates}`);
    const tabOk =
      states[0].startsWith('loader/') && states[0].includes('(working)') && states[0].endsWith('vc-tab-working') &&
      states[1].startsWith('check/') && states[1].includes('(finished)') && states[1].endsWith('vc-tab-done') &&
      states[2].startsWith('bot/') && !states[2].includes('(') && states[2].endsWith('/');
    if (!tabOk) process.exitCode = 1;

    // Esc in the panel stops a working chat.
    let interrupted = false;
    const live = view as unknown as { busy: boolean; session: unknown };
    live.busy = true;
    live.session = { interrupt: async () => void (interrupted = true) };
    root.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    console.log(`Esc stopped the turn: ${interrupted}`);
    if (!interrupted) process.exitCode = 1;
    live.busy = false;
    live.session = null;

    // System notifications only while Obsidian is not in front.
    const notified: string[] = [];
    g.Notification = class {
      onclick: (() => void) | null = null;
      constructor(title: string) {
        notified.push(title);
      }
      close(): void {}
    };
    const doc = dom.window.document as unknown as { hasFocus: () => boolean };
    const notify = (view as unknown as { systemNotify(title: string, body: string): void }).systemNotify.bind(view);
    doc.hasFocus = () => true;
    notify('in front', 'x');
    doc.hasFocus = () => false;
    notify('behind', 'x');
    console.log(`notifications: ${notified.join(', ')} (expected behind)`);
    if (notified.join(',') !== 'behind') process.exitCode = 1;

    // Checkboxes in replies: ticks saved per chat and reply, shown again when the reply is re-rendered, carried by Copy.
    const { applyTicks } = await import('../src/chatText');
    const applied = applyTicks('- [ ] a\n```\n- [ ] code\n```\n> - [x] b\n1. [ ] c', new Set([0, 1]));
    const applyOk = applied === '- [x] a\n```\n- [ ] code\n```\n> - [ ] b\n1. [ ] c';
    const tickView = view as unknown as { chatId: string | null };
    tickView.chatId = 'chat-ticks';
    const tickTranscript = [entry('u30', 'user', 'list'), entry('a30', 'assistant', [{ type: 'text', text: 'Steps:\n- [ ] one\n- [x] two\n- [ ] three' }])];
    internals.messagesEl.empty();
    internals.renderTranscript(tickTranscript);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let boxes = [...root.querySelectorAll<HTMLInputElement>('.vc-messages input.task-list-item-checkbox')];
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new dom.window.Event('change'));
    boxes[1].checked = false;
    boxes[1].dispatchEvent(new dom.window.Event('change'));
    const stored = JSON.stringify(plugin.ticks);
    internals.messagesEl.empty();
    internals.renderTranscript(tickTranscript);
    await new Promise((resolve) => setTimeout(resolve, 0));
    boxes = [...root.querySelectorAll<HTMLInputElement>('.vc-messages input.task-list-item-checkbox')];
    const restored = boxes.map((box) => box.checked).join(',');
    const copyButtons = root.querySelectorAll<HTMLElement>('.vc-messages .vc-turn-actions button[aria-label="Copy reply"]');
    copyButtons[copyButtons.length - 1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ticksOk =
      applyOk && stored === '{"chat-ticks":{"a30":[0,1]}}' && restored === 'true,false,false' && copied === 'Steps:\n- [x] one\n- [ ] two\n- [ ] three';
    console.log(`reply checkboxes: stored ${stored}, restored ${restored}, copied ${JSON.stringify(copied)}, applyTicks ${applyOk} -> ${ticksOk}`);
    if (!ticksOk) process.exitCode = 1;
    tickView.chatId = null;

    // A thinking line, from a transcript.
    internals.messagesEl.empty();
    internals.renderTranscript([
      entry('u9', 'user', 'plan it'),
      entry('a9', 'assistant', [{ type: 'thinking', thinking: 'Plan the steps first.' }, { type: 'text', text: 'Planned.' }]),
    ]);
    const thinkingLine = root.querySelector('.vc-thinking .vc-tools-text')?.textContent;
    console.log(`thinking line: "${thinkingLine}"`);
    if (thinkingLine !== 'Thinking: Plan the steps first.') process.exitCode = 1;

    // The approval card previews an edit as a line diff: unchanged lines once, changed ones marked.
    const detailHost = document.createElement('div');
    (view as unknown as { renderPermissionDetail(el: HTMLElement, request: unknown): void }).renderPermissionDetail(detailHost, {
      toolName: 'Edit',
      input: { file_path: '/tmp/Note.md', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' },
      signal: new AbortController().signal,
    });
    const detailLines = [...detailHost.querySelectorAll('.vc-diff > div')].map((el) => `${el.className}:${el.textContent}`).join(' | ');
    const detailOk = detailLines === 'vc-diff-same:  a | vc-diff-del:\u2212 b | vc-diff-ins:+ B | vc-diff-same:  c | vc-diff-ins:+ d';
    console.log(`approval card diff: ${detailLines} -> ${detailOk}`);
    if (!detailOk) process.exitCode = 1;
    // Claude's multiple-choice questions: answered in a card, the answers going back as the tool's input.
    {
      const askView = view as unknown as { askPermission(request: unknown): Promise<{ behavior: string; updatedInput?: { answers?: Record<string, string> }; message?: string }> };
      const fruit = { question: 'Which fruit do you prefer?', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple', description: 'Crisp' }, { label: 'Banana', description: 'Soft', preview: 'a sketch' }] };
      const extras = { question: 'Which extras?', header: 'Extras', multiSelect: true, options: [{ label: 'Nuts', description: '' }, { label: 'Honey', description: '' }, { label: 'Yogurt', description: '' }] };
      const drawState = view as unknown as { draw: { turn: HTMLElement | null } };
      const ask = (questions: unknown[], signal = new AbortController().signal) => {
        internals.messagesEl.empty();
        drawState.draw.turn = null;
        const answered = askView.askPermission({ toolName: 'AskUserQuestion', input: { questions }, signal });
        return { answered, card: internals.messagesEl.querySelector('.vc-question-card') as HTMLElement };
      };
      const option = (card: HTMLElement, label: string) => [...card.querySelectorAll<HTMLElement>('.vc-question-option')].find((el) => el.querySelector('.vc-question-label')?.textContent === label);
      // One question, one answer: a click answers it.
      const one = ask([fruit]);
      const oneTitle = one.card.querySelector('.vc-permission-title')?.textContent;
      option(one.card, 'Banana')?.click();
      const oneResult = await one.answered;
      const oneDecided = internals.messagesEl.querySelector('.vc-permission.is-decided')?.textContent;
      // Two questions, one of several answers: Send waits for both; several picks and one's own answer are joined.
      const two = ask([fruit, extras]);
      const send = [...two.card.querySelectorAll('button')].find((el) => el.textContent === 'Send') as HTMLButtonElement;
      option(two.card, 'Banana')?.click();
      const previewShown = (two.card.querySelector('.vc-question-preview') as HTMLElement).isShown();
      const disabledWithOne = send.disabled;
      option(two.card, 'Nuts')?.click();
      option(two.card, 'Yogurt')?.click();
      const own = two.card.querySelectorAll<HTMLInputElement>('.vc-question-own')[1];
      own.value = 'Cinnamon';
      own.dispatchEvent(new dom.window.Event('input'));
      const enabledWithBoth = !send.disabled;
      send.click();
      const twoResult = await two.answered;
      // Skipped, or cancelled by Claude Code: refused, and the card says so.
      const skip = ask([fruit]);
      ([...skip.card.querySelectorAll('button')].find((el) => el.textContent === 'Skip') as HTMLElement).click();
      const skipped = await skip.answered;
      const controller = new AbortController();
      const cancel = ask([fruit], controller.signal);
      controller.abort();
      const cancelled = await cancel.answered;
      // Questions the card cannot read are refused at once, so that Claude asks in plain text.
      const malformed = ask(['not a question']);
      const malformedResult = await malformed.answered;
      internals.messagesEl.empty();
      drawState.draw.turn = null;
      const questionsOk =
        oneTitle === 'Claude has a question' &&
        oneResult.behavior === 'allow' &&
        JSON.stringify(oneResult.updatedInput?.answers) === JSON.stringify({ 'Which fruit do you prefer?': 'Banana' }) &&
        oneDecided === 'Answered: Fruit → Banana' &&
        previewShown &&
        disabledWithOne &&
        enabledWithBoth &&
        JSON.stringify(twoResult.updatedInput?.answers) === JSON.stringify({ 'Which fruit do you prefer?': 'Banana', 'Which extras?': 'Nuts, Yogurt, Cinnamon' }) &&
        skipped.behavior === 'deny' &&
        cancelled.behavior === 'deny' &&
        malformedResult.behavior === 'deny' &&
        malformedResult.message === 'The panel could not show these questions. Ask them in plain text instead.';
      console.log(
        `questions: "${oneTitle}" answered ${JSON.stringify(oneResult.updatedInput?.answers)}, "${oneDecided}"; two ${JSON.stringify(twoResult.updatedInput?.answers)} (send waited ${disabledWithOne}, preview ${previewShown}); skipped ${skipped.behavior}, cancelled ${cancelled.behavior} -> ${questionsOk}`,
      );
      if (!questionsOk) process.exitCode = 1;
    }
    // An approval drawn, sent to the background with its chat, drawn again and answered leaves no
    // listener on its request's signal.
    {
      const listening = new Set<unknown>();
      const signal = new AbortController().signal;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((type: string, listener: () => void, options?: AddEventListenerOptions) => {
        listening.add(listener);
        add(type, listener, options);
      }) as typeof signal.addEventListener;
      signal.removeEventListener = ((type: string, listener: () => void) => {
        listening.delete(listener);
        remove(type, listener);
      }) as typeof signal.removeEventListener;
      const tripView = view as unknown as {
        askPermission(request: unknown): Promise<{ behavior: string }>;
        adoptApproval(entry: { approvals: unknown[] }, approval: unknown): void;
        renderApprovalCard(approval: unknown): void;
        openApprovals: unknown[];
        draw: { turn: HTMLElement | null };
      };
      internals.messagesEl.empty();
      tripView.draw.turn = null;
      const asked = tripView.askPermission({ toolName: 'Bash', input: { command: 'ls' }, signal });
      const approval = tripView.openApprovals[tripView.openApprovals.length - 1];
      tripView.openApprovals = tripView.openApprovals.filter((open) => open !== approval);
      tripView.adoptApproval({ approvals: [] }, approval);
      internals.messagesEl.empty();
      tripView.draw.turn = null;
      tripView.renderApprovalCard(approval);
      const whileOpen = listening.size;
      ([...internals.messagesEl.querySelectorAll('button')].find((el) => el.textContent === 'Allow') as HTMLElement).click();
      const answer = await asked;
      internals.messagesEl.empty();
      tripView.draw.turn = null;
      // Drawn twice without the newChat or showChat that resets it in the panel: reset here.
      (view as unknown as { pendingApprovals: number }).pendingApprovals = 0;
      const tripOk = whileOpen === 2 && listening.size === 0 && answer.behavior === 'allow';
      console.log(`approval listeners after a background round trip: ${whileOpen} while open, ${listening.size} once answered -> ${tripOk}`);
      if (!tripOk) process.exitCode = 1;
    }
    // Claude's plan: approved as it is, approved as edited in a note (which then goes), sent back with
    // feedback, or rejected.
    {
      type Answer = { behavior: string; updatedInput?: { plan?: string }; message?: string; updatedPermissions?: unknown };
      const planView = view as unknown as { askPermission(request: unknown): Promise<Answer>; draw: { turn: HTMLElement | null } };
      const vault = app.vault as unknown as Record<string, unknown>;
      vault.create = async (path: string, text: string) => {
        notesOnDisk.set(path, text);
        return Object.assign(new stub.TFile(), { path, basename: path.split('/').pop()?.replace(/\.md$/, ''), extension: 'md' });
      };
      vault.createFolder = async () => undefined;
      const plan = '## Steps\n\n1. List the notes.\n2. Summarise them.';
      const propose = (signal = new AbortController().signal) => {
        internals.messagesEl.empty();
        planView.draw.turn = null;
        const answered = planView.askPermission({ toolName: 'ExitPlanMode', input: { plan, planFilePath: '/tmp/plan.md' }, signal });
        const card = internals.messagesEl.querySelector('.vc-plan-card') as HTMLElement;
        const button = (text: string) => [...card.querySelectorAll('button')].find((el) => el.textContent === text) as HTMLElement;
        return { answered, card, button };
      };
      const decided = () => internals.messagesEl.querySelector('.vc-permission.is-decided')?.textContent;
      const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
      // Approved in Plan mode entered from Auto: back to Auto, and Claude Code is told so.
      const modeView = view as unknown as { mode: string; modeBeforePlan: string };
      const modeWas = { mode: modeView.mode, before: modeView.modeBeforePlan };
      Object.assign(modeView, { mode: 'plan', modeBeforePlan: 'auto' });
      const fromAuto = propose();
      fromAuto.button('Approve').click();
      const fromAutoResult = (await fromAuto.answered) as Answer & { updatedPermissions?: { type: string; mode: string }[] };
      const backTo = modeView.mode;
      Object.assign(modeView, modeWas);
      // As it is.
      const plain = propose();
      const planTitle = plain.card.querySelector('.vc-permission-title')?.textContent;
      // Styled as any rendered Markdown (its tables, say).
      const planMarkdown = plain.card.querySelector('.vc-plan')?.classList.contains('vc-markdown') === true;
      plain.button('Approve').click();
      const plainResult = await plain.answered;
      const plainSaid = decided();
      // Edited in a note: the note's text is the plan, and the note goes.
      const edited = propose();
      edited.button('Edit in a note').click();
      await settle();
      const notePath = [...notesOnDisk.keys()].find((path) => path.includes('/Plans/'));
      const opened = openedFiles.some((entry) => entry.path === notePath);
      const relabelled = edited.button('Open the plan note') !== undefined;
      if (notePath) notesOnDisk.set(notePath, `${plan}\n3. Say PINEAPPLE.`);
      edited.button('Approve').click();
      const editedResult = await edited.answered;
      const editedSaid = decided();
      const noteGone = notePath !== undefined && !notesOnDisk.has(notePath) && trashed.includes(notePath);
      // The first answer holds: Approve then at once Reject approves, with the edits; and a note that is
      // renamed while edited is still the plan.
      const raced = propose();
      raced.button('Edit in a note').click();
      await settle();
      const racedOld = [...notesOnDisk.keys()].find((path) => path.includes('/Plans/')) ?? '';
      const racedNew = racedOld.replace('/Plans/', '/Plans/Renamed ');
      notesOnDisk.set(racedNew, `${plan}\n3. Renamed and edited.`);
      notesOnDisk.delete(racedOld);
      (view as unknown as { followNote(from: string, to: string | null): void }).followNote(racedOld, racedNew);
      raced.button('Approve').click();
      raced.button('Reject').click();
      const racedResult = await raced.answered;
      const racedNoteGone = !notesOnDisk.has(racedNew);
      // A plan refused without its card (its chat dropped from the background) takes its note too.
      notesOnDisk.set('Claude chats/Plans/Dropped.md', plan);
      plugin.planNotes['dropped-chat'] = { path: 'Claude chats/Plans/Dropped.md', plan: 'other' };
      void (view as unknown as { withdrawPlanNote(approval: { notePath: string | null; chatKey: string }, keep: boolean): Promise<void> }).withdrawPlanNote(
        { notePath: 'Claude chats/Plans/Dropped.md', chatKey: 'dropped-chat' },
        false,
      );
      await settle();
      const droppedGone = !notesOnDisk.has('Claude chats/Plans/Dropped.md') && plugin.planNotes['dropped-chat'] === undefined;
      // Withdrawn (Esc) with edits in its note: the note stays for the chat's next plan, whose card says so
      // and whose Approve sends the edits; unedited, it goes. "Use Claude's plan instead" drops it.
      const keepChat = view as unknown as { chatId: string | null; interrupted: boolean };
      const chatWas = keepChat.chatId;
      keepChat.chatId = 'plan-chat';
      const firstController = new AbortController();
      const first = propose(firstController.signal);
      first.button('Edit in a note').click();
      await settle();
      const keptPath = [...notesOnDisk.keys()].find((path) => path.includes('/Plans/')) ?? '';
      notesOnDisk.set(keptPath, `${plan}\n3. Kept across Esc.`);
      keepChat.interrupted = true;
      firstController.abort();
      await first.answered;
      keepChat.interrupted = false;
      await settle();
      // Kept in the plugin's data, so that a restart or the chat's deletion finds it.
      const keptAfterEsc = notesOnDisk.has(keptPath) && plugin.planNotes['plan-chat']?.path === keptPath;
      const next = propose();
      const carriedLine = next.card.querySelector('.vc-plan-carried')?.textContent ?? '';
      const carriedButton = next.button('Open the plan note') !== undefined;
      next.button('Approve').click();
      const nextResult = await next.answered;
      const keptGoneAfter = !notesOnDisk.has(keptPath) && plugin.planNotes['plan-chat'] === undefined;
      // Again, but Claude's plan is chosen instead: the kept note goes, and the plan is sent as Claude wrote it.
      const againController = new AbortController();
      const again = propose(againController.signal);
      again.button('Edit in a note').click();
      await settle();
      const againPath = [...notesOnDisk.keys()].find((path) => path.includes('/Plans/')) ?? '';
      notesOnDisk.set(againPath, `${plan}\n3. Edited, then dropped.`);
      againController.abort();
      await again.answered;
      await settle();
      const instead = propose();
      (instead.card.querySelector('.vc-plan-carried .vc-welcome-link') as HTMLElement).click();
      await settle();
      const droppedNote = !notesOnDisk.has(againPath);
      instead.button('Approve').click();
      const insteadResult = await instead.answered;
      keepChat.chatId = chatWas;
      const keepOk =
        keptAfterEsc &&
        carriedLine.startsWith('Your edits to the plan you withdrew are in the plan note') &&
        carriedButton &&
        nextResult.updatedInput?.plan === `${plan}\n3. Kept across Esc.` &&
        keptGoneAfter &&
        droppedNote &&
        insteadResult.updatedInput?.plan === plan;
      console.log(`plan edits kept across Esc: kept ${keptAfterEsc}; next card "${carriedLine.slice(0, 60)}…" sends ${JSON.stringify(nextResult.updatedInput?.plan?.split('\n').pop())}, note gone after ${keptGoneAfter}; Claude's plan instead: note dropped ${droppedNote}, sends Claude's ${insteadResult.updatedInput?.plan === plan} -> ${keepOk}`);
      if (!keepOk) process.exitCode = 1;
      // Feedback, and Reject.
      const sentBack = propose();
      const feedbackBox = sentBack.card.querySelector('.vc-plan-feedback input') as HTMLInputElement;
      feedbackBox.value = 'Only the first step';
      sentBack.button('Send feedback').click();
      const feedbackResult = await sentBack.answered;
      const rejected = propose();
      rejected.button('Reject').click();
      const rejectResult = await rejected.answered;
      // Cancelled with a note open (Esc stopped the reply): the note goes too, and the card says the plan was withdrawn.
      const controller = new AbortController();
      const cancelled = propose(controller.signal);
      cancelled.button('Edit in a note').click();
      await settle();
      const cancelledNote = [...notesOnDisk.keys()].find((path) => path.includes('/Plans/'));
      const stopping = view as unknown as { interrupted: boolean };
      stopping.interrupted = true;
      controller.abort();
      await cancelled.answered;
      const withdrawnSaid = decided();
      stopping.interrupted = false;
      await settle();
      const cancelledGone = cancelledNote !== undefined && !notesOnDisk.has(cancelledNote);
      // A request without the plan's text, sent before Claude wrote its plan file: read from the file
      // once it is there, and nothing can be approved or edited until it is shown.
      const { mkdtempSync: makeTemp, mkdirSync: makeDir, writeFileSync: writeFile, rmSync: removeAll } = await import('fs');
      const { tmpdir: tempDir } = await import('os');
      const planConfig = makeTemp(`${tempDir()}/vc-plans-`);
      makeDir(`${planConfig}/plans`);
      const configBefore = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = planConfig;
      internals.messagesEl.empty();
      planView.draw.turn = null;
      const late = planView.askPermission({ toolName: 'ExitPlanMode', input: { plan: '', planFilePath: `${planConfig}/plans/late.md` }, signal: new AbortController().signal });
      const lateCard = internals.messagesEl.querySelector('.vc-plan-card') as HTMLElement;
      const lateButton = (text: string) => [...lateCard.querySelectorAll('button')].find((el) => el.textContent === text) as HTMLButtonElement;
      const lateBefore = { text: lateCard.querySelector('.vc-plan')?.textContent, approve: lateButton('Approve').disabled, edit: lateButton('Edit in a note').disabled };
      writeFile(`${planConfig}/plans/late.md`, '## Steps\n\n1. Written late.');
      await new Promise((resolve) => setTimeout(resolve, 700));
      const lateAfter = { text: lateCard.querySelector('.vc-plan')?.textContent, approve: lateButton('Approve').disabled };
      lateButton('Reject').click();
      await late;
      if (configBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = configBefore;
      removeAll(planConfig, { recursive: true, force: true });
      const lateOk =
        lateBefore.text === 'Reading the plan…' && lateBefore.approve && lateBefore.edit && lateAfter.text?.includes('Written late.') === true && !lateAfter.approve;
      console.log(`plan written after its request: before ${JSON.stringify(lateBefore)}; after ${JSON.stringify(lateAfter)} -> ${lateOk}`);
      if (!lateOk) process.exitCode = 1;
      delete vault.create;
      delete vault.createFolder;
      internals.messagesEl.empty();
      planView.draw.turn = null;
      const planOk =
        planTitle === "Claude's plan" &&
        planMarkdown &&
        plainResult.behavior === 'allow' &&
        plainResult.updatedInput?.plan === plan &&
        plainSaid === 'Plan approved' &&
        opened &&
        relabelled &&
        editedResult.updatedInput?.plan === `${plan}\n3. Say PINEAPPLE.` &&
        editedSaid === 'Plan approved, with your edits' &&
        noteGone &&
        feedbackResult.behavior === 'deny' &&
        feedbackResult.message === 'The user reviewed the plan and asks for changes: Only the first step' &&
        rejectResult.behavior === 'deny' &&
        cancelledGone &&
        withdrawnSaid === 'Plan withdrawn: you stopped the reply' &&
        backTo === 'auto' &&
        JSON.stringify(fromAutoResult.updatedPermissions) === JSON.stringify([{ type: 'setMode', mode: 'auto', destination: 'session' }]) &&
        plainResult.updatedPermissions === undefined &&
        racedResult.behavior === 'allow' &&
        racedResult.updatedInput?.plan === `${plan}\n3. Renamed and edited.` &&
        racedNoteGone &&
        droppedGone;
      console.log(
        `plan card: "${planTitle}"; as it is "${plainSaid}"; edited in ${notePath} (opened ${opened}) -> "${editedSaid}", note gone ${noteGone}; feedback ${feedbackResult.behavior} "${feedbackResult.message}"; reject ${rejectResult.behavior}; cancelled, note gone ${cancelledGone}, "${withdrawnSaid}"; Approve then Reject ${racedResult.behavior} with the renamed note's edits ${racedResult.updatedInput?.plan?.includes('Renamed and edited') === true}; dropped note gone ${droppedGone} -> ${planOk}`,
      );
      if (!planOk) process.exitCode = 1;
    }

    // "Send to Claude": a folder and a PDF become @ mentions after what is typed.
    const mentionInput = root.querySelector('.vc-input') as HTMLTextAreaElement;
    mentionInput.value = 'Compare';
    view.mentionItems([Object.assign(new stub.TFolder(), { path: 'Notes' }), Object.assign(new stub.TFile(), { path: 'paper.pdf', extension: 'pdf' })] as never);
    console.log(`send to Claude: ${JSON.stringify(mentionInput.value)} (expected "Compare @[[Notes/]] @[[paper.pdf]] ")`);
    if (mentionInput.value !== 'Compare @[[Notes/]] @[[paper.pdf]] ') process.exitCode = 1;
    mentionInput.value = '';

    // Find in chat opens above the messages.
    view.openFind();
    const findShown = (root.querySelector('.vc-find') as HTMLElement).isShown();
    console.log(`find bar opens: ${findShown}`);
    if (!findShown) process.exitCode = 1;

    // Edits as diffs: the patch from a live result, the input for a chat from history, a new file,
    // an unchanged write; one card of changed files per reply, a line per file, opening to its diffs.
    const { bashEditDiffs, editDiff, ChangesCard } = await import('../src/editDiff');
    type Diff = ReturnType<typeof editDiff>;
    const showDiff = (diff: Diff) => (diff ? diff.lines.map((line) => `${line.kind}${line.no ?? ''}:${line.text}`).join(' ') : 'null');
    const patched = editDiff('Edit', { file_path: '/tmp/Note.md', old_string: 'b', new_string: 'B' }, {
      structuredPatch: [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, lines: [' a', '-b', '+B', ' c'] }],
    });
    const fromInput = editDiff('Edit', { file_path: '/tmp/Note.md', old_string: 'one\ntwo\nthree', new_string: 'one\n2\nthree' });
    const createdFile = editDiff('Write', { file_path: '/tmp/New.md', content: 'x\ny\n' }, { type: 'create', structuredPatch: [] });
    const unchangedWrite = editDiff('Write', { file_path: '/tmp/New.md', content: 'x' }, { type: 'update', structuredPatch: [] });
    const multiEdit = editDiff('MultiEdit', { file_path: '/tmp/Note.md', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] });
    const diffShapes = [patched, fromInput, createdFile, unchangedWrite, multiEdit].map(showDiff);
    const expectedShapes = ['same3:a del4:b ins4:B same5:c', 'same:one del:two ins:2 same:three', 'ins1:x ins2:y', 'null', 'del:a ins:b gap: del:c ins:d'];
    const longDiff = editDiff('Write', { file_path: '/tmp/Long.md', content: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') });
    // The card: two edits to one note and a new file make two lines with combined counts; the
    // name is a link and leaves the diff closed; the line opens both edits, a gap between them.
    const cardHost = document.createElement('div');
    const changes = new ChangesCard(cardHost);
    const secondEdit = editDiff('Edit', { file_path: '/tmp/Note.md', old_string: 'c', new_string: 'C\nD' });
    for (const [diff, path] of [[patched, 'Note.md'], [secondEdit, 'Note.md'], [createdFile, 'New.md']] as const) if (diff) changes.add(diff, path);
    const rowText = (row: Element) =>
      [...row.querySelectorAll('.vc-edit-file, .vc-edit-added, .vc-edit-removed')].map((el) => el.textContent).filter(Boolean).join(' ');
    const changeRows = [...changes.el.querySelectorAll<HTMLElement>('.vc-changes-row')];
    const changesShape = `${changes.el.querySelector('.vc-changes-title')?.textContent} | ${changeRows.map(rowText).join(' | ')}`;
    (changeRows[0].querySelector('.vc-edit-file') as HTMLElement).click();
    const firstDiff = changes.el.querySelector('.vc-changes-diff') as HTMLElement;
    const nameLeavesClosed = !firstDiff.isShown();
    changeRows[0].click();
    const opensBoth = firstDiff.isShown() && firstDiff.querySelectorAll('.vc-edit-line').length === 7 && firstDiff.querySelectorAll('.vc-edit-gap').length === 1;
    // The header folds the list away and brings it back.
    const changesHeader = changes.el.querySelector('.vc-changes-header') as HTMLElement;
    changesHeader.click();
    const foldsOnClick = changes.el.hasClass('is-folded');
    changesHeader.click();
    const unfoldsOnClick = !changes.el.hasClass('is-folded');
    const cardShape = changesShape === '2 files changed | Note.md +3 −2 | New.md +2' && nameLeavesClosed && opensBoth && foldsOnClick && unfoldsOnClick;
    // An opened diff folds by height, not by line count: three wrapped 400-character lines fold, five short ones do not.
    const openedDiff = (diff: Diff, path: string) => {
      if (!diff) return null;
      const card = new ChangesCard(cardHost);
      card.add(diff, path);
      (card.el.querySelector('.vc-changes-row') as HTMLElement).click();
      return card.el.querySelector('.vc-changes-diff') as HTMLElement;
    };
    const wideDiff = editDiff('Write', { file_path: '/tmp/Wide.md', content: Array.from({ length: 3 }, () => 'word '.repeat(80)).join('\n') });
    const shortDiff = editDiff('Write', { file_path: '/tmp/Short.md', content: 'a\nb\nc\nd\ne' });
    const wideFolds = openedDiff(wideDiff, 'Wide.md')?.hasClass('is-collapsed') === true;
    const shortOpen = openedDiff(shortDiff, 'Short.md')?.hasClass('is-collapsed') === false;
    const longToggle = openedDiff(longDiff, 'Long.md')?.querySelector('.vc-edit-toggle')?.textContent === 'Show all (20 lines)';
    const foldByHeight = wideFolds && shortOpen && longToggle;
    console.log(`edit fold by height: long wrapped lines fold ${wideFolds}; short diff open ${shortOpen}; Show all on 20 lines ${longToggle}`);
    if (!foldByHeight) process.exitCode = 1;
    // A click on a line of a diff asks to open the file there; a removed line points at the line
    // kept after it. A file outside the vault (no vault path) has no such links.
    const lineOpens: string[] = [];
    const openLine = (path: string, text: string, hint: number | undefined) => void lineOpens.push(`${path}|${text}|${hint}`);
    const diffLines = (path: string | undefined) => {
      const card = new ChangesCard(cardHost, openLine);
      if (patched) card.add(patched, path);
      (card.el.querySelector('.vc-changes-row') as HTMLElement).click();
      return [...card.el.querySelectorAll<HTMLElement>('.vc-edit-line')];
    };
    const inVault = diffLines('Note.md');
    inVault[1]?.click();
    inVault[3]?.click();
    const outside = diffLines(undefined);
    outside[1]?.click();
    const lineLinks = lineOpens.join(' ; ') === 'Note.md|B|4 ; Note.md|c|5' && inVault[0]?.parentElement?.hasClass('is-linked') === true && !outside[0]?.parentElement?.hasClass('is-linked');
    console.log(`diff lines open the file there: ${lineOpens.join(' ; ')} -> ${lineLinks}`);
    if (!lineLinks) process.exitCode = 1;
    // Files changed by a Bash command (its bashEditDiff), and for a chat from history the structured
    // results read from the session file, which the SDK's transcript loader leaves out.
    const bashResult = { bashEditDiff: { files: [{ filePath: '/vault/dir/People.md', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] }] }] } };
    const bashShape = bashEditDiffs(bashResult).map(showDiff).join(' | ');
    const { loadChat } = await import('../src/history');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join: joinPath } = await import('path');
    const configDir = mkdtempSync(joinPath(tmpdir(), 'vc-config-'));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    mkdirSync(joinPath(configDir, 'projects', '-vault-dir'), { recursive: true });
    writeFileSync(
      joinPath(configDir, 'projects', '-vault-dir', 's1.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b9', content: 'ok' }] }, toolUseResult: bashResult }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'x' }] }, toolUseResult: { stdout: 'x' } }),
        '{"partial',
      ].join('\n'),
    );
    const loadedEdits = (await loadChat('s1', '/vault/dir')).edits;
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    const historyOk = bashShape === 'same1:a ins2:b' && loadedEdits.size === 1 && bashEditDiffs(loadedEdits.get('b9')).length === 1;
    // A compacted chat: the summary Claude Code stores as a user row is not one of your messages;
    // the boundary stays, as a system row, for the divider.
    const { loadTranscript } = await import('../src/history');
    const compactDir = mkdtempSync(joinPath(tmpdir(), 'vc-compact-'));
    const configBefore = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = compactDir;
    mkdirSync(joinPath(compactDir, 'projects', '-vault-dir'), { recursive: true });
    writeFileSync(
      joinPath(compactDir, 'projects', '-vault-dir', 'c1.jsonl'),
      [
        JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'a question' } }),
        JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b1' }),
        JSON.stringify({ type: 'user', uuid: 'u2', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued…' } }),
        JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] } }),
      ].join('\n'),
    );
    const compacted = await loadTranscript('c1', '/vault/dir');
    if (configBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = configBefore;
    const compactOk = compacted.map((row) => (row as { uuid?: string }).uuid).join(',') === 'u1,b1,a1';
    console.log(`compaction summary left out of the transcript: ${compacted.map((row) => (row as { uuid?: string }).uuid).join(',')} -> ${compactOk}`);
    if (!compactOk) process.exitCode = 1;
    console.log(`bash edits: ${bashShape}; read from the session file: ${loadedEdits.size} result(s) -> ${historyOk}`);
    if (!historyOk) process.exitCode = 1;
    const toolCalls = view as unknown as { draw: { turn: HTMLElement | null }; addTool(id: string, name: string, input: Record<string, unknown>): void; finishTool(id: string, isError: boolean, structured?: unknown): void };
    toolCalls.draw.turn = null;
    internals.messagesEl.empty();
    toolCalls.addTool('e1', 'Edit', { file_path: '/tmp/Note.md', old_string: 'a', new_string: 'b' });
    toolCalls.finishTool('e1', false);
    toolCalls.addTool('e2', 'Edit', { file_path: '/tmp/Note.md', old_string: 'c', new_string: 'd' });
    toolCalls.finishTool('e2', false);
    toolCalls.addTool('b1', 'Bash', { command: 'python3 edit.py' });
    toolCalls.finishTool('b1', false, bashResult);
    // Two Edit calls and a Bash command in one reply: one card, a line for each file.
    const liveCards = root.querySelectorAll('.vc-messages .vc-changes');
    const liveRows = liveCards[0] ? [...liveCards[0].querySelectorAll('.vc-changes-row')].map(rowText) : [];
    // Open while the reply runs; folded to its header once the reply is done.
    const openWhileRunning = liveCards[0] ? !liveCards[0].hasClass('is-folded') : false;
    const liveTurn = root.querySelector('.vc-messages .vc-turn') as HTMLElement;
    (view as unknown as { finishTurnActions(turn: HTMLElement): void }).finishTurnActions(liveTurn);
    const foldedWhenDone = liveCards[0]?.hasClass('is-folded') === true;
    const liveCardOk = liveCards.length === 1 && liveRows.join(' | ') === 'Note.md +2 −2 | /vault/dir/People.md +1' && openWhileRunning && foldedWhenDone;
    const diffsOk = diffShapes.join('|') === expectedShapes.join('|') && patched?.added === 1 && createdFile?.created === true && cardShape && liveCardOk;
    console.log(`edit diffs: ${diffShapes.join(' | ')}; card ${cardShape}; after an Edit call ${liveCardOk} -> ${diffsOk}`);
    if (!diffsOk) process.exitCode = 1;

    // Fast mode: the button shows for a model that supports it, lights when on, and turns amber
    // with the reason when the session reports fast mode is not running.
    const fastButton = root.querySelector('.vc-actions .vc-fast') as HTMLElement;
    const fastView = view as unknown as { populateModelSelect(): void; toggleFastMode(): Promise<void>; setFastState(state?: string, reason?: string): void };
    const hiddenWithoutModels = !fastButton.isShown();
    (plugin as { models: unknown[] }).models = [{ value: 'default', displayName: 'Default', description: '', supportsFastMode: true }];
    fastView.populateModelSelect();
    const shownForFastModel = fastButton.isShown();
    await fastView.toggleFastMode();
    const litWhenOn = fastButton.hasClass('is-on');
    fastView.setFastState('off', 'extra_usage_disabled');
    const amberWithReason = fastButton.hasClass('is-blocked') && (fastButton.getAttribute('aria-label') ?? '').includes('extra usage is turned off');
    const fastOk = hiddenWithoutModels && shownForFastModel && litWhenOn && amberWithReason;
    console.log(`fast mode button: hidden without models ${hiddenWithoutModels}; shown ${shownForFastModel}; lit ${litWhenOn}; amber with reason ${amberWithReason} -> ${fastOk}`);
    if (!fastOk) process.exitCode = 1;
    (plugin as { models: unknown[] }).models = [];

    // What a panel holds by path follows a move and goes with a deletion: the attached note, the
    // drafts of chats not started yet, and files in the tray; another note's change leaves them.
    const attachView = view as unknown as {
      attachedNote: string | null;
      localDrafts: Map<string, { text?: string; note?: string }>;
      attachments: { kind: string; name: string; path: string; text?: string; fromLine?: number; toLine?: number }[];
      followNote(from: string, to: string | null): void;
    };
    attachView.attachedNote = 'Folder/A.md';
    attachView.localDrafts.set('scratch', { text: 'kept text', note: 'Folder/B.md' });
    attachView.localDrafts.set('', { note: 'Folder/C.md' });
    attachView.attachments = [
      { kind: 'file', name: 'D.md', path: '/tmp/Folder/D.md' },
      { kind: 'file', name: 'My name', path: '/tmp/Folder/E.md' },
      { kind: 'file', name: 'outside.txt', path: '/elsewhere/outside.txt' },
      { kind: 'selection', name: 'F', path: 'Folder/F.md', fromLine: 1, toLine: 2, text: 'selected' },
    ];
    attachView.followNote('Folder', 'Moved');
    const afterMove = [
      attachView.attachedNote,
      attachView.localDrafts.get('scratch')?.note,
      attachView.localDrafts.get('')?.note,
      ...attachView.attachments.map((a) => `${a.name}@${a.path}`),
    ].join(' | ');
    attachView.followNote('Other.md', null);
    const afterOther = attachView.attachedNote;
    attachView.followNote('Moved', null);
    const afterDelete = [
      String(attachView.attachedNote),
      JSON.stringify(attachView.localDrafts.get('scratch')),
      attachView.localDrafts.has(''),
      attachView.attachments.map((a) => a.name).join(','),
    ].join(' | ');
    attachView.localDrafts.clear();
    attachView.attachments = [];
    const attachFollowOk =
      afterMove === 'Moved/A.md | Moved/B.md | Moved/C.md | D.md@/tmp/Moved/D.md | My name@/tmp/Moved/E.md | outside.txt@/elsewhere/outside.txt | F@Moved/F.md' &&
      afterOther === 'Moved/A.md' &&
      // A selection keeps its text when its note is deleted.
      afterDelete === 'null | {"text":"kept text"} | false | outside.txt,F';
    console.log(`a panel follows what it holds by path: moved "${afterMove}"; another deleted ${afterOther}; deleted "${afterDelete}" -> ${attachFollowOk}`);
    if (!attachFollowOk) process.exitCode = 1;

    // Quoting chat text into the input: a Markdown quote, a long selection cut at a word.
    const { quoteMarkdown } = await import('../src/chatText');
    const quoted = quoteMarkdown('First line\n\nSecond line');
    const cutQuote = quoteMarkdown(`${'word '.repeat(200)}end`, 40);
    const quoteView = view as unknown as { quoteText(text: string): void; inputEl: HTMLTextAreaElement };
    quoteView.inputEl.value = 'already typed';
    quoteView.quoteText('Some reply text');
    const inputAfter = quoteView.inputEl.value;
    const quoteOk =
      quoted === '> First line\n>\n> Second line' &&
      cutQuote.endsWith('…') &&
      cutQuote.length <= 45 &&
      inputAfter === 'already typed\n\n> Some reply text\n\n';
    console.log(`quote in the input: ${JSON.stringify(quoted)}; cut ${JSON.stringify(cutQuote)}; input ${JSON.stringify(inputAfter)} -> ${quoteOk}`);
    if (!quoteOk) process.exitCode = 1;
    quoteView.inputEl.value = '';

    // Side chat: a session of its own beside the chat, read-only, forked from the chat unless the
    // setting says to give it only what is asked; replies drawn as Markdown; deleted on close.
    type SideHandlers = { onMessage(message: unknown): void; onPermission(request: unknown): Promise<{ behavior: string }>; onEnd(error?: Error): void };
    const sideView = view as unknown as {
      chatId: string | null;
      sideChat: { el: HTMLElement; isOpen(): boolean };
      startSideSession(handlers: unknown, id: string, own: boolean): unknown;
      deleteSideSession(id: string): void;
      keepSideChat(id: string, unsent: string): void;
      openKeptSideChat(id: string): Promise<void>;
      chatName: string | null;
      closing: boolean;
      openSideChat(quote?: string): void;
      newChat(): void;
      historyRows(listed: unknown[]): { id: string }[];
    };
    // Session files go to a directory of the test's own, not the real ~/.claude.
    const sideFs = await import('fs');
    const sideOs = await import('os');
    const sideConfigBefore = process.env.CLAUDE_CONFIG_DIR;
    const sideConfigDir = sideFs.mkdtempSync(`${sideOs.tmpdir()}/vault-claude-config-`);
    process.env.CLAUDE_CONFIG_DIR = sideConfigDir;
    // Named after the real path, as Claude Code names it (/tmp is /private/tmp on macOS).
    const realOf = (root: string) => (sideFs.existsSync(root) ? sideFs.realpathSync(root) : root);
    const projectOf = (root: string) => `${sideConfigDir}/projects/${realOf(root).replace(/[^a-zA-Z0-9]/g, '-')}`;
    const writeSession = (root: string, id: string, rows: { uuid: string; parentUuid: string | null; type: string; content: unknown }[]) => {
      sideFs.mkdirSync(projectOf(root), { recursive: true });
      const lines = rows.map((r) =>
        JSON.stringify({ type: r.type, uuid: r.uuid, parentUuid: r.parentUuid, sessionId: id, timestamp: new Date().toISOString(), cwd: root, message: { role: r.type, content: r.content } }),
      );
      sideFs.writeFileSync(`${projectOf(root)}/${id}.jsonl`, `${lines.join('\n')}\n`);
    };

    plugin.settings.claudePath = '/nonexistent/claude';
    sideView.chatId = 'main-chat';
    const sideConfig = async (id: string, own = false) => ((await sideView.startSideSession({}, id, own)) as { config: Record<string, unknown> }).config;
    const forkConfig = await sideConfig('fork-id');
    const ownConfig = await sideConfig('own-id', true);
    const ownForkConfig = await sideConfig('fork-id', true);
    plugin.settings.sideChatContext = 'quote';
    const quoteConfig = await sideConfig('quote-id');
    plugin.settings.sideChatContext = 'chat';
    const heldIds = [...plugin.sideSessions];
    const sideConfigOk =
      forkConfig.permissionMode === 'plan' &&
      forkConfig.resume === 'main-chat' &&
      forkConfig.forkSession === true &&
      forkConfig.sessionId === 'fork-id' &&
      forkConfig.resumeSessionAt === undefined &&
      forkConfig.allowBypass === undefined &&
      String(forkConfig.appendSystemPrompt).includes('beside the conversation, in a small pane') &&
      // Without a copy it is told it has not seen the chat; resumed, a copy is told so again.
      String(quoteConfig.appendSystemPrompt).includes('You have not seen that conversation') &&
      String(ownConfig.appendSystemPrompt).includes('You have not seen that conversation') &&
      String(ownForkConfig.appendSystemPrompt).includes('beside the conversation, in a small pane') &&
      quoteConfig.permissionMode === 'plan' &&
      quoteConfig.resume === undefined &&
      quoteConfig.sessionId === 'quote-id' &&
      ownConfig.resume === 'own-id' &&
      ownConfig.forkSession === undefined &&
      ownConfig.sessionId === undefined &&
      ownConfig.permissionMode === 'plan' &&
      JSON.stringify(heldIds) === JSON.stringify(['fork-id', 'own-id', 'quote-id']);
    console.log(
      `side chat session: plan ${forkConfig.permissionMode}, forks ${forkConfig.resume}/${forkConfig.forkSession} as ${forkConfig.sessionId}; quote-only resumes ${quoteConfig.resume}, as ${quoteConfig.sessionId}; its own again ${ownConfig.resume}/${ownConfig.forkSession}; held ${JSON.stringify(heldIds)} -> ${sideConfigOk}`,
    );
    if (!sideConfigOk) process.exitCode = 1;

    // With a reply in progress, the fork ends just before the prompts it answers; with the chat's
    // first reply in progress there is nothing to fork; prompts not written yet leave the chat as it
    // stands (its last entry); with no reply in progress it is forked whole.
    writeSession('/tmp', 'main-chat', [
      { uuid: 'u1', parentUuid: null, type: 'user', content: 'first question' },
      { uuid: 'a1', parentUuid: 'u1', type: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { uuid: 'u2', parentUuid: 'a1', type: 'user', content: 'second question' },
      { uuid: 'u3', parentUuid: 'u2', type: 'user', content: 'sent while it worked' },
      { uuid: 'a2', parentUuid: 'u3', type: 'assistant', content: [{ type: 'text', text: 'half an ans' }] },
    ]);
    const sideTurnView = view as unknown as { turnPrompts: string[] };
    const cutAt = async (prompts: string[]) => {
      sideTurnView.turnPrompts = prompts;
      const config = await sideConfig('cut-id');
      return `${config.resume ?? '-'}@${config.resumeSessionAt ?? 'end'}`;
    };
    const cuts = [await cutAt(['u3', 'u2']), await cutAt(['u1']), await cutAt(['missing']), await cutAt([])];
    sideTurnView.turnPrompts = [];
    plugin.settings.claudePath = DEFAULT_SETTINGS.claudePath;
    const cutOk = JSON.stringify(cuts) === JSON.stringify(['main-chat@a1', '-@end', 'main-chat@a2', 'main-chat@end']);
    console.log(`side chat fork with a reply in progress: ${cuts.join(', ')} (expected main-chat@a1, -@end, main-chat@a2, main-chat@end) -> ${cutOk}`);
    if (!cutOk) process.exitCode = 1;

    // The history leaves held side sessions out: they are copies made for a side chat, not chats.
    const historyRoot = '/tmp/vault-claude-side-history';
    plugin.sideSessions = [];
    plugin.settings.historyIncludesAllSessions = true;
    plugin.settings.scratchChat = false;
    const historyStubs = plugin as unknown as Record<string, unknown>;
    historyStubs.chatStatuses = () => new Map();
    historyStubs.chatsWithTasks = () => new Set();
    const chatSessionId = '11111111-1111-4111-8111-111111111111';
    const sideSessionId = '22222222-2222-4222-8222-222222222222';
    writeSession(historyRoot, chatSessionId, [{ uuid: 'c1', parentUuid: null, type: 'user', content: 'the chat' }]);
    writeSession(historyRoot, sideSessionId, [{ uuid: 's1', parentUuid: null, type: 'user', content: 'the chat' }]);
    const { listHistory } = await import('../src/history');
    const listedNow = await listHistory(historyRoot, [], true);
    const listedBefore = sideView.historyRows(listedNow).map((item) => item.id).sort();
    plugin.sideSessions = [sideSessionId];
    const listedHeld = sideView.historyRows(listedNow).map((item) => item.id);
    plugin.sideSessions = [];
    plugin.settings.historyIncludesAllSessions = DEFAULT_SETTINGS.historyIncludesAllSessions;
    plugin.settings.scratchChat = DEFAULT_SETTINGS.scratchChat;
    delete historyStubs.chatStatuses;
    delete historyStubs.chatsWithTasks;
    if (sideConfigBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = sideConfigBefore;
    sideFs.rmSync(sideConfigDir, { recursive: true, force: true });
    const sideHistoryOk = JSON.stringify(listedBefore) === JSON.stringify([chatSessionId, sideSessionId]) && JSON.stringify(listedHeld) === JSON.stringify([chatSessionId]);
    console.log(`history without side sessions: ${listedBefore.length} listed, ${listedHeld.length} once one is held -> ${sideHistoryOk}`);
    if (!sideHistoryOk) process.exitCode = 1;

    // A closed session ends as a real one does, telling its handlers: at once, or when the test says
    // (`endLater`), as a real process takes a moment to exit.
    const sideSessions: { id: string; own: boolean; sent: unknown[]; closed: boolean; endLater?: boolean; handlers: SideHandlers; started(): void }[] = [];
    const sideDeleted: string[] = [];
    const sideKept: string[] = [];
    sideView.startSideSession = (handlers, id, own) => {
      const session = {
        id,
        own,
        sent: [] as unknown[],
        closed: false,
        endLater: false,
        handlers: handlers as SideHandlers,
        send: (text: unknown) => void session.sent.push(text),
        close: () => {
          session.closed = true;
          if (!session.endLater) session.handlers.onEnd();
        },
        started: () => session.handlers.onMessage({ type: 'system', subtype: 'init', session_id: id }),
      };
      sideSessions.push(session);
      return session;
    };
    sideView.deleteSideSession = (id) => void sideDeleted.push(id);
    const sideOpened: string[] = [];
    const sideUnsent: string[] = [];
    sideView.keepSideChat = (id, unsent) => {
      sideKept.push(id);
      sideUnsent.push(unsent);
    };
    sideView.openKeptSideChat = async (id) => void sideOpened.push(id);
    const side = sideView.sideChat.el;
    const sideInput = side.querySelector('.vc-side-chat-input') as HTMLTextAreaElement;
    const sideStatus = () => (side.querySelector('.vc-side-chat-status') as HTMLElement).textContent;
    const sideKey = (key: string, metaKey = false, isComposing = false) => {
      const evt = new dom.window.KeyboardEvent('keydown', { key, metaKey, isComposing, cancelable: true, bubbles: true });
      sideInput.dispatchEvent(evt);
      return evt.defaultPrevented;
    };
    const sideButton = (label: string) => (side.querySelector(`[aria-label="${label}"]`) as HTMLElement).click();
    // A question's session starts after a pause (see startSideSession), and is used after it.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const ask = async (started = true) => {
      sideInput.value = 'Why?';
      sideKey('Enter', true);
      await tick();
      const session = sideSessions[sideSessions.length - 1];
      if (started) session.started();
      return session;
    };
    const sideIds = (...indices: number[]) => JSON.stringify(indices.map((i) => sideSessions[i].id));

    // A long selection is quoted whole: a side chat given only what is asked knows no more of it.
    const longQuote = `${'word '.repeat(300)}end`;
    sideView.openSideChat(longQuote);
    const quotedWhole = sideInput.value.includes(' end\n\n') && sideInput.value.length > 1500;
    sideInput.value = '';
    sideView.openSideChat('Selected reply text');
    const openedWith = sideInput.value;
    sideInput.value += 'What does this mean?';
    const plainEnterSent = sideKey('Enter');
    const composingEsc = sideKey('Escape', false, true);
    const sentOnMod = sideKey('Enter', true);
    await tick();
    const sideSession = sideSessions[0];
    const questionShown = side.querySelector('.vc-side-chat-question')?.textContent;
    const thinking = sideStatus();
    sideSession.started();
    sideSession.handlers.onMessage({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } } });
    const liveReply = side.querySelector('.vc-side-chat-reply.is-live')?.textContent;
    sideSession.handlers.onMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } });
    const looking = sideStatus();
    const liveGone = side.querySelectorAll('.vc-side-chat-reply').length === 0;
    sideSession.handlers.onMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'It means **this**.' }] } });
    sideSession.handlers.onMessage({ type: 'result', subtype: 'success' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replies = [...side.querySelectorAll('.vc-side-chat-reply')].map((el) => `${el.textContent}${el.classList.contains('is-live') ? ' (live)' : ''}`);
    // Its replies' components are its own, not the chat's, and are unloaded when it closes.
    const replyComponent = stub.MarkdownRenderer.lastComponent;
    const ownComponent = replyComponent !== null && replyComponent !== (view as unknown as { chatComponent: unknown }).chatComponent && replyComponent.loaded;
    const denied = await sideSession.handlers.onPermission({ toolName: 'Edit', input: {} });
    // Esc from anywhere in it, not only its input.
    const escEvent = new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    side.querySelector('.vc-side-chat-reply')?.dispatchEvent(escEvent);
    const escUsed = escEvent.defaultPrevented;
    const sideOk =
      quotedWhole &&
      openedWith === '> Selected reply text\n\n' &&
      !plainEnterSent &&
      !composingEsc &&
      sentOnMod &&
      sideSession.own === false &&
      /^[0-9a-f-]{36}$/.test(sideSession.id) &&
      JSON.stringify(sideSession.sent) === JSON.stringify(['> Selected reply text\n\nWhat does this mean?']) &&
      questionShown === '> Selected reply text\n\nWhat does this mean?' &&
      thinking === 'Thinking…' &&
      liveReply === 'Partial' &&
      looking === 'Looking: Read…' &&
      liveGone &&
      JSON.stringify(replies) === JSON.stringify(['It means **this**.']) &&
      sideStatus() === '' &&
      denied.behavior === 'deny' &&
      escUsed &&
      ownComponent &&
      replyComponent?.loaded === false &&
      sideSession.closed &&
      JSON.stringify(sideDeleted) === sideIds(0) &&
      !sideView.sideChat.isOpen() &&
      side.querySelectorAll('.vc-side-chat-reply, .vc-side-chat-question').length === 0 &&
      sideInput.value === '';
    console.log(
      `side chat: opened with ${JSON.stringify(openedWith)}; sent ${JSON.stringify(sideSession.sent)} on ⌘↩ only ${!plainEnterSent && sentOnMod}; an IME's Esc kept it open ${!composingEsc}; statuses ${thinking}/${looking}; live ${liveReply}; replies ${JSON.stringify(replies)}; permission ${denied.behavior}; own components ${ownComponent}, unloaded on close ${replyComponent?.loaded === false}; Esc closes and deletes its session ${JSON.stringify(sideDeleted) === sideIds(0)} -> ${sideOk}`,
    );
    if (!sideOk) process.exitCode = 1;

    // Keep: nothing to keep before a question, nor before Claude Code has started the session under
    // its id; after that, its session is kept, not deleted.
    sideView.openSideChat();
    sideButton('Keep as a chat, in a new tab');
    const keepNothing = sideStatus();
    const unstarted = await ask(false);
    sideButton('Keep as a chat, in a new tab');
    const keepUnstarted = sideStatus();
    unstarted.started();
    // Kept at once (in the history, safe from the next start's sweep); opened once its process has
    // ended, so nothing still writes to the file the new tab resumes.
    unstarted.endLater = true;
    // Typed and not sent: it goes with the kept chat, and the side chat's input is emptied.
    sideInput.value = 'A follow-up not sent';
    sideButton('Keep as a chat, in a new tab');
    const unsentCarried = JSON.stringify(sideUnsent) === JSON.stringify(['A follow-up not sent']) && sideInput.value === '';
    const keptAtClick = JSON.stringify(sideKept) === sideIds(1);
    const keptBeforeEnd = sideOpened.length;
    unstarted.handlers.onEnd();
    const keptOk =
      keepNothing === 'There is nothing to keep yet.' &&
      keepUnstarted === 'There is nothing to keep yet.' &&
      keptAtClick &&
      unsentCarried &&
      keptBeforeEnd === 0 &&
      JSON.stringify(sideOpened) === sideIds(1) &&
      sideSessions[1].closed &&
      JSON.stringify(sideDeleted) === sideIds(0) &&
      !sideView.sideChat.isOpen();
    // Start over deletes the session and keeps the side chat open; what the old session still says is
    // not drawn. A session that fails once started is resumed by the next question; one that fails
    // before it started is replaced by a new one, and deleted.
    sideView.openSideChat();
    await ask();
    sideButton('Start over');
    sideSessions[2].handlers.onMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'late' }] } });
    const startedOver = sideView.sideChat.isOpen() && sideSessions[2].closed && side.querySelectorAll('.vc-side-chat-question, .vc-side-chat-reply').length === 0;
    await ask();
    sideSessions[3].handlers.onEnd(new Error('the process exited'));
    const failedStatus = sideStatus();
    await ask(false);
    const resumedOwn = sideSessions.length === 5 && sideSessions[4].own && sideSessions[4].id === sideSessions[3].id;
    sideButton('Start over');
    await ask(false);
    sideSessions[5].handlers.onEnd(new Error('the process exited'));
    await ask(false);
    const replaced =
      sideSessions.length === 7 && !sideSessions[6].own && sideSessions[6].id !== sideSessions[5].id && sideDeleted[sideDeleted.length - 1] === sideSessions[5].id;
    sideView.newChat();
    const newChatOk = !sideView.sideChat.isOpen() && sideSessions[6].closed && sideDeleted[sideDeleted.length - 1] === sideSessions[6].id;
    // Closed while its session starts: that session is never used, and its id is let go. One that
    // cannot start gives the question back to the input.
    const gate: { open?: () => void } = {};
    const startNow = sideView.startSideSession;
    sideView.startSideSession = (handlers, id, own) => new Promise((resolve) => (gate.open = () => resolve(startNow(handlers, id, own))));
    sideView.openSideChat();
    sideInput.value = 'Slow?';
    sideKey('Enter', true);
    const busyWhileStarting = sideStatus() === 'Thinking…';
    sideButton('Close (Esc)');
    gate.open?.();
    await tick();
    const late = sideSessions[sideSessions.length - 1];
    const closedWhileStarting = busyWhileStarting && sideSessions.length === 8 && late.sent.length === 0 && sideDeleted[sideDeleted.length - 1] === late.id && !sideView.sideChat.isOpen();
    sideView.startSideSession = async () => null;
    sideView.openSideChat();
    sideInput.value = 'No Claude Code?';
    sideKey('Enter', true);
    await tick();
    const gaveBack = sideInput.value === 'No Claude Code?' && side.querySelectorAll('.vc-side-chat-question').length === 0 && sideStatus() === '';
    sideButton('Close (Esc)');
    const sideRestOk = keptOk && startedOver && failedStatus === 'The side chat stopped: the process exited' && resumedOwn && replaced && newChatOk && closedWhileStarting && gaveBack;
    console.log(
      `side chat keep ${JSON.stringify(sideKept) === sideIds(1)}, with its unsent text ${unsentCarried}, after its process ended ${keptBeforeEnd === 0} (too soon: ${JSON.stringify(keepNothing)}, ${JSON.stringify(keepUnstarted)}); start over ${startedOver}; failed ${JSON.stringify(failedStatus)}, then resumed its own ${resumedOwn}; failed before starting: replaced and deleted ${replaced}; new chat closes and deletes ${newChatOk}; closed while starting ${closedWhileStarting}; unable to start, gives the question back ${gaveBack} -> ${sideRestOk}`,
    );
    if (!sideRestOk) process.exitCode = 1;

    // Images: pasted into the side chat's input, or dropped on it, go with its question as image
    // blocks; it takes no other files, and a drop elsewhere on the panel is the chat's.
    {
      sideView.startSideSession = startNow;
      const globals = globalThis as { createImageBitmap?: unknown };
      const bitmapBefore = globals.createImageBitmap;
      globals.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
      const sideRoot = side.closest('.vc-root') as HTMLElement;
      const file = (name: string, type: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type });
      const withData = (type: string, key: string, value: unknown, target: HTMLElement) => {
        const evt = new dom.window.Event(type, { cancelable: true, bubbles: true });
        Object.defineProperty(evt, key, { value });
        target.dispatchEvent(evt);
        return evt;
      };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
      sideView.openSideChat();
      const pasted = withData('paste', 'clipboardData', { files: [file('shot.png', 'image/png')] }, sideInput);
      const textPaste = withData('paste', 'clipboardData', { files: [] }, sideInput);
      await settle();
      withData('dragover', 'dataTransfer', { types: ['Files'], files: [] }, sideInput);
      const outlined = side.classList.contains('is-drop-target') && !sideRoot.classList.contains('is-drop-target');
      const said: string[] = [];
      const realLog = console.log;
      console.log = (...parts: unknown[]) => void said.push(parts.join(' '));
      withData('drop', 'dataTransfer', { types: ['Files'], files: [file('plot.jpg', 'image/jpeg'), file('paper.pdf', 'application/pdf')] }, sideInput);
      await settle();
      console.log = realLog;
      const outlineGone = !side.classList.contains('is-drop-target');
      const sideTray = () => [...side.querySelectorAll('.vc-side-chat-tray .vc-chip-label')].map((el) => el.textContent).join();
      const trayBefore = sideTray();
      const mainTray = () => [...sideRoot.querySelectorAll('.vc-tray:not(.vc-side-chat-tray) .vc-chip-label')].map((el) => el.textContent).join();
      const mainBefore = mainTray();
      sideInput.value = 'What is in these?';
      sideKey('Enter', true);
      await tick();
      const imaged = sideSessions[sideSessions.length - 1];
      imaged.started();
      const sent = imaged.sent[0] as { type: string; source?: { media_type?: string }; text?: string }[];
      const bubbleImages = side.querySelectorAll('.vc-side-chat-question .vc-chip img').length;
      // A drop on the chat itself, beside the side chat, still goes to the chat's own tray.
      withData('drop', 'dataTransfer', { types: ['Files'], files: [file('other.png', 'image/png')] }, sideRoot.querySelector('.vc-footer') as HTMLElement);
      await settle();
      const mainAfter = mainTray();
      (sideRoot.querySelector('.vc-tray:not(.vc-side-chat-tray) .vc-chip-remove') as HTMLElement | null)?.click();
      sideButton('Close (Esc)');
      globals.createImageBitmap = bitmapBefore;
      const imagesOk =
        pasted.defaultPrevented &&
        !textPaste.defaultPrevented &&
        outlined &&
        outlineGone &&
        trayBefore === 'shot.png,plot.jpg' &&
        said.some((line) => line.includes('left out: paper.pdf')) &&
        mainBefore === '' &&
        JSON.stringify(sent.map((block) => block.source?.media_type ?? block.text)) === JSON.stringify(['image/png', 'image/jpeg', 'What is in these?']) &&
        sideTray() === '' &&
        bubbleImages === 2 &&
        mainAfter === 'other.png';
      console.log(
        `side chat images: tray ${trayBefore}; sent ${JSON.stringify(sent.map((block) => block.source?.media_type ?? block.text))}; in the question ${bubbleImages}; outlined over it ${outlined}; a pdf ${said.some((line) => line.includes('left out: paper.pdf')) ? 'refused' : 'taken'}; a drop beside it went to the chat ${mainAfter} -> ${imagesOk}`,
      );
      if (!imagesOk) process.exitCode = 1;
    }
    for (const key of ['startSideSession', 'deleteSideSession', 'keepSideChat', 'openKeptSideChat']) delete (sideView as unknown as Record<string, unknown>)[key];

    // Keeping records the chat at once, named after the chat it was opened from and let go of by the
    // sweep; opening it waits, and goes through the plugin when this panel has closed meanwhile.
    const recorded: string[] = [];
    const openedBy: string[] = [];
    const keepPlugin = plugin as unknown as Record<string, unknown>;
    const pluginWas = { recordChat: keepPlugin.recordChat, openChatById: keepPlugin.openChatById, openChatTab: keepPlugin.openChatTab, chats: keepPlugin.chats };
    keepPlugin.recordChat = (id: string, title: string) => void recorded.push(`${id}:${title}`);
    keepPlugin.chats = [{ id: 'kept-id', title: 'Side chat: The chat' }];
    keepPlugin.openChatById = async (id: string, title: string) => void openedBy.push(`plugin ${id}:${title}`);
    keepPlugin.openChatTab = async () => ({ openChat: async (item: { id: string; title: string }) => void openedBy.push(`tab ${item.id}:${item.title}`) });
    plugin.sideSessions = ['kept-id'];
    sideView.chatName = 'The chat';
    sideView.keepSideChat('kept-id', 'Still to ask');
    const keptHeld = plugin.sideSessions.length;
    const keptDraft = (plugin.drafts as Record<string, { text?: string }>)['kept-id']?.text;
    delete (plugin.drafts as Record<string, unknown>)['kept-id'];
    // Opened from the history before its process has ended, it waits; then it opens.
    const opens: string[] = [];
    const waitView = view as unknown as { showSavedChat(item: { id: string }): Promise<void>; openChat(item: unknown): Promise<void> };
    waitView.showSavedChat = async (item) => void opens.push(item.id);
    const openFromHistory = waitView.openChat({ id: 'kept-id', title: 'Side chat: The chat', updatedAt: 0, fromPanel: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const openedEarly = opens.length;
    await sideView.openKeptSideChat('kept-id');
    await openFromHistory;
    delete (waitView as unknown as Record<string, unknown>).showSavedChat;
    const waited = openedEarly === 0 && JSON.stringify(opens) === JSON.stringify(['kept-id']);
    sideView.closing = true;
    await sideView.openKeptSideChat('kept-id');
    sideView.closing = false;
    Object.assign(keepPlugin, pluginWas);
    sideView.chatName = null;
    const keepRealOk =
      JSON.stringify(recorded) === JSON.stringify(['kept-id:Side chat: The chat']) &&
      keptHeld === 0 &&
      keptDraft === 'Still to ask' &&
      waited &&
      JSON.stringify(openedBy) === JSON.stringify(['tab kept-id:Side chat: The chat', 'plugin kept-id:Side chat: The chat']);
    console.log(`keeping a side chat: recorded ${JSON.stringify(recorded)}, held ${keptHeld}, unsent text ${JSON.stringify(keptDraft)}; from the history, waited for its process ${waited}; opened ${JSON.stringify(openedBy)} -> ${keepRealOk}`);
    if (!keepRealOk) process.exitCode = 1;
    sideView.chatId = null;

    // A long run of thinking and tool steps: every step must land in the fold, not just the last few.
    internals.messagesEl.empty();
    const longRun: unknown[] = [entry('lu1', 'user', 'do a long job')];
    for (let i = 0; i < 4; i++) {
      longRun.push(entry(`lt${i}`, 'assistant', [{ type: 'thinking', thinking: `step ${i}` }]));
      longRun.push(entry(`la${i}`, 'assistant', [{ type: 'tool_use', id: `lb${i}`, name: 'Bash', input: { command: 'ls' } }]));
      longRun.push(entry(`lr${i}`, 'user', [{ type: 'tool_result', tool_use_id: `lb${i}`, content: 'x' }]));
    }
    longRun.push(entry('lend', 'assistant', [{ type: 'text', text: 'Done.' }]));
    internals.renderTranscript(longRun);
    const longTurn = root.querySelector('.vc-messages .vc-turn') as HTMLElement;
    const outsideFold = [...longTurn.children].filter((el) => el.classList.contains('vc-tools')).length;
    const insideFold = longTurn.querySelectorAll('.vc-steps-body > .vc-tools').length;
    const longFoldText = longTurn.querySelector('.vc-steps-header')?.textContent;
    const longOk = outsideFold === 0 && insideFold === 8 && longFoldText === 'Steps: 4 tool calls, 4 thoughts';
    console.log(`steps fold on a long run: "${longFoldText}"; inside ${insideFold}; left outside ${outsideFold} -> ${longOk}`);
    if (!longOk) process.exitCode = 1;

    // A reply that speaks between runs of steps: one fold per run, the messages between them open.
    internals.messagesEl.empty();
    internals.renderTranscript([
      entry('su', 'user', 'two rounds'),
      entry('st1', 'assistant', [{ type: 'thinking', thinking: 'first' }]),
      entry('sa1', 'assistant', [{ type: 'tool_use', id: 'sb1', name: 'Bash', input: { command: 'ls' } }]),
      entry('sr1', 'user', [{ type: 'tool_result', tool_use_id: 'sb1', content: 'x' }]),
      entry('sm', 'assistant', [{ type: 'text', text: 'Here is what I found so far.' }]),
      entry('st2', 'assistant', [{ type: 'thinking', thinking: 'second' }]),
      entry('sa2', 'assistant', [{ type: 'tool_use', id: 'sb2', name: 'Read', input: { file_path: '/tmp/x' } }]),
      entry('sr2', 'user', [{ type: 'tool_result', tool_use_id: 'sb2', content: 'y' }]),
      entry('se', 'assistant', [{ type: 'text', text: 'Done.' }]),
    ]);
    const splitTurn = root.querySelector('.vc-messages .vc-turn') as HTMLElement;
    const splitOrder = [...splitTurn.children]
      .map((el) => (el.classList.contains('vc-steps') ? 'fold' : el.classList.contains('vc-text') ? 'text' : null))
      .filter(Boolean)
      .join(',');
    const splitOk = splitOrder === 'fold,text,fold,text';
    console.log(`steps and messages in order: ${splitOrder} (expected fold,text,fold,text) -> ${splitOk}`);
    if (!splitOk) process.exitCode = 1;
    // Text with nothing to show between steps (white space streamed between tool calls) leaves one fold.
    {
      const blankTurn = document.createElement('div');
      const step = (text: string, thinking = false) => blankTurn.createDiv({ cls: `vc-tools${thinking ? ' vc-thinking' : ''}` }).createDiv({ cls: 'vc-tool', text });
      step('thought', true);
      step('Bash ls');
      blankTurn.createDiv({ cls: 'vc-text', text: '\n  ' });
      step('Read x');
      step('another thought', true);
      blankTurn.createDiv({ cls: 'vc-text', text: 'Done.' });
      (view as unknown as { foldSteps(turn: HTMLElement): void }).foldSteps(blankTurn);
      const blankOrder = [...blankTurn.children].map((el) => (el.classList.contains('vc-steps') ? 'fold' : el.classList.contains('vc-text') ? 'text' : 'other')).join(',');
      const blankHeader = blankTurn.querySelector('.vc-steps-header')?.textContent;
      // Text whose Markdown is still rendering is empty on screen but not blank: it stays between folds.
      const pendingTurn = document.createElement('div');
      const pendingStep = (text: string) => pendingTurn.createDiv({ cls: 'vc-tools' }).createDiv({ cls: 'vc-tool', text });
      pendingStep('Bash ls');
      pendingStep('Read x');
      const rendering = pendingTurn.createDiv({ cls: 'vc-text' });
      (view as unknown as { markdownSource: Map<HTMLElement, string> }).markdownSource.set(rendering, 'Here is what I found, with a [[link]].');
      pendingStep('Bash pwd');
      pendingStep('Read y');
      (view as unknown as { foldSteps(turn: HTMLElement): void }).foldSteps(pendingTurn);
      // The card of changed files sits where the first file changed but shows at the reply's end: it does not split the steps.
      const cardTurn = document.createElement('div');
      const cardStep = (text: string, thinking = false) => cardTurn.createDiv({ cls: `vc-tools${thinking ? ' vc-thinking' : ''}` }).createDiv({ cls: 'vc-tool', text });
      cardStep('thought', true);
      cardStep('Write plan');
      cardTurn.createDiv({ cls: 'vc-changes', text: '1 file changed +5' });
      cardStep('another thought', true);
      cardStep('ExitPlanMode');
      cardTurn.createDiv({ cls: 'vc-text', text: 'Done.' });
      (view as unknown as { foldSteps(turn: HTMLElement): void }).foldSteps(cardTurn);
      const cardFolds = [...cardTurn.querySelectorAll('.vc-steps-header')].map((el) => el.textContent);
      const cardKept = cardTurn.querySelector(':scope > .vc-changes') !== null;
      const pendingOrder = [...pendingTurn.children].map((el) => (el.classList.contains('vc-steps') ? 'fold' : el.classList.contains('vc-text') ? 'text' : 'other')).join(',');
      const blankOk = blankOrder === 'fold,text' && blankHeader === 'Steps: 2 tool calls, 2 thoughts' && pendingOrder === 'fold,text,fold' && rendering.parentElement === pendingTurn && JSON.stringify(cardFolds) === JSON.stringify(['Steps: 2 tool calls, 2 thoughts']) && cardKept;
      console.log(`steps around empty text: ${blankOrder}, "${blankHeader}"; around text still rendering: ${pendingOrder}; around the changed-files card: ${JSON.stringify(cardFolds)} -> ${blankOk}`);
      if (!blankOk) process.exitCode = 1;
    }
    // Steps before any message of yours (a resumed session) must still land in a turn, not loose in the chat.
    internals.messagesEl.empty();
    internals.renderTranscript([
      entry('ht', 'assistant', [{ type: 'thinking', thinking: 'carrying on' }]),
      entry('ha', 'assistant', [{ type: 'tool_use', id: 'hb', name: 'Bash', input: { command: 'ls' } }]),
      entry('hr', 'user', [{ type: 'tool_result', tool_use_id: 'hb', content: 'x' }]),
      entry('he', 'assistant', [{ type: 'text', text: 'Done.' }]),
    ]);
    const loose = root.querySelectorAll('.vc-messages > .vc-tools').length;
    const inTurn = root.querySelectorAll('.vc-messages > .vc-turn .vc-steps-body > .vc-tools').length;
    console.log(`steps before a message of yours: loose ${loose} (expected 0); in a fold ${inTurn} (expected 2)`);
    if (loose !== 0 || inTurn !== 2) process.exitCode = 1;
    internals.messagesEl.empty();

    // Switching the model in a reopened chat (no session yet) sticks, rather than snapping back
    // to the model its transcript ran on.
    const modelView = view as unknown as { currentModel: string | null; changeModel(value: string): Promise<void> };
    (plugin as { models: unknown[] }).models = [
      { value: 'default', resolvedModel: 'claude-opus-5', supportsFastMode: true },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
    ];
    modelView.currentModel = 'claude-sonnet-5';
    (view as unknown as { populateModelSelect(): void }).populateModelSelect();
    const beforeSwitch = root.querySelector('.vc-actions .vc-menu-button-label')?.textContent;
    await modelView.changeModel('default');
    const afterSwitch = root.querySelector('.vc-actions .vc-menu-button-label')?.textContent;
    console.log(`model switch without a session: ${beforeSwitch} -> ${afterSwitch} (expected Sonnet 5 -> Opus 5)`);
    if (beforeSwitch !== 'Sonnet 5' || afterSwitch !== 'Opus 5') process.exitCode = 1;
    // Claude Code's settings name a model of their own (Fable here). A new chat starts on Default,
    // sent as such; with the setting that leaves it to Claude Code, on that model, sent as none; and
    // choosing Default then sends "default" and stays on it.
    (plugin as { configured: { model?: string } }).configured = { model: 'claude-fable-5-1[1m]' };
    (plugin as { models: unknown[] }).models = [
      { value: 'default', resolvedModel: 'claude-opus-5-5' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5' },
      { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1' },
    ];
    const shownModel = () => root.querySelector('.vc-actions .vc-menu-button-label')?.textContent ?? '';
    const sentModel = () => (view as unknown as { modelOverride?: string }).modelOverride;
    view.newChat();
    const newChatModel = `${shownModel()}/${sentModel()}`;
    plugin.settings.model = 'claude-code';
    view.newChat();
    const leftToClaude = `${shownModel()}/${sentModel()}`;
    await modelView.changeModel('default');
    const defaultChosen = `${shownModel()}/${sentModel()}`;
    plugin.settings.model = DEFAULT_SETTINGS.model;
    const defaultOk = newChatModel === 'Opus 5.5/default' && leftToClaude.startsWith('Fable 5.1') && leftToClaude.endsWith('/undefined') && defaultChosen === 'Opus 5.5/default';
    console.log(`models over one Claude Code's settings name: new chat ${newChatModel}; left to Claude Code ${leftToClaude}; Default chosen ${defaultChosen} -> ${defaultOk}`);
    if (!defaultOk) process.exitCode = 1;
    (plugin as { configured: { model?: string } }).configured = {};
    view.newChat();
    (plugin as { models: unknown[] }).models = [];

    // An empty chat offers the scratch chat; the scratch chat offers Clear instead.
    view.newChat();
    const welcomeLink = root.querySelector('.vc-welcome .vc-welcome-link') as HTMLElement | null;
    const clearButton = root.querySelector('.vc-chat-title-actions .vc-delete-chat') as HTMLElement;
    const linkBefore = welcomeLink?.textContent === 'Open the scratch chat' && !clearButton.isShown();

    // The notes button: what the chat changed, then what it mentioned, newest first.
    internals.messagesEl.empty();
    const notesTurn = internals.messagesEl.createDiv({ cls: 'vc-turn' });
    const older = notesTurn.createDiv({ cls: 'vc-changes' });
    older.createSpan({ cls: 'vc-edit-file vc-file-link', attr: { 'data-path': 'Old.md' } });
    notesTurn.createEl('a', { cls: 'internal-link', text: 'Linked note', attr: { 'data-href': 'Linked.md' } });
    // Mentioned later, changed earlier: it belongs under Changed.
    notesTurn.createEl('a', { cls: 'internal-link', text: 'Old note', attr: { 'data-href': 'Old.md' } });
    const newer = notesTurn.createDiv({ cls: 'vc-changes' });
    newer.createSpan({ cls: 'vc-edit-file vc-file-link', attr: { 'data-path': 'New.md' } });
    const notes = (view as unknown as { notesInChat(): { changed: { target: string }[]; mentioned: { target: string }[] } }).notesInChat();
    const notesOk = notes.changed.map((n) => n.target).join(',') === 'New.md,Old.md' && notes.mentioned.map((n) => n.target).join(',') === 'Linked.md';
    console.log(`notes in chat: changed ${notes.changed.map((n) => n.target).join(',')}; mentioned ${notes.mentioned.map((n) => n.target).join(',')} -> ${notesOk}`);
    if (!notesOk) process.exitCode = 1;
    // The notes menu after a reply that changed a note and an image in attachments, and mentions a path in code.
    internals.messagesEl.empty();
    const menuTurn = internals.messagesEl.createDiv({ cls: 'vc-turn' });
    const menuCard = menuTurn.createDiv({ cls: 'vc-changes' });
    menuCard.createSpan({ cls: 'vc-edit-file vc-file-link', attr: { 'data-path': 'Demo — Solow model.md' } });
    menuCard.createSpan({ cls: 'vc-edit-file vc-file-link', attr: { 'data-path': 'attachments/Solow Diagram — Demo.svg' } });
    menuTurn.createDiv({ cls: 'vc-text' }).createEl('code', { text: 'attachments/Solow Diagram — Demo.svg' });
    menuTurn.createEl('a', { cls: 'internal-link', text: 'Solow Diagram — Demo.svg', attr: { 'data-href': 'attachments/Solow Diagram — Demo.svg' } });
    stub.Menu.last = null;
    const notesButtonEl = root.querySelector('button[aria-label="Notes in this chat"]') as HTMLElement;
    (notesButtonEl as HTMLElement & { show(): void }).show();
    notesButtonEl.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 0 }));
    const shownMenu = stub.Menu.last as unknown as { items: { title: string }[]; placed: string } | null;
    const menuTitles = shownMenu ? shownMenu.items.map((item) => item.title).join(' | ') : 'not shown';
    // In the input's bar, beside the paperclip, with the count once drawing has settled.
    (view as unknown as { countNotesSoon(): void }).countNotesSoon();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const inBar = notesButtonEl.closest('.vc-actions-tools') !== null;
    const count = notesButtonEl.querySelector('.vc-notes-count')?.textContent;
    const menuOk = !!shownMenu && menuTitles === 'Notes in this chat · ⌥-click to attach | Changed | Demo — Solow model.md' && inBar && count === '1';
    console.log(`notes menu: ${menuTitles} (an attachment left out); in the input bar ${inBar}, count ${count} -> ${menuOk}`);
    if (!menuOk) process.exitCode = 1;
    internals.messagesEl.empty();

    // ⌥-click on an entry attaches the note as an @ mention instead of opening it.
    const notesMenu = view as unknown as { attachNoteFromMenu(entry: { target: string; label: string }): void; inputEl: HTMLTextAreaElement };
    notesMenu.inputEl.value = '';
    notesMenu.inputEl.setSelectionRange(0, 0);
    notesMenu.attachNoteFromMenu({ target: 'New.md', label: 'New' });
    const attachOk = notesMenu.inputEl.value === '@[[New]] ';
    console.log(`alt-click attaches a note: "${notesMenu.inputEl.value}" -> ${attachOk}`);
    if (!attachOk) process.exitCode = 1;
    notesMenu.inputEl.value = '';

    // The draft line: an empty draft is thrown away unsent, and a written one is sent and thrown away.
    const draftView = view as unknown as { draftPath: string | null; updateDraftLine(): void; sendDraft(): Promise<void>; holdsDraft(path: string): boolean };
    const draftLine = root.querySelector('.vc-draft-line') as HTMLElement;
    notesOnDisk.set('Drafts/draft.md', '   \n');
    draftView.draftPath = 'Drafts/draft.md';
    draftView.updateDraftLine();
    const draftShown = draftLine.isShown() && draftLine.querySelector('span')?.textContent === 'Draft in “draft” · click to send it';
    const draftOwned = draftView.holdsDraft('Drafts/draft.md');
    await draftView.sendDraft();
    const emptyOk = draftShown && draftOwned && !draftLine.isShown() && trashed.includes('Drafts/draft.md') && notesMenu.inputEl.value === '';
    // The × throws a draft away unsent.
    notesOnDisk.set('Drafts/thrown.md', 'half a thought');
    draftView.draftPath = 'Drafts/thrown.md';
    draftView.updateDraftLine();
    (draftLine.querySelector('.vc-draft-close') as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const discardedOk = !draftLine.isShown() && trashed.includes('Drafts/thrown.md');
    console.log(`draft thrown away by the ×: line gone ${!draftLine.isShown()}; trashed ${trashed.includes('Drafts/thrown.md')} -> ${discardedOk}`);
    if (!discardedOk) process.exitCode = 1;
    // A draft deleted in Obsidian takes the line with it; a moved one is followed (the plugin passes
    // both on to each panel, see noteMoved).
    const follow = (view as unknown as { followNote(from: string, to: string | null): void }).followNote.bind(view);
    notesOnDisk.set('Drafts/moved.md', 'text');
    draftView.draftPath = 'Drafts/moved.md';
    draftView.updateDraftLine();
    follow('Drafts/moved.md', 'Drafts/renamed.md');
    notesOnDisk.set('Drafts/renamed.md', 'text');
    const followedMove = draftView.holdsDraft('Drafts/renamed.md');
    notesOnDisk.delete('Drafts/renamed.md');
    follow('Drafts/renamed.md', null);
    const goneWithNote = !draftLine.isShown() && !draftView.holdsDraft('Drafts/renamed.md');
    console.log(`draft line follows its note: moved ${followedMove}; gone when deleted ${goneWithNote}`);
    if (!followedMove || !goneWithNote) process.exitCode = 1;
    console.log(`empty draft: line shown ${draftShown}; gone after sending ${!draftLine.isShown()}; trashed ${trashed.includes('Drafts/draft.md')} -> ${emptyOk}`);
    if (!emptyOk) process.exitCode = 1;

    internals.messagesEl.empty();



    // The line above the input offers the chats that changed the note on screen.
    const noteLine = root.querySelector('.vc-note-chats') as HTMLElement;
    (view as unknown as { updateNoteChats(file: unknown): void }).updateNoteChats({ path: 'Note.md', basename: 'Note' });
    const offered = noteLine.isShown() && noteLine.textContent === '1 chat about this note';
    // Not offered when that chat is the one on screen, by either of its ids.
    const ids = view as unknown as { chatId: string | null; resumeId: string | null };
    const wasResume = ids.resumeId;
    ids.resumeId = 'c1';
    (view as unknown as { updateNoteChats(file: unknown): void }).updateNoteChats({ path: 'Note.md', basename: 'Note' });
    const hiddenForCurrent = !noteLine.isShown();
    ids.resumeId = wasResume;
    (view as unknown as { updateNoteChats(file: unknown): void }).updateNoteChats({ path: 'Other.md', basename: 'Other' });
    const hiddenElsewhere = !noteLine.isShown();
    console.log(`note chat line: offered ${offered}; hidden for the chat on screen ${hiddenForCurrent}; hidden for another note ${hiddenElsewhere}`);
    if (!offered || !hiddenForCurrent || !hiddenElsewhere) process.exitCode = 1;
    // Two chats about the note, one of them on screen: the line counts the other one, and says so.
    const entriesBefore = (plugin as { noteChatEntries: unknown }).noteChatEntries;
    (plugin as { noteChatEntries: unknown }).noteChatEntries = () => [
      { id: 'c1', title: 'About the note', why: 'changed' },
      { id: 'c2', title: 'Also about it', why: 'sent' },
    ];
    ids.resumeId = 'c1';
    (view as unknown as { updateNoteChats(file: unknown): void }).updateNoteChats({ path: 'Note.md', basename: 'Note' });
    const otherText = noteLine.textContent;
    ids.resumeId = wasResume;
    (plugin as { noteChatEntries: unknown }).noteChatEntries = entriesBefore;
    const otherOk = otherText === '1 other chat about this note';
    console.log(`note chat line with the chat on screen about it too: "${otherText}" -> ${otherOk}`);
    if (!otherOk) process.exitCode = 1;
    // Chats a panel holds are marked: clicking one shows it there rather than starting it again.
    const openIds = (plugin as unknown as { openChatIds: Set<string> }).openChatIds;
    const lineWith = (ids: string[], entries: { id: string; title: string; why: string }[]) => {
      openIds.clear();
      for (const id of ids) openIds.add(id);
      (plugin as { noteChatEntries: unknown }).noteChatEntries = () => entries;
      (view as unknown as { updateNoteChats(file: unknown): void }).updateNoteChats({ path: 'Note.md', basename: 'Note' });
      return noteLine.querySelector('span')?.textContent ?? noteLine.textContent;
    };
    const two = [
      { id: 'c1', title: 'About the note', why: 'changed' },
      { id: 'c2', title: 'Also about it', why: 'sent' },
    ];
    const oneOfTwo = lineWith(['c2'], two);
    const noneOfTwo = lineWith([], two);
    const singleOpen = lineWith(['c1'], [two[0]]);
    openIds.clear();
    (plugin as { noteChatEntries: unknown }).noteChatEntries = entriesBefore;
    const openLineOk = oneOfTwo === '2 chats about this note · 1 open' && noneOfTwo === '2 chats about this note' && singleOpen === '1 chat about this note · open';
    console.log(`note chat line marks open chats: ${JSON.stringify([oneOfTwo, noneOfTwo, singleOpen])} -> ${openLineOk}`);
    if (!openLineOk) process.exitCode = 1;
    // ⌥-click on a chat in the note's list takes it off the note; a plain click opens it.
    {
      const taken: string[] = [];
      const opened: string[] = [];
      const lineView = view as unknown as Record<string, unknown> & { openNoteChats(evt: unknown): void; updateNoteChats(file: unknown): void };
      const pluginRec = plugin as unknown as Record<string, unknown>;
      const pluginWas = { removeNoteChat: pluginRec.removeNoteChat, noteChatEntries: pluginRec.noteChatEntries };
      pluginRec.removeNoteChat = (path: string, id: string) => void taken.push(`${path}:${id}`);
      lineView.activeNote = () => ({ file: { path: 'Note.md' } });
      lineView.openChatId = async (id: string) => void opened.push(id);
      const listed = (entries: typeof two) => {
        pluginRec.noteChatEntries = () => entries;
        lineView.updateNoteChats({ path: 'Note.md', basename: 'Note' });
      };
      listed(two);
      stub.Menu.last = null;
      lineView.openNoteChats({ altKey: false });
      const menu = stub.Menu.last as unknown as { items: { title: string; label: boolean; click: ((evt?: unknown) => unknown) | null }[] } | null;
      const hint = menu?.items[0];
      const item = (title: string) => menu?.items.find((entry) => entry.title === title);
      item('Also about it')?.click?.({ altKey: true });
      item('About the note')?.click?.({ altKey: false });
      // One chat opens at once on a click; ⌥-click on the line takes it off.
      listed([two[1]]);
      lineView.openNoteChats({ altKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const key of ['activeNote', 'openChatId']) delete lineView[key];
      Object.assign(pluginRec, pluginWas);
      listed([]);
      const takeOk =
        hint?.label === true &&
        hint.title === '⌥-click takes a chat off this note' &&
        JSON.stringify(taken) === JSON.stringify(['Note.md:c2', 'Note.md:c2']) &&
        JSON.stringify(opened) === JSON.stringify(['c1']);
      console.log(`taking a chat off a note: hint "${hint?.title}"; taken ${JSON.stringify(taken)}; opened ${JSON.stringify(opened)} -> ${takeOk}`);
      if (!takeOk) process.exitCode = 1;
    }


    // The notes a message carries: the active note, mentioned notes and attached selections.
    const sentView = view as unknown as {
      buildPrompt(text: string, files: unknown[], selections: unknown[]): Promise<{ prompt: string; notes: string[] }>;
      linkSentNotes(paths: string[]): void;
      attachedNote: string | null;
      chatId: string | null;
      scratch: boolean;
    };
    notesOnDisk.set('New.md', 'body');
    const wasAttached = sentView.attachedNote;
    sentView.attachedNote = null;
    const built = await sentView.buildPrompt('see @[[New.md]]', [], [
      { kind: 'selection', name: 'Sel', path: 'Sel.md', fromLine: 1, toLine: 2, text: 'x' },
    ]);
    const plain = await sentView.buildPrompt('nothing attached', [], []);
    sentView.attachedNote = wasAttached;
    notesOnDisk.delete('New.md');
    const carriedOk = built.notes.join(',') === 'New.md,Sel.md' && plain.notes.length === 0;
    console.log(`notes a message carries: ${built.notes.join(',')}; none without any ${plain.notes.length === 0} -> ${carriedOk}`);
    if (!carriedOk) process.exitCode = 1;
    // Sent before the chat has an id: linked once the id arrives, not before; the scratch chat links nothing.
    const savedIds = { chatId: sentView.chatId, scratch: sentView.scratch };
    sentView.chatId = null;
    sentView.scratch = false;
    sentView.linkSentNotes(['First.md']);
    const beforeId = noteRefCalls.length;
    sentView.chatId = 'new-chat';
    sentView.linkSentNotes([]);
    sentView.scratch = true;
    sentView.linkSentNotes(['Scratch.md']);
    Object.assign(sentView, savedIds);
    const linkedOk = beforeId === 0 && noteRefCalls.join(',') === 'First.md@new-chat';
    console.log(`sent notes linked: waited for the id ${beforeId === 0}; linked ${noteRefCalls.join(',')} -> ${linkedOk}`);
    if (!linkedOk) process.exitCode = 1;

    // The scratch chat: fixed title, its own mark and welcome, and no renaming.
    welcomeLink?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const scratchTitleEl = root.querySelector('.vc-chat-title') as HTMLElement;
    const scratchWelcome = root.querySelector('.vc-welcome')?.textContent ?? '';
    const scratchOk =
      scratchTitleEl.textContent === 'Scratch' &&
      !scratchTitleEl.hasClass('is-renamable') &&
      view.isScratchChat() &&
      (view as unknown as { modelOverride?: string }).modelOverride === 'sonnet' &&
      scratchWelcome.startsWith('Scratch chat') &&
      scratchWelcome.includes('24 hours idle') &&
      !root.querySelector('.vc-welcome .vc-welcome-link') &&
      clearButton.isShown() &&
      clearButton.getAttribute('aria-label') === 'Clear the scratch chat: it starts over' &&
      linkBefore &&
      (view as unknown as { inputEl: HTMLTextAreaElement }).inputEl.placeholder === 'Ask something quick — this chat clears itself…';
    // Claude Code's own title for the session must not replace it.
    (view as unknown as { setChatTitle(title: string): void }).setChatTitle('Inbox review');
    const keptName = scratchTitleEl.textContent === 'Scratch';
    console.log(`scratch chat: title "${scratchTitleEl.textContent}"; welcome ${JSON.stringify(scratchWelcome.slice(0, 30))}; name kept ${keptName} -> ${scratchOk && keptName}`);
    if (!scratchOk || !keptName) process.exitCode = 1;

    // Turned off, an empty chat stops offering it; the opening lines are redrawn where they are shown.
    plugin.settings.scratchChat = false;
    view.newChat();
    const offerGone = !root.querySelector('.vc-welcome .vc-welcome-link');
    plugin.settings.scratchChat = true;
    view.refreshWelcome();
    const offerBack = !!root.querySelector('.vc-welcome .vc-welcome-link');
    console.log(`scratch offer follows the setting: off ${offerGone}; on ${offerBack}`);
    if (!offerGone || !offerBack) process.exitCode = 1;
    await (view as unknown as { openScratch(): Promise<void> }).openScratch();

    // Opened while another panel shows it: shown there, and its session kept, not started over.
    const scratchStubs = { chatHolder: plugin.chatHolder, scratchSession: plugin.scratchSession, clearScratch: plugin.clearScratch };
    const shownIn: string[] = [];
    let scratchCleared = 0;
    Object.assign(plugin, {
      scratchSession: () => 'held-scratch',
      chatHolder: (id: string) => (id === 'held-scratch' ? { showHeldChat: async (held: string) => void shownIn.push(held) } : null),
      clearScratch: async () => void (scratchCleared += 1),
    });
    const titleBefore = scratchTitleEl.textContent;
    await (view as unknown as { openScratch(): Promise<void> }).openScratch();
    const heldKept = shownIn.join() === 'held-scratch' && scratchCleared === 0 && scratchTitleEl.textContent === titleBefore;
    // Its file gone (nothing to read), it starts over.
    Object.assign(plugin, { scratchSession: () => 'gone-scratch', chatHolder: () => null });
    await (view as unknown as { openScratch(): Promise<void> }).openScratch();
    const goneStartsOver = scratchCleared === 1 && view.isScratchChat();
    Object.assign(plugin, scratchStubs);
    console.log(`scratch held by another panel: shown there ${heldKept}; one that cannot be read starts over ${goneStartsOver}`);
    if (!heldKept || !goneStartsOver) process.exitCode = 1;

    // A scratch reply carries on as a chat: named after the note it made, linked to the notes the copy
    // changed (not those of later turns), and opened with its own opening lines. A real session file,
    // under a Claude Code config dir of the test's own, is copied by the SDK.
    {
      const { randomUUID } = await import('node:crypto');
      const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { projectFolder } = await import('../src/history');
      const config = mkdtempSync(`${tmpdir()}/vault-claude-continue-`);
      const configWas = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = config;
      const scratchId = randomUUID();
      const [u1, a1, r1, a2, u2, a3, r2, a4] = Array.from({ length: 8 }, () => randomUUID());
      const row = (uuid: string, parentUuid: string | null, type: 'user' | 'assistant', content: unknown, extra: object = {}) =>
        JSON.stringify({ type, uuid, parentUuid, sessionId: scratchId, cwd: '/tmp', timestamp: new Date().toISOString(), message: { role: type, content }, ...extra });
      const rows = [
        row(u1, null, 'user', 'Make a note on fiscal unions'),
        row(a1, u1, 'assistant', [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/tmp/Fiscal unions.md', content: 'x' } }]),
        row(r1, a1, 'user', [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }], {
          toolUseResult: { type: 'create', filePath: '/tmp/Fiscal unions.md', content: 'x', structuredPatch: [] },
        }),
        row(a2, r1, 'assistant', [{ type: 'text', text: 'Written.' }]),
        row(u2, a2, 'user', 'Something else entirely'),
        row(a3, u2, 'assistant', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/tmp/Later.md', old_string: 'a', new_string: 'b' } }]),
        row(r2, a3, 'user', [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }]),
        row(a4, r2, 'assistant', [{ type: 'text', text: 'Changed.' }]),
      ];
      const dir = `${config}/projects/${projectFolder('/tmp')}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/${scratchId}.jsonl`, `${rows.join('\n')}\n`);
      const continueView = view as unknown as {
        chatId: string | null;
        messagesEl: HTMLElement;
        openScratch(): Promise<void>;
        branch(upTo: string, newTab: boolean): Promise<void>;
      };
      const continuePlugin = plugin as unknown as Record<string, unknown>;
      const continueWas = { recordChat: continuePlugin.recordChat, scratchSession: continuePlugin.scratchSession };
      const recordedChats: string[] = [];
      continuePlugin.recordChat = (id: string, title: string) => void recordedChats.push(`${id}:${title}`);
      // Reopened as the scratch chat, as after a restart: its replies are drawn as the scratch chat's.
      continuePlugin.scratchSession = () => scratchId;
      const linksBefore = plugin.noteLinks.length;
      view.newChat();
      await continueView.openScratch();
      const firstTurn = continueView.messagesEl.querySelector<HTMLElement>(`.vc-turn[data-branch-uuid="${a2}"]`);
      const labels = [...continueView.messagesEl.querySelectorAll('.vc-turn.has-branch .vc-turn-actions button:last-child')].map((el) => el.getAttribute('aria-label'));
      const lines = [...continueView.messagesEl.querySelectorAll('.vc-continue-line')].map((el) => el.textContent);
      const offered =
        labels.join() === 'Continue as a chat,Continue as a chat' &&
        JSON.stringify(lines) === JSON.stringify(['Continue in a chat about “Fiscal unions”']) &&
        firstTurn?.querySelector('.vc-continue-line') !== null &&
        view.isScratchChat() &&
        continueView.chatId === scratchId &&
        plugin.noteLinks.length === linksBefore;
      await continueView.branch(a2, false);
      const newId = recordedChats[0]?.split(':')[0] ?? '';
      const linksAfter = plugin.noteLinks.slice(linksBefore);
      const opened = [...continueView.messagesEl.querySelectorAll('.vc-resumed')].map((el) => el.textContent);
      const carried =
        JSON.stringify(recordedChats) === JSON.stringify([`${newId}:Fiscal unions`]) &&
        newId !== scratchId &&
        linksAfter[0] === `Fiscal unions.md@${newId}` &&
        !linksAfter.some((link) => link.startsWith('Later.md')) &&
        !view.isScratchChat() &&
        continueView.chatId === newId &&
        opened[0] === 'Carried on from the scratch chat' &&
        opened[opened.length - 1] === 'New messages continue this chat; the scratch chat is unchanged.';
      // Without a note, the prompt answered names it.
      await continueView.openScratch();
      recordedChats.length = 0;
      await continueView.branch(a4, false);
      const promptNamed = recordedChats[0]?.endsWith(':Something else entirely') === true;
      // Copied from a message of yours on: the copy starts there, is named by it, and is linked to
      // what its replies changed only.
      await continueView.openScratch();
      recordedChats.length = 0;
      plugin.noteLinks.length = linksBefore;
      continuePlugin.openChatTab = async () => view;
      const bubbleButtons = [...continueView.messagesEl.querySelectorAll('.vc-user[data-uuid] .vc-user-action')].map((el) => el.getAttribute('aria-label'));
      continueView.messagesEl.querySelector<HTMLElement>(`.vc-user[data-uuid="${u2}"] .vc-user-action`)?.click();
      for (const end = Date.now() + 5000; !continueView.messagesEl.querySelector('.vc-resumed') || recordedChats.length === 0; ) {
        if (Date.now() > end) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const fromId = recordedChats[0]?.split(':')[0] ?? '';
      const { loadTranscript } = await import('../src/history');
      const copiedPrompts = (await loadTranscript(fromId, '/tmp')).filter((m) => m.type === 'user' && typeof (m.message as { content?: unknown }).content === 'string').map((m) => (m.message as { content: string }).content);
      const fromLinks = plugin.noteLinks.slice(linksBefore).filter((link) => !link.endsWith('(kept back)'));
      const copiedFrom =
        bubbleButtons.join() === 'Copy from here on to a new chat,Copy from here on to a new chat' &&
        JSON.stringify(recordedChats) === JSON.stringify([`${fromId}:Something else entirely`]) &&
        JSON.stringify(copiedPrompts) === JSON.stringify(['Something else entirely']) &&
        JSON.stringify(fromLinks) === JSON.stringify([`Later.md@${fromId}`]) &&
        continueView.chatId === fromId;
      delete continuePlugin.openChatTab;
      Object.assign(continuePlugin, continueWas);
      plugin.noteLinks.length = linksBefore;
      view.newChat();
      if (configWas === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = configWas;
      rmSync(config, { recursive: true, force: true });
      console.log(
        `scratch continued as a chat: offered ${offered} (${labels.join()}; ${JSON.stringify(lines)}); carried on ${carried} (${JSON.stringify(recordedChats)}, links ${JSON.stringify(linksAfter)}, lines ${JSON.stringify(opened)}); named by its prompt ${promptNamed}; copied from a message on ${copiedFrom} (${bubbleButtons.join()}; ${JSON.stringify(recordedChats)}; prompts ${JSON.stringify(copiedPrompts)}; links ${JSON.stringify(fromLinks)})`,
      );
      if (!offered || !carried || !promptNamed || !copiedFrom) process.exitCode = 1;
    }

    // A vault file named in bold is a link; a subagent's edit joins the reply's changed files; a
    // background agent's changes show under its notice, their notes linked to the chat.
    {
      const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const agentView = view as unknown as {
        chatId: string | null;
        messagesEl: HTMLElement;
        renderTranscript(t: unknown[]): void;
        onMessage(message: unknown): void;
      };
      view.newChat();
      agentView.chatId = 'agent-chat';
      agentView.renderTranscript([entry('lu1', 'user', 'which note?'), entry('la1', 'assistant', [{ type: 'text', text: '**New.md**' }])]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const named = agentView.messagesEl.querySelector<HTMLElement>('.vc-text strong.vc-file-link')?.dataset.path;
      // A subagent's Write, live, while the reply waits for its Agent call; once that call has
      // returned (an agent sent to the background), its edits show under its notice instead.
      const subagent = (id: string, file: string) => {
        agentView.onMessage({ type: 'assistant', parent_tool_use_id: 'task-1', uuid: `${id}a`, session_id: 'agent-chat', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content: 'x' } }] } });
        agentView.onMessage({ type: 'user', parent_tool_use_id: 'task-1', uuid: `${id}u`, session_id: 'agent-chat', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
      };
      agentView.onMessage({ type: 'assistant', parent_tool_use_id: null, uuid: 'ag1', session_id: 'agent-chat', message: { content: [{ type: 'tool_use', id: 'task-1', name: 'Agent', input: { description: 'write' } }] } });
      subagent('sw1', '/tmp/Sub note.md');
      agentView.onMessage({ type: 'user', parent_tool_use_id: null, uuid: 'ag2', session_id: 'agent-chat', message: { content: [{ type: 'tool_result', tool_use_id: 'task-1', content: 'started in the background' }] } });
      subagent('sw2', '/tmp/Later note.md');
      const subCard = [...agentView.messagesEl.querySelectorAll('.vc-changes .vc-edit-file')].map((el) => el.textContent);
      // A background agent's notice, its output file a link to its transcript.
      const dir = mkdtempSync(`${tmpdir()}/vault-claude-agent-`);
      const lines = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bw1', name: 'Write', input: { file_path: '/tmp/Agent note.md', content: 'a\nb' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bw1', content: 'ok' }] } },
      ];
      writeFileSync(`${dir}/agent-b1.jsonl`, lines.map((line) => JSON.stringify(line)).join('\n'));
      symlinkSync(`${dir}/agent-b1.jsonl`, `${dir}/b1.output`);
      const linksBefore = plugin.noteLinks.length;
      agentView.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', output_file: `${dir}/b1.output`, summary: 'Agent "Write the note" completed', uuid: 'tn1', session_id: 'agent-chat' });
      for (const end = Date.now() + 2000; !agentView.messagesEl.querySelector('.vc-task .vc-changes') && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 10));
      const agentCard = [...agentView.messagesEl.querySelectorAll('.vc-task .vc-changes .vc-edit-file')].map((el) => el.textContent);
      const agentLinks = plugin.noteLinks.slice(linksBefore);
      rmSync(dir, { recursive: true, force: true });
      plugin.noteLinks.length = linksBefore;
      view.newChat();
      // A note the chat read is recorded as mentioned, under the chat's id; one from outside the
      // panel under its own session; the scratch chat records none.
      const mentionView = agentView as unknown as { resumeId: string | null; scratch: boolean; recordMentions(): void };
      agentView.renderTranscript([
        entry('mu1', 'user', 'read it'),
        entry('ma1', 'assistant', [{ type: 'tool_use', id: 'mr1', name: 'Read', input: { file_path: '/tmp/New.md' } }]),
        entry('mu2', 'user', [{ type: 'tool_result', tool_use_id: 'mr1', content: 'x' }]),
        entry('ma2', 'assistant', [{ type: 'text', text: 'Read.' }]),
      ]);
      notesOnDisk.set('New.md', '');
      plugin.mentionLinks.length = 0;
      agentView.chatId = 'agent-chat';
      mentionView.recordMentions();
      agentView.chatId = null;
      mentionView.resumeId = 'outside-1';
      mentionView.recordMentions();
      mentionView.scratch = true;
      mentionView.recordMentions();
      mentionView.scratch = false;
      mentionView.resumeId = null;
      const mentions = [...plugin.mentionLinks];
      // A note's name in bold, linked once the reply's Markdown is in, is recorded then.
      notesOnDisk.set('Linked.md', '');
      plugin.mentionLinks.length = 0;
      agentView.chatId = 'agent-chat';
      agentView.renderTranscript([entry('lu9', 'user', 'which?'), entry('la9', 'assistant', [{ type: 'text', text: '**Linked.md**' }])]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const boldMention = plugin.mentionLinks.includes('Linked.md@agent-chat');
      notesOnDisk.delete('Linked.md');
      notesOnDisk.delete('New.md');
      const agentOk =
        JSON.stringify(mentions) === JSON.stringify(['New.md@agent-chat', 'New.md@outside-1']) &&
        boldMention &&
        named === 'New.md' && JSON.stringify(subCard) === '["Sub note.md"]' && JSON.stringify(agentCard) === '["Agent note.md"]' && JSON.stringify(agentLinks) === '["Agent note.md@agent-chat"]';
      console.log(`mentions recorded ${JSON.stringify(mentions)}; file names linked ${named}; subagent edit in the card ${JSON.stringify(subCard)}; background agent's changes ${JSON.stringify(agentCard)}, linked ${JSON.stringify(agentLinks)} -> ${agentOk}`);
      if (!agentOk) process.exitCode = 1;
    }

    // Turning the scratch chat off hands the open one over as an ordinary chat.
    (view as unknown as { chatId: string | null }).chatId = 'scratch-session';
    view.keepScratchAsChat();
    const handedOver =
      !view.isScratchChat() &&
      clearButton.getAttribute('aria-label') === 'Delete this chat' &&
      (view as unknown as { inputEl: HTMLTextAreaElement }).inputEl.placeholder === 'Ask Claude about this vault…';
    console.log(`scratch kept as an ordinary chat: ${handedOver}`);
    if (!handedOver) process.exitCode = 1;

    // The trash button deletes the chat on screen once confirmed: the panel starts a new chat first.
    {
      const deleted: string[] = [];
      const deletePlugin = plugin as unknown as Record<string, unknown>;
      deletePlugin.deleteChat = async (id: string) => void deleted.push(id);
      (view as unknown as { chatName: string | null }).chatName = 'Old question';
      stub.Modal.last = null;
      clearButton.click();
      const asked = stub.Modal.last as unknown as { message: string; onConfirm(): void } | null;
      const askedFirst = deleted.length === 0 && asked?.message.startsWith('“Old question” and its saved conversation will be deleted') === true;
      asked?.onConfirm();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const deleteOk = askedFirst && JSON.stringify(deleted) === '["scratch-session"]' && (view as unknown as { chatId: string | null }).chatId === null && !clearButton.isShown();
      delete deletePlugin.deleteChat;
      console.log(`delete button: asks first ${askedFirst}; deletes ${JSON.stringify(deleted)} after a new chat starts -> ${deleteOk}`);
      if (!deleteOk) process.exitCode = 1;
    }

    // The back button: shown after a note sends the panel to another chat, gone once a new chat starts.
    const backView = view as unknown as { backChat: { id: string; title: string } | null; updateChatButtons(): void };
    const backEl = root.querySelector('.vc-back-line') as HTMLElement;
    backView.backChat = { id: 'prev', title: 'Earlier chat' };
    backView.updateChatButtons();
    const backShown = backEl.isShown() && backEl.textContent === '← Back to “Earlier chat”×';
    // The × dismisses the line without going anywhere.
    (backEl.querySelector('.vc-back-close') as HTMLElement).click();
    const dismissed = !backEl.isShown() && backView.backChat === null;
    backView.backChat = { id: 'prev', title: 'Earlier chat' };
    backView.updateChatButtons();

    view.newChat();
    const backGone = !backEl.isShown() && backView.backChat === null;
    console.log(`back line: shown after a jump ${backShown}; dismissed by the × ${dismissed}; gone in a new chat ${backGone}`);
    if (!backShown || !dismissed || !backGone) process.exitCode = 1;
    console.log(`newChat completed; save button: ${internals.saveButton.isShown()}`);
    const clearedOk = !(root.querySelector('.vc-find') as HTMLElement).isShown();
    console.log(`new chat closes find: ${clearedOk}`);
    if (!clearedOk) process.exitCode = 1;
    // A new chat lists the panel's keys (macOS, ⌘↩ sends by default); the input keeps a plain placeholder.
    const welcome = [...root.querySelectorAll('.vc-welcome > div')].map((el) => el.textContent).join('\n');
    const placeholder = (view as unknown as { inputEl: HTMLTextAreaElement }).inputEl.placeholder;
    const welcomeOk =
      welcome ===
        'Claude Code, running in this vault\n⌘↩ send · ↑ last message · @ file · / command\n⌥↑↓ your messages · ⌘F find\nOpen the scratch chat for daily odds and ends' &&
      placeholder === 'Ask Claude about this vault…';
    console.log(`new chat lists the keys: ${welcomeOk}`);
    if (!welcomeOk) {
      console.log(JSON.stringify({ welcome, placeholder }));
      process.exitCode = 1;
    }
    // Text typed and not sent stays with its chat: a switch clears the input, and coming back restores it.
    const unsentView = view as unknown as { inputEl: HTMLTextAreaElement; chatId: string | null; restoreDraft(): void };
    view.newChat();
    unsentView.chatId = 'chat-a';
    unsentView.inputEl.value = 'half a thought';
    view.newChat();
    const clearedOnSwitch = unsentView.inputEl.value === '';
    unsentView.inputEl.value = 'for a new chat';
    view.newChat();
    unsentView.chatId = 'chat-a';
    unsentView.restoreDraft();
    const backInChat = unsentView.inputEl.value === 'half a thought';
    view.newChat();
    const backInNew = unsentView.inputEl.value === 'for a new chat';
    unsentView.inputEl.value = '';
    view.newChat();
    const emptyForgotten = unsentView.inputEl.value === '';
    const unsentOk = clearedOnSwitch && backInChat && backInNew && emptyForgotten;
    console.log(`unsent text per chat: cleared ${clearedOnSwitch}; back in its chat ${backInChat}; back in a new chat ${backInNew}; emptied stays empty ${emptyForgotten} -> ${unsentOk}`);
    if (!unsentOk) process.exitCode = 1;
    // The attached note belongs to its chat: a new chat starts with none, another chat has its own,
    // and coming back finds it, kept in the plugin's data rather than the panel.
    const noteView = view as unknown as {
      chatId: string | null;
      attachedNote: string | null;
      inputEl: HTMLTextAreaElement;
      restoreDraft(): void;
      attachNote(path: string | null): void;
      moveDraft(from: string): void;
      localDrafts: Map<string, unknown>;
    };
    const drafts = (plugin as unknown as { drafts: Record<string, { text?: string; note?: string }> }).drafts;
    view.newChat();
    const startsEmpty = noteView.attachedNote === null;
    noteView.chatId = 'chat-n';
    noteView.attachNote('Kept.md');
    view.newChat();
    const otherHasNone = noteView.attachedNote === null;
    noteView.chatId = 'chat-n';
    noteView.restoreDraft();
    const keptWithChat = noteView.attachedNote === 'Kept.md' && drafts['chat-n']?.note === 'Kept.md';
    // A new chat's note and text move to its id when Claude Code gives it one.
    view.newChat();
    noteView.attachNote('Fresh.md');
    noteView.inputEl.value = 'typed before the id';
    noteView.chatId = 'fresh-id';
    noteView.moveDraft('');
    const moved = drafts['fresh-id']?.note === 'Fresh.md' && drafts['fresh-id']?.text === 'typed before the id' && !noteView.localDrafts.has('');
    noteView.inputEl.value = '';
    view.newChat();
    const noteOk = startsEmpty && otherHasNone && keptWithChat && moved;
    console.log(`attached note per chat: none to start ${startsEmpty}; none in another chat ${otherHasNone}; kept with its chat ${keptWithChat}; moved to the new id ${moved} -> ${noteOk}`);
    if (!noteOk) process.exitCode = 1;
    const sys = (fields: Record<string, unknown>) => ({ type: 'system', uuid: 'u', session_id: 's', ...fields }) as never;

    // A chat whose reply is done but whose background tasks still run keeps its process when you
    // switch away; it is closed after the turn that follows its last task. Without tasks, as before.
    const bgView = view as unknown as {
      session: unknown;
      busy: boolean;
      chatId: string | null;
      tasks: Set<string>;
      background: Set<unknown>;
    };
    let closes = 0;
    let handlers: { onMessage(message: unknown): void } | null = null;
    const stoppedTasks: string[] = [];
    const fakeSession = () => ({
      setHandlers(h: { onMessage(message: unknown): void }) {
        handlers = h;
      },
      close() {
        closes += 1;
      },
      enableRemoteControl: async () => undefined,
      stopTask: async (id: string) => void stoppedTasks.push(id),
    });
    view.newChat();
    bgView.session = fakeSession();
    bgView.chatId = 'bg-chat';
    bgView.busy = false;
    bgView.tasks = new Set(['t1']);
    // An edit still running when the chat goes off screen.
    const editOf = (path: string) => ({ file_path: path, old_string: 'a', new_string: 'b' });
    (view as unknown as { tools: Map<string, unknown> }).tools.set('s1', { name: 'Edit', input: editOf('/tmp/Started.md'), status: 'running', lineEl: null, group: null });
    view.newChat();
    const keptOnSwitch = closes === 0 && bgView.background.size === 1;
    // Its status in the history says why it runs; it is not on the phone.
    const bgStatus = (view as unknown as { chatStatuses(): Map<string, string> }).chatStatuses().get('bg-chat');
    const statusOk = bgStatus === '1 task in the background';
    console.log(`background chat status: "${bgStatus}" (expected "1 task in the background") -> ${statusOk}`);
    if (!statusOk) process.exitCode = 1;
    // A chat open in a panel is marked, by either of its ids.
    const openStatuses = (view as unknown as { chatStatuses(): Map<string, string>; chatId: string | null; resumeId: string | null });
    const heldChat = openStatuses.chatId;
    openStatuses.chatId = null;
    openStatuses.resumeId = 'reopened';
    const reopenedStatus = openStatuses.chatStatuses().get('reopened');
    openStatuses.chatId = heldChat;
    openStatuses.resumeId = null;
    const openOk = reopenedStatus === 'Open';
    console.log(`a chat reopened from the history is marked Open: ${reopenedStatus} -> ${openOk}`);
    if (!openOk) process.exitCode = 1;

    // The history offers to stop them, and stopping reaches the chat in the background.
    const withTasks = (plugin as unknown as { chatViews?: unknown }) && (view as unknown as { chatsWithTasks(): string[] }).chatsWithTasks();
    const stoppedFromHistory = (view as unknown as { stopTasksOf(id: string): boolean }).stopTasksOf('bg-chat') && stoppedTasks.join(',') === 't1';
    console.log(`background tasks from the history: listed ${withTasks.join(',')}; stopped ${stoppedTasks.join(',')} -> ${withTasks.join(',') === 'bg-chat' && stoppedFromHistory}`);
    if (withTasks.join(',') !== 'bg-chat' || !stoppedFromHistory) process.exitCode = 1;
    stoppedTasks.length = 0;

    // Edits it finishes off screen link the notes they changed, as the chat on screen does: one it
    // started on screen too, and a shell command's. A failed edit does not, nor one outside the vault.
    const noteLinksBefore = plugin.noteLinks.length;
    const bgSend = (message: unknown) => (handlers as { onMessage(message: unknown): void } | null)?.onMessage(message);
    const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
    const toolResult = (id: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: isError ? 'failed' : 'ok', ...(isError ? { is_error: true } : {}) });
    bgSend({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [toolUse('e1', 'Edit', editOf('/tmp/Off Screen.md')), toolUse('e2', 'Edit', editOf('/tmp/Failed.md')), toolUse('e3', 'Edit', editOf('/elsewhere/Out.md'))] },
    });
    bgSend({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [toolResult('s1'), toolResult('e1'), toolResult('e2', true), toolResult('e3')] } });
    bgSend({ type: 'assistant', parent_tool_use_id: null, message: { content: [toolUse('b1', 'Bash', { command: "sed -i '' s/a/b/ Shell.md" })] } });
    bgSend({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [toolResult('b1')] },
      tool_use_result: { bashEditDiff: { files: [{ filePath: '/tmp/Shell.md', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }] } },
    });
    // The scratch chat links no notes, off screen as on.
    const scratchWas = plugin.scratch;
    plugin.scratch = { id: 'bg-chat', usedAt: 0 };
    bgSend({ type: 'assistant', parent_tool_use_id: null, message: { content: [toolUse('e4', 'Edit', editOf('/tmp/Scratch.md'))] } });
    bgSend({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [toolResult('e4')] } });
    plugin.scratch = scratchWas;
    const bgLinks = plugin.noteLinks.slice(noteLinksBefore);
    // A shell command's reported change links nothing: it may be another chat's, made meanwhile.
    const bgLinksOk = JSON.stringify(bgLinks) === JSON.stringify(['Started.md@bg-chat', 'Off Screen.md@bg-chat']);
    console.log(`notes linked by edits a background chat finishes: ${JSON.stringify(bgLinks)} -> ${bgLinksOk}`);
    if (!bgLinksOk) process.exitCode = 1;

    const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, user_message_uuids: [] };
    (handlers as { onMessage(message: unknown): void } | null)?.onMessage(result);
    const keptAfterReply = closes === 0 && bgView.background.size === 1;
    (handlers as { onMessage(message: unknown): void } | null)?.onMessage(sys({ subtype: 'task_notification', task_id: 't1', status: 'completed' }));
    (handlers as { onMessage(message: unknown): void } | null)?.onMessage({ type: 'stream_event', event: {}, parent_tool_use_id: null });
    (handlers as { onMessage(message: unknown): void } | null)?.onMessage(result);
    const closedAfterTasks = closes === 1 && bgView.background.size === 0;
    // Finished off screen, it is marked in the history until it is shown.
    const unseenMarks = (plugin as unknown as { unseen: Record<string, string> }).unseen;
    const markedUnseen = unseenMarks['bg-chat'] === 'done';
    bgView.chatId = 'bg-chat';
    (view as unknown as { seeChat(): void }).seeChat();
    const clearedWhenShown = !('bg-chat' in unseenMarks);
    bgView.chatId = null;
    console.log(`finished chat marked until shown: marked ${markedUnseen}; cleared when shown ${clearedWhenShown}`);
    if (!markedUnseen || !clearedWhenShown) process.exitCode = 1;
    bgView.session = fakeSession();
    bgView.chatId = 'idle-chat';
    bgView.busy = false;
    view.newChat();
    const idleClosed = closes === 2 && bgView.background.size === 0;
    const bgOk = keptOnSwitch && keptAfterReply && closedAfterTasks && idleClosed;
    console.log(`process kept for background tasks: on a switch ${keptOnSwitch}; after the reply ${keptAfterReply}; closed after the last task's turn ${closedAfterTasks}; idle chat still closed ${idleClosed} -> ${bgOk}`);
    if (!bgOk) process.exitCode = 1;

    // The messages a turn answers (a side chat's fork ends before them) go with a chat to the
    // background, follow a turn that starts there, and come back with it.
    const carry = view as unknown as {
      turnPrompts: string[];
      busy: boolean;
      readForOpening: unknown;
      showBackground(entry: unknown): Promise<void>;
      background: Set<{ chatId: string | null; busy: boolean; turnPrompts: string[] }>;
    };
    bgView.session = fakeSession();
    bgView.chatId = 'carry-chat';
    carry.busy = true;
    carry.turnPrompts = ['p1'];
    view.newChat();
    const carried = [...carry.background].find((entry) => entry.chatId === 'carry-chat');
    const onDetach = carried?.turnPrompts.join(',');
    if (carried) carried.busy = false;
    // A subagent's frame first: it names no prompts, and the turn's own first frame does.
    (handlers as { onMessage(message: unknown): void } | null)?.onMessage({ type: 'stream_event', event: {}, parent_tool_use_id: 'task-1' });
    (handlers as { onMessage(message: unknown): void } | null)?.onMessage({ type: 'stream_event', event: {}, parent_tool_use_id: null, user_message_uuids: ['p2'] });
    const offScreen = carried?.turnPrompts.join(',');
    carry.readForOpening = async () => ({ chat: { transcript: [], edits: new Map() }, readMs: 0 });
    if (carried) await carry.showBackground(carried);
    delete (carry as unknown as Record<string, unknown>).readForOpening;
    const shownAgain = carry.turnPrompts.join(',');
    carry.busy = false;
    view.newChat();
    const carryOk = onDetach === 'p1' && offScreen === 'p2' && shownAgain === 'p2';
    console.log(`turn prompts through the background: on leaving "${onDetach}"; a turn begun off screen "${offScreen}"; shown again "${shownAgain}" -> ${carryOk}`);
    if (!carryOk) process.exitCode = 1;
    // A resumed chat: Claude Code first ends a turn of its own (a leftover task notice), then replies
    // to the message sent here. Every result ends the turn it finds — one that answers no message
    // may still carry the reply's own text — and a reply stamped with a message sent here starts
    // this panel's turn, never a bubble labelled as sent from elsewhere.
    const turnView = view as unknown as {
      onMessage(message: unknown): void;
      beginTurn(): void;
      busy: boolean;
      sentIds: Set<string>;
      messagesEl: HTMLElement;
      turnPrompts: string[];
    };
    view.newChat();
    const finished = (ids?: string[], text = '') => ({
      type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: 16, duration_api_ms: 0, num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 }, ...(ids ? { user_message_uuids: ids } : {}),
    });
    turnView.sentIds.add('mine');
    turnView.beginTurn();
    // A result with no ids still ends the turn, and its text is shown: it may be the reply itself.
    turnView.onMessage(finished(undefined, 'The answer, carried by the result.'));
    const endedAndKeptText = !turnView.busy && turnView.messagesEl.textContent?.includes('The answer, carried by the result.') === true;
    // The reply that follows is this panel's turn, so the message sent here is not drawn again.
    turnView.onMessage({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'ping' }, user_message_uuids: ['mine'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const noDuplicate = turnView.busy && !turnView.messagesEl.querySelector('.vc-origin-label');
    // The turn knows the messages it answers (a side chat's fork ends before them) until it ends.
    const promptsDuring = turnView.turnPrompts.join(',');
    turnView.onMessage(finished(['mine']));
    const promptsAfter = turnView.turnPrompts.join(',');
    const leftoverOk = endedAndKeptText && noDuplicate && promptsDuring === 'mine' && promptsAfter === '';
    console.log(
      `resumed chat: a result with no ids ends the turn and keeps its text ${endedAndKeptText}; own message not drawn again ${noDuplicate}; the turn's prompts "${promptsDuring}", then "${promptsAfter}" -> ${leftoverOk}`,
    );
    if (!leftoverOk) process.exitCode = 1;
    view.newChat();
    // Streamed text is written once a frame, not once a token (a layout per token while it streams).
    view.newChat();
    const stream = view as unknown as { onMessage(message: unknown): void; beginTurn(): void };
    stream.beginTurn();
    const delta = (text: string) => ({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
    for (const piece of ['Hel', 'lo ', 'wor', 'ld']) stream.onMessage(delta(piece));
    const beforeFrame = root.querySelector('.vc-live')?.textContent;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterFrame = root.querySelector('.vc-live')?.textContent;
    // What is still buffered when the reply ends is written with it.
    stream.onMessage(delta(' again'));
    (view as unknown as { finishTurnUi(): void }).finishTurnUi();
    const afterEnd = root.querySelector('.vc-text')?.textContent;
    const liveOk = beforeFrame === '' && afterFrame === 'Hello world' && afterEnd === 'Hello world again';
    console.log(`streamed text batched: before the frame "${beforeFrame}"; after "${afterFrame}"; at the end "${afterEnd}" -> ${liveOk}`);
    if (!liveOk) process.exitCode = 1;
    view.newChat();
    // After a reply, while its background tasks still run, Stop stays and stops the tasks.
    view.newChat();
    const stopView = view as unknown as { session: unknown; tasks: Set<string>; busy: boolean; onMessage(message: unknown): void };
    const stopButtonEl = [...root.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Stop')) as HTMLElement;
    const stoppedOnScreen: string[] = [];
    stopView.session = { stopTask: async (id: string) => void stoppedOnScreen.push(id), close() {}, setHandlers() {} };
    stopView.busy = false;
    stopView.onMessage({ type: 'system', subtype: 'task_started', task_id: 'agent-1', is_backgrounded: true, description: '', uuid: 'u', session_id: 's' });
    const labelForTasks = stopButtonEl.textContent;
    const tabWithTasks = view.getDisplayText();
    const shownForTasks = stopButtonEl.isShown() && labelForTasks === 'Stop 1 task';
    stopButtonEl.click();
    const stoppedOk = stoppedOnScreen.join(',') === 'agent-1';
    stopView.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'stopped', summary: 'Audit', output_file: '', uuid: 'u', session_id: 's' });
    const hiddenAfter = !stopButtonEl.isShown();
    const tabAfter = view.getDisplayText();
    const tabTasksOk = tabWithTasks.endsWith('(1 task in the background)') && !tabAfter.includes('task');
    console.log(`tab with background tasks: "${tabWithTasks}"; after: "${tabAfter}" -> ${tabTasksOk}`);
    if (!tabTasksOk) process.exitCode = 1;
    stopView.session = null;
    const stopOk = shownForTasks && stoppedOk && hiddenAfter;
    console.log(`Stop for background tasks: shown "${labelForTasks}" ${shownForTasks}; stopped ${stoppedOnScreen.join(',')}; hidden once they end ${hiddenAfter} -> ${stopOk}`);
    if (!stopOk) process.exitCode = 1;
    view.newChat();
    // Selecting text in a reply shows the Quote button above it; a click quotes it in the input.
    view.newChat();
    const quoteReply = root.querySelector('.vc-messages') as HTMLElement;
    const replyEl = quoteReply.createDiv({ cls: 'vc-text' });
    replyEl.textContent = 'A sentence worth asking about.';
    const quoteRange = document.createRange();
    quoteRange.selectNodeContents(replyEl);
    // jsdom has no layout: give the range the geometry a browser would.
    const box = { top: 100, bottom: 120, left: 40, right: 200, width: 160, height: 20, x: 40, y: 100 };
    (quoteRange as unknown as { getClientRects(): unknown[] }).getClientRects = () => [box];
    const panelBox = { top: 0, bottom: 400, left: 0, right: 300, width: 300, height: 400, x: 0, y: 0 };
    const wrapEl = quoteReply.parentElement as HTMLElement;
    const layoutBefore = [quoteReply.getBoundingClientRect, wrapEl.getBoundingClientRect];
    quoteReply.getBoundingClientRect = () => panelBox as DOMRect;
    wrapEl.getBoundingClientRect = () => panelBox as DOMRect;
    dom.window.getSelection()?.removeAllRanges();
    dom.window.getSelection()?.addRange(quoteRange);
    (view as unknown as { placeQuoteButton(): void }).placeQuoteButton();
    const quoteBtn = root.querySelector('.vc-quote-button') as HTMLElement;
    const quoteShown = quoteBtn.isShown();
    // Scrolled out of view it goes; scrolled back, it returns.
    const scrolledAway = { ...box, top: -200, bottom: -180, y: -200 };
    (quoteRange as unknown as { getClientRects(): unknown[] }).getClientRects = () => [scrolledAway];
    quoteReply.dispatchEvent(new dom.window.Event('scroll'));
    const goneWhenAway = !quoteBtn.isShown();
    (quoteRange as unknown as { getClientRects(): unknown[] }).getClientRects = () => [box];
    quoteReply.dispatchEvent(new dom.window.Event('scroll'));
    const backWhenBack = quoteBtn.isShown();
    console.log(`Quote button on scroll: gone when away ${goneWhenAway}; back when scrolled back ${backWhenBack}`);
    if (!goneWhenAway || !backWhenBack) process.exitCode = 1;
    quoteBtn.click();
    const quotedInput = (view as unknown as { inputEl: HTMLTextAreaElement }).inputEl.value;
    const quoteBtnOk = quoteShown && quotedInput.startsWith('> A sentence worth asking about.') && !quoteBtn.isShown();
    console.log(`Quote button: shown over a selection ${quoteShown}; input "${quotedInput.trim()}"; hidden after ${!quoteBtn.isShown()} -> ${quoteBtnOk}`);
    if (!quoteBtnOk) process.exitCode = 1;
    // Side chat sits just after Quote, both inside the panel, even for a selection at its right edge.
    const sideBtn = root.querySelector('.vc-side-button') as HTMLElement;
    Object.defineProperty(quoteBtn, 'offsetWidth', { configurable: true, value: 70 });
    Object.defineProperty(sideBtn, 'offsetWidth', { configurable: true, value: 90 });
    const placed = (left: number) => {
      (quoteRange as unknown as { getClientRects(): unknown[] }).getClientRects = () => [{ ...box, left, x: left }];
      (view as unknown as { placeQuoteButton(): void }).placeQuoteButton();
      return `${parseFloat(quoteBtn.style.left)}/${parseFloat(sideBtn.style.left)}${sideBtn.isShown() ? '' : ' (side hidden)'}`;
    };
    // 300 px wide: Quote 70 and Side chat 90, 6 apart, 4 from the edge.
    const placements = [placed(40), placed(280)];
    (quoteRange as unknown as { getClientRects(): unknown[] }).getClientRects = () => [box];
    const placeOk = JSON.stringify(placements) === JSON.stringify(['40/116', '130/206']);
    console.log(`Side chat button beside Quote: ${placements.join(', ')} (expected 40/116, 130/206) -> ${placeOk}`);
    if (!placeOk) process.exitCode = 1;
    // A link out of the vault opens through window.open, as a note's reading view opens one, so that
    // Obsidian asks before opening a file; a link whose scheme runs script is refused.
    {
      const opened: string[][] = [];
      const openBefore = dom.window.open;
      dom.window.open = ((url: string, target: string) => void opened.push([url, target])) as typeof dom.window.open;
      const messages = root.querySelector('.vc-messages') as HTMLElement;
      const link = (href: string) => {
        const a = messages.createEl('a', { cls: 'external-link', text: 'link', attr: { href } });
        const evt = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
        a.dispatchEvent(evt);
        a.remove();
        return evt.defaultPrevented;
      };
      const pdf = 'file:///private/tmp/Harvest%20Plan%202026.pdf';
      const handled = [link(pdf), link('javascript:alert(1)')];
      dom.window.open = openBefore;
      const linksOk = JSON.stringify(opened) === JSON.stringify([[pdf, '']]) && handled.every(Boolean);
      console.log(`links out of the vault: opened ${JSON.stringify(opened)}; both clicks handled ${handled.every(Boolean)} -> ${linksOk}`);
      if (!linksOk) process.exitCode = 1;
    }
    dom.window.getSelection()?.removeAllRanges();
    (view as unknown as { placeQuoteButton(): void }).placeQuoteButton();
    const hiddenWithout = !quoteBtn.isShown() && !sideBtn.isShown();
    console.log(`Quote button hidden with nothing selected: ${hiddenWithout}`);
    if (!hiddenWithout) process.exitCode = 1;
    (view as unknown as { inputEl: HTMLTextAreaElement }).inputEl.value = '';
    [quoteReply.getBoundingClientRect, wrapEl.getBoundingClientRect] = layoutBefore;
    view.newChat();
    // Equations keep their LaTeX for quoting: saved from Obsidian's parse before MathJax draws them,
    // then put back as $…$ (or $$…$$) in place of the drawn glyphs.
    const { saveMathSource, selectionWithMath } = await import('../src/mathSource');
    const parsed = document.createElement('div');
    parsed.innerHTML = '<p>x <span class="math math-inline">\\sigma_{KL}</span> and <span class="math math-inline is-loaded"><mjx-container>drawn</mjx-container></span></p>';
    saveMathSource(parsed);
    const spans = parsed.querySelectorAll<HTMLElement>('.math');
    const savedOk = spans[0].dataset.tex === '\\sigma_{KL}' && spans[1].dataset.tex === undefined;
    console.log(`equation source saved before drawing: ${spans[0].dataset.tex}; a drawn one skipped ${spans[1].dataset.tex === undefined} -> ${savedOk}`);
    if (!savedOk) process.exitCode = 1;

    const mathReply = document.createElement('div');
    document.body.appendChild(mathReply);
    mathReply.innerHTML =
      '<p>the factor is <span class="math math-inline" data-tex="1-0.28(\\sigma-1)"><mjx-container>1−0.28(σ−1)</mjx-container></span>, so small</p>' +
      '<div class="math math-block" data-tex="x^{2}"><mjx-container>x2</mjx-container></div>' +
      '<p>after it</p><p>no math here</p>';
    const [first, , , last] = Array.from(mathReply.children);
    const factorText = first.firstChild as Text;
    const insideGlyphs = first.querySelector('mjx-container')?.firstChild as Text;
    // From "factor" to partway into the equation: the whole equation comes with it.
    const partial = document.createRange();
    partial.setStart(factorText, 4);
    partial.setEnd(insideGlyphs, 3);
    const partialText = selectionWithMath(partial);
    // Across a display equation: on lines of its own.
    const across = document.createRange();
    across.setStart(first.lastChild as Text, 2);
    across.setEnd(mathReply.children[2].firstChild as Text, 5);
    const acrossText = selectionWithMath(across);
    // No equation: null, so the browser's own text is used, as before.
    const noMath = document.createRange();
    noMath.selectNodeContents(last);
    const plainText = selectionWithMath(noMath);
    mathReply.remove();
    const mathQuoteOk =
      partialText === 'factor is $1-0.28(\\sigma-1)$' &&
      acrossText === 'so small\n\n$$\nx^{2}\n$$\n\nafter' &&
      plainText === null;
    console.log(`quote with equations: ${JSON.stringify(partialText)} | ${JSON.stringify(acrossText)} | ${plainText} -> ${mathQuoteOk}`);
    if (!mathQuoteOk) process.exitCode = 1;
    // Equations a selection in the chat takes in are marked as selected, and unmarked when it moves off them.
    {
      const shown = internals.messagesEl.createDiv();
      shown.innerHTML =
        '<p>the factor is <span class="math math-inline" data-tex="a"><mjx-container>a</mjx-container></span>, so</p>' +
        '<div class="math math-block" data-tex="b"><mjx-container>b</mjx-container></div><p>after it</p>' +
        '<div class="math math-block" data-tex="c"><mjx-container><mjx-math></mjx-math></mjx-container></div>';
      const [inline, block, drawnOnly] = Array.from(shown.querySelectorAll<HTMLElement>('.math'));
      const afterText = shown.querySelectorAll('p')[1].firstChild as Text;
      const select = (range: Range) => {
        dom.window.getSelection()?.removeAllRanges();
        dom.window.getSelection()?.addRange(range);
        document.dispatchEvent(new dom.window.Event('selectionchange'));
      };
      const marks = () => [inline, block].map((el) => el.classList.contains('vc-math-selected'));
      const across = document.createRange();
      across.setStart(shown.firstChild?.firstChild as Text, 4);
      across.setEnd(afterText, 3);
      select(across);
      const acrossMarks = marks();
      const textOnly = document.createRange();
      textOnly.setStart(afterText, 0);
      textOnly.setEnd(afterText, 5);
      select(textOnly);
      const textMarks = marks();
      dom.window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new dom.window.Event('selectionchange'));
      const clearedMarks = marks();
      // An equation selected alone, whose drawing holds no text, is still a selection to quote; a click in one is not.
      const quoting = view as unknown as { selectedInChat(): string | null };
      const alone = document.createRange();
      alone.setStartBefore(drawnOnly);
      alone.setEndAfter(drawnOnly);
      dom.window.getSelection()?.removeAllRanges();
      dom.window.getSelection()?.addRange(alone);
      const aloneQuote = quoting.selectedInChat();
      dom.window.getSelection()?.collapse(drawnOnly.firstChild as Node, 0);
      const clickQuote = quoting.selectedInChat();
      dom.window.getSelection()?.removeAllRanges();
      shown.remove();
      const markOk =
        JSON.stringify(acrossMarks) === '[true,true]' &&
        JSON.stringify(textMarks) === '[false,false]' &&
        JSON.stringify(clearedMarks) === '[false,false]' &&
        aloneQuote === '$$\nc\n$$' &&
        clickQuote === null;
      console.log(`equations marked as selected: across ${acrossMarks}, text only ${textMarks}, cleared ${clearedMarks}; alone quotes ${JSON.stringify(aloneQuote)}, a click ${clickQuote} -> ${markOk}`);
      if (!markOk) process.exitCode = 1;
    }
    // Pinned at the bottom while a reply streams, the bar is still brought up to date — spaced out,
    // not on every frame's scroll — and once more when the reply ends.
    {
      const pinned = view as unknown as { promptNav: { schedule(): void }; stickToBottom: boolean; navCheckedAt: number; finishTurnUi(): void; busy: boolean; messagesEl: HTMLElement };
      const realSchedule = pinned.promptNav.schedule.bind(pinned.promptNav);
      let scheduled = 0;
      pinned.promptNav.schedule = () => void (scheduled += 1);
      const scroller = pinned.messagesEl;
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1000 });
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 400 });
      scroller.scrollTop = 600;
      pinned.stickToBottom = true;
      pinned.navCheckedAt = 0;
      scroller.dispatchEvent(new dom.window.Event('scroll'));
      scroller.dispatchEvent(new dom.window.Event('scroll'));
      scroller.dispatchEvent(new dom.window.Event('scroll'));
      const whilePinned = scheduled;
      pinned.busy = true;
      pinned.finishTurnUi();
      const atEnd = scheduled - whilePinned;
      pinned.promptNav.schedule = realSchedule;
      delete (scroller as unknown as Record<string, unknown>).scrollHeight;
      delete (scroller as unknown as Record<string, unknown>).clientHeight;
      const pinnedOk = whilePinned === 1 && atEnd === 1;
      console.log(`bar over the chat while pinned: updated ${whilePinned} time(s) for 3 quick scrolls; again at the reply's end ${atEnd === 1} -> ${pinnedOk}`);
      if (!pinnedOk) process.exitCode = 1;
    }
    console.log(`takeOffPhone completed: ${await view.takeOffPhone()} chats`);

    // Closing a panel: its running chats move to another panel, or stop with a notice saying so.
    const closing = view as unknown as { background: Set<unknown>; tasks: Set<string>; busy: boolean; session: unknown };
    const startRunning = () => {
      closing.session = { close() {}, setHandlers() {}, stopTask: async () => undefined };
      closing.busy = true;
      closing.tasks = new Set(['t1', 't2']);
      closing.background.clear();
      closing.background.add({ session: { close() {}, setHandlers() {} }, tasks: new Set(['t3']), approvals: [], notice: null, settleTimer: null, chatId: 'bg', title: 'Other', busy: true });
    };
    const notices = async (run: () => Promise<void>) => {
      const said: string[] = [];
      const realLog = console.log;
      console.log = (...parts: unknown[]) => void said.push(parts.join(' '));
      await run();
      console.log = realLog;
      return said.filter((line) => line.startsWith('[Notice]'));
    };

    // Adopting: an idle chat is given this panel's settle timer; a panel that is closing takes nothing.
    // A note opens from a diff line where the line's text is now: the occurrence nearest the recorded number.
    notesOnDisk.set('Moved.md', 'intro\nB\nx\ny\nz\nB\nend');
    const { openFileAtLine } = await import('../src/editDiff');
    await openFileAtLine(app as never, 'Moved.md', 'B', 5, false);
    const openedAt = JSON.stringify(openedFiles.at(-1));
    const openAtOk = openedAt === JSON.stringify({ path: 'Moved.md', state: { active: true, eState: { line: 5 } } });
    console.log(`diff line opens the note at the nearest match: ${openedAt} -> ${openAtOk}`);
    if (!openAtOk) process.exitCode = 1;
    // In the editor (source mode) the cursor goes to the line and it is scrolled into view; a file
    // other than a note opens as its name would; a file gone says so.
    const cursor: string[] = [];
    leafStub.view = Object.assign(new stub.MarkdownView(), {
      getMode: () => 'source',
      editor: {
        setCursor: (at: { line: number }) => void cursor.push(`cursor ${at.line}`),
        scrollIntoView: (range: { from: { line: number } }, center: boolean) => void cursor.push(`scroll ${range.from.line} ${center}`),
      },
    });
    await openFileAtLine(app as never, 'Moved.md', 'B', 5, false);
    leafStub.view = null;
    notesOnDisk.set('data.csv', 'a,b');
    await openFileAtLine(app as never, 'data.csv', 'a,b', 1, false);
    const saidGone: string[] = [];
    const realConsole = console.log;
    console.log = (...parts: unknown[]) => void saidGone.push(parts.join(' '));
    await openFileAtLine(app as never, 'Gone.md', 'x', 1, false);
    console.log = realConsole;
    const openPathsOk =
      cursor.join(', ') === 'cursor 5, scroll 5 true' && openedLinks.at(-1) === 'data.csv' && saidGone.includes('[Notice] Gone.md is no longer in the vault.');
    console.log(`diff line in the editor, a non-note, a file gone: ${cursor.join(', ')}; ${openedLinks.at(-1)}; ${JSON.stringify(saidGone)} -> ${openPathsOk}`);
    if (!openPathsOk) process.exitCode = 1;

    // The divider drawn when Claude Code compacts the chat live, with its details or without them.
    internals.messagesEl.empty();
    const liveFeed = view as unknown as { onMessage(message: unknown): void };
    liveFeed.onMessage({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 1234 }, uuid: 'c1', session_id: 's' });
    liveFeed.onMessage({ type: 'system', subtype: 'compact_boundary', uuid: 'c2', session_id: 's' });
    const dividers = [...internals.messagesEl.querySelectorAll('.vc-compaction')].map((el) => el.textContent);
    const liveCompactionOk = dividers.join(' | ') === `Context compacted on request at ${(1234).toLocaleString()} tokens | Context compacted`;
    console.log(`live compaction dividers: ${dividers.join(' | ')} -> ${liveCompactionOk}`);
    if (!liveCompactionOk) process.exitCode = 1;
    view.newChat();

    // Pointing at a link in a reply, or at a file name, asks Obsidian's page preview for it.
    const hoverTurn = internals.messagesEl.createDiv({ cls: 'vc-turn' });
    const replyLink = hoverTurn.createEl('a', { cls: 'internal-link', text: 'Linked', attr: { 'data-href': 'Linked.md' } });
    const fileName = hoverTurn.createSpan({ cls: 'vc-edit-file vc-file-link', text: 'Note.md' });
    fileName.dataset.path = 'Note.md';
    const notALink = hoverTurn.createSpan({ text: 'no link' });
    for (const el of [replyLink, fileName, notALink]) el.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
    const hovered = hovers.map((hover) => `${hover.name}:${hover.data.source}:${hover.data.linktext}`).join(' ; ');
    const hoverOk = hovered === 'hover-link:vault-claude-chat:Linked.md ; hover-link:vault-claude-chat:Note.md';
    console.log(`links ask for a page preview: ${hovered} -> ${hoverOk}`);
    if (!hoverOk) process.exitCode = 1;
    hoverTurn.remove();

    // A reopened chat shows where it was compacted, inside the reply that went on after it.
    internals.messagesEl.empty();
    internals.renderTranscript([
      entry('k1', 'user', 'long question'),
      entry('k2', 'assistant', [{ type: 'tool_use', id: 'k-t1', name: 'Read', input: { file_path: '/tmp/x' } }]),
      entry('k3', 'user', [{ type: 'tool_result', tool_use_id: 'k-t1', content: 'x' }]),
      { type: 'system', uuid: 'k4', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { subtype: 'compact_boundary', trigger: 'auto', preTokens: 900000 } },
      entry('k5', 'assistant', [{ type: 'text', text: 'carried on' }]),
    ]);
    const divider = internals.messagesEl.querySelector('.vc-turn > .vc-compaction');
    const turnsAfter = internals.messagesEl.querySelectorAll('.vc-turn').length;
    const compactionOk =
      divider?.textContent === `Context compacted automatically at ${(900000).toLocaleString()} tokens` &&
      divider.getAttribute('aria-label') === 'From here on, Claude works from a summary of the earlier conversation.' &&
      turnsAfter === 1 &&
      divider.nextElementSibling?.textContent?.includes('carried on') === true;
    console.log(`compaction divider in a reopened chat: ${JSON.stringify(divider?.textContent)}; turns ${turnsAfter} -> ${compactionOk}`);
    if (!compactionOk) process.exitCode = 1;

    // A long chat draws its last turns only; the earlier ones are drawn when needed: scrolling up
    // to the top, Show all, find stepping back into them, or the list of your messages going to one.
    const history = view as unknown as {
      renderHistory(chat: { transcript: unknown[]; edits: Map<string, unknown> }, running: boolean, readMs: number): void;
      showOpening(title: string): HTMLElement;
      lastSent: string | null;
      findBar: { open(): void; state(): { count: number; current: number; hidden: number } };
    };
    const longChat = Array.from({ length: 25 }, (_, i) => [entry(`lp${i}`, 'user', `prompt ${i}`), entry(`la${i}`, 'assistant', [{ type: 'text', text: `answer ${i}` }])]).flat();
    const openLong = () => {
      view.newChat();
      internals.messagesEl.empty();
      const opening = history.showOpening('Long chat');
      history.renderHistory({ transcript: longChat, edits: new Map() }, false, 0);
      return opening;
    };
    const prompts = () => [...internals.messagesEl.querySelectorAll('.vc-user-text')].map((el) => el.textContent?.replace('prompt ', ''));
    const earlierLine = () => internals.messagesEl.querySelector('.vc-earlier')?.textContent ?? null;
    const earlierOf = () => (view as unknown as { earlier: { idle: boolean } | null }).earlier;
    // Until no drawing of earlier turns is under way, seen twice in a row (a drawing that catches up
    // may ask for more), at most three seconds.
    const settle = async () => {
      let calm = 0;
      for (const end = Date.now() + 3000; calm < 2 && Date.now() < end; ) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        calm = earlierOf()?.idle === false ? 0 : calm + 1;
      }
    };
    const until = async (done: () => boolean) => {
      for (const end = Date.now() + 3000; !done() && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const allInOrder = Array.from({ length: 25 }, (_, i) => String(i)).join(',');
    const opening = openLong();
    const overlayShown = root.querySelector('.vc-opening')?.textContent === 'Opening “Long chat”…';
    opening.remove();
    const firstDrawn = prompts().join(',');
    const lineFirst = earlierLine();
    await settle();
    const lazyOk =
      overlayShown &&
      !root.querySelector('.vc-opening') &&
      firstDrawn === '15,16,17,18,19,20,21,22,23,24' &&
      lineFirst === 'Scroll up for 15 earlier exchanges · Show all' &&
      prompts().length === 10 &&
      history.lastSent === 'prompt 24';
    console.log(`long chat draws its last turns only: ${firstDrawn}; ${JSON.stringify(lineFirst)}; still ${prompts().length} later; ↑ gives ${JSON.stringify(history.lastSent)} -> ${lazyOk}`);
    if (!lazyOk) process.exitCode = 1;

    // Scrolling to the top draws the next ten, then, still at the top, the rest; in order.
    Object.defineProperty(internals.messagesEl, 'clientHeight', { configurable: true, get: () => 500 });
    internals.messagesEl.dispatchEvent(new dom.window.Event('scroll'));
    await settle();
    delete (internals.messagesEl as unknown as { clientHeight?: number }).clientHeight;
    const scrollOk = prompts().join(',') === allInOrder && earlierLine() === null && internals.messagesEl.querySelectorAll('.vc-turn.has-actions').length === 25;
    console.log(`scrolling up draws the earlier turns: ${prompts().length} in order ${prompts().join(',') === allInOrder}; line gone ${earlierLine() === null} -> ${scrollOk}`);
    if (!scrollOk) process.exitCode = 1;

    // Show all, held back while a dialog is open over the window.
    openLong().remove();
    const dialog = document.body.createDiv({ cls: 'modal-container' });
    (internals.messagesEl.querySelector('.vc-earlier-link') as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const whileOpen = prompts().length;
    dialog.remove();
    await settle();
    const showAllOk = whileOpen === 10 && prompts().join(',') === allInOrder && earlierLine() === null && history.lastSent === 'prompt 24';
    console.log(`Show all, held while a dialog is open: ${whileOpen} while open, then ${prompts().length} -> ${showAllOk}`);
    if (!showAllOk) process.exitCode = 1;

    // Find counts the matches not drawn, and stepping back draws the chat back to the next one.
    openLong().remove();
    history.findBar.open();
    const chatFind = root.querySelector('.vc-find-input') as HTMLInputElement;
    chatFind.value = 'answer 1';
    chatFind.dispatchEvent(new dom.window.Event('input'));
    // "answer 1" is in answers 1 and 10–19: six not drawn (1, 10–14), five drawn (15–19); the
    // first drawn match is the seventh, and stepping back draws turn 14 and makes its match the sixth.
    const before = history.findBar.state();
    chatFind.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
    await settle();
    const after = history.findBar.state();
    const findEarlierOk =
      JSON.stringify(before) === JSON.stringify({ count: 11, current: 7, hidden: 6 }) &&
      JSON.stringify(after) === JSON.stringify({ count: 11, current: 6, hidden: 5 }) &&
      prompts()[0] === '14';
    console.log(`find reaches undrawn turns: ${JSON.stringify(before)} then ${JSON.stringify(after)}; top drawn ${prompts()[0]} -> ${findEarlierOk}`);
    if (!findEarlierOk) process.exitCode = 1;
    // Enter goes round the six drawn matches only: six presses come back to the first drawn one, nothing more drawn.
    for (let i = 0; i < 6; i += 1) chatFind.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await settle();
    const roundOk = JSON.stringify(history.findBar.state()) === JSON.stringify({ count: 11, current: 6, hidden: 5 }) && prompts()[0] === '14';
    console.log(`Enter goes round the drawn matches: ${JSON.stringify(history.findBar.state())}; top drawn ${prompts()[0]} -> ${roundOk}`);
    if (!roundOk) process.exitCode = 1;
    chatFind.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

    // A query found only in undrawn turns, which then get drawn: the count follows and the match
    // becomes the current one. Highlights stand in for the browser's, which reject a missing range.
    const globals = globalThis as { CSS?: { highlights: Map<string, unknown> }; Highlight?: unknown };
    const hadHighlights = [globals.CSS, globals.Highlight] as const;
    globals.CSS = { highlights: new Map() };
    globals.Highlight = class {
      constructor(...ranges: unknown[]) {
        if (ranges.some((range) => !range)) throw new TypeError('not a range');
      }
    };
    try {
      openLong().remove();
      history.findBar.open();
      chatFind.value = 'answer 3';
      chatFind.dispatchEvent(new dom.window.Event('input'));
      const onlyEarlier = history.findBar.state();
      (internals.messagesEl.querySelector('.vc-earlier-link') as HTMLElement).click();
      await settle();
      const afterDrawn = history.findBar.state();
      const findDrawnOk =
        JSON.stringify(onlyEarlier) === JSON.stringify({ count: 1, current: 0, hidden: 1 }) &&
        JSON.stringify(afterDrawn) === JSON.stringify({ count: 1, current: 1, hidden: 0 }) &&
        prompts().join(',') === allInOrder;
      console.log(`find follows turns drawn under it: ${JSON.stringify(onlyEarlier)} then ${JSON.stringify(afterDrawn)} -> ${findDrawnOk}`);
      if (!findDrawnOk) process.exitCode = 1;
      chatFind.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

      // Closing find while a step draws the chat back: nothing is highlighted once the drawing ends.
      openLong().remove();
      history.findBar.open();
      chatFind.value = 'answer 1';
      chatFind.dispatchEvent(new dom.window.Event('input'));
      chatFind.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
      chatFind.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      await settle();
      const closedOk = globals.CSS.highlights.size === 0 && prompts()[0] === '14';
      console.log(`closing find mid-draw leaves no highlights: ${globals.CSS.highlights.size} left; top drawn ${prompts()[0]} -> ${closedOk}`);
      if (!closedOk) process.exitCode = 1;
    } finally {
      [globals.CSS, globals.Highlight] = hadHighlights;
    }

    // The list of your messages has all 25; going to an undrawn one draws the chat back to it.
    openLong().remove();
    const messageList = (view as unknown as { promptNav: { openList(): void } }).promptNav;
    messageList.openList();
    const listedPrompts = [...root.querySelectorAll('.vc-message-list-item .vc-message-list-text')].map((el) => el.textContent?.replace('prompt ', ''));
    (root.querySelectorAll('.vc-message-list-item')[3] as HTMLElement).click();
    await settle();
    const listOk = listedPrompts.join(',') === allInOrder && prompts()[0] === '3' && prompts().length === 22 && earlierLine() === 'Scroll up for 3 earlier exchanges · Show all';
    console.log(`message list includes undrawn messages: ${listedPrompts.length} listed; after going to 4: top ${prompts()[0]}, ${prompts().length} drawn -> ${listOk}`);
    if (!listOk) process.exitCode = 1;

    // A reply streaming while the earlier turns are drawn (a chat brought back from the background)
    // keeps its streamed text, its turn, its phase and the message ↑ brings back.
    openLong().remove();
    const streaming = view as unknown as {
      busy: boolean;
      phase: string;
      appendLive(text: string): void;
      setPhase(phase: string): void;
      draw: { liveText: HTMLElement | null; turn: HTMLElement | null };
      liveDraw: { liveText: HTMLElement | null };
    };
    streaming.busy = true;
    streaming.setPhase('Writing…');
    streaming.appendLive('streaming ');
    const streamEl = streaming.draw.liveText;
    // Written out now; the next piece then waits a tenth of a second, while the drawing runs.
    await new Promise((resolve) => setTimeout(resolve, 20));
    (internals.messagesEl.querySelector('.vc-earlier-link') as HTMLElement).click();
    streaming.appendLive('on');
    await settle();
    await until(() => streamEl?.textContent === 'streaming on');
    const lastTurn = [...internals.messagesEl.querySelectorAll('.vc-turn')].at(-1);
    const streamOk =
      prompts().join(',') === allInOrder &&
      streaming.draw === (streaming.liveDraw as unknown) &&
      streaming.draw.liveText === streamEl &&
      streamEl?.textContent === 'streaming on' &&
      lastTurn?.contains(streamEl) === true &&
      streaming.phase === 'Writing…' &&
      history.lastSent === 'prompt 24';
    console.log(`a streaming reply is left alone: text ${JSON.stringify(streamEl?.textContent)}, phase ${streaming.phase}, ↑ ${JSON.stringify(history.lastSent)} -> ${streamOk}`);
    if (!streamOk) process.exitCode = 1;
    streaming.busy = false;

    // A saved message that cannot be drawn is left out and the rest drawn; its tool calls are closed
    // out, not left running. Nothing is thrown, so a chat brought back from the background still
    // gets its running session attached after its saved messages.
    const partway = view as unknown as { renderThinking(text: string): void; tools: Map<string, { status: string }> };
    const renderThinking = partway.renderThinking;
    partway.renderThinking = () => {
      throw new Error('cannot draw');
    };
    let threw = false;
    try {
      internals.messagesEl.empty();
      internals.renderTranscript([
        entry('pw1', 'user', 'go'),
        entry('pw2', 'assistant', [{ type: 'tool_use', id: 'partway-tool', name: 'Read', input: { file_path: '/tmp/x' } }, { type: 'thinking', thinking: 'then this fails' }]),
        entry('pw3', 'assistant', [{ type: 'text', text: 'drawn after it' }]),
      ]);
    } catch {
      threw = true;
    } finally {
      partway.renderThinking = renderThinking;
    }
    const partwayOk = !threw && partway.tools.get('partway-tool')?.status === 'done' && (internals.messagesEl.textContent ?? '').includes('drawn after it');
    console.log(`a saved message that fails to draw is left out: threw ${threw}; tool ${partway.tools.get('partway-tool')?.status} -> ${partwayOk}`);
    if (!partwayOk) process.exitCode = 1;
    view.newChat();

    // A prompt whose bubble fails partway still starts its own turn: its reply does not join the
    // exchange before it.
    type DrawBubble = (text: string, chips: unknown[], parent?: HTMLElement) => HTMLElement;
    const bubbleDrawing = view as unknown as { renderUserBubble: DrawBubble };
    const renderUserBubble = bubbleDrawing.renderUserBubble;
    bubbleDrawing.renderUserBubble = function (this: unknown, text, chips, parent) {
      if (text === 'bad prompt') throw new Error('cannot draw');
      return renderUserBubble.call(this, text, chips, parent);
    };
    try {
      internals.messagesEl.empty();
      internals.renderTranscript([
        entry('bp1', 'user', 'first prompt'),
        entry('bp2', 'assistant', [{ type: 'text', text: 'answer one' }]),
        entry('bp3', 'user', 'bad prompt'),
        entry('bp4', 'assistant', [{ type: 'text', text: 'answer two' }]),
      ]);
    } finally {
      bubbleDrawing.renderUserBubble = renderUserBubble;
    }
    const turnOf = (text: string) => [...internals.messagesEl.querySelectorAll('.vc-turn')].find((turn) => turn.textContent?.includes(text));
    const ownTurnOk = turnOf('answer one') !== undefined && turnOf('answer two') !== undefined && turnOf('answer one') !== turnOf('answer two');
    console.log(`a reply keeps its own turn when its prompt fails to draw: ${ownTurnOk}`);
    if (!ownTurnOk) process.exitCode = 1;
    view.newChat();

    // An edit seen again in a saved chat fills in the note's link without making the chat its newest;
    // an edit made now does.
    const linking = view as unknown as { chatId: string | null; addTool(id: string, name: string, input: Record<string, unknown>): void; finishTool(id: string, isError: boolean, structured?: unknown, saved?: boolean): void };
    const links = (plugin as unknown as { noteLinks: string[] }).noteLinks;
    links.length = 0;
    view.newChat();
    linking.chatId = 'saved-chat';
    internals.renderTranscript([
      entry('ed1', 'user', 'edit it'),
      entry('ed2', 'assistant', [{ type: 'tool_use', id: 'ed-t', name: 'Edit', input: { file_path: '/tmp/Linked.md', old_string: 'a', new_string: 'b' } }]),
      entry('ed3', 'user', [{ type: 'tool_result', tool_use_id: 'ed-t', content: 'ok' }]),
    ]);
    linking.addTool('live-t', 'Edit', { file_path: '/tmp/Linked.md', old_string: 'b', new_string: 'c' });
    linking.finishTool('live-t', false);
    const linksOk = links.join(' | ') === 'Linked.md@saved-chat (kept back) | Linked.md@saved-chat';
    console.log(`note links from saved and live edits: ${links.join(' | ')} -> ${linksOk}`);
    if (!linksOk) process.exitCode = 1;
    view.newChat();

    // Opening another chat stops a drawing under way.
    openLong().remove();
    (internals.messagesEl.querySelector('.vc-earlier-link') as HTMLElement).click();
    view.newChat();
    await settle();
    const stopsOk = internals.messagesEl.querySelectorAll('.vc-user-text').length === 0;
    console.log(`opening another chat stops the earlier turns: ${stopsOk}`);
    if (!stopsOk) process.exitCode = 1;

    // Two chats opened one after the other: the second wins even when the first, a long one, is read last.
    {
      const { mkdtempSync: mkdtemp, mkdirSync: mkdir, writeFileSync: write, realpathSync: realpath } = await import('fs');
      const { tmpdir: temp } = await import('os');
      const { join } = await import('path');
      const config = mkdtemp(join(temp(), 'vc-race-'));
      const configWas = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = config;
      // The vault is /tmp, which Claude Code files under its real path (/private/tmp on macOS).
      const tmpProject = realpath('/tmp').replace(/[^a-zA-Z0-9]/g, '-');
      mkdir(join(config, 'projects', tmpProject), { recursive: true });
      const row = (type: string, uuid: string, content: unknown) => JSON.stringify({ type, uuid, message: { role: type, content } });
      const filler = Array.from({ length: 4000 }, (_, i) => row('assistant', `f${i}`, [{ type: 'text', text: 'x'.repeat(500) }]));
      write(join(config, 'projects', tmpProject, 'long.jsonl'), [row('user', 'l1', 'long chat'), ...filler].join('\n'));
      write(join(config, 'projects', tmpProject, 'short.jsonl'), [row('user', 's1', 'short chat'), row('assistant', 's2', [{ type: 'text', text: 'ok' }])].join('\n'));
      const opener2 = view as unknown as { openChat(item: { id: string; title: string; updatedAt: number; fromPanel: boolean }): Promise<void>; resumeId: string | null };
      const first = opener2.openChat({ id: 'long', title: 'Long', updatedAt: 0, fromPanel: true });
      const second = opener2.openChat({ id: 'short', title: 'Short', updatedAt: 0, fromPanel: true });
      await Promise.all([first, second]);
      // Picking the chat already on screen while another is read keeps the one on screen.
      const onScreen = view as unknown as { chatId: string | null };
      onScreen.chatId = 'short';
      const pending = opener2.openChat({ id: 'long', title: 'Long', updatedAt: 0, fromPanel: true });
      await opener2.openChat({ id: 'short', title: 'Short', updatedAt: 0, fromPanel: true });
      await pending;
      const keptOk = opener2.resumeId === 'short' && [...internals.messagesEl.querySelectorAll('.vc-user-text')].map((el) => el.textContent).join(',') === 'short chat';
      console.log(`picking the chat on screen cancels another being read: on screen ${opener2.resumeId} -> ${keptOk}`);
      if (!keptOk) process.exitCode = 1;
      if (configWas === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = configWas;
      const shown = [...internals.messagesEl.querySelectorAll('.vc-user-text')].map((el) => el.textContent).join(',');
      const raceOk = opener2.resumeId === 'short' && shown === 'short chat' && !root.querySelector('.vc-opening');
      console.log(`a chat opened after another wins: on screen ${opener2.resumeId} (${shown}) -> ${raceOk}`);
      if (!raceOk) process.exitCode = 1;
      // A turn the panel did not start shows the prompt from the end of the file, as the chat would:
      // the question after a background-task notice, without the notice.
      const notice = '<task-notification><task-id>1</task-id><status>completed</status><summary>done</summary></task-notification>';
      process.env.CLAUDE_CONFIG_DIR = config;
      write(
        join(config, 'projects', tmpProject, 'remote.jsonl'),
        [...filler, row('user', 'b1', 'first of two'), row('user', 'b2', 'second of two'), row('user', 'r1', `${notice}\nwhat next?`)].join('\n'),
      );
      view.newChat();
      const remote = view as unknown as { chatId: string | null; beginRemoteTurn(answering?: string[]): Promise<void>; finishTurnUi(): void };
      const remoteTurn = async (answering: string[] | undefined) => {
        view.newChat();
        remote.chatId = 'remote';
        await remote.beginRemoteTurn(answering);
        const shown = [...internals.messagesEl.querySelectorAll('.vc-user .vc-user-text')].map((el) => el.textContent);
        const label = internals.messagesEl.querySelector('.vc-origin-label')?.textContent;
        remote.finishTurnUi();
        return shown.length > 0 ? `${shown.join(' | ')} (${label})` : null;
      };
      // By the uuid the reply names; with none named (older Claude Code), the latest prompt; and a turn
      // answering nothing in the file (Claude Code going on by itself) shows no old prompt again.
      const byUuid = await remoteTurn(['r1']);
      const latest = await remoteTurn(undefined);
      const unknown = await remoteTurn(['not-in-the-file']);
      // Several sent close together and answered as one turn: each shows, in the order written.
      const batch = await remoteTurn(['b2', 'b1']);
      const remoteOk =
        byUuid === 'what next? (Sent outside the panel)' && latest === byUuid && unknown === null && batch === 'first of two | second of two (Sent outside the panel)';
      console.log(
        `a turn started elsewhere shows its prompts: by uuid ${JSON.stringify(byUuid)}; latest ${JSON.stringify(latest)}; unknown ${JSON.stringify(unknown)}; batch ${JSON.stringify(batch)} -> ${remoteOk}`,
      );
      if (!remoteOk) process.exitCode = 1;
      if (configWas === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = configWas;
      view.newChat();
    }

    // The new-chat button's right-click menu chooses how long the scratch chat may be left alone.
    type StubItem = { title: string; checked: boolean | null; click: (() => unknown) | null; submenu: { items: StubItem[] } | null };
    const idleSet: number[] = [];
    (plugin as unknown as { setScratchIdle(hours: number): Promise<void> }).setScratchIdle = async (hours) => void idleSet.push(hours);
    stub.Menu.last = null;
    const newChatButton = root.querySelector('.vc-header button[aria-label^="New chat"]') as HTMLElement;
    newChatButton.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const newChatMenu = stub.Menu.last as unknown as { items: StubItem[] } | null;
    const idleItem = newChatMenu?.items.find((item) => item.title === 'Scratch chat starts over after');
    const idleChoices = idleItem?.submenu?.items ?? [];
    idleChoices.find((choice) => choice.title === '3 days')?.click?.();
    const idleMenuOk =
      idleChoices.map((choice) => `${choice.title}${choice.checked ? ' ✓' : ''}`).join(', ') === '1 hour, 4 hours, 12 hours, 24 hours ✓, 3 days, 1 week' &&
      idleSet.join(',') === '72';
    console.log(`scratch idle time from the new-chat menu: ${idleChoices.map((choice) => `${choice.title}${choice.checked ? ' ✓' : ''}`).join(', ')}; chose ${idleSet.join(',')} -> ${idleMenuOk}`);
    if (!idleMenuOk) process.exitCode = 1;

    const adopter = view as unknown as { adoptBackground(entry: unknown): void; background: Set<unknown>; closing: boolean };
    const idleEntry = { session: { close() {}, setHandlers() {} }, tasks: new Set<string>(), approvals: [], notice: null, settleTimer: 5 as number | null, chatId: 'idle', title: 'Idle', busy: false, remoteUrl: null };
    adopter.adoptBackground(idleEntry);
    const rearmed = adopter.background.has(idleEntry) && idleEntry.settleTimer !== null && idleEntry.settleTimer !== 5;
    adopter.background.delete(idleEntry);
    if (idleEntry.settleTimer !== null) window.clearTimeout(idleEntry.settleTimer);
    let closedOnAdopt = false;
    adopter.closing = true;
    adopter.adoptBackground({ ...idleEntry, settleTimer: null, session: { close: () => void (closedOnAdopt = true), setHandlers() {} } });
    adopter.closing = false;
    const adoptOk = rearmed && closedOnAdopt && adopter.background.size === 0;
    console.log(`adopting a chat: idle one re-armed ${rearmed}; a closing panel closes it ${closedOnAdopt} -> ${adoptOk}`);
    if (!adoptOk) process.exitCode = 1;

    // Opening a chat from outside the panel that was copied before offers its latest copy, whose line
    // then says it is a copy.
    {
      const newer = { id: 'copy-2', title: 'Papers', updatedAt: Date.UTC(2026, 8, 28, 12), fromPanel: true, copied: true };
      const older = { id: 'copy-1', title: 'Papers', updatedAt: Date.UTC(2026, 8, 17, 12), fromPanel: true, copied: true };
      const original = { id: 'desk', title: 'Papers', updatedAt: Date.UTC(2026, 8, 20, 12), fromPanel: false, copies: [newer, older] };
      const copyView = view as unknown as { readForOpening: unknown; openChat(item: unknown): Promise<boolean>; resumeId: string | null; forkOnResume: boolean; messagesEl: HTMLElement };
      const said = (id: string) => [
        { type: 'user', uuid: `${id}-u`, session_id: id, parent_tool_use_id: null, message: { role: 'user', content: 'Which papers?' } },
        { type: 'assistant', uuid: `${id}-a`, session_id: id, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'These.' }] } },
      ];
      copyView.readForOpening = async (id: string) => ({ chat: { transcript: said(id), edits: new Map() }, readMs: 0 });
      await copyView.openChat(original);
      // Sending in it makes a copy, whose record names it.
      const recordedCopies: string[] = [];
      const initPlugin = plugin as unknown as Record<string, unknown>;
      const pluginBefore = { recordChat: initPlugin.recordChat, checkClaudeVersion: initPlugin.checkClaudeVersion };
      initPlugin.recordChat = (id: string, _title: string, copyOf?: string) => void recordedCopies.push(`${id}:${copyOf}`);
      initPlugin.checkClaudeVersion = () => undefined;
      const initView = view as unknown as { onMessage(message: unknown): void; forkOnResume: boolean; chatId: string | null; resumeId: string | null };
      const stateBefore = { forkOnResume: initView.forkOnResume, chatId: initView.chatId, resumeId: initView.resumeId };
      initView.onMessage({ type: 'system', subtype: 'init', session_id: 'copy-3', model: 'claude-opus-5-5', tools: [], mcp_servers: [], slash_commands: [], permissionMode: 'default' });
      Object.assign(initView, stateBefore);
      Object.assign(initPlugin, pluginBefore);
      const offer = [...copyView.messagesEl.querySelectorAll('.vc-resumed')].pop();
      const offerText = offer?.textContent ?? '';
      (offer?.querySelector('.vc-welcome-link') as HTMLElement | null)?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const copyLine = copyView.messagesEl.querySelector('.vc-resumed')?.textContent ?? '';
      const openedCopy = copyView.resumeId === 'copy-2' && !copyView.forkOnResume;
      delete (copyView as unknown as Record<string, unknown>).readForOpening;
      view.newChat();
      const offerOk =
        JSON.stringify(recordedCopies) === JSON.stringify(['copy-3:desk']) &&
        offerText.startsWith('Started outside the panel, and copied before: the latest of your 2 copies was last active') &&
        offerText.includes('Open that copy. New messages here start another copy') &&
        openedCopy &&
        copyLine.endsWith(' · a copy of a chat from outside the panel');
      console.log(`opening a copied chat: recorded ${JSON.stringify(recordedCopies)}; offered "${offerText}"; opened the latest ${openedCopy}, "${copyLine}" -> ${offerOk}`);
      if (!offerOk) process.exitCode = 1;
    }

    // Plan mode shows: Claude Code's report of it (Claude entering it itself) switches the menu, a line
    // in the chat marks where it starts and ends, and the input carries a cue with a way back.
    {
      const modeChat = view as unknown as { onMessage(message: unknown): void; mode: string; busy: boolean; session: unknown; modeMenu: { value: string } };
      const modeWas = modeChat.mode;
      view.newChat();
      modeChat.mode = 'auto';
      const changes: string[] = [];
      modeChat.session = { setPermissionMode: async (mode: string) => void changes.push(mode), setHandlers() {}, close() {} };
      const planLine = root.querySelector('.vc-plan-line') as HTMLElement;
      const inputBox = root.querySelector('.vc-input') as HTMLTextAreaElement;
      const lines = () => [...root.querySelectorAll('.vc-setting-line')].map((el) => el.textContent);
      modeChat.onMessage({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', uuid: 'st1', session_id: 's' });
      const entered = { mode: modeChat.mode, menu: modeChat.modeMenu.value, cue: planLine.isShown(), tinted: inputBox.hasClass('is-plan-mode'), placeholder: inputBox.placeholder };
      (planLine.querySelector('.vc-welcome-link') as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const left = { mode: modeChat.mode, cue: planLine.isShown(), tinted: inputBox.hasClass('is-plan-mode'), changes: [...changes] };
      // The same report twice draws one line.
      modeChat.onMessage({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', uuid: 'st2', session_id: 's' });
      modeChat.onMessage({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', uuid: 'st3', session_id: 's' });
      modeChat.onMessage({ type: 'system', subtype: 'status', status: null, permissionMode: 'auto', uuid: 'st4', session_id: 's' });
      const drawn = lines();
      // A new chat does not inherit Plan mode: it starts in the mode before it, unless new chats start in Plan mode.
      modeChat.onMessage({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', uuid: 'st5', session_id: 's' });
      modeChat.session = null;
      view.newChat();
      const afterNew = { mode: modeChat.mode, cue: planLine.isShown(), tinted: inputBox.hasClass('is-plan-mode') };
      const settingsMode = plugin.settings.permissionMode;
      plugin.settings.permissionMode = 'plan';
      modeChat.mode = 'plan';
      view.newChat();
      const keptPlan = modeChat.mode;
      // Any other mode change, and a model change, draw a line too; one that fails does not.
      modeChat.mode = 'auto';
      modeChat.session = {
        setPermissionMode: async () => undefined,
        setModel: async (model: string) => {
          // A reply naming the model it ran on arrives while the refused switch is pending.
          if (model !== 'claude-broken-1') return;
          (view as unknown as { currentModel: string | null }).currentModel = 'claude-haiku-4-5-20251001';
          throw new Error('refused');
        },
        setHandlers() {},
        close() {},
      };
      const settingView = view as unknown as { changeMode(mode: string): Promise<void>; changeModel(value: string): Promise<void> };
      await settingView.changeMode('acceptEdits');
      await settingView.changeModel('claude-sonnet-5-5');
      await settingView.changeModel('claude-broken-1');
      // Refused: the menu stays on the model that runs.
      const refusedView = view as unknown as { modelMenu: { label: string }; modelOverride?: string };
      const afterRefusal = `${refusedView.modelMenu.label} (${refusedView.modelOverride})`;
      const settingLines = lines();
      const planColoured = [...root.querySelectorAll('.vc-setting-line')].map((el) => el.hasClass('is-plan'));
      modeChat.session = null;
      view.newChat();
      plugin.settings.permissionMode = settingsMode;
      modeChat.mode = modeWas;
      (view as unknown as { populateModeSelect(): void }).populateModeSelect();
      const modeOk =
        entered.mode === 'plan' &&
        entered.menu === 'plan' &&
        entered.cue &&
        entered.tinted &&
        entered.placeholder === 'Describe what to plan…' &&
        left.mode === 'auto' &&
        afterNew.mode === 'auto' &&
        !afterNew.cue &&
        !afterNew.tinted &&
        keptPlan === 'plan' &&
        JSON.stringify(settingLines) === JSON.stringify(['Permission mode: Accept edits', 'Model: Sonnet 5.5']) &&
        afterRefusal === 'Haiku 4.5 (claude-sonnet-5-5)' &&
        JSON.stringify(planColoured) === '[false,false]' &&
        !left.cue &&
        !left.tinted &&
        JSON.stringify(left.changes) === JSON.stringify(['auto']) &&
        JSON.stringify(drawn) ===
          JSON.stringify([
            'Plan mode: Claude plans, and changes nothing until you approve',
            'Left plan mode · back to Auto (classifier)',
            'Plan mode: Claude plans, and changes nothing until you approve',
            'Left plan mode · back to Auto (classifier)',
          ]);
      console.log(`plan mode cues: entered ${JSON.stringify(entered)}; left ${JSON.stringify(left)}; new chat ${JSON.stringify(afterNew)}, with Plan as the default ${keptPlan}; lines ${JSON.stringify(drawn)}; other settings ${JSON.stringify(settingLines)}, after a refused switch ${afterRefusal} -> ${modeOk}`);
      if (!modeOk) process.exitCode = 1;
    }

    // `/plan`, which Claude Code takes only in a terminal: the panel switches the chat to Plan mode and
    // sends what follows; `/plan` alone only switches. It is offered among the slash commands.
    {
      const planInput = root.querySelector('.vc-input') as HTMLTextAreaElement;
      planInput.value = '/pl';
      planInput.setSelectionRange(3, 3);
      planInput.dispatchEvent(new dom.window.Event('input'));
      const offeredPlan = [...root.querySelectorAll('.vc-suggest-item .vc-suggest-name')].some((el) => el.textContent === '/plan');
      const modes: string[] = [];
      const sentPlan: unknown[] = [];
      const planChat = view as unknown as { session: unknown; mode: string; busy: boolean; lastSent: string; send(): Promise<void> };
      const modeBefore = planChat.mode;
      view.newChat();
      planChat.mode = 'auto';
      planChat.session = {
        setPermissionMode: async (mode: string) => void modes.push(mode),
        send: (content: unknown) => void sentPlan.push(content),
        setHandlers() {},
        close() {},
      };
      // While Claude works, /plan waits: the reply running is not switched.
      planChat.busy = true;
      planInput.value = '/plan check the notes';
      await planChat.send();
      const whileBusy = { mode: planChat.mode, input: planInput.value, sent: sentPlan.length };
      planChat.busy = false;
      await planChat.send();
      const afterPlan = { mode: planChat.mode, input: planInput.value, recalled: planChat.lastSent };
      // The reply to it has ended; /plan alone then only switches.
      planChat.busy = false;
      planInput.value = '/plan';
      await planChat.send();
      const alone = { sent: sentPlan.length, input: planInput.value };
      planChat.session = null;
      view.newChat();
      planChat.mode = modeBefore;
      const slashOk =
        offeredPlan &&
        whileBusy.mode === 'auto' &&
        whileBusy.input === '/plan check the notes' &&
        whileBusy.sent === 0 &&
        afterPlan.recalled === '/plan check the notes' &&
        JSON.stringify(modes) === JSON.stringify(['plan']) &&
        afterPlan.mode === 'plan' &&
        JSON.stringify(sentPlan) === JSON.stringify(['check the notes']) &&
        alone.sent === 1 &&
        alone.input === '';
      console.log(`/plan: busy ${JSON.stringify(whileBusy)}; after ${JSON.stringify(afterPlan)}; offered ${offeredPlan}; modes set ${JSON.stringify(modes)}; sent ${JSON.stringify(sentPlan)}; alone sends nothing ${alone.sent === 1}, leaves ${JSON.stringify(alone.input)} -> ${slashOk}`);
      if (!slashOk) process.exitCode = 1;
    }

    const adopted: unknown[] = [];
    (plugin as { heir: unknown }).heir = { adoptBackground: (entry: unknown) => void adopted.push(entry) };
    startRunning();
    const movedSaid = await notices(() => view.onClose());
    const movedOk =
      adopted.length === 2 &&
      movedSaid.some((line) => line === '[Notice] 2 chats and 3 background tasks moved to another Claude panel, still running.') &&
      !movedSaid.some((line) => line.includes('stopped'));
    console.log(`closing hands its chats over: moved ${adopted.length}; ${JSON.stringify(movedSaid[0])} -> ${movedOk}`);
    if (!movedOk) process.exitCode = 1;

    (plugin as { heir: unknown }).heir = null;
    startRunning();
    const stoppedSaid = await notices(() => view.onClose());
    const closeNotice = stoppedSaid.find((line) => line.startsWith('[Notice] Closing the panel'));
    const closeOk = closeNotice === '[Notice] Closing the panel stopped 2 chats and 3 background tasks. The conversations are saved: reopen one from the history to carry on.';
    console.log(`closing the last panel says what it stopped: ${JSON.stringify(closeNotice)} -> ${closeOk}`);
    if (!closeOk) process.exitCode = 1;

    view.unload();
    dom.window.close();
  } catch (error) {
    console.log(`onOpen FAILED: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
    process.exitCode = 1;
  }
}

void main();
