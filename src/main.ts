import { FileSystemAdapter, Menu, Notice, Plugin, TFile, type Editor, type TAbstractFile, type WorkspaceLeaf } from 'obsidian';
import { CLAUDE_CODE_TARGET, versionDrift } from './version';
import type { ModelInfo, SDKControlGetUsageResponse, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { patchSetMaxListenersForRenderer } from './electronCompat';
import { deleteSessionIfAny, deleteSessions, listHistory, loadTranscript, renameSessionTitle, sessionIds, sessionStamp, type ChatRecord, type HistoryItem } from './history';
import { messageSearchText } from './chatText';
import { errorText, log } from './log';
import { followDraftNotes, followNote, forgetChat, linkNote, NOTE_CHAT_ICONS, noteChatEntries, type NoteChatEntry, type NoteChats } from './noteChats';
import { hiddenPaths } from './pathFilter';
import { saveMathSource } from './mathSource';
import { RemoteControlServer, type RemoteState } from './remoteControl';
import { configuredDefaults, findClaude, probeClaude, runOneShot, type ClaudeLaunch, type ConfiguredDefaults } from './session';
import { summaryPrompt, summarySystem } from './chatSummary';
import { prettyModel } from './usageDisplay';
import { InlineEditModal } from './inlineEdit';
import { INLINE_CONTEXT_CHARS, inlineEditSystem } from './inlineEditPrompt';
import { ChatView, VIEW_TYPE } from './view';
import { DEFAULT_SETTINGS, SCRATCH_IDLE_CHOICES, VaultClaudeSettingTab, chatModel, extraPathEntries, type VaultClaudeSettings } from './settings';

const MAX_CHAT_RECORDS = 500;
const MODEL_CACHE_MS = 24 * 60 * 60 * 1000;
const PLAN_CACHE_MS = 5 * 60 * 1000;
/** How long saveSoon waits to save, gathering the changes of a burst of events. */
const SAVE_SOON_MS = 300;
/** Longest a chat being opened waits for a session's process to end (see sessionEnded); it takes about 2.5 s. */
const ENDING_WAIT_MS = 10_000;
/** How long after Obsidian is ready the chats are first listed (see listChats), out of the way of its start. */
const FIRST_LISTING_DELAY_MS = 3000;

/** Resolves when `promise` does, or after `ms` at the latest. */
function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** What a chat holds between messages: the text typed and not sent, and the note attached to it. */
export interface ChatDraft {
  text?: string;
  /** Vault path of the note that goes with each message. */
  note?: string;
  /** When it was last saved (ms); a draft of a chat outside the panel's list is dropped after DRAFT_DAYS. */
  at?: number;
}

/** A chat outside the panel's list (a session run elsewhere, opened here) keeps its draft this long. */
const DRAFT_DAYS = 30;

interface PluginData {
  settings?: Partial<VaultClaudeSettings>;
  chats?: ChatRecord[];
  models?: ModelInfo[];
  modelsFetchedAt?: number;
  commands?: SlashCommand[];
  commandsFetchedAt?: number;
  pinned?: string[];
  ticks?: Record<string, Record<string, number[]>>;
  noteChats?: NoteChats;
  noteRefs?: NoteChats;
  noteMentions?: NoteChats;
  drafts?: Record<string, ChatDraft>;
  unseen?: Record<string, 'done' | 'error'>;
  scratch?: { id: string; usedAt: number };
  sideSessions?: string[];
}

export default class VaultClaudePlugin extends Plugin {
  settings: VaultClaudeSettings = { ...DEFAULT_SETTINGS };
  /** Chats started from the panel, newest first. */
  chats: ChatRecord[] = [];
  /** Session ids pinned to the top of the history (panel chats or outside sessions). */
  pinned: string[] = [];
  /**
   * Checkboxes ticked in replies: chat id → reply key → positions flipped from the reply's text.
   * Dropped with the chat's record when the history is trimmed.
   */
  ticks: Record<string, Record<string, number[]>> = {};
  /** Models reported by Claude Code, cached so a new chat can list them before its session starts. */
  models: ModelInfo[] = [];
  modelsFetchedAt = 0;
  /** Slash commands and skills Claude Code reports, cached for the input's suggestions. */
  commands: SlashCommand[] = [];
  commandsFetchedAt = 0;
  /** Latest plan rate-limit usage, shared by all panels; kept in memory only. */
  planUsage: SDKControlGetUsageResponse | null = null;
  planFetchedAt = 0;
  /** Chats that changed each note: vault path → chat ids, newest first. */
  noteChats: NoteChats = {};
  /** Chats a note was sent with, as the attached note or an `@` mention: vault path → chat ids. */
  noteRefs: NoteChats = {};
  /** Notes a chat mentioned (linked in a reply, or read), as the notes menu lists them: for the history's notes view. */
  noteMentions: NoteChats = {};
  /** Each chat's unsent text and attached note, by chat id. */
  drafts: Record<string, ChatDraft> = {};
  /** Chats that finished while not on screen, and how, until they are shown. */
  unseen: Record<string, 'done' | 'error'> = {};
  /** The scratch chat: one chat that starts over when it has been idle, kept out of the history list. */
  scratch: { id: string; usedAt: number } | null = null;
  /** Side chats' sessions not deleted yet: those open now, and any left when Obsidian last quit. */
  sideSessions: string[] = [];
  /** A save waiting to cover a burst of changes (see saveSoon). */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sessions whose process is still ending (a kept side chat's), each with what resolves when it has. */
  private readonly endingSessions = new Map<string, Promise<void>>();
  /** Model and effort from Claude Code's settings files: what "Default" means for a new chat. */
  configured: ConfiguredDefaults = {};
  /** `claude remote-control` for the vault: phone access through the Claude app. */
  readonly remote = new RemoteControlServer();
  private lastRemoteState: RemoteState = 'stopped';
  private probe: Promise<void> | null = null;
  /** The vault's chats as last listed, and a listing still running (see listChats). */
  private lastListing: HistoryItem[] | null = null;
  private listing: Promise<HistoryItem[]> | null = null;
  /** Chats deleted, or being deleted, kept out of listings (see unlist). */
  private readonly unlisted = new Set<string>();
  /** Processes of closed chats still exiting, by session id (see processEnding). */
  private readonly exiting = new Map<string, Promise<void>>();
  /** Each chat's text for the history's search, with the stamp of the file it was read from (see chatSearchText). */
  private readonly searchTexts = new Map<string, { stamp: string; text: string }>();

  async onload(): Promise<void> {
    patchSetMaxListenersForRenderer();
    log(`plugin loaded (version ${this.manifest.version})`);
    // Obsidian's console is not visible outside the app: record this plugin's own uncaught errors.
    const ours = (error: unknown) => error instanceof Error && /vault-claude/.test(error.stack ?? '');
    this.registerDomEvent(window, 'error', (evt) => {
      if (ours(evt.error)) log('uncaught error', evt.error);
    });
    this.registerDomEvent(window, 'unhandledrejection', (evt) => {
      if (ours(evt.reason)) log('unhandled rejection', evt.reason);
    });
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    // Links in replies show Obsidian's page preview, with the modifier key held unless the Page preview settings say otherwise.
    this.registerHoverLinkSource(VIEW_TYPE, { display: 'Vault Claude', defaultMod: true });
    this.addRibbonIcon('bot', 'Open Claude', () => void this.activateView());
    this.addCommand({ id: 'open-chat', name: 'Open chat', callback: () => void this.activateView() });
    this.addCommand({
      id: 'new-chat',
      name: 'New chat',
      callback: async () => (await this.activateView())?.newChat(),
    });
    this.addCommand({
      id: 'chat-history',
      name: 'Chat history',
      callback: async () => (await this.activateView())?.openHistory(),
    });
    this.addCommand({
      id: 'branch-chat',
      name: 'Branch this chat into a new tab',
      callback: async () => (this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView()))?.branchIntoNewTab(),
    });
    this.addCommand({
      id: 'inline-edit',
      name: 'Edit selection with Claude',
      editorCallback: (editor, ctx) => {
        if (ctx.file) void this.openInlineEdit(editor, ctx.file);
      },
    });
    this.addCommand({
      id: 'new-chat-tab',
      name: 'New chat in a new tab',
      callback: async () => {
        const current = this.app.workspace.getActiveViewOfType(ChatView) ?? this.firstChatView();
        const view = current ? await this.openChatTab(current.leaf) : await this.activateView();
        view?.focusInput();
      },
    });
    this.addCommand({
      id: 'find-in-chat',
      name: 'Find in chat',
      callback: async () => (this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView()))?.openFind(),
    });
    this.addCommand({
      id: 'previous-message',
      name: 'Go to previous message you sent',
      callback: () => this.app.workspace.getActiveViewOfType(ChatView)?.stepMessage(-1),
    });
    this.addCommand({
      id: 'next-message',
      name: 'Go to next message you sent',
      callback: () => this.app.workspace.getActiveViewOfType(ChatView)?.stepMessage(1),
    });
    this.addCommand({
      id: 'list-messages',
      name: 'List messages you sent',
      callback: () => this.app.workspace.getActiveViewOfType(ChatView)?.listMessages(),
    });
    this.addCommand({
      id: 'edit-draft',
      name: 'Write this message in a note',
      callback: async () => (this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView()))?.editDraft(),
    });
    this.addCommand({
      id: 'send-draft',
      name: 'Send the draft note',
      callback: async () => (this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView()))?.sendDraft(),
    });
    this.addCommand({
      id: 'note-as-prompt',
      name: 'Send this note to Claude as a prompt',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.sendNoteAsPrompt(file);
        return true;
      },
    });
    this.addCommand({
      id: 'quote-selection',
      name: 'Quote the selected chat text in your next message',
      callback: () => this.app.workspace.getActiveViewOfType(ChatView)?.quoteSelection(),
    });
    this.addCommand({
      id: 'side-chat',
      name: 'Open side chat',
      callback: async () => (this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView()))?.openSideChat(),
    });
    this.addCommand({
      id: 'scratch-chat',
      name: 'Open scratch chat',
      callback: async () => (await this.activateView())?.openScratch(),
    });
    this.addCommand({
      id: 'clear-scratch',
      name: 'Clear scratch chat',
      callback: () => void this.clearScratchChat(),
    });
    this.addCommand({
      id: 'toggle-fast-mode',
      name: 'Toggle fast mode',
      callback: () => void this.app.workspace.getActiveViewOfType(ChatView)?.toggleFastMode(),
    });
    this.addCommand({
      id: 'focus-input',
      name: 'Focus chat input',
      callback: async () => (await this.activateView())?.focusInput(),
    });
    this.addCommand({
      id: 'stop',
      name: 'Stop Claude',
      callback: () => (this.app.workspace.getActiveViewOfType(ChatView) ?? this.firstChatView())?.stopTurn(),
    });
    this.addCommand({
      id: 'rename-chat',
      name: 'Rename chat',
      callback: async () => (this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView()))?.renameCurrentChat(),
    });
    this.addCommand({
      id: 'save-summary-as-note',
      name: 'Save chat summary as note',
      callback: async () => (this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView()))?.saveSummaryAsNote(),
    });
    this.addCommand({
      id: 'save-chat-as-note',
      name: 'Save chat as note',
      callback: async () => (this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView()))?.saveChatAsNote(),
    });
    this.addCommand({
      id: 'ask-about-selection',
      name: 'Ask Claude about selection',
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!file || !editor.getSelection().trim()) return false;
        if (!checking) void this.askAboutSelection(editor, file);
        return true;
      },
    });
    this.addCommand({
      id: 'take-all-off-phone',
      name: 'Take all chats off the phone',
      callback: () => void this.takeAllOffPhone(),
    });
    this.addCommand({
      id: 'toggle-phone-access',
      name: 'Toggle phone access (Remote Control)',
      callback: () => this.toggleRemote(),
    });
    this.addSettingTab(new VaultClaudeSettingTab(this.app, this));
    // Equations in the chat keep their LaTeX, for quoting. The panel renders with no source path;
    // markdown that has one is a note's, and is left alone. Early, to run before Obsidian draws them.
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (ctx.sourcePath === '') saveMathSource(el);
    }, -100);
    // Attaching notes, files and folders from the file explorer (one or several) as `@` mentions.
    const attachItem = (menu: Menu, items: TAbstractFile[]) =>
      menu.addItem((item) =>
        item
          .setTitle('Attach to Claude')
          .setIcon('paperclip')
          .onClick(() => void this.attachToClaude(items)),
      );
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        attachItem(menu, [file]);
        this.promptFromNoteItem(menu, file);
        this.chatForNoteItem(menu, file);
      }),
    );
    this.registerNoteEvents();
    this.registerEvent(this.app.workspace.on('files-menu', (menu, files) => attachItem(menu, files)));
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        const file = info.file;
        if (!file || !editor.getSelection().trim()) return;
        menu.addItem((item) =>
          item
            .setTitle('Edit with Claude')
            .setIcon('wand')
            .onClick(() => void this.openInlineEdit(editor, file)),
        );
        menu.addItem((item) =>
          item
            .setTitle('Ask Claude about selection')
            .setIcon('bot')
            .onClick(() => void this.askAboutSelection(editor, file)),
        );
      }),
    );
    this.register(this.remote.onChange(() => this.onRemoteChange()));
    // Side chats open when Obsidian last quit: their sessions are deleted now, as closing them would have.
    const leftover = [...this.sideSessions];
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.phoneAccessAtStartup) this.startRemote();
      void this.sweepSideSessions(leftover);
      // Listed once soon after starting, so that even the first history opened shows its rows at once;
      // and the note links of sessions Claude Code has since deleted are let go.
      const timer = window.setTimeout(() => {
        void this.listChats().catch((error: unknown) => log('listing history failed', error));
        void this.pruneNoteLinks();
      }, FIRST_LISTING_DELAY_MS);
      this.register(() => window.clearTimeout(timer));
    });
  }

  /**
   * Lets go of the links between notes and sessions whose files are gone (Claude Code deletes old
   * sessions; links of chats from outside the panel are not dropped with the oldest chat records),
   * so that the note indexes do not grow for good. Nothing is let go when the folder cannot be read.
   */
  async pruneNoteLinks(): Promise<void> {
    const dir = this.vaultRoot();
    const ids = dir ? await sessionIds(dir) : null;
    if (!ids) return;
    let changed = false;
    for (const index of [this.noteChats, this.noteRefs, this.noteMentions]) {
      for (const id of new Set(Object.values(index).flat())) {
        if (!ids.has(id)) changed = forgetChat(index, id) || changed;
      }
    }
    if (changed) this.saveSoon();
  }

  /** The vault's chats as last listed (see listChats), for the history to show at once; null before the first listing. */
  listedChats(): HistoryItem[] | null {
    return this.lastListing;
  }

  /**
   * Lists the vault's chats (see listHistory) and keeps them for the next history opened; one
   * listing at a time, which a second request shares.
   */
  listChats(): Promise<HistoryItem[]> {
    const dir = this.vaultRoot();
    if (!dir) return Promise.resolve([]);
    this.listing ??= (async () => {
      const started = performance.now();
      try {
        const listed = await listHistory(dir, this.chats, this.settings.historyIncludesAllSessions);
        // A chat deleted while this listing ran, or whose file is still there, is not listed again.
        const found = new Set(listed.map((item) => item.id));
        for (const id of this.unlisted) if (!found.has(id)) this.unlisted.delete(id);
        const items = listed.filter((item) => !this.unlisted.has(item.id));
        log(`history listed: ${items.length} chats in ${Math.round(performance.now() - started)} ms`);
        this.lastListing = items;
        return items;
      } finally {
        this.listing = null;
      }
    })();
    return this.listing;
  }

  /**
   * A chat's prompts and replies as the history searches them (see messageSearchText), kept while
   * Obsidian runs: a chat is read again only when its file has changed. Reading every chat takes a
   * couple of seconds (their files hold tool output and images too); the text is a small part.
   */
  async chatSearchText(id: string): Promise<string> {
    const dir = this.vaultRoot();
    if (!dir) return '';
    const stamp = await sessionStamp(id, dir);
    const kept = this.searchTexts.get(id);
    if (stamp && kept?.stamp === stamp) return kept.text;
    const text = (await loadTranscript(id, dir)).map(messageSearchText).filter(Boolean).join('\n');
    if (stamp) this.searchTexts.set(id, { stamp, text });
    else this.searchTexts.delete(id);
    return text;
  }

  /**
   * Takes a chat whose session is deleted, or about to be, out of the chats as last listed, and out
   * of every listing until one no longer finds its file.
   */
  private unlist(id: string): void {
    this.unlisted.add(id);
    if (this.lastListing) this.lastListing = this.lastListing.filter((item) => item.id !== id);
  }

  /**
   * A note that moves keeps its chats, and the chats it is attached to; a deleted one lets them go
   * (see noteMoved). Quitting Obsidian does not unload plugins, so a save still waiting is started
   * when it quits, as a best effort: no quit task is added to wait for it, since that makes "Reload
   * app without saving" quit the app instead (a reported Obsidian bug).
   */
  registerNoteEvents(): void {
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.noteMoved(oldPath, file.path)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.noteMoved(file.path, null)));
    this.registerEvent(this.app.workspace.on('quit', () => void this.flushSave()));
  }

  onunload(): void {
    this.remote.stop();
    void this.flushSave();
  }

  /** Makes a save still waiting (see saveSoon) at once; nothing when none is waiting. */
  flushSave(): Promise<void> {
    if (this.saveTimer === null) return Promise.resolve();
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.saveSettings();
  }

  /** Saves the plugin's data once for a burst of changes, SAVE_SOON_MS after the first. */
  private saveSoon(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveSettings();
    }, SAVE_SOON_MS);
  }

  phoneAccessName(): string {
    return this.settings.phoneAccessName.trim() || `${this.app.vault.getName()} vault`;
  }

  /**
   * What running Claude Code in the vault takes: the vault's folder, the `claude` executable and
   * the extra PATH entries; or, when it cannot run, why, in words for a notice.
   */
  claudeLaunch(): ClaudeLaunch | string {
    const cwd = this.vaultRoot();
    const claude = findClaude(this.settings.claudePath);
    if (claude.path === undefined) return claude.error;
    if (!cwd) return 'Vault Claude needs a vault stored on the local file system.';
    return { cwd, claudePath: claude.path, extraPath: extraPathEntries(this.settings.extraPath) };
  }

  /** claudeLaunch, or null after a notice saying why Claude Code cannot run. */
  launchOrNotice(): ClaudeLaunch | null {
    const launch = this.claudeLaunch();
    if (typeof launch !== 'string') return launch;
    new Notice(launch);
    return null;
  }

  startRemote(): void {
    const launch = this.launchOrNotice();
    if (!launch) return;
    // Phone sessions never bypass permissions: the panel's deny rules cannot be passed to them.
    const mode = this.settings.permissionMode === 'bypassPermissions' ? 'default' : this.settings.permissionMode;
    this.remote.start({ ...launch, name: this.phoneAccessName(), permissionMode: mode });
  }

  toggleRemote(): void {
    if (this.remote.isRunning()) this.remote.stop();
    else this.startRemote();
  }

  private onRemoteChange(): void {
    const { state, error } = this.remote.status;
    if (state === 'connected' && this.lastRemoteState !== 'connected') {
      new Notice(`Phone access on. In the Claude app, open Code and choose "${this.phoneAccessName()}".`);
    } else if (state === 'error' && this.lastRemoteState !== 'error') {
      new Notice(`Phone access stopped: ${error ?? 'unknown error'}`, 10_000);
    }
    this.lastRemoteState = state;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.updatePhoneButton();
    }
  }

  vaultRoot(): string | null {
    const { adapter } = this.app.vault;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  async activateView(): Promise<ChatView | null> {
    if (!this.vaultRoot()) {
      new Notice('Vault Claude needs a vault stored on the local file system.');
      return null;
    }
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  /** Opens an empty chat panel as a new tab in the same area (sidebar or main) as `beside`. */
  async openChatTab(beside: WorkspaceLeaf): Promise<ChatView | null> {
    const { workspace } = this.app;
    const root = beside.getRoot();
    const leaf =
      root === workspace.rightSplit
        ? workspace.getRightLeaf(false)
        : root === workspace.leftSplit
          ? workspace.getLeftLeaf(false)
          : workspace.getLeaf('tab');
    if (!leaf) return null;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  refreshPanelMargins(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.applyPanelMargin();
    }
  }

  /** Redraws the opening lines of every empty chat, after a setting changed what they say. */
  refreshWelcomes(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.refreshWelcome();
    }
  }

  refreshModeMenus(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.populateModeSelect();
    }
  }

  /** How long the scratch chat may be left alone before it starts over, in milliseconds (the setting). */
  private scratchIdleMs(): number {
    return this.settings.scratchIdleHours * 60 * 60 * 1000;
  }

  /** How long the scratch chat has left before it starts over, in milliseconds. */
  scratchLeft(): number {
    const idle = this.scratchIdleMs();
    return this.scratch ? Math.max(0, this.scratch.usedAt + idle - Date.now()) : idle;
  }

  /** The scratch chat's session, unless it has been idle long enough to start over. */
  scratchSession(): string | null {
    if (!this.scratch) return null;
    return Date.now() - this.scratch.usedAt < this.scratchIdleMs() ? this.scratch.id : null;
  }

  /** Sets how long the scratch chat may be left alone, from the settings or the new-chat menu; the panels' lines about it follow. */
  async setScratchIdle(hours: number): Promise<void> {
    this.settings.scratchIdleHours = hours;
    await this.saveSettings();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.refreshScratchLines();
    }
  }

  /** The session a panel started for the scratch chat; it is not added to the history list. */
  setScratch(id: string): void {
    this.scratch = { id, usedAt: Date.now() };
    void this.saveSettings();
  }

  touchScratch(): void {
    if (!this.scratch) return;
    this.scratch.usedAt = Date.now();
    void this.saveSettings();
  }

  /**
   * Follows a note, or a folder's notes, that moved to `to`, or was deleted (`to` null): the chats
   * that changed it, were sent it or mentioned it, and the chats it is attached to, go with it, or let
   * it go; so do the panels, for what they hold by path (see ChatView.followNote).
   */
  noteMoved(from: string, to: string | null): void {
    let changed = followNote(this.noteChats, from, to);
    changed = followNote(this.noteRefs, from, to) || changed;
    changed = followNote(this.noteMentions, from, to) || changed;
    changed = followDraftNotes(Object.entries(this.drafts), from, to, (id) => delete this.drafts[id]) || changed;
    // Moving or deleting a folder is one event per file: saved once for them all.
    if (changed) this.saveSoon();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.followNote(from, to);
    }
  }

  /** Marks session `id` as still ending; the function returned says it has ended. */
  sessionEnding(id: string): () => void {
    let ended = (): void => undefined;
    const done = new Promise<void>((resolve) => (ended = resolve));
    this.endingSessions.set(id, done);
    return () => {
      if (this.endingSessions.get(id) === done) this.endingSessions.delete(id);
      ended();
    };
  }

  /** Resolves once session `id` has no process still ending (see sessionEnding), or after `limitMs`. */
  sessionEnded(id: string, limitMs = ENDING_WAIT_MS): Promise<void> {
    const ending = this.endingSessions.get(id);
    return ending ? waitAtMost(ending, limitMs) : Promise.resolve();
  }

  /**
   * Notes that the process of session `id`, closed, is gone once `ended` resolves. Claude Code writes
   * to a session's file as its process exits, so deleting the file waits for this (see processesEnded);
   * opening the chat does not, since a new process can resume it meanwhile.
   */
  processEnding(id: string, ended: Promise<void>): void {
    this.exiting.set(id, ended);
    void ended.then(() => {
      if (this.exiting.get(id) === ended) this.exiting.delete(id);
    });
  }

  /** Resolves once session `id` has no process left, a closed one exiting (see processEnding) or a kept side chat's, or after `limitMs`. */
  private async processesEnded(id: string, limitMs = ENDING_WAIT_MS): Promise<void> {
    const exiting = this.exiting.get(id);
    await Promise.all([this.sessionEnded(id, limitMs), exiting && waitAtMost(exiting, limitMs)]);
  }

  /** Notes a side chat's session, so it is deleted at the next start if Obsidian quits with it open. */
  holdSideSession(id: string): void {
    if (this.sideSessions.includes(id)) return;
    this.sideSessions.push(id);
    void this.saveSettings();
  }

  /** Forgets a side chat's session: deleted, or kept as a chat. */
  releaseSideSession(id: string): void {
    if (!this.sideSessions.includes(id)) return;
    this.sideSessions = this.sideSessions.filter((held) => held !== id);
    void this.saveSettings();
  }

  /** Deletes the side chats' sessions `ids`, left from the last run, and forgets them. */
  private async sweepSideSessions(ids: string[]): Promise<void> {
    const dir = this.vaultRoot();
    if (!dir || ids.length === 0) return;
    await deleteSessions(ids, dir, new Set(this.chats.map((chat) => chat.id)));
    this.sideSessions = this.sideSessions.filter((id) => !ids.includes(id));
    await this.saveSettings();
  }

  /** Forgets which chat is the scratch chat; returns its session id, if it had one. What it leaves goes when it is deleted (see deleteScratch). */
  private forgetScratch(): string | undefined {
    const old = this.scratch?.id;
    this.scratch = null;
    void this.saveSettings();
    return old;
  }

  /** Deletes a scratch chat let go of (see deleteWhenEnded), and then what it left: ticks, draft, mark. */
  private async deleteScratch(id: string): Promise<void> {
    try {
      await this.deleteWhenEnded(id);
      this.forgetChatData(id);
      this.saveSoon();
    } catch (error) {
      log('deleting the scratch session failed', error);
    }
  }

  /**
   * Deletes a session, out of the chat listings at once, once no process of it is still ending:
   * Claude Code writes to the session's file as its process exits, which would leave a file of that
   * alone in the history. One that cannot be deleted is listed again, and the error thrown.
   */
  private async deleteWhenEnded(id: string): Promise<void> {
    const dir = this.vaultRoot();
    if (!dir) throw new Error('the vault folder is not known');
    const listed = this.lastListing?.find((item) => item.id === id);
    this.unlist(id);
    await this.processesEnded(id);
    try {
      await deleteSessionIfAny(id, dir);
      this.searchTexts.delete(id);
    } catch (error) {
      this.unlisted.delete(id);
      if (listed && this.lastListing) this.lastListing = [...this.lastListing, listed].sort((a, b) => b.updatedAt - a.updatedAt);
      throw error;
    }
  }

  /**
   * Forgets the scratch chat, as `except`, a panel starting a new one, lets it go, and deletes the
   * session Claude Code saved for it; unless another panel still shows it or runs it, which keeps it
   * (as an ordinary chat, when it shows it).
   */
  async clearScratch(except?: ChatView): Promise<void> {
    const old = this.forgetScratch();
    if (!old) return;
    const holder = this.chatHolder(old, except);
    if (holder) {
      // It goes on there, as an ordinary chat in the chat list rather than a scratch chat no longer recorded.
      holder.keepAsChat(old);
      return;
    }
    except?.closeBackgroundChat(old);
    await this.deleteScratch(old);
  }

  /**
   * Turning the scratch chat off: a panel showing one keeps it as an ordinary chat, which joins
   * the chat list, rather than leaving it open with nowhere to reach it again.
   */
  async stopScratch(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof ChatView && leaf.view.isScratchChat()) leaf.view.keepScratchAsChat();
    }
    this.scratch = null;
    await this.saveSettings();
  }

  /** Clears the scratch chat: a panel showing it starts a new one in its place, and it stops wherever it still runs. */
  async clearScratchChat(): Promise<void> {
    const old = this.forgetScratch();
    for (const view of this.chatViews()) {
      if (view.isScratchChat()) view.startScratchOver();
      if (old) view.closeBackgroundChat(old);
    }
    if (old) await this.deleteScratch(old);
    new Notice('Scratch chat cleared.');
  }

  /** Records that a chat changed a note, so the note can offer it later. */
  /** `promote`: an edit made now, which makes the chat the note's newest (see linkNote); saved only when the index changed. */
  linkNoteChat(path: string, chatId: string, promote = true): void {
    if (hiddenPaths(this.settings.hiddenNotePaths)(path)) return;
    // Links come in bursts (a turn editing many notes, an older chat reopened): saved once for them.
    if (linkNote(this.noteChats, path, chatId, promote)) this.saveSoon();
  }

  chatDraft(id: string): ChatDraft {
    return this.drafts[id] ?? {};
  }

  /** Stores a chat's unsent text and attached note; an empty draft is dropped. Saved only on a change. */
  setChatDraft(id: string, draft: ChatDraft): void {
    const next: ChatDraft = {};
    if (draft.text?.trim()) next.text = draft.text;
    if (draft.note) next.note = draft.note;
    const before = this.drafts[id] ?? {};
    if (before.text === next.text && before.note === next.note) return;
    if (next.text !== undefined || next.note !== undefined) this.drafts[id] = { ...next, at: Date.now() };
    else delete this.drafts[id];
    void this.saveSettings();
  }

  /** Records that a note went with a message in a chat: as the attached note, or mentioned. */
  linkNoteRef(path: string, chatId: string): void {
    if (hiddenPaths(this.settings.hiddenNotePaths)(path)) return;
    if (linkNote(this.noteRefs, path, chatId)) this.saveSoon();
  }

  /** Records that a chat mentioned a note (see ChatView.recordMentions), for the history's notes view. */
  linkNoteMention(path: string, chatId: string): void {
    if (hiddenPaths(this.settings.hiddenNotePaths)(path)) return;
    if (linkNote(this.noteMentions, path, chatId, false)) this.saveSoon();
  }

  /** The chats offered for a note; only chats still in the history. */
  noteChatEntries(file: TFile): NoteChatEntry[] {
    const known = (ids: string[] | undefined) => (ids ?? []).flatMap((id) => this.chats.find((chat) => chat.id === id) ?? []);
    return noteChatEntries(known(this.noteChats[file.path]), this.sessionOfNote(file), known(this.noteRefs[file.path]));
  }

  /** The chat a saved chat note came from, from its `claude_session` frontmatter. */
  sessionOfNote(file: TFile): string | null {
    const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.claude_session;
    return typeof value === 'string' && value ? value : null;
  }

  /** Whether a chat was started in the panel (rather than elsewhere in the vault, which opens as a copy). */
  isPanelChat(id: string): boolean {
    return this.chats.some((chat) => chat.id === id);
  }

  recordChat(id: string, title: string): void {
    if (this.isPanelChat(id)) return;
    const now = Date.now();
    this.chats.unshift({ id, title, createdAt: now, updatedAt: now });
    for (const dropped of this.chats.slice(MAX_CHAT_RECORDS)) this.forgetChatData(dropped.id);
    this.chats = this.chats.slice(0, MAX_CHAT_RECORDS);
    void this.saveSettings();
  }

  /** Forgets what the plugin keeps for chat `id` beside its record: pin, ticks, draft, mark and note links. */
  private forgetChatData(id: string): void {
    this.pinned = this.pinned.filter((other) => other !== id);
    delete this.ticks[id];
    delete this.drafts[id];
    delete this.unseen[id];
    for (const index of [this.noteChats, this.noteRefs, this.noteMentions]) forgetChat(index, id);
  }

  /** The positions of reply `replyKey`'s checkboxes that the reader flipped; a fresh set to change and save. */
  toggledTicks(chat: string, replyKey: string): Set<number> {
    return new Set(this.ticks[chat]?.[replyKey] ?? []);
  }

  setTicks(chat: string, replyKey: string, toggled: ReadonlySet<number>): void {
    const chatTicks = (this.ticks[chat] ??= {});
    if (toggled.size > 0) chatTicks[replyKey] = [...toggled].sort((a, b) => a - b);
    else delete chatTicks[replyKey];
    if (Object.keys(chatTicks).length === 0) delete this.ticks[chat];
    void this.saveSettings();
  }

  private versionChecked = false;

  /** Once per launch: a notice when the installed Claude Code is far from the SDK's version. */
  checkClaudeVersion(running: string | undefined): void {
    if (this.versionChecked || !running || !CLAUDE_CODE_TARGET) return;
    this.versionChecked = true;
    const drift = versionDrift(running, CLAUDE_CODE_TARGET);
    log('claude code version', { running, sdkTarget: CLAUDE_CODE_TARGET, drift: drift !== null });
    if (drift) new Notice(drift, 15_000);
  }

  async attachToClaude(items: TAbstractFile[]): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView());
    view?.mentionItems(items);
  }

  private chatViews(): ChatView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is ChatView => view instanceof ChatView);
  }

  /** The panel, other than `except`, that has chat `id` on screen or running in its background. */
  chatHolder(id: string, except?: ChatView): ChatView | null {
    return this.chatViews().find((view) => view !== except && view.holdsChat(id)) ?? null;
  }

  /** History status labels from every panel. */
  /** Status labels for the history: chats open or running in any panel, then those finished and not yet seen. */
  chatStatuses(): Map<string, string> {
    const statuses = new Map<string, string>();
    for (const view of this.chatViews()) {
      for (const [id, status] of view.chatStatuses()) statuses.set(id, status);
    }
    for (const [id, outcome] of Object.entries(this.unseen)) {
      if (!statuses.has(id)) statuses.set(id, outcome === 'done' ? 'New reply' : 'Stopped with an error');
    }
    return statuses;
  }

  /** Chats a panel holds: on screen or running in its background, in any panel. */
  openChats(): Set<string> {
    return new Set(this.chatViews().flatMap((view) => [...view.chatStatuses().keys()]));
  }

  /** Another panel, which can take over a closing panel's running chats. */
  otherChatView(except: ChatView): ChatView | null {
    return this.chatViews().find((view) => view !== except && !view.isClosing()) ?? null;
  }

  /** Chats with tasks running in the background, in any panel. */
  chatsWithTasks(): Set<string> {
    return new Set(this.chatViews().flatMap((view) => view.chatsWithTasks()));
  }

  /** Stops a chat's background tasks in whichever panel holds it. */
  stopChatTasks(id: string): void {
    for (const view of this.chatViews()) if (view.stopTasksOf(id)) return;
  }

  /** A chat finished while not on screen: the history marks it until it is shown. */
  markChatUnseen(id: string, outcome: 'done' | 'error'): void {
    if (this.unseen[id] === outcome) return;
    this.unseen[id] = outcome;
    void this.saveSettings();
  }

  markChatSeen(id: string): void {
    if (!(id in this.unseen)) return;
    delete this.unseen[id];
    void this.saveSettings();
  }

  phoneChatCount(): number {
    return this.chatViews().reduce((sum, view) => sum + view.phoneChats(), 0);
  }

  async takeAllOffPhone(): Promise<void> {
    let count = 0;
    for (const view of this.chatViews()) count += await view.takeOffPhone();
    new Notice(count > 0 ? `Took ${count} chat${count === 1 ? '' : 's'} off the phone.` : 'No chats are on the phone.');
  }

  firstChatView(): ChatView | null {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    return view instanceof ChatView ? view : null;
  }

  /** Pins or unpins a chat in the history; returns whether it is pinned afterwards. */
  togglePin(id: string): boolean {
    const pinned = !this.pinned.includes(id);
    this.pinned = pinned ? [...this.pinned, id] : this.pinned.filter((other) => other !== id);
    void this.saveSettings();
    return pinned;
  }

  /**
   * Deletes a chat: Claude Code's saved session, and the plugin's record, pin and ticks for it.
   * Refused while the chat is on screen or running in any panel, whose process would keep writing it.
   */
  /** A note's right-click menu: send what it says as the next message. */
  private promptFromNoteItem(menu: Menu, file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    menu.addItem((item) =>
      item
        .setTitle('Send to Claude as a prompt')
        .setIcon('bot')
        .onClick(() => void this.sendNoteAsPrompt(file)),
    );
  }

  /** Sends a note's text as the message, in the panel. A chat's draft goes through that chat. */
  async sendNoteAsPrompt(file: TFile): Promise<void> {
    const owner = this.chatViews().find((view) => view.holdsDraft(file.path));
    if (owner) return owner.sendDraft();
    const text = (await this.app.vault.read(file)).trim();
    if (!text) {
      new Notice(`“${file.basename}” is empty.`);
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView());
    await view?.sendText(text);
  }

  /** A note's right-click menu: the chats that changed it or were sent it, or the chat a saved chat note came from. */
  private chatForNoteItem(menu: Menu, file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    const entries = this.noteChatEntries(file);
    if (entries.length === 0) return;
    menu.addItem((item) => {
      item.setTitle(entries.length === 1 ? 'Open its Claude chat' : 'Open a Claude chat about this note').setIcon('bot');
      if (entries.length === 1) {
        item.onClick(() => void this.openChatById(entries[0].id, entries[0].title));
        return;
      }
      const submenu = (item as unknown as { setSubmenu(): Menu }).setSubmenu();
      const open = this.openChats();
      for (const entry of entries) {
        submenu.addItem((sub) =>
          sub
            .setTitle(open.has(entry.id) ? `${entry.title} · open` : entry.title)
            .setIcon(NOTE_CHAT_ICONS[entry.why])
            .onClick(() => void this.openChatById(entry.id, entry.title)),
        );
      }
    });
  }

  /** Opens a chat by its session id in the panel. */
  async openChatById(id: string, title: string): Promise<void> {
    const view = await this.activateView();
    await view?.openChat({ id, title, updatedAt: Date.now(), fromPanel: this.isPanelChat(id) });
  }

  async deleteChat(id: string): Promise<boolean> {
    if (this.chatHolder(id)) {
      new Notice('This chat is open or still running. Start a new chat in its panel, then delete it.');
      return false;
    }
    try {
      await this.deleteWhenEnded(id);
    } catch (error) {
      log('deleting a chat failed', error);
      new Notice(`Could not delete the chat: ${errorText(error)}`);
      return false;
    }
    this.chats = this.chats.filter((chat) => chat.id !== id);
    this.forgetChatData(id);
    log('chat deleted', { id });
    await this.saveSettings();
    return true;
  }

  /** A user-chosen title: the panel's record, Claude Code's record of the session, and any panel showing it. */
  async renameChatTitle(id: string, title: string): Promise<void> {
    this.renameChat(id, title);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.onChatRenamed(id, title);
    }
    const dir = this.vaultRoot();
    if (!dir) return;
    try {
      await renameSessionTitle(id, dir, title);
    } catch (error) {
      log('renaming the session failed', error);
    }
  }

  renameChat(id: string, title: string): void {
    const chat = this.chats.find((record) => record.id === id);
    if (!chat || chat.title === title) return;
    chat.title = title;
    void this.saveSettings();
  }

  touchChat(id: string): void {
    const chat = this.chats.find((record) => record.id === id);
    if (!chat) return;
    chat.updatedAt = Date.now();
    void this.saveSettings();
  }

  /** "Edit selection with Claude" for the editor's selection, or for writing at the cursor. */
  async openInlineEdit(editor: Editor, file: TFile): Promise<void> {
    const launch = this.launchOrNotice();
    if (!launch) return;
    const from = editor.getCursor('from');
    const to = editor.getCursor('to');
    const text = editor.getValue();
    const start = editor.posToOffset(from);
    const end = editor.posToOffset(to);
    const target = {
      editor,
      file,
      from,
      to,
      original: editor.getRange(from, to),
      before: text.slice(Math.max(0, start - INLINE_CONTEXT_CHARS), start),
      after: text.slice(end, end + INLINE_CONTEXT_CHARS),
    };
    const conventions = await this.vaultConventions();
    if (!this.configured.model) await this.loadConfigured();
    const model = this.settings.smallJobModel || chatModel(this.settings.model);
    new InlineEditModal(this.app, target, inlineEditSystem(target.original === '', conventions), (system, prompt, onText, signal) =>
      runOneShot(launch, { system, prompt, model }, onText, signal),
    ).open();
  }

  /**
   * "Save summary as note": one request with no tools, following the vault's CLAUDE.md, on the
   * summary model; resolves to Claude's note. `transcript` is the chat's prompts and replies.
   */
  async summarizeChat(input: { title: string; date: string; sessionId: string; transcript: string }, signal: AbortSignal): Promise<string> {
    const launch = this.claudeLaunch();
    if (typeof launch === 'string') throw new Error(launch);
    const conventions = await this.vaultConventions();
    if (!this.configured.model) await this.loadConfigured();
    const model = this.settings.smallJobModel || chatModel(this.settings.model);
    return runOneShot(
      launch,
      { system: summarySystem(conventions), prompt: summaryPrompt({ ...input, model: this.modelName(model) }), model, effort: 'medium' },
      () => undefined,
      signal,
    );
  }

  /** The vault's CLAUDE.md, for one-off requests, which run without Claude Code's settings files. */
  private async vaultConventions(): Promise<string> {
    const { adapter } = this.app.vault;
    try {
      return (await adapter.exists('CLAUDE.md')) ? await adapter.read('CLAUDE.md') : '';
    } catch (error) {
      log('reading CLAUDE.md failed', error);
      return '';
    }
  }

  /**
   * `Opus 5` for a model alias or id, resolved through Claude Code's model list; with none, the model
   * Claude Code's settings name, which it then runs, else its default; `undefined` when unknown.
   */
  private modelName(model: string | undefined): string | undefined {
    const wanted = model ?? this.configured.model;
    const entry = this.models.find((candidate) => candidate.value === (wanted ?? 'default'));
    const id = entry?.resolvedModel ?? wanted;
    return id ? prettyModel(id).replace(/ · 1M$/, '') : undefined;
  }

  /** Opens the chat panel with the editor's selection attached to the next message. */
  async askAboutSelection(editor: Editor, file: TFile): Promise<void> {
    const text = editor.getSelection();
    const fromLine = editor.getCursor('from').line + 1;
    const toLine = editor.getCursor('to').line + 1;
    const view = await this.activateView();
    view?.attachSelection({ kind: 'selection', name: file.basename, path: file.path, fromLine, toLine, text });
  }

  setCommands(commands: SlashCommand[]): void {
    this.commands = commands;
    this.commandsFetchedAt = Date.now();
    void this.saveSettings();
  }

  setModels(models: ModelInfo[]): void {
    this.models = models;
    this.modelsFetchedAt = Date.now();
    void this.saveSettings();
  }

  async loadConfigured(): Promise<void> {
    const cwd = this.vaultRoot();
    if (cwd) this.configured = await configuredDefaults(cwd);
  }

  setPlanUsage(plan: SDKControlGetUsageResponse): void {
    this.planUsage = plan;
    this.planFetchedAt = Date.now();
  }

  /**
   * Runs a prompt-less Claude Code process for the model list and plan usage when either is
   * stale (models: a day; plan usage: five minutes), so a panel can show both before any chat.
   */
  refreshStatus(): Promise<void> {
    const now = Date.now();
    const modelsFresh = this.models.length > 0 && now - this.modelsFetchedAt < MODEL_CACHE_MS;
    const commandsFresh = this.commands.length > 0 && now - this.commandsFetchedAt < MODEL_CACHE_MS;
    const planFresh = now - this.planFetchedAt < PLAN_CACHE_MS;
    if (modelsFresh && commandsFresh && planFresh) return Promise.resolve();
    if (this.probe) return this.probe;
    const launch = this.claudeLaunch();
    if (typeof launch === 'string') return Promise.resolve();
    this.probe = probeClaude(launch)
      .then(({ models, commands, plan }) => {
        log('probe', { models: models.length, commands: commands.length, plan: plan !== null });
        if (models.length > 0) this.setModels(models);
        if (commands.length > 0) this.setCommands(commands);
        if (plan) this.setPlanUsage(plan);
      })
      .catch((error) => log('probe failed', error))
      .finally(() => {
        this.probe = null;
      });
    return this.probe;
  }

  async loadSettings(): Promise<void> {
    const raw = ((await this.loadData()) ?? {}) as PluginData & Partial<VaultClaudeSettings>;
    // Version 0.1 stored the settings object itself at the top level.
    const stored: Partial<VaultClaudeSettings> = raw.settings ?? raw;
    this.settings = { ...DEFAULT_SETTINGS, ...stored };
    // Only the times offered: anything else (a hand-edited data.json) falls back to the default.
    if (!SCRATCH_IDLE_CHOICES.includes(this.settings.scratchIdleHours)) this.settings.scratchIdleHours = DEFAULT_SETTINGS.scratchIdleHours;
    if (this.settings.sideChatContext !== 'quote') this.settings.sideChatContext = 'chat';
    // Up to 0.11.0 these were three settings; whichever was set becomes the one for small jobs.
    const legacy = stored as Partial<Record<'smallJobModel' | 'scratchModel' | 'summaryModel' | 'inlineEditModel', string>>;
    if (typeof legacy.smallJobModel !== 'string') {
      this.settings.smallJobModel = legacy.scratchModel || legacy.summaryModel || legacy.inlineEditModel || DEFAULT_SETTINGS.smallJobModel;
    }
    // Up to 0.13.0 a panel-wide switch, on by default; notes are now attached per chat, and none to start with.
    delete (this.settings as Partial<Record<'includeActiveNote', unknown>>).includeActiveNote;
    this.chats = Array.isArray(raw.chats) ? raw.chats : [];
    this.pinned = Array.isArray(raw.pinned) ? raw.pinned : [];
    this.scratch = raw.scratch && typeof raw.scratch.id === 'string' ? raw.scratch : null;
    this.sideSessions = Array.isArray(raw.sideSessions) ? raw.sideSessions.filter((id): id is string => typeof id === 'string') : [];
    this.noteChats = raw.noteChats && typeof raw.noteChats === 'object' ? raw.noteChats : {};
    this.noteRefs = raw.noteRefs && typeof raw.noteRefs === 'object' ? raw.noteRefs : {};
    this.noteMentions = raw.noteMentions && typeof raw.noteMentions === 'object' ? raw.noteMentions : {};
    this.drafts = raw.drafts && typeof raw.drafts === 'object' ? raw.drafts : {};
    // A draft of a chat in the panel's list goes with the chat (deleted with it, or dropped with
    // the oldest records); one of a session opened from elsewhere has no such end, so it ages out.
    const listed = new Set(this.chats.map((chat) => chat.id));
    const cutoff = Date.now() - DRAFT_DAYS * 24 * 60 * 60 * 1000;
    for (const [id, draft] of Object.entries(this.drafts)) {
      if (listed.has(id) || id === this.scratch?.id) continue;
      // Saved before drafts carried a date: counted from now.
      if (draft.at === undefined) draft.at = Date.now();
      else if (draft.at < cutoff) delete this.drafts[id];
    }
    this.unseen = raw.unseen && typeof raw.unseen === 'object' ? raw.unseen : {};
    this.ticks = raw.ticks && typeof raw.ticks === 'object' ? raw.ticks : {};
    this.models = Array.isArray(raw.models) ? raw.models : [];
    this.modelsFetchedAt = typeof raw.modelsFetchedAt === 'number' ? raw.modelsFetchedAt : 0;
    this.commands = Array.isArray(raw.commands) ? raw.commands : [];
    this.commandsFetchedAt = typeof raw.commandsFetchedAt === 'number' ? raw.commandsFetchedAt : 0;
  }

  async saveSettings(): Promise<void> {
    const data: PluginData = {
      settings: this.settings,
      chats: this.chats,
      scratch: this.scratch ?? undefined,
      noteChats: this.noteChats,
      noteRefs: this.noteRefs,
      noteMentions: this.noteMentions,
      drafts: this.drafts,
      unseen: this.unseen,
      models: this.models,
      modelsFetchedAt: this.modelsFetchedAt,
      commands: this.commands,
      commandsFetchedAt: this.commandsFetchedAt,
      pinned: this.pinned,
      ticks: this.ticks,
      sideSessions: this.sideSessions,
    };
    await this.saveData(data);
  }
}
