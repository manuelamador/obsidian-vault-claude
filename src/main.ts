import { existsSync } from 'fs';
import { FileSystemAdapter, Menu, Notice, Plugin, TFile, normalizePath, parseYaml, stringifyYaml, type Editor, type TAbstractFile, type WorkspaceLeaf } from 'obsidian';
import { join as joinPath } from 'path';
import { CLAUDE_CODE_TARGET, versionDrift } from './version';
import type { ModelInfo, SDKControlGetUsageResponse, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { patchSetMaxListenersForRenderer } from './electronCompat';
import { deleteSessionIfAny, deleteSessions, listHistory, loadTranscript, renameSessionTitle, sessionIds, sessionStamp, type ChatRecord, type HistoryItem } from './history';
import { messageSearchText } from './chatText';
import { errorText, log } from './log';
import { followDraftNotes, followNote, forgetChat, linkNote, movedPath, noteChatEntries, unlinkNote, type NoteChatEntry, type NoteChats } from './noteChats';
import { hiddenPaths } from './pathFilter';
import { ALL_MEMOS_VIEW, MEMO_SUGGESTION_SYSTEM, chatMemosView, firstPassageTarget, isChatViewName, PROTOCOL_ACTION, memoBaseYaml, pairChat, retargetMemoBase, memoSuggestionPrompt, readMemoSuggestion, type MemoPassage } from './memos';
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

/** A plan edited in a note (see ChatView.renderPlanCard): the note, and the plan as Claude wrote it. */
interface PlanNote {
  path: string;
  plan: string;
}

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
  noteRemoved?: NoteChats;
  drafts?: Record<string, ChatDraft>;
  planNotes?: Record<string, PlanNote>;
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
  /** Chats taken off a note by hand (see removeNoteChat), by note: not linked to it again by a chat drawn again. */
  noteRemoved: NoteChats = {};
  /** Each chat's unsent text and attached note, by chat id. */
  drafts: Record<string, ChatDraft> = {};
  /**
   * Each chat's plan note, by chat id: one being edited, or one kept with its edits from a plan
   * withdrawn, for the chat's next plan. Deleted with the chat's other data (see forgetChatData).
   */
  planNotes: Record<string, PlanNote> = {};
  /** Chats that finished while not on screen, and how, until they are shown. */
  unseen: Record<string, 'done' | 'error'> = {};
  /** The scratch chat: one chat that starts over when it has been idle, kept out of the history list. */
  scratch: { id: string; usedAt: number } | null = null;
  /** Side chats' sessions not deleted yet: those open now, and any left when Obsidian last quit. */
  sideSessions: string[] = [];
  /** A save waiting to cover a burst of changes (see saveSoon). */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last write of data.json asked for, and whether it waits to start (see saveSettings). */
  private saving: Promise<void> = Promise.resolve();
  private saveWaiting = false;
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
  /** The hidden-path patterns last compiled, with their test (see isHiddenPath). */
  private hidden: { patterns: string; test: (path: string) => boolean } | null = null;
  /** Each chat's text for the history's search, with the stamp of the file it was read from (see chatSearchText). */
  private readonly searchTexts = new Map<string, { stamp: string; text: string }>();
  /** Search texts being read, by chat id, so that two histories open one after the other read a chat once. */
  private readonly searchReads = new Map<string, Promise<string>>();

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
    // Links in memo notes back to the passages they came from (see memos.ts).
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => void this.openChatLink(params));
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
      }),
    );
    this.registerNoteEvents();
    this.registerEvent(this.app.workspace.on('files-menu', (menu, files) => attachItem(menu, files)));
    // A memo's Send box ticked or cleared, in the Memos base: the memo goes into the chat's input, or out of it (see followMemoBox).
    this.registerEvent(
      this.app.metadataCache.on('changed', (file, _data, cache) => {
        if (cache.frontmatter?.type === 'memo') void this.followMemoBox(file, cache.frontmatter.send === true);
      }),
    );
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
      void this.tidyPlanNotes();
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
   * so that the note indexes do not grow for good; nothing is let go when the folder cannot be read.
   * And of notes no longer on disk: deleted while Obsidian was closed, or linked before 0.23.0 once
   * gone (see onDisk).
   */
  async pruneNoteLinks(): Promise<void> {
    const dir = this.vaultRoot();
    const ids = dir ? await sessionIds(dir) : null;
    let changed = false;
    // A plan note kept for a chat whose session is gone has no next plan to go to.
    for (const [id, note] of Object.entries(this.planNotes)) {
      if (!ids || ids.has(id)) continue;
      delete this.planNotes[id];
      void this.trashNote(note.path);
      changed = true;
    }
    for (const index of [this.noteChats, this.noteRefs, this.noteMentions, this.noteRemoved]) {
      for (const id of ids ? new Set(Object.values(index).flat()) : []) {
        if (!ids?.has(id)) changed = forgetChat(index, id) || changed;
      }
      for (const path of Object.keys(index)) {
        if (this.onDisk(path)) continue;
        delete index[path];
        changed = true;
      }
    }
    if (changed) this.saveSoon();
  }

  /**
   * Whether vault path `path` is a file on disk now: only such notes are linked to chats. A note a
   * chat made and then deleted in the same reply (its content moved into another note by a shell
   * command) was otherwise linked for good, and drawing the saved chat again linked it once more. On
   * disk rather than in Obsidian's index, which learns of a note a moment after Claude writes it.
   */
  private onDisk(path: string): boolean {
    // Obsidian's index first, which holds every note but one just written; the disk for that one.
    if (this.app.vault?.getAbstractFileByPath(path) instanceof TFile) return true;
    const root = this.vaultRoot();
    return root === null || existsSync(joinPath(root, path));
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
        const listed = await listHistory(dir, this.chats, this.settings.historyIncludesAllSessions, new Set(this.sideSessions));
        // A chat deleted while this listing ran, or whose file is still there, is not listed again.
        const found = new Set(listed.map((item) => item.id));
        for (const id of this.unlisted) if (!found.has(id)) this.unlisted.delete(id);
        const items = listed.filter((item) => !this.unlisted.has(item.id));
        // Search texts only of chats the history can still show: these, and the scratch chat, which
        // the history lists whether or not this listing has it.
        const searchable = new Set(items.flatMap((item) => [item.id, ...(item.copies ?? []).map((copy) => copy.id)]));
        if (this.scratch) searchable.add(this.scratch.id);
        for (const id of this.searchTexts.keys()) if (!searchable.has(id)) this.searchTexts.delete(id);
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
  chatSearchText(id: string): Promise<string> {
    const reading = this.searchReads.get(id);
    if (reading) return reading;
    const read = this.readSearchText(id).finally(() => this.searchReads.delete(id));
    this.searchReads.set(id, read);
    return read;
  }

  private async readSearchText(id: string): Promise<string> {
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
    if (!this.lastListing) return;
    this.lastListing = this.lastListing.filter((item) => item.id !== id);
    // Nor is it offered as a copy. In place: the history's rows share these lists.
    for (const item of this.lastListing) {
      const at = item.copies?.findIndex((copy) => copy.id === id) ?? -1;
      if (at !== -1) item.copies?.splice(at, 1);
    }
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

  /** Makes a save still waiting (see saveSoon) at once; resolves once the saves under way are written. */
  flushSave(): Promise<void> {
    if (this.saveTimer === null) return this.saving;
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
    for (const view of this.chatViews()) view.updatePhoneButton();
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
    for (const view of this.chatViews()) view.applyPanelMargin();
  }

  /** Redraws the opening lines of every empty chat, after a setting changed what they say. */
  refreshWelcomes(): void {
    for (const view of this.chatViews()) view.refreshWelcome();
  }

  refreshModeMenus(): void {
    for (const view of this.chatViews()) view.populateModeSelect();
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
    for (const view of this.chatViews()) view.refreshScratchLines();
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
    changed = followNote(this.noteRemoved, from, to) || changed;
    changed = followDraftNotes(Object.entries(this.drafts), from, to, (id) => delete this.drafts[id]) || changed;
    for (const [path, on] of [...this.memoBoxes]) {
      const moved = movedPath(path, from, to);
      if (moved === undefined) continue;
      this.memoBoxes.delete(path);
      if (moved !== null) this.memoBoxes.set(moved, on);
    }
    for (const [id, note] of Object.entries(this.planNotes)) {
      const moved = movedPath(note.path, from, to);
      if (moved === undefined) continue;
      if (moved === null) delete this.planNotes[id];
      else note.path = moved;
      changed = true;
    }
    // Moving or deleting a folder is one event per file: saved once for them all.
    if (changed) this.saveSoon();
    for (const view of this.chatViews()) view.followNote(from, to);
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

  /** Deletes the side chats' sessions `ids`, left from the last run, and forgets them; one that failed to go is tried again at the next start. */
  private async sweepSideSessions(ids: string[]): Promise<void> {
    const dir = this.vaultRoot();
    if (!dir || ids.length === 0) return;
    const failed = await deleteSessions(ids, dir, new Set(this.chats.map((chat) => chat.id)));
    this.sideSessions = this.sideSessions.filter((id) => !ids.includes(id) || failed.includes(id));
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
    for (const view of this.chatViews()) if (view.isScratchChat()) view.keepScratchAsChat();
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
    if (this.isHiddenPath(path) || !this.onDisk(path) || !this.mayLink(path, chatId, promote)) return;
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
    if (this.isHiddenPath(path) || !this.onDisk(path) || !this.mayLink(path, chatId, true)) return;
    if (linkNote(this.noteRefs, path, chatId)) this.saveSoon();
  }

  /** Records that a chat mentioned a note (see ChatView.recordMentions), for the history's notes view. */
  linkNoteMention(path: string, chatId: string): void {
    if (this.isHiddenPath(path) || !this.onDisk(path) || !this.mayLink(path, chatId, false)) return;
    if (linkNote(this.noteMentions, path, chatId, false)) this.saveSoon();
  }

  /**
   * Whether chat `chatId` may be linked to note `path`: always, unless it was taken off the note by
   * hand (see removeNoteChat). Then only something new (`now`: the chat edits the note again, or is
   * sent it) links it again, and ends the removal; a saved chat drawn again, or a mention, does not.
   */
  private mayLink(path: string, chatId: string, now: boolean): boolean {
    if (!this.noteRemoved[path]?.includes(chatId)) return true;
    if (now) unlinkNote(this.noteRemoved, path, chatId);
    return now;
  }

  /**
   * Takes chat `chatId` off note `path`'s chats, as ⌥-clicking it in the list above the input does: no
   * longer offered for the note, nor listed under it in the history, until the chat edits the note
   * again or is sent it (see mayLink).
   */
  removeNoteChat(path: string, chatId: string, title: string): void {
    for (const index of [this.noteChats, this.noteRefs, this.noteMentions]) unlinkNote(index, path, chatId);
    linkNote(this.noteRemoved, path, chatId, false);
    this.saveSoon();
    for (const view of this.chatViews()) view.noteLinksChanged();
    new Notice(`“${title}” is no longer listed with this note.`);
  }

  /** The chats offered for a note; only chats still in the history, and none taken off it by hand. */
  noteChatEntries(file: TFile): NoteChatEntry[] {
    const known = (ids: string[] | undefined) => (ids ?? []).flatMap((id) => this.chats.find((chat) => chat.id === id) ?? []);
    const removed = this.noteRemoved[file.path] ?? [];
    return noteChatEntries(known(this.noteChats[file.path]), this.sessionOfNote(file), known(this.noteRefs[file.path])).filter((entry) => !removed.includes(entry.id));
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

  /**
   * Records a chat started in the panel; `copyOf`: it is the copy of a chat started outside the panel
   * made by sending a message there, which is then offered with it at once (see listHistory).
   */
  recordChat(id: string, title: string, copyOf?: string): void {
    if (this.isPanelChat(id)) return;
    this.chats.unshift(copyOf ? { id, title, copyOf } : { id, title });
    const original = copyOf ? this.lastListing?.find((item) => item.id === copyOf) : undefined;
    if (original) (original.copies ??= []).unshift({ id, title, updatedAt: Date.now(), fromPanel: true, copied: true });
    for (const dropped of this.chats.slice(MAX_CHAT_RECORDS)) this.forgetChatData(dropped.id);
    this.chats = this.chats.slice(0, MAX_CHAT_RECORDS);
    void this.saveSettings();
  }

  /** Records chat `id`'s plan note, at `path`, made from `plan`. */
  setPlanNote(id: string, path: string, plan: string): void {
    this.planNotes[id] = { path, plan };
    void this.saveSettings();
  }

  /** Forgets the plan note at `path`, whichever chat it was kept for: it has been answered, or put away. */
  forgetPlanNote(path: string): void {
    const ids = Object.keys(this.planNotes).filter((id) => this.planNotes[id].path === path);
    for (const id of ids) delete this.planNotes[id];
    if (ids.length > 0) void this.saveSettings();
  }

  /**
   * No plan is waiting when Obsidian starts: a plan note left as Claude wrote it (by a quit while its
   * plan was open) goes, and one holding edits stays for its chat's next plan.
   */
  async tidyPlanNotes(): Promise<void> {
    for (const [id, note] of Object.entries(this.planNotes)) {
      const file = this.app.vault.getAbstractFileByPath(note.path);
      if (file instanceof TFile) {
        const text = await this.app.vault.read(file).catch((error: unknown) => {
          log('reading a plan note failed', error);
          return null;
        });
        if (text === null || text.trim() !== note.plan.trim() || !(await this.trashNote(note.path))) continue;
      }
      delete this.planNotes[id];
      this.saveSoon();
    }
  }

  /** Moves note `path` to the trash, if it is there. Whether it went, or was not there; a failure is logged. */
  async trashNote(path: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return true;
    try {
      await this.app.fileManager.trashFile(file);
      return true;
    } catch (error) {
      log('removing a note failed', error);
      return false;
    }
  }

  /** Forgets what the plugin keeps for chat `id` beside its record: pin, ticks, draft, plan note, mark and note links. */
  private forgetChatData(id: string): void {
    this.pinned = this.pinned.filter((other) => other !== id);
    delete this.ticks[id];
    delete this.drafts[id];
    const planNote = this.planNotes[id];
    delete this.planNotes[id];
    if (planNote) void this.trashNote(planNote.path);
    delete this.unseen[id];
    for (const index of [this.noteChats, this.noteRefs, this.noteMentions, this.noteRemoved]) forgetChat(index, id);
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

  /** Each memo's Send box as last seen, so that only a change of it is acted on (see followMemoBox). */
  private readonly memoBoxes = new Map<string, boolean>();

  /**
   * A memo's Send box, ticked or cleared in the Memos base, puts the memo in the chat's input as an
   * `@` mention, or takes it out of every panel's input. Only a change of the box counts: a memo's
   * other edits leave the inputs alone, and the boxes the panels set themselves find them as they are.
   */
  async followMemoBox(file: TFile, on: boolean): Promise<void> {
    const before = this.memoBoxes.get(file.path);
    this.memoBoxes.set(file.path, on);
    if (before === on) return;
    const views = this.chatViews();
    if (!on) {
      for (const view of views) view.unmention(file.path);
      return;
    }
    if (views.some((view) => view.mentions(file.path))) return;
    await this.attachToClaude([file]);
  }

  async attachToClaude(items: TAbstractFile[]): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(ChatView) ?? (await this.activateView());
    view?.mentionItems(items);
  }

  /** Whether `path` is left out of the notes a chat lists (see hiddenPaths); the patterns compiled once for each value of the setting. */
  isHiddenPath(path: string): boolean {
    const patterns = this.settings.hiddenNotePaths;
    if (this.hidden?.patterns !== patterns) this.hidden = { patterns, test: hiddenPaths(patterns) };
    return this.hidden.test(path);
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
    return this.chatViews()[0] ?? null;
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

  /**
   * Opens a chat by its session id in the panel, as listed when it was (its copies with it): a kept
   * side chat whose panel has closed, a passage a memo came from. The panel that shows it, once
   * shown; null when it could not be.
   */
  async openChatById(id: string, title: string): Promise<ChatView | null> {
    const view = await this.activateView();
    const listed = this.lastListing?.find((item) => item.id === id);
    const opened = await view?.openChat(listed ? { ...listed, title } : { id, title, updatedAt: Date.now(), fromPanel: this.isPanelChat(id) });
    return opened ? view : null;
  }

  /**
   * A link from a memo note (see memos.ts chatLink) or the Memos table: opens its chat, then goes to
   * the passage's message (`msg`) and its words in it (`find`; alone, searched for in the chat),
   * quotes it in the input to carry on from it (`quote`), or goes to the memo's first passage from
   * that chat (`memo`, the memo's name, or its path in a table written before).
   */
  private async openChatLink(params: Record<string, string>): Promise<void> {
    const id = params.chat;
    if (!id) return;
    const title = this.chats.find((chat) => chat.id === id)?.title ?? this.lastListing?.find((item) => item.id === id)?.title ?? 'Chat';
    const view = await this.openChatById(id, title);
    if (!view) {
      new Notice('That chat could not be opened: it may have been deleted. The passage is kept in the memo note.');
      return;
    }
    if (params.quote) view.quote(params.quote);
    else if (params.msg || params.find) await view.findPassage(params.find ?? '', params.msg);
    else if (params.memo) {
      // From the Memos table: the memo's first passage from this chat.
      const memo = this.app.vault.getAbstractFileByPath(params.memo) ?? this.app.metadataCache.getFirstLinkpathDest(params.memo, '');
      const target = memo instanceof TFile ? firstPassageTarget(await this.app.vault.cachedRead(memo), id) : null;
      if (target) await view.findPassage(target.find ?? '', target.msg);
    }
  }

  /** The memo notes (`type: memo`, see MemoModal), the most recently changed first; `chat`: only those saved from that chat. */
  memoNotes(chat?: string): TFile[] {
    // Wherever they are: memos saved before the memos folder moved are memos still.
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (frontmatter?.type !== 'memo') return false;
        return chat === undefined || (Array.isArray(frontmatter.claude_chats) && frontmatter.claude_chats.includes(chat));
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  /**
   * Opens the Memos base on chat `chatId`'s memos: the base, in the memos folder, is written for that
   * chat (see memoBaseYaml) and opened in a tab on its first view.
   */
  async openChatMemos(chatId: string, chatTitle: string, all = false): Promise<void> {
    try {
      const file = await this.writeMemosBase(chatId, chatTitle);
      // On the chat's memos, or all of them (asked for, or a chat with no memos to have yet), in the
      // tab already showing the base when there is one: a Bases tab is told its view by name.
      const viewName = all || !chatId ? ALL_MEMOS_VIEW : chatMemosView(chatTitle);
      const leaf = this.memosBaseLeaf() ?? this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'bases', state: { file: file.path, viewName }, active: true });
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) {
      log('opening the memos base failed', error);
      new Notice(`Could not show the memos: ${errorText(error)}`);
    }
  }

  /** The memos folder (setting), normalized: `/` for the vault root. */
  memosFolder(): string {
    return normalizePath(this.settings.memosFolder || '/');
  }

  /** The path of `name` in the memos folder, which is made when it is missing. */
  async memosPath(name: string): Promise<string> {
    const folder = this.memosFolder();
    if (folder !== '/' && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    return `${folder === '/' ? '' : `${folder}/`}${name}`;
  }

  /** A tab showing the Memos base, if one does. */
  private memosBaseLeaf(): WorkspaceLeaf | null {
    const folder = this.memosFolder();
    const path = `${folder === '/' ? '' : `${folder}/`}Memos.base`;
    return this.app.workspace.getLeavesOfType('bases').find((leaf) => (leaf.view as { file?: TFile | null }).file?.path === path) ?? null;
  }

  /**
   * Writes the Memos base for chat `chatId`: a new one from the template (see memoBaseYaml); one there
   * already has only its view of one chat's memos turned to this chat (see retargetMemoBase), so that
   * what was changed in the table (columns, sorts, widths, views of one's own) stays.
   */
  private async writeMemosBase(chatId: string, chatTitle: string): Promise<TFile> {
    const path = await this.memosPath('Memos.base');
    const existing = this.app.vault.getAbstractFileByPath(path);
    const vault = this.app.vault.getName();
    if (!(existing instanceof TFile)) return this.app.vault.create(path, memoBaseYaml(chatId, chatTitle, vault));
    // A chat not started has no id to pick its memos by: the chat view keeps the last chat's.
    if (!chatId) return existing;
    const before = await this.app.vault.read(existing);
    let parsed: unknown = null;
    try {
      parsed = parseYaml(before);
    } catch {
      // Not YAML any more: written anew below.
    }
    const turned = retargetMemoBase(parsed, chatId, chatTitle, vault);
    const text = turned ? stringifyYaml(turned) : memoBaseYaml(chatId, chatTitle, vault);
    if (text !== before) {
      await this.app.vault.modify(existing, text);
      await this.followRenamedView(chatMemosView(chatTitle));
    }
    return existing;
  }

  /**
   * A Bases tab remembers its view by name, so a tab on the chat view (named after its chat) would
   * lose it when the view is renamed for another chat, saying the view was not found: such a tab is
   * moved to the view's new name.
   */
  private async followRenamedView(viewName: string): Promise<void> {
    const leaf = this.memosBaseLeaf();
    const state = leaf?.getViewState();
    const showing = (state?.state as { viewName?: unknown } | undefined)?.viewName;
    if (!leaf || !state || !isChatViewName(showing) || showing === viewName) return;
    await leaf.setViewState({ ...state, state: { ...state.state, viewName } });
  }

  /**
   * The chat on a panel changed (opened, started, renamed): a Memos base open in a tab follows it,
   * its view of one chat's memos turning to that chat. One closed is left alone.
   */
  async followChatMemos(chatId: string, chatTitle: string): Promise<void> {
    if (!this.memosBaseLeaf()) return;
    await this.writeMemosBase(chatId, chatTitle).catch((error: unknown) => log('following the chat in the memos base failed', error));
  }

  /** Whether a panel other than `except` has the file at `path` mentioned in its input (see ChatView.followMemoBoxes). */
  mentionedElsewhere(path: string, except: ChatView): boolean {
    return this.chatViews().some((view) => view !== except && view.mentions(path));
  }

  /**
   * A title and description for a memo of `passages`, suggested on the model for small jobs (see
   * MemoModal): one request with no tools. Null when Claude Code cannot run or no suggestion came.
   */
  async suggestMemo(chatTitle: string, passages: MemoPassage[], signal: AbortSignal): Promise<{ title: string; description: string } | null> {
    const launch = this.claudeLaunch();
    if (typeof launch === 'string') return null;
    if (!this.configured.model) await this.loadConfigured();
    const model = this.settings.smallJobModel || chatModel(this.settings.model);
    const reply = await runOneShot(launch, { system: MEMO_SUGGESTION_SYSTEM, prompt: memoSuggestionPrompt(chatTitle, passages), model, effort: 'low' }, () => undefined, signal);
    return readMemoSuggestion(reply);
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
    // The memos saved from it, whose table links show its title.
    for (const memo of this.memoNotes(id)) {
      await this.app.fileManager
        .processFrontMatter(memo, (frontmatter: Record<string, unknown>) => {
          const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []);
          const paired = pairChat(list(frontmatter.claude_chats), list(frontmatter.chats), id, title);
          frontmatter.chats = paired.titles;
        })
        .catch((error: unknown) => log('renaming a chat in a memo failed', error));
    }
    for (const view of this.chatViews()) view.onChatRenamed(id, title);
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
    // Up to 0.21.1 each record also held when it was made and last used, which nothing read.
    this.chats = Array.isArray(raw.chats) ? raw.chats.map(({ id, title, copyOf }) => ({ id, title, ...(typeof copyOf === 'string' ? { copyOf } : {}) })) : [];
    this.pinned = Array.isArray(raw.pinned) ? raw.pinned : [];
    this.scratch = raw.scratch && typeof raw.scratch.id === 'string' ? raw.scratch : null;
    this.sideSessions = Array.isArray(raw.sideSessions) ? raw.sideSessions.filter((id): id is string => typeof id === 'string') : [];
    this.noteChats = raw.noteChats && typeof raw.noteChats === 'object' ? raw.noteChats : {};
    this.noteRefs = raw.noteRefs && typeof raw.noteRefs === 'object' ? raw.noteRefs : {};
    this.noteMentions = raw.noteMentions && typeof raw.noteMentions === 'object' ? raw.noteMentions : {};
    this.noteRemoved = raw.noteRemoved && typeof raw.noteRemoved === 'object' ? raw.noteRemoved : {};
    this.drafts = raw.drafts && typeof raw.drafts === 'object' ? raw.drafts : {};
    this.planNotes = Object.fromEntries(
      Object.entries(raw.planNotes && typeof raw.planNotes === 'object' ? raw.planNotes : {}).filter(
        ([, note]) => typeof note?.path === 'string' && typeof note.plan === 'string',
      ),
    );
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

  /**
   * Saves the plugin's data. One write at a time, each of the data as it is when it starts: writes
   * of the whole file that overlapped could finish out of order and leave an older copy. A save asked
   * for while another waits to start is that one, which takes its change along.
   */
  saveSettings(): Promise<void> {
    if (this.saveWaiting) return this.saving;
    this.saveWaiting = true;
    const write = async () => {
      this.saveWaiting = false;
      await this.saveData(this.dataToSave());
    };
    this.saving = this.saving.then(write, write);
    return this.saving;
  }

  /** The plugin's data as data.json holds it. */
  private dataToSave(): PluginData {
    return {
      settings: this.settings,
      chats: this.chats,
      scratch: this.scratch ?? undefined,
      noteChats: this.noteChats,
      noteRefs: this.noteRefs,
      noteMentions: this.noteMentions,
      noteRemoved: this.noteRemoved,
      drafts: this.drafts,
      planNotes: this.planNotes,
      unseen: this.unseen,
      models: this.models,
      modelsFetchedAt: this.modelsFetchedAt,
      commands: this.commands,
      commandsFetchedAt: this.commandsFetchedAt,
      pinned: this.pinned,
      ticks: this.ticks,
      sideSessions: this.sideSessions,
    };
  }
}
