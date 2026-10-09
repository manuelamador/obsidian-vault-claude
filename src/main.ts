import { existsSync } from 'fs';
import { FileSystemAdapter, Menu, Notice, Plugin, TFile, TFolder, normalizePath, parseYaml, stringifyYaml, type Editor, type TAbstractFile, type WorkspaceLeaf, type MarkdownFileInfo } from 'obsidian';
import { isAbsolute, join as joinPath } from 'path';
import { CLAUDE_CODE_TARGET, versionDrift } from './version';
import type { ModelInfo, SDKControlGetUsageResponse, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { patchSetMaxListenersForRenderer } from './electronCompat';
import { deleteSessionIfAny, deleteSessions, eachInParallel, formatDate, lastMessages, listHistory, loadChat, loadTranscript, renameSessionTitle, sessionIds, sessionStamp, setPlansDirectory, type ChatRecord, type HistoryItem } from './history';
import { messageSearchText } from './chatText';
import { errorText, log } from './log';
import { savedChangedFiles } from './editDiff';
import { ConfirmModal, RenameModal } from './historyModal';
import { transcriptNotes } from './rebuildLinks';
import { vaultRelative } from './toolSummary';
import { followDraftNotes, followNote, forgetChat, linkNote, movedPath, noteChatEntries, unlinkNote, type NoteChatEntry, type NoteChats } from './noteChats';
import { hiddenPaths } from './pathFilter';
import { ALL_MEMOS_VIEW, MEMO_SUGGESTION_SYSTEM, chatLink, chatMemosView, continueDraft, firstPassageTarget, isChatId, memoDescription, isChatViewName, PROTOCOL_ACTION, memoBaseYaml, memoSection, pairChat, retargetMemoBase, upgradeMemoBase, memoSuggestionPrompt, readMemoSuggestion, savedPassages, type LinkedMemo, type MemoPassage } from './memos';
import { ContinueMemoModal } from './memoModal';
import { DAY_MS, OLDER_LOOKED_AT, PICK_UP_SYSTEM, SKIP_DAYS, candidateOf, leftOut, ownMessage, chatsToLookAt, keptToday, localDay, remindersNow, pickUpPrompt, readPickUp, type Candidate, type PickUpState, type Suggestion } from './pickUp';
import { PickUpModal, type ChatDetails } from './pickUpModal';
import { renderSafely } from './safeRender';
import { inFolder, notesByChat, suggestFolder, weightedNotes, type FolderSuggestion } from './chatFolders';
import { CONTEXT_SYSTEM, PROJECT_TYPE, contextHash, contextPrompt, homeOf, chatDigest, noteOpening, projectNoteMarkdown, projectParts, readContext, withContext, withGenerated, type HomeReason } from './projects';
import { ChooseFolderModal, ContextModal, CreateProjectModal, type FolderSource } from './projectModals';
import { FRONTMATTER_SYSTEM, frontmatterPrompt, readFrontmatterSuggestions } from './frontmatterSuggest';
import { FrontmatterModal } from './frontmatterModal';
import { chatMap, hubNotes, projectMap, withoutHubs } from './connections';
import { CONNECTIONS_VIEW_TYPE, ConnectionsView, type ChatMapHost, type ProjectMapHost } from './connectionsView';
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
/** How long a listing of the chats serves what reads it often (see recentListing). */
const LISTING_FRESH_MS = 5000;
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
/** How much of a chat's file is read for picking it up: its last messages, from at most its last bytes. */
const PICK_UP_MESSAGES = 60;
const PICK_UP_BYTES = 2_000_000;
/** The most older chats read, at random, for those with a clue that something was left open. */
const PICK_UP_OLDER_READS = 30;

/** How many of a chat's last messages its digest reads, when it has no memos (see linkedChatDigest). */
const DIGEST_MESSAGES = 16;
/** How much of a chat's conversation its summary is written from (see summariseLinkedChat), at most: its latest part. */
const SUMMARY_SOURCE_CHARS = 120_000;
/** The instructions for summarising a chat that is included in another. */
const LINKED_SUMMARY_SYSTEM =
  'Summarise the conversation given, between a user and an AI assistant, for another conversation that will use it as context. In at most 250 words: what was asked, what was decided or found (with numbers where given), and what was left open. Plain prose or short bullets; no preamble.';
/** The most notes beside a note, and chats, that Suggest frontmatter updates reads. */
const FRONTMATTER_NEIGHBOURS = 40;
const FRONTMATTER_CHATS = 12;
/** What a project's Context is written from: its notes, its chats, and of each chat its last messages, kept to a few thousand characters. */
const CONTEXT_NOTES = 25;
const CONTEXT_CHATS = 8;
const CONTEXT_MESSAGES = 10;
const CONTEXT_DIGEST_CHARS = 2500;
/** The most key notes a project lists. */
const PROJECT_KEY_NOTES = 12;

/** Today, as YYYY-MM-DD in local time. */
function today(): string {
  return localDay(Date.now());
}

/** The chat ids in a frontmatter value. */
function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id !== '') : [];
}

/**
 * What a chat's projects sent with it and what it chose to send: `sent`, the projects whose context
 * went with a message (it goes once, until sent again by hand); `declined`, its project removed by
 * hand, after which its notes do not give it one and none is offered; `start`, the note attached when
 * it started, whose folder decides its project first (see homeOf).
 */
export interface ChatProjectState {
  sent?: string[];
  /** Per project sent, a fingerprint of what went (see contextHash), to tell when it changed since. */
  sentHash?: Record<string, string>;
  declined?: boolean;
  start?: string;
  /** The chats it links to whose digests go with it (see ChatView.linksPane). */
  includeChats?: string[];
}

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
  pickUp?: PickUpState;
  chatProjects?: Record<string, ChatProjectState>;
  chatLinks?: Record<string, string[]>;
  chatSummaries?: Record<string, { text: string; at: number }>;
  frontmatterGuidance?: Record<string, string>;
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
  /** Pick up where you left off: the chats set aside (see pickUp.ts). */
  pickUp: PickUpState = { hidden: {} };
  /** Per chat, what its projects sent with it and what it chose to send (see ChatProjectState). */
  chatProjects: Record<string, ChatProjectState> = {};
  /** Chats linked from a message of another (see linkChats): chat id → the chats it linked to. */
  chatLinks: Record<string, string[]> = {};
  /** Summaries asked for of chats, used when they are included in another (see summariseLinkedChat). */
  chatSummaries: Record<string, { text: string; at: number }> = {};
  /** The guidance last given to Suggest frontmatter updates, by folder ('' for the top of the vault). */
  frontmatterGuidance: Record<string, string> = {};
  /** The project notes, once found (see projectNotes). */
  private projectCache: TFile[] | null = null;
  /** Chats' home projects, and the notes each chat worked on, once worked out (see homeReason, chatNotes). */
  private homeCache = new Map<string, HomeReason | null>();
  private notesCache: Map<string, Set<string>> | null = null;
  private weightsCache: Map<string, Map<string, number>> | null = null;
  private hubsCache: Set<string> | null = null;
  /** The panel whose chat the Connections pane shows (see chatShown): the last to show a chat. */
  private connectionsPanel: ChatView | null = null;
  /** The pane's map read again soon, after its data changed (see connectionsSoon). */
  private connectionsTimer: number | null = null;
  /** When that read is due, in milliseconds since the epoch. */
  private connectionsDue = 0;
  /** Projects' fingerprints, by path, once read (see projectHashNow): of Context and Instructions, and of Instructions alone. */
  private readonly projectHashes = new Map<string, { all: string; instructions: string } | null>();
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
  /** When lastListing was listed. */
  private listedAt = 0;
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
    // Opened again with the workspace: it shows the chat of the first panel.
    this.registerView(CONNECTIONS_VIEW_TYPE, (leaf) => new ConnectionsView(leaf, (pane) => void this.followPanel(pane, this.connectionsPanel ?? this.chatViews()[0] ?? null)));
    // Links in replies show Obsidian's page preview, with the modifier key held unless the Page preview settings say otherwise.
    this.registerHoverLinkSource(VIEW_TYPE, { display: 'Vault Claude', defaultMod: true });
    this.addRibbonIcon('bot', 'Open Claude', () => void this.activateView());
    // Links in memo notes back to the passages they came from (see memos.ts).
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => void this.openChatLink(params));
    this.addCommand({ id: 'open-chat', name: 'Open chat', callback: () => void this.activateView() });
    this.addCommand({
      id: 'new-chat',
      name: 'New chat',
      callback: async () => (await this.activateView())?.startNewChat(),
    });
    this.addCommand({
      id: 'chat-history',
      name: 'Chat history',
      callback: async () => (await this.activateView())?.openHistory(),
    });
    this.addCommand({ id: 'pick-up', name: 'Pick up where you left off', callback: () => void this.openPickUp() });
    this.addCommand({
      id: 'suggest-frontmatter',
      name: 'Suggest frontmatter updates for this note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.suggestFrontmatter(file);
        return true;
      },
    });
    this.addCommand({
      id: 'open-connections',
      name: 'Open connections',
      callback: async () => {
        const view = this.frontChatView() ?? (await this.activateView());
        if (view) void this.openConnections(view);
      },
    });
    this.addCommand({ id: 'write-project-contexts', name: 'Write every project’s context anew', callback: () => this.writeAllContexts() });
    this.addCommand({ id: 'create-project', name: 'Create project…', callback: () => void this.openCreateProject({ chatId: this.frontChatView()?.currentChatId() }) });
    this.addCommand({ id: 'rebuild-connections', name: 'Rebuild connections from chat files', callback: () => this.confirmRebuildConnections() });
    this.addCommand({
      id: 'pick-up-reset',
      name: 'Pick up where you left off: show ignored chats again',
      callback: () => this.clearIgnoredChats(),
    });
    this.addCommand({
      id: 'continue-from-memo',
      name: 'Continue from this memo',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isMemo(file)) return false;
        if (!checking) void this.continueFromMemo(file);
        return true;
      },
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
        if (ctx.file) void this.openInlineEdit(editor, ctx.file, ctx);
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
        if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) =>
            item
              .setTitle('Suggest frontmatter updates')
              .setIcon('list-checks')
              .onClick(() => void this.suggestFrontmatter(file)),
          );
        }
        if (file instanceof TFile && this.isMemo(file)) {
          menu.addItem((item) =>
            item
              .setTitle('Continue from this memo')
              .setIcon('message-square-plus')
              .onClick(() => void this.continueFromMemo(file)),
          );
        }
      }),
    );
    this.registerNoteEvents();
    this.registerEvent(this.app.workspace.on('files-menu', (menu, files) => attachItem(menu, files)));
    // A memo's Send box ticked or cleared, in the Memos base: the memo goes into the chat's input, or out of it (see followMemoBox).
    this.app.workspace.onLayoutReady(() => {
      this.seedMemoBoxes();
      void this.renameDoneMemos();
      void this.upgradeMemosBase();
    });
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
            .onClick(() => void this.openInlineEdit(editor, file, info)),
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
    // Ticks, pins and unseen replies of chats whose sessions are gone: nothing left to show them on.
    if (ids) {
      for (const id of Object.keys(this.ticks)) if (!ids.has(id)) changed = delete this.ticks[id] || changed;
      for (const id of Object.keys(this.unseen)) if (!ids.has(id)) changed = delete this.unseen[id] || changed;
      for (const id of Object.keys(this.chatProjects)) if (!ids.has(id)) changed = delete this.chatProjects[id] || changed;
      for (const id of Object.keys(this.chatSummaries)) if (!ids.has(id)) changed = delete this.chatSummaries[id] || changed;
      changed = this.pruneChatLinks((id) => ids.has(id)) || changed;
      for (const record of [this.pickUp.hidden, this.pickUp.later ?? {}, this.pickUp.skipped ?? {}]) for (const id of Object.keys(record)) if (!ids.has(id)) changed = delete record[id] || changed;
      // Skips that have run out.
      for (const [id, until] of Object.entries(this.pickUp.skipped ?? {})) if (until <= Date.now()) changed = delete this.pickUp.skipped?.[id] || changed;
      const pinned = this.pinned.filter((id) => ids.has(id));
      if (pinned.length !== this.pinned.length) {
        this.pinned = pinned;
        changed = true;
      }
    }
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
    if (changed) this.notesLinked();
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
        this.listedAt = Date.now();
        return items;
      } finally {
        this.listing = null;
      }
    })();
    return this.listing;
  }

  /**
   * The chats as listed a moment ago (see LISTING_FRESH_MS), else listed again: for what reads the
   * listing often (maps, project lists), where a listing takes a read of every session file.
   */
  private async recentListing(): Promise<void> {
    if (this.lastListing && Date.now() - this.listedAt < LISTING_FRESH_MS) return;
    await this.listChats().catch(() => []);
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
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.noteMoved(oldPath, file.path);
        if (file instanceof TFolder) this.projectFolderMoved(oldPath, file.path);
      }),
    );
    this.registerEvent(this.app.vault.on('delete', (file) => this.noteMoved(file.path, null)));
    // The projects are found again when a note becomes, or stops being, one.
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        const isProject = this.isProjectNote(file);
        if (this.projectCache && isProject !== this.projectCache.includes(file)) this.projectCache = null;
        // A project's folder or added chats may have changed: only the chats' homes follow from those.
        if (isProject || this.projectCache === null) this.homesChanged();
        if (isProject && this.projectHashes.has(file.path)) {
          this.projectHashes.delete(file.path);
          this.projectHashNow(file.path);
        }
      }),
    );
    this.registerEvent(this.app.workspace.on('quit', () => void this.flushSave()));
    // A project note's lists of chats and notes follow from the notes: brought up to date when it is opened.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file && this.isProjectNote(file)) void this.refreshProjectLists(file).catch((error: unknown) => log('refreshing a project failed', error));
      }),
    );
  }

  onunload(): void {
    if (this.connectionsTimer !== null) window.clearTimeout(this.connectionsTimer);
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
    // A project note renamed or deleted: the projects are found again, and the chats' homes, which name them by path.
    if (this.projectCache?.some((file) => file.path === from || file.path === to)) {
      this.projectCache = null;
      this.projectHashes.delete(from);
      this.homesChanged();
      this.projectsChanged();
    }
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
    for (const state of Object.values(this.chatProjects)) {
      const start = state.start === undefined ? undefined : movedPath(state.start, from, to);
      if (start !== undefined) {
        if (start === null) delete state.start;
        else state.start = start;
        changed = true;
      }
      // What went is kept by key: a project note's path, `parent:` and one, or `chat:` and an id (see ChatView.projectContext).
      const follow = (key: string): string | null | undefined => {
        const parent = key.startsWith('parent:');
        const moved = movedPath(parent ? key.slice('parent:'.length) : key, from, to);
        return moved === undefined || moved === null ? moved : parent ? `parent:${moved}` : moved;
      };
      if (state.sent?.some((key) => follow(key) !== undefined)) {
        state.sent = state.sent.flatMap((key) => {
          const moved = follow(key);
          return moved === undefined ? [key] : moved === null ? [] : [moved];
        });
        changed = true;
      }
      if (state.sentHash && Object.keys(state.sentHash).some((key) => follow(key) !== undefined)) {
        state.sentHash = Object.fromEntries(
          Object.entries(state.sentHash).flatMap(([key, hash]) => {
            const moved = follow(key);
            return moved === undefined ? [[key, hash]] : moved === null ? [] : [[moved, hash]];
          }),
        );
        changed = true;
      }
    }
    // Moving or deleting a folder is one event per file: saved once for them all.
    if (changed) this.notesLinked();
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
  async processesEnded(id: string, limitMs = ENDING_WAIT_MS): Promise<void> {
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

  /** A note was linked to a chat: saved soon, and chats' projects are worked out again (see homeReason). */
  private notesLinked(): void {
    this.membershipChanged();
    this.saveSoon();
    this.connectionsSoon();
  }

  /** Records that a chat changed a note, so the note can offer it later. */
  /** `promote`: an edit made now, which makes the chat the note's newest (see linkNote); saved only when the index changed. */
  linkNoteChat(path: string, chatId: string, promote = true): void {
    if (this.isHiddenPath(path) || !this.onDisk(path) || !this.mayLink(path, chatId, promote)) return;
    // Links come in bursts (a turn editing many notes, an older chat reopened): saved once for them.
    if (linkNote(this.noteChats, path, chatId, promote)) this.notesLinked();
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
    if (linkNote(this.noteRefs, path, chatId)) this.notesLinked();
  }

  /** Records that a chat mentioned a note (see ChatView.recordMentions), for the history's notes view. */
  linkNoteMention(path: string, chatId: string): void {
    if (this.isHiddenPath(path) || !this.onDisk(path) || !this.mayLink(path, chatId, false)) return;
    if (linkNote(this.noteMentions, path, chatId, false)) this.notesLinked();
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
    this.notesLinked();
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
    // Its project and summary, and its links to and from other chats.
    delete this.chatProjects[id];
    delete this.chatSummaries[id];
    this.pruneChatLinks((other) => other !== id);
    // Its notes no longer count toward any project's chats.
    this.membershipChanged();
  }

  /** Keeps only the links between chats that `keeps` keeps, both ends; whether any went. */
  private pruneChatLinks(keeps: (id: string) => boolean): boolean {
    let changed = false;
    for (const [from, to] of Object.entries(this.chatLinks)) {
      const kept = keeps(from) ? to.filter(keeps) : [];
      if (kept.length === to.length) continue;
      if (kept.length > 0) this.chatLinks[from] = kept;
      else delete this.chatLinks[from];
      changed = true;
    }
    return changed;
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
    // A box not seen before (see seedMemoBoxes) is taken as it is: only a change of it is acted on.
    if (before === on || before === undefined) return;
    const views = this.chatViews();
    if (!on) {
      for (const view of views) view.unmention(file.path);
      return;
    }
    if (views.some((view) => view.mentions(file.path))) return;
    await this.attachToClaude([file]);
  }

  /** Each memo's Send box as it is when Obsidian has loaded, so that a later edit of a memo left ticked does not count as ticking it. */
  private seedMemoBoxes(): void {
    for (const file of this.memoNotes()) this.memoBoxes.set(file.path, this.app.metadataCache.getFileCache(file)?.frontmatter?.send === true);
  }

  /** Memos from when an archived memo was called done (before 0.27.0): their `done` property becomes `archived`. */
  private async renameDoneMemos(): Promise<void> {
    for (const file of this.memoNotes()) {
      if (this.app.metadataCache.getFileCache(file)?.frontmatter?.done === undefined) continue;
      await this.app.fileManager
        .processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          if (frontmatter.done === undefined) return;
          frontmatter.archived ??= frontmatter.done === true;
          delete frontmatter.done;
        })
        .catch((error: unknown) => log(`renaming done to archived in ${file.path} failed`, error));
    }
  }

  /** Whether memo `file` is archived (its `archived` box ticked). */
  isArchived(file: TFile): boolean {
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.archived === true;
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

  /** The chat panel in front, else the first. */
  frontChatView(): ChatView | null {
    return this.app.workspace.getActiveViewOfType(ChatView) ?? this.firstChatView();
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

  /** How many chats Pick up where you left off never suggests (skipped ones come back by themselves). */
  ignoredChats(): number {
    return Object.keys(this.pickUp.hidden).length;
  }

  /** The chats never to be suggested (see ignoredChats) may be suggested again; a notice says how many. */
  clearIgnoredChats(): void {
    const count = this.ignoredChats();
    this.pickUp.hidden = {};
    void this.saveSettings();
    new Notice(count > 0 ? `${count} ignored chat${count === 1 ? '' : 's'} can be suggested again.` : 'No chats were ignored.');
  }

  /** The project notes of the vault: notes with `type: project` and a `folder` (see projects.ts). */
  projectNotes(): TFile[] {
    // Kept: the chip looks for the chat's project on every move of the cursor.
    this.projectCache ??= this.app.vault.getMarkdownFiles().filter((file) => this.isProjectNote(file));
    return this.projectCache.filter((file) => this.app.vault.getAbstractFileByPath(file.path) === file);
  }

  /** A note the plugin made for a project: `type: project`, a common property of notes of one's own, with the `folder` it gave it. */
  isProjectNote(file: TFile): boolean {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return frontmatter?.type === PROJECT_TYPE && typeof frontmatter.folder === 'string';
  }

  /** A project note's list of chat ids added to it by hand (`added`). */
  private projectAdded(file: TFile): string[] {
    return idList(this.app.metadataCache.getFileCache(file)?.frontmatter?.added);
  }

  /** A project's folder, without slashes at its ends; empty when it has none (a note made by hand). */
  projectFolder(file: TFile): string {
    const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.folder;
    return typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : '';
  }

  /** The project whose folder is `folder`, if one is. */
  projectOfFolder(folder: string): TFile | null {
    return this.projectNotes().find((file) => this.projectFolder(file) === folder) ?? null;
  }

  /** Chat `id`'s home project and why it is (see homeOf); kept until projects, notes or the chat's choices change. */
  homeReason(id: string): { file: TFile; reason: HomeReason } | null {
    if (!this.homeCache.has(id)) {
      const projects = this.projectNotes().map((file) => ({ key: file.path, folder: this.projectFolder(file), added: this.projectAdded(file) }));
      const state = this.projectState(id);
      this.homeCache.set(id, homeOf(id, { notes: withoutHubs(this.weightedNotes().get(id), this.hubNotes()), start: state.start, declined: state.declined }, projects));
    }
    const reason = this.homeCache.get(id);
    const file = reason ? this.app.vault.getAbstractFileByPath(reason.key) : null;
    return reason && file instanceof TFile ? { file, reason } : null;
  }

  /**
   * A fingerprint of project `path`'s Context and Instructions (see contextHash), or of its Instructions
   * alone (what goes of an enclosing project); null until read, when the panels are told. Read again
   * when the note changes.
   */
  projectHashNow(path: string, instructionsOnly = false): string | null {
    const known = this.projectHashes.get(path);
    if (known) return instructionsOnly ? known.instructions : known.all;
    if (known === null) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    this.projectHashes.set(path, null);
    void this.projectParts(file).then(
      (parts) => {
        this.projectHashes.set(path, { all: contextHash(parts), instructions: contextHash({ context: '', instructions: parts.instructions }) });
        this.projectsChanged();
      },
      (error: unknown) => log('reading a project failed', error),
    );
    return null;
  }

  /** Records that chat `from` linked to chats `to` in a message sent (see ChatView.send): shown on its map, and their projects offered. */
  linkChats(from: string, to: string[]): void {
    const known = this.chatLinks[from] ?? [];
    const added = to.filter((id) => id !== from && !known.includes(id));
    if (added.length === 0) return;
    this.chatLinks[from] = [...known, ...added];
    this.saveSoon();
    this.chatLinksChanged();
  }

  /** The chats chat `id` linked to, and those that linked to it. */
  linkedChats(id: string): string[] {
    const to = this.chatLinks[id] ?? [];
    const from = Object.keys(this.chatLinks).filter((other) => this.chatLinks[other].includes(id));
    return [...new Set([...to, ...from])];
  }

  /** Takes away chat `from`'s link to chat `to`. */
  unlinkChat(from: string, to: string): void {
    const kept = (this.chatLinks[from] ?? []).filter((id) => id !== to);
    if (kept.length > 0) this.chatLinks[from] = kept;
    else delete this.chatLinks[from];
    this.saveSoon();
    this.chatLinksChanged();
    // Its digest, waiting to go with a message, no longer goes.
    for (const view of this.chatViews()) view.projectsChanged();
  }

  /** A link between chats made or taken away, from wherever: the Connections pane draws it at once (a read the project change that follows shares). */
  private chatLinksChanged(): void {
    this.connectionsSoon(0);
  }

  /**
   * What goes to another chat when chat `id` is included in it: its title and date, then its summary
   * when one was asked for (see summariseLinkedChat), else its memos (description, Next), else its last
   * exchanges, the latest kept (see chatDigest). Read locally: no request.
   */
  async linkedChatDigest(id: string): Promise<string> {
    const item = this.lastListing?.find((each) => each.id === id);
    const head = `${this.chatTitleOf(id)}${item ? ` (last active ${formatDate(item.updatedAt)})` : ''}`;
    const summary = this.chatSummaries[id];
    if (summary) return `${head}\nSummary (${formatDate(summary.at)}):\n${summary.text}`;
    const memos = this.memoNotes(id).slice(0, 3);
    if (memos.length > 0) {
      const items = await Promise.all(
        memos.map(async (file) => {
          const text = await this.app.vault.cachedRead(file);
          const description = memoDescription(text);
          const next = memoSection(text, 'Next').trim();
          return [`Memo “${file.basename}”${description ? `: ${description}` : ''}`, ...(next ? [`Next: ${next}`] : [])].join('\n');
        }),
      );
      return `${head}\n${items.join('\n\n')}`;
    }
    const dir = this.vaultRoot();
    const messages = dir ? await lastMessages(id, dir, ownMessage, DIGEST_MESSAGES, PICK_UP_BYTES).catch(() => []) : [];
    const digest = chatDigest(messages);
    return digest ? `${head}\nIts last exchanges:\n${digest}` : head;
  }

  /** Asks the model for small jobs for a summary of chat `id`, used in place of its digest when it is included in another chat. */
  async summariseLinkedChat(id: string, signal: AbortSignal): Promise<void> {
    const launch = this.claudeLaunch();
    const dir = this.vaultRoot();
    if (typeof launch === 'string') throw new Error(launch);
    if (!dir) throw new Error('the vault is not a folder on this computer');
    // More of it than a digest keeps: the summary is what is kept short.
    const transcript = chatDigest(await loadTranscript(id, dir), SUMMARY_SOURCE_CHARS);
    const text = await runOneShot(launch, { system: LINKED_SUMMARY_SYSTEM, prompt: `Conversation “${this.chatTitleOf(id)}”:\n\n${transcript}`, model: this.smallJobModel(), effort: 'low' }, () => undefined, signal);
    if (signal.aborted || !text.trim()) return;
    this.chatSummaries[id] = { text: text.trim(), at: Date.now() };
    this.saveSoon();
  }

  /** Drops chat `id`'s summary: its digest is read from it again. */
  forgetLinkedSummary(id: string): void {
    delete this.chatSummaries[id];
    this.saveSoon();
  }

  /**
   * What the maps do: open a note, preview it, open a chat in panel `view`, link or unlink a chat from
   * chat `from` (the panel's), name another chat's project, and mention a chat in the message being
   * typed in panel `view`.
   * `stale`: whether the panel has moved on from chat `from` since the map was read; then nothing is
   * done, and the map is drawn again.
   */
  private mapActions(from: string | null, view: ChatView | null, stale: () => boolean = () => false) {
    const panel = async () => view ?? this.frontChatView() ?? (await this.activateView());
    return {
      mentionChat: (id: string) => void panel().then((target) => target?.mentionChat(id)),
      titleOf: (id: string) => this.chatTitleOf(id),
      openNote: (path: string, newTab: boolean) => void this.app.workspace.openLinkText(path, '', newTab ? 'tab' : false),
      previewNote: (path: string, event: MouseEvent | KeyboardEvent, target: Element, parent: unknown) =>
        this.app.workspace.trigger('hover-link', { event, source: VIEW_TYPE, hoverParent: parent, targetEl: target, linktext: path }),
      openChat: (id: string) => void this.openChatById(id, this.chatTitleOf(id), view),
      linked: (id: string) => (from ? (this.chatLinks[from] ?? []).includes(id) : null),
      link: (id: string, on: boolean) => {
        if (!from || from === id || this.staleMap(stale)) return;
        if (on) this.linkChats(from, [id]);
        else this.unlinkChat(from, id);
        this.projectsChanged();
        new Notice(on ? `Linked to “${this.chatTitleOf(id)}”: tick Include in the links under the chat's map to send what it found.` : `No longer linked to “${this.chatTitleOf(id)}”.`);
      },
      projectOfChat: (other: string) => this.homeProject(other)?.basename ?? null,
    };
  }

  /** Whether the Connections pane's map is of a chat the panel no longer shows (see mapActions): then it is drawn again for the panel's chat, with a notice. */
  private staleMap(stale: () => boolean): boolean {
    if (!stale()) return false;
    new Notice('The panel shows another chat now: its map is drawn instead.');
    this.refollowConnections();
    return true;
  }

  /** The Connections pane drawn again for the chat its panel shows now. */
  private refollowConnections(): void {
    const pane = this.connectionsPane();
    if (pane) void this.followPanel(pane, this.connectionsPanel);
  }

  /** Asks before rebuilding the links between chats and notes (see rebuildConnections). */
  confirmRebuildConnections(): void {
    new ConfirmModal(
      this.app,
      'Rebuild connections',
      "Reads every chat's session file again and adds the links to notes it is missing: the notes it changed, was sent and linked to in its replies. No link is taken away, and links you removed by hand stay removed. Chats put in a project by hand stay in it; the others follow their notes, so some may move to another project.",
      'Rebuild',
      () =>
        void this.rebuildConnections().then((result) => {
          if (result) new Notice(`Connections rebuilt from ${result.chats} chat${result.chats === 1 ? '' : 's'}: ${result.added} link${result.added === 1 ? '' : 's'} added.`);
        }),
    ).open();
  }

  /**
   * Adds the links between chats and notes that the chats' session files show and the indexes miss:
   * the notes each changed (its saved edits), was sent (its prompts' context blocks) and mentioned (the
   * notes its replies link to). The panel otherwise records them as it draws a chat, so chats never
   * opened since, or from before a kind of link was recorded, miss some. Nothing is taken away: a file
   * names a note by the path it had then, so a note renamed since is linked by the indexes alone.
   * Links removed by hand stay removed. Chats added to a project by hand stay in it; the others'
   * projects follow from their notes.
   */
  async rebuildConnections(): Promise<{ chats: number; added: number } | null> {
    const root = this.vaultRoot();
    if (!root) return null;
    const notice = new Notice('Rebuilding connections…', 0);
    try {
      const items = (await this.listChats()).filter((item) => !item.scratch);
      const found = new Map<string, { changed: string[]; sent: string[]; mentioned: string[] }>();
      await eachInParallel(items, async (item) => {
        try {
          const { transcript, edits } = await loadChat(item.id, root);
          found.set(item.id, { changed: savedChangedFiles(transcript, edits), ...transcriptNotes(transcript) });
        } catch (error) {
          log('reading a chat for its connections failed', item.id, error);
        }
      });
      const removed = (path: string, id: string) => this.noteRemoved[path]?.includes(id) === true;
      // Into the indexes as they are now, links recorded while the files were read included; each
      // added after the chats that note lists already.
      const indexes = [this.noteChats, this.noteRefs, this.noteMentions];
      let added = 0;
      for (const [id, links] of found) {
        this.linkedPaths(links, root).forEach((paths, i) => {
          for (const path of paths) if (path && !removed(path, id) && linkNote(indexes[i], path, id, false)) added += 1;
        });
      }
      if (added > 0) {
        this.notesLinked();
        this.projectsChanged();
      }
      return { chats: found.size, added };
    } finally {
      notice.hide();
    }
  }

  /** A chat's notes as its file names them (see rebuildConnections), as vault paths: changed, sent, mentioned; null for none. */
  private linkedPaths(links: { changed: string[]; sent: string[]; mentioned: string[] }, root: string): (string | null)[][] {
    const inVault = (written: string) => {
      const path = isAbsolute(written) ? vaultRelative(written, root) : written;
      return path && !this.isHiddenPath(path) && this.onDisk(path) ? path : null;
    };
    const linkTarget = (target: string) => {
      const file = this.app.metadataCache.getFirstLinkpathDest(target, '') ?? this.app.vault.getAbstractFileByPath(target);
      return file instanceof TFile && file.extension === 'md' && !this.isHiddenPath(file.path) ? file.path : null;
    };
    return [links.changed.map(inVault), links.sent.map(inVault), links.mentioned.map(linkTarget)];
  }

  /**
   * After part of chat `id` was removed: the notes that part changed (`changed`, vault paths) no longer
   * list the chat as having changed them, unless what is left of it changed them too (read from its
   * file). Only edits are taken off; nothing is added. Returns the notes taken off, for Undo to put
   * back. When the file cannot be read, nothing is taken off.
   */
  async unlinkRemovedEdits(id: string, changed: string[]): Promise<string[]> {
    const root = this.vaultRoot();
    if (!root || changed.length === 0) return [];
    let still: Set<string>;
    try {
      const { transcript, edits } = await loadChat(id, root);
      still = new Set(this.linkedPaths({ changed: savedChangedFiles(transcript, edits), sent: [], mentioned: [] }, root)[0].filter((path): path is string => path !== null));
    } catch (error) {
      log('reading a chat for its connections failed', id, error);
      return [];
    }
    const dropped = changed.filter((path) => !still.has(path) && unlinkNote(this.noteChats, path, id));
    if (dropped.length > 0) {
      this.notesLinked();
      this.projectsChanged();
    }
    return dropped;
  }

  /** The Connections pane, when open. */
  private connectionsPane(): ConnectionsView | null {
    const view = this.app.workspace.getLeavesOfType(CONNECTIONS_VIEW_TYPE)[0]?.view;
    return view instanceof ConnectionsView ? view : null;
  }

  /**
   * Shows the Connections pane (see ConnectionsView) for the chat in panel `view`, opening it as a tab
   * among the notes when it is not open; `atProject`, centred on the chat's project (the project
   * chip's); `links`, with the links under the map unfolded and in view (the links chip's).
   */
  async openConnections(view: ChatView, atProject = false, links = false): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CONNECTIONS_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      // A tab of its own in the main area, among the notes, rather than a split beside them.
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: CONNECTIONS_VIEW_TYPE, active: true });
    }
    // Made the active tab, not only shown: the notes behind it then stop counting as in front.
    workspace.setActiveLeaf(leaf, { focus: false });
    await workspace.revealLeaf(leaf);
    if (!(leaf.view instanceof ConnectionsView)) return;
    await this.followPanel(leaf.view, view, atProject);
    if (links) leaf.view.openLinks();
  }

  /** Shows panel `view`'s chat in pane `pane` (none: no chat); `atProject`, centred on its project. */
  private async followPanel(pane: ConnectionsView, view: ChatView | null, atProject = false): Promise<void> {
    this.connectionsPanel = view;
    const shown = view?.connectionsChat() ?? null;
    if (!view || !shown) return pane.follow(null);
    const home = atProject ? this.homeProject(shown.id) : null;
    await pane.follow(await this.chatMapHost(view, shown.id, false, shown.lookOnly), home?.path ?? null);
  }

  /** Panel `view` is closing: a Connections pane following it follows another panel, or none. */
  panelClosing(view: ChatView): void {
    if (this.connectionsPanel !== view) return;
    const next = this.chatViews().find((other) => other !== view && !other.isClosing()) ?? null;
    this.connectionsPanel = next;
    const pane = this.connectionsPane();
    if (pane) void this.followPanel(pane, next);
  }

  /** Panel `view` shows another chat (or a new one): the Connections pane follows it. */
  chatShown(view: ChatView): void {
    const pane = this.connectionsPane();
    if (pane) void this.followPanel(pane, view);
  }

  /** The Connections pane's map read again in a second, once what it shows may have changed (notes linked, projects). */
  private connectionsSoon(delay = 1000): void {
    if (!this.connectionsPane()) return;
    // One read for a burst of changes: one already due sooner covers this one too.
    const due = Date.now() + delay;
    if (this.connectionsTimer !== null) {
      if (this.connectionsDue <= due) return;
      window.clearTimeout(this.connectionsTimer);
    }
    this.connectionsDue = due;
    this.connectionsTimer = window.setTimeout(() => {
      this.connectionsTimer = null;
      void this.connectionsPane()?.refresh();
    }, delay);
  }

  /**
   * What the map of chat `id`, panel `view`'s, shows, read now, and what it does. `lookOnly`: the chat
   * has no session of its own yet (see ChatView.connectionsChat): its map is looked at, and nothing is
   * changed for it.
   */
  private async chatMapHost(view: ChatView, id: string, all = false, lookOnly = false): Promise<ChatMapHost> {
    await this.recentListing();
    const recent = (other: string) => this.lastListing?.find((item) => item.id === other)?.updatedAt ?? 0;
    const listed = new Set((this.lastListing ?? []).filter((item) => !item.scratch).map((item) => item.id));
    const weighted = new Map([...this.weightedNotes()].filter(([other]) => other === id || listed.has(other)));
    const to = (this.chatLinks[id] ?? []).filter((other) => listed.has(other));
    const from = this.linkedChats(id).filter((other) => listed.has(other) && !to.includes(other));
    const map = chatMap(id, weighted, to, recent, all, this.hubNotes(), from);
    const home = this.homeProject(id);
    const stale = () => view.connectionsChat()?.id !== id;
    return {
      // Look-only: no chat for links to be made from.
      ...this.mapActions(lookOnly ? null : id, view, stale),
      lookOnly,
      baseline: { id, title: this.chatTitleOf(id) },
      title: this.chatTitleOf(id),
      ...map,
      hubs: this.hubNotes(),
      project: home ? { name: home.basename, folder: this.projectFolder(home), path: home.path } : null,
      ownProject: home ? { name: home.basename, path: home.path } : null,
      openProjectNote: (path) => void this.app.workspace.openLinkText(path, '', 'tab'),
      projectMap: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error('the project note is gone');
        return this.projectMapHost(file, view);
      },
      sendAgain: (path) => {
        if (this.staleMap(stale)) return;
        const state = this.projectState(id);
        this.setProjectState(id, { ...state, sent: state.sent?.filter((key) => key !== path && !key.startsWith('parent:')) });
        this.projectsChanged();
        new Notice('Its context goes again with your next message.');
      },
      renameProject: (path, done) => this.renameProject(path, done),
      deleteProject: (path, done) => this.deleteProject(path, done),
      drawLinks: (el) => {
        const links = view.linksPane();
        links.mount(el);
        return { stop: () => links.onClose(), redraw: () => links.redraw() };
      },
      refreshContext: (path, saved) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) void this.refreshContext(file, saved);
      },
      changeFolder: (path, changed) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;
        const source = this.folderSource((this.lastListing ?? []).filter((item) => !item.scratch), this.chatNotes());
        new ChooseFolderModal(this.app, source, this.projectFolder(file), file.basename, (folder) => {
          void this.setProjectFolder(file, folder).then(changed);
        }).open();
      },
      projects: () => this.projectNotes().map((file) => ({ path: file.path, name: file.basename })),
      setHome: async (path) => {
        if (lookOnly || this.staleMap(stale)) return;
        const file = path === null ? null : this.app.vault.getAbstractFileByPath(path);
        if (path !== null && !(file instanceof TFile)) {
          // A project deleted since the map was drawn: not a choice to leave the chat's own.
          new Notice('That project is gone.');
          void this.connectionsPane()?.refresh();
          return;
        }
        await this.setHomeProject(id, file instanceof TFile ? file : null);
        new Notice(file instanceof TFile ? `This chat is now in “${file.basename}”.` : 'This chat is out of its project; its notes no longer place it in one.');
      },
      projectHolding: (folder) => {
        const file = this.projectForPath(`${folder}/note.md`);
        return file && { path: file.path, name: file.basename, folder: this.projectFolder(file) };
      },
      all,
      reload: (more) => this.chatMapHost(view, id, more, lookOnly),
      linkedProject: home ? null : (() => {
        for (const other of this.linkedChats(id)) {
          const file = this.homeProject(other);
          if (file) return { path: file.path, name: file.basename };
        }
        return null;
      })(),
      folderSuggestion: home ? null : this.folderSuggestionFor(id),
      makeProject: (folder, created) => {
        if (!this.staleMap(stale)) void this.openCreateProject({ folder, chatId: id, created });
      },
    };
  }

  /** What project `file`'s map shows, read now; with `all`, every chat and note (see projectMap). */
  private async projectMapHost(file: TFile, view: ChatView | null, all = false): Promise<ProjectMapHost> {
    await this.recentListing();
    const members = this.projectMembers(file).map((item) => item.id);
    const map = projectMap(members, this.weightedNotes(), all);
    return {
      ...this.mapActions(view?.currentChatId() ?? null, view),
      name: file.basename,
      path: file.path,
      openBeside: (path) => {
        const note = this.app.vault.getAbstractFileByPath(path);
        if (note instanceof TFile) void this.app.workspace.getLeaf('split', 'vertical').openFile(note);
      },
      folder: this.projectFolder(file),
      ...map,
      moreChats: Math.max(0, members.length - map.chats.length),
      all,
      reload: (more) => this.projectMapHost(file, view, more),
    };
  }

  /** Chat `id`'s home project, if it has one. */
  homeProject(id: string): TFile | null {
    return this.homeReason(id)?.file ?? null;
  }

  /** The projects changed (their notes, folders or added chats): the chats' homes are worked out again when asked for. */
  private homesChanged(): void {
    this.homeCache.clear();
  }

  /** What chats' homes are worked out from changed, their notes too: they are worked out again when asked for. */
  private membershipChanged(): void {
    this.homesChanged();
    this.notesCache = null;
    this.weightsCache = null;
    this.hubsCache = null;
  }

  /** The listed chats whose home project is `file`, newest first. */
  projectMembers(file: TFile): HistoryItem[] {
    return (this.lastListing ?? []).filter((item) => !item.scratch && this.homeProject(item.id) === file).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The projects whose folders hold project `file`'s folder, the outermost first: their Instructions go with its chats too. */
  enclosingProjects(file: TFile): TFile[] {
    const folder = this.projectFolder(file);
    if (!folder) return [];
    return this.projectNotes()
      .filter((other) => other !== file && this.projectFolder(other) !== '' && folder.startsWith(`${this.projectFolder(other)}/`))
      .sort((a, b) => this.projectFolder(a).length - this.projectFolder(b).length);
  }

  /** The project whose folder holds note `path` (the deepest such folder), which a new chat with it attached joins. */
  projectForPath(path: string): TFile | null {
    let best: TFile | null = null;
    let depth = -1;
    for (const file of this.projectNotes()) {
      const folder = this.projectFolder(file);
      if (!folder || !inFolder(path, folder) || folder.length <= depth) continue;
      best = file;
      depth = folder.length;
    }
    return best;
  }

  /** What a chat's projects have sent with it, and what it chose (see ChatProjectState). */
  projectState(id: string): ChatProjectState {
    return this.chatProjects[id] ?? {};
  }

  setProjectState(id: string, state: ChatProjectState): void {
    const kept: ChatProjectState = {};
    if (state.sent?.length) kept.sent = state.sent;
    if (state.sent?.length && state.sentHash) kept.sentHash = Object.fromEntries(Object.entries(state.sentHash).filter(([path]) => state.sent?.includes(path)));
    if (state.declined) kept.declined = true;
    if (state.start) kept.start = state.start;
    if (state.includeChats?.length) kept.includeChats = state.includeChats;
    if (Object.keys(kept).length > 0) this.chatProjects[id] = kept;
    else delete this.chatProjects[id];
    this.homeCache.delete(id);
    void this.saveSettings();
  }

  /**
   * The context that went with chat `id` has left its conversation (compacted, or cut away): it is
   * sent again with the next message. `cut`: part of the chat was removed, so its stored summary,
   * which holds that part, goes too.
   */
  contextLeft(id: string, cut: boolean): void {
    const state = this.projectState(id);
    if (state.sent?.length) this.setProjectState(id, { ...state, sent: undefined, sentHash: undefined });
    if (cut && this.chatSummaries[id]) {
      delete this.chatSummaries[id];
      this.saveSoon();
    }
    for (const view of this.chatViews()) view.projectsChanged();
  }

  /**
   * Keeps `state`, what a chat chose before it had id `id`, together with what was recorded under the
   * id meanwhile: the context its hook sent with its first message (see markContextSent).
   */
  adoptProjectState(id: string, state: ChatProjectState): void {
    const now = this.projectState(id);
    const union = (a?: string[], b?: string[]) => [...new Set([...(a ?? []), ...(b ?? [])])];
    this.setProjectState(id, {
      sent: union(state.sent, now.sent),
      sentHash: { ...state.sentHash, ...now.sentHash },
      declined: now.declined || state.declined,
      start: now.start ?? state.start,
      includeChats: union(state.includeChats, now.includeChats),
    });
  }

  /** Records that context `paths` (see ChatView.projectContext), with their fingerprints, went with chat `id`. */
  markContextSent(id: string, paths: string[], hashes: Record<string, string>): void {
    const state = this.projectState(id);
    this.setProjectState(id, { ...state, sent: [...new Set([...(state.sent ?? []), ...paths])], sentHash: { ...state.sentHash, ...hashes } });
  }

  /**
   * Makes `file` chat `id`'s project, added by hand; null takes it out of its project, by hand, after
   * which its notes do not give it one. A chat has at most one project.
   */
  async setHomeProject(id: string, file: TFile | null): Promise<void> {
    for (const project of this.projectNotes()) {
      const isHome = project === file;
      const listed = this.projectAdded(project).includes(id);
      if (isHome ? listed : !listed) continue;
      // From the frontmatter as written, which the index may not have caught up with.
      await this.app.fileManager.processFrontMatter(project, (front: Record<string, unknown>) => {
        const added = idList(front.added).filter((each) => each !== id);
        front.added = isHome ? [...added, id] : added;
        front.updated = today();
      });
      await this.indexed(project);
    }
    // A new home's context (with its enclosing projects' Instructions) goes with the chat's next message, however it was chosen.
    const state = this.projectState(id);
    this.setProjectState(id, { ...state, declined: file === null, sent: file ? state.sent?.filter((key) => key !== file.path && !key.startsWith('parent:')) : state.sent });
    this.homesChanged();
    this.projectsChanged();
  }

  /** Resolves once Obsidian has read `file` again after a change (at most a second later). */
  private indexed(file: TFile): Promise<void> {
    return new Promise((resolve) => {
      const ref = this.app.metadataCache.on('changed', (changed) => {
        if (changed !== file) return;
        this.app.metadataCache.offref(ref);
        window.clearTimeout(timer);
        resolve();
      });
      const timer = window.setTimeout(() => {
        this.app.metadataCache.offref(ref);
        resolve();
      }, 1000);
    });
  }

  /** A folder moved or was renamed: the projects of it and of folders in it follow (their notes, and so their chats, are there). */
  private projectFolderMoved(from: string, to: string): void {
    for (const file of this.projectNotes()) {
      const folder = this.projectFolder(file);
      const moved = folder ? movedPath(folder, from, to) : undefined;
      if (!moved) continue;
      void this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
        front.folder = moved;
        front.updated = today();
      });
    }
  }

  /** The panels draw their project chips again. */
  private projectsChanged(): void {
    for (const view of this.chatViews()) view.projectsChanged();
    this.connectionsSoon();
  }

  /** A chat's title as listed; `Chat` when it is not. */
  chatTitleOf(id: string): string {
    return this.lastListing?.find((item) => item.id === id)?.title ?? this.chats.find((chat) => chat.id === id)?.title ?? 'Chat';
  }

  /** A Markdown link that opens chat `id` (see chatLink), titled by it. */
  chatMarkdownLink(id: string): string {
    return `[${this.chatTitleOf(id).replace(/[[\]]/g, '')}](${chatLink({ vault: this.app.vault.getName(), chat: id })})`;
  }

  /**
   * Writes a project's generated lists as they are now: its chats (newest first), and the notes its chats worked on most. Written only when they changed; done when the note is
   * opened, as its chats follow from their notes rather than from the note.
   */
  async refreshProjectLists(file: TFile): Promise<void> {
    await this.recentListing();
    const own = this.projectMembers(file).map((item) => item.id);
    const chats = own.map((id) => `- ${this.chatMarkdownLink(id)}`).join('\n');
    const keyNotes = this.keyNotes(file, own);
    const before = await this.app.vault.read(file);
    const after = withGenerated(withGenerated(before, 'Chats', chats), 'Key notes', keyNotes);
    if (after !== before) await this.app.vault.process(file, (text) => withGenerated(withGenerated(text, 'Chats', chats), 'Key notes', keyNotes));
  }

  /** The notes chats `own` edited or were sent most (how many of them did), as a list of links from project note `file`. */
  private keyNotes(file: TFile, own: string[]): string {
    const counts = new Map<string, number>();
    for (const index of [this.noteChats, this.noteRefs]) {
      for (const [path, ids] of Object.entries(index)) {
        const n = ids.filter((id) => own.includes(id)).length;
        if (n > 0 && path !== file.path) counts.set(path, Math.max(counts.get(path) ?? 0, n));
      }
    }
    return [...counts]
      .flatMap(([path, n]) => {
        const note = this.app.vault.getAbstractFileByPath(path);
        return note instanceof TFile ? [{ note, n }] : [];
      })
      .sort((a, b) => b.n - a.n || a.note.basename.localeCompare(b.note.basename))
      .slice(0, PROJECT_KEY_NOTES)
      .map(({ note, n }) => `- [[${this.app.metadataCache.fileToLinktext(note, file.path)}]]${n > 1 ? ` (${n} chats)` : ''}`)
      .join('\n');
  }

  /** Where project notes go: `Projects` beside the memos folder. */
  private projectsFolder(): string {
    const memos = this.memosFolder();
    const parent = memos === '/' ? '' : memos.split('/').slice(0, -1).join('/');
    return parent ? `${parent}/Projects` : 'Projects';
  }

  /**
   * Create project: a folder of the vault, chosen in a browser; `folder`, one chosen already (from the
   * history); `chatId`, a chat to make it for, whose notes suggest the folder and which joins it.
   */
  async openCreateProject(options: { folder?: string; chatId?: string | null; created?: () => void } = {}): Promise<void> {
    await this.listChats().catch(() => []);
    new CreateProjectModal(this.app, {
      ...this.folderSource((this.lastListing ?? []).filter((item) => !item.scratch), this.chatNotes()),
      folder: options.folder,
      suggestion: options.chatId ? this.folderSuggestionFor(options.chatId) : null,
      create: async (name, folder) => {
        // The chat it is made for joins it only when it has no project: one in another stays there.
        const joining = options.chatId && !this.homeProject(options.chatId) ? options.chatId : null;
        const made = await this.createProject(name, folder, joining);
        if (made) options.created?.();
        return made;
      },
      nameProblem: (name) => this.projectNameProblem(name),
      defaultName: (folder) => {
        const base = `Claude Project — ${folder.slice(folder.lastIndexOf('/') + 1)}`;
        let name = base;
        for (let n = 2; this.projectNameProblem(name) !== null; n++) name = `${base} ${n}`;
        return name;
      },
    }).open();
  }

  /** The notes each chat edited or was sent (see notesByChat): what tells which folder its work is in. Kept until the indexes change. */
  chatNotes(): Map<string, Set<string>> {
    this.notesCache ??= notesByChat(this.noteChats, this.noteRefs);
    return this.notesCache;
  }

  /** Each chat's notes, edited, sent or mentioned, with the weight of its link to each (see weightedNotes). Kept until the indexes change. */
  weightedNotes(): Map<string, Map<string, number>> {
    this.weightsCache ??= weightedNotes(this.noteChats, this.noteRefs, this.noteMentions);
    return this.weightsCache;
  }

  /** The notes linked to many chats (see hubNotes). Kept until the indexes change. */
  hubNotes(): Set<string> {
    this.hubsCache ??= hubNotes(this.weightedNotes());
    return this.hubsCache;
  }

  /** Folders not offered for a project: the plugin's own (saved chats, memos, projects) and those hidden. */
  private skipFolder(folder: string): boolean {
    const own = [this.settings.savedChatsFolder, this.memosFolder(), this.projectsFolder()].map((each) => normalizePath(each || '/')).filter((each) => each !== '/');
    return own.some((each) => folder === each || folder.startsWith(`${each}/`)) || this.isHiddenFolder(folder);
  }

  /** Whether a folder's notes are hidden from Claude: the hidden-path patterns read notes only, so a note in it is asked about. */
  private isHiddenFolder(folder: string): boolean {
    return this.isHiddenPath(`${folder}/note.md`);
  }

  /** For a chat without a project, the folder its notes suggest (see suggestFolder), when it is not a project already. */
  folderSuggestionFor(id: string): FolderSuggestion | null {
    const suggestion = suggestFolder(this.chatNotes().get(id) ?? [], (folder) => this.skipFolder(folder));
    return suggestion && !this.projectOfFolder(suggestion.folder) ? suggestion : null;
  }

  /** A project note's name as it is written: without the characters a note name cannot hold, nor a leading dot, which would hide it. */
  private cleanProjectName(name: string): string {
    return name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+\s*/, '');
  }

  /**
   * Why a project note cannot be called `name`: none left once cleaned, or a note of that name exists
   * (names are unique in the vault); `renamed`, the note being renamed, which may keep its name in
   * other letter case.
   */
  projectNameProblem(name: string, renamed?: TFile): string | null {
    const clean = this.cleanProjectName(name);
    if (!clean) return 'A project needs a name with letters or numbers in it.';
    const taken = this.app.vault.getAbstractFileByPath(`${this.projectsFolder()}/${clean}.md`) ?? this.app.metadataCache.getFirstLinkpathDest(clean, '');
    return taken && taken !== renamed ? `A note named “${clean}” exists already (${taken.path}): choose another name.` : null;
  }

  /**
   * Makes project note `name` for folder `folder` and opens it; `chatId`, a chat it is made for, which
   * is added to it unless its notes put it there already. False when it could not be made.
   */
  async createProject(name: string, folder: string, chatId: string | null): Promise<boolean> {
    const clean = this.cleanProjectName(name);
    const problem = this.projectNameProblem(name);
    if (problem) {
      new Notice(problem);
      return false;
    }
    if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
      new Notice(`There is no folder “${folder}”.`);
      return false;
    }
    const taken = this.projectOfFolder(folder);
    if (taken) {
      new Notice(`“${folder}” is the folder of “${taken.basename}” already.`);
      return false;
    }
    const where = this.projectsFolder();
    const path = `${where}/${clean}.md`;
    try {
      if (!this.app.vault.getAbstractFileByPath(where)) await this.app.vault.createFolder(where);
      const file = await this.app.vault.create(path, projectNoteMarkdown({ name: clean, folder, added: [], date: today() }));
      await this.indexed(file);
      this.projectCache = null;
      this.membershipChanged();
      if (chatId && this.homeProject(chatId) !== file) await this.setHomeProject(chatId, file);
      await this.refreshProjectLists(file);
      this.projectsChanged();
      await this.app.workspace.getLeaf('tab').openFile(file);
      // Its Context, written straight into the note (which can then be edited); without it, the project still stands.
      const writing = new Notice(`Project “${clean}” created. Writing its context from its notes and chats…`, 0);
      void this.writeProjectContext(file)
        .then(async (context) => {
          await this.saveProjectContext(file, context);
          new Notice(`The context of “${clean}” is written: edit it in the note, or Refresh context later.`);
        })
        .catch((error: unknown) => {
          log('writing a project context failed', error);
          new Notice(`The context of “${clean}” could not be written: ${errorText(error)}. Use Refresh context to try again.`);
        })
        .finally(() => writing.hide());
      return true;
    } catch (error) {
      log('creating a project failed', error);
      new Notice(`The project could not be created: ${errorText(error)}.`);
      return false;
    }
  }

  /** The vault's folders, as the folder browser offers them: which are projects, and the chats working in each. */
  private folderSource(listed: HistoryItem[], notes: Map<string, Set<string>>): FolderSource {
    return {
      folders: this.app.vault
        .getAllLoadedFiles()
        .filter((each): each is TFolder => each instanceof TFolder && each.path !== '/' && !this.skipFolder(each.path))
        .map((folder) => folder.path)
        .sort(),
      projectOf: (folder) => this.projectOfFolder(folder)?.basename ?? null,
      preview: (folder) => {
        const chats = listed.filter((item) => [...(notes.get(item.id) ?? [])].some((path) => inFolder(path, folder)));
        return { count: chats.length, latest: chats.length > 0 ? formatDate(Math.max(...chats.map((item) => item.updatedAt))) : '' };
      },
    };
  }

  /** Makes `folder` project `file`'s folder. */
  private async setProjectFolder(file: TFile, folder: string): Promise<boolean> {
    await this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
      front.folder = folder;
      front.updated = today();
    });
    await this.indexed(file);
    this.homesChanged();
    this.projectsChanged();
    new Notice(`“${file.basename}” is now the project of ${folder}.`);
    return true;
  }

  /** Renames project `path`'s note, asking for the name; `done` runs once renamed. Links to it, and the chats' records of it by path, follow (see noteMoved). */
  private renameProject(path: string, done: () => void): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    new RenameModal(
      this.app,
      file.basename,
      (name) => {
        if (name.trim() === file.basename) return;
        const problem = this.projectNameProblem(name, file);
        if (problem) return void new Notice(problem);
        const folder = file.parent && !file.parent.isRoot() ? file.parent.path : '';
        void this.app.fileManager.renameFile(file, `${folder ? `${folder}/` : ''}${this.cleanProjectName(name)}.md`).then(done, (error: unknown) => {
          log('renaming a project failed', error);
          new Notice(`The project was not renamed: ${errorText(error)}.`);
        });
      },
      'Rename project',
    ).open();
  }

  /** Deletes project `path`, after asking: its note to the trash, as Obsidian's settings say; its chats and folder stay. `done` runs once deleted. */
  private deleteProject(path: string, done: () => void): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const chats = this.projectMembers(file).length;
    new ConfirmModal(
      this.app,
      'Delete project',
      `The project note “${file.basename}” goes to the trash, with its Context and Instructions. Its ${chats} chat${chats === 1 ? '' : 's'} and the notes in ${this.projectFolder(file) || 'its folder'} stay as they are; the chats no longer get the project's context.`,
      'Delete',
      () =>
        void this.app.fileManager.trashFile(file).then(() => {
          new Notice(`Project “${file.basename}” deleted: its note is in the trash.`);
          done();
        }),
    ).open();
  }

  /** Writes every project's Context anew, straight into its note (one request each, on the model for small jobs), after asking. */
  writeAllContexts(): void {
    const projects = this.projectNotes();
    if (projects.length === 0) return void new Notice('There are no projects yet.');
    const names = projects.map((file) => `“${file.basename}”`).join(', ');
    new ConfirmModal(
      this.app,
      'Write every project’s context anew',
      `This replaces the Context of ${projects.length === 1 ? 'the project' : `all ${projects.length} projects`} (${names}), edits by hand included, with one written from its notes and chats. Their Instructions stay. Each Context then goes again with the next message of each of its chats.`,
      'Write',
      () => void this.writeContexts(projects),
    ).open();
  }

  private async writeContexts(projects: TFile[]): Promise<void> {
    const notice = new Notice(`Writing the context of ${projects.length} project${projects.length === 1 ? '' : 's'}…`, 0);
    let done = 0;
    for (const file of projects) {
      try {
        await this.saveProjectContext(file, await this.writeProjectContext(file));
        this.contextChanged(file.path);
        done += 1;
      } catch (error) {
        log('writing a project context failed', file.path, error);
      }
    }
    notice.hide();
    new Notice(`Context written for ${done} of ${projects.length} project${projects.length === 1 ? '' : 's'}.`);
  }

  /** A project's Context and Instructions as they go with a chat. */
  async projectParts(file: TFile): Promise<{ context: string; instructions: string }> {
    return projectParts(await this.app.vault.cachedRead(file));
  }

  /** Writes a project's Context anew and shows it beside the one it has, to save or not (see ContextModal). */
  async refreshContext(file: TFile, saved?: () => void): Promise<void> {
    const current = (await this.projectParts(file)).context;
    new ContextModal(this.app, {
      name: file.basename,
      current,
      write: (signal) => this.writeProjectContext(file, signal),
      save: async (context) => {
        await this.saveProjectContext(file, context);
        this.contextChanged(file.path);
        new Notice(`The context of “${file.basename}” is updated: it goes with the next message of each of its chats.`);
        saved?.();
      },
    }).open();
  }

  /** Project `path`'s Context has been written anew: its chats get it again, whether or not it went before. */
  private contextChanged(path: string): void {
    for (const [id, state] of Object.entries(this.chatProjects)) {
      if (state.sent?.includes(path)) this.setProjectState(id, { ...state, sent: state.sent.filter((key) => key !== path) });
    }
  }

  /** Puts `context` in a project's note, and stamps when. */
  private async saveProjectContext(file: TFile, context: string): Promise<void> {
    await this.app.vault.process(file, (text) => withContext(text, context));
    await this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
      front.context_updated = today();
      front.updated = today();
    });
    // Read again by Obsidian before anything shows it: its properties are missing while it is.
    await this.indexed(file);
    this.projectsChanged();
  }

  /**
   * A project's Context, written on the model for small jobs from its folder's notes (their
   * properties and opening lines, the most recently changed first) and the chats that worked on them
   * (their last exchanges): read locally, one request.
   */
  async writeProjectContext(file: TFile, signal?: AbortSignal): Promise<string> {
    const launch = this.claudeLaunch();
    const dir = this.vaultRoot();
    if (typeof launch === 'string') throw new Error(launch);
    await this.listChats().catch(() => []);
    const folder = this.projectFolder(file);
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((note) => note !== file && folder !== '' && inFolder(note.path, folder) && !this.isHiddenPath(note.path))
      // The folder's own notes (its hub, by its name) first, then the most recently changed.
      .sort((a, b) => Number(b.parent?.path === folder) - Number(a.parent?.path === folder) || b.stat.mtime - a.stat.mtime)
      .slice(0, CONTEXT_NOTES);
    const notes = await Promise.all(
      files.map(async (note) => {
        const { position: _position, ...properties } = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
        return { path: note.path, properties, opening: noteOpening(await this.app.vault.cachedRead(note)) };
      }),
    );
    const chats = await Promise.all(
      this.projectMembers(file)
        .slice(0, CONTEXT_CHATS)
        .map(async (item) => ({
          title: item.title,
          date: formatDate(item.updatedAt).slice(0, 10),
          digest: dir ? chatDigest(await lastMessages(item.id, dir, ownMessage, CONTEXT_MESSAGES, PICK_UP_BYTES).catch(() => [])).slice(-CONTEXT_DIGEST_CHARS) : '',
        })),
    );
    const reply = await runOneShot(launch, { system: CONTEXT_SYSTEM, prompt: contextPrompt({ name: file.basename, folder }, notes, chats), model: this.smallJobModel(), effort: 'low' }, () => undefined, signal ?? new AbortController().signal);
    const context = readContext(reply);
    if (!context) throw new Error('Claude did not write one');
    return context;
  }

  /**
   * Suggest frontmatter updates for `file` (see frontmatterSuggest.ts): Claude reads the note, the
   * properties of the notes beside it (its folder and the folders in it, the most recently changed
   * first) and the titles of the chats that worked on them, and proposes values; written only once
   * approved, with `updated` stamped when the note has it. Read locally; one request, on the model
   * for small jobs.
   */
  async suggestFrontmatter(file: TFile): Promise<void> {
    if (this.isHiddenPath(file.path)) {
      new Notice(`“${file.basename}” is hidden from Claude by the plugin's settings.`);
      return;
    }
    await this.listChats().catch(() => []);
    const folder = file.parent?.path === '/' ? '' : (file.parent?.path ?? '');
    // At the top of the vault, the notes there only: not the whole vault.
    const beside = (path: string) => (folder ? inFolder(path, folder) : !path.includes('/'));
    const neighbours = this.app.vault
      .getMarkdownFiles()
      .filter((other) => other !== file && beside(other.path) && !this.isHiddenPath(other.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, FRONTMATTER_NEIGHBOURS)
      .map((other) => {
        const { position: _position, ...frontmatter } = this.app.metadataCache.getFileCache(other)?.frontmatter ?? {};
        return { path: other.path, frontmatter, modified: formatDate(other.stat.mtime).slice(0, 10) };
      });
    const ids = new Set<string>();
    for (const index of [this.noteChats, this.noteRefs]) for (const [path, chats] of Object.entries(index)) if (path === file.path || beside(path)) for (const id of chats) ids.add(id);
    const chats = (this.lastListing ?? [])
      .filter((item) => ids.has(item.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, FRONTMATTER_CHATS)
      .map((item) => ({ title: item.title, date: formatDate(item.updatedAt).slice(0, 10) }));
    const current = (): Record<string, unknown> => {
      const { position: _position, ...frontmatter } = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      return frontmatter;
    };
    new FrontmatterModal(this.app, {
      name: file.basename,
      neighbours: neighbours.length,
      chats: chats.length,
      current: current(),
      guidance: this.frontmatterGuidance[folder] ?? '',
      suggest: async (guidance, signal) => {
        if (guidance.trim()) this.frontmatterGuidance[folder] = guidance.trim();
        else delete this.frontmatterGuidance[folder];
        this.saveSoon();
        const launch = this.claudeLaunch();
        if (typeof launch === 'string') throw new Error(launch);
        const text = await this.app.vault.cachedRead(file);
        const reply = await runOneShot(launch, { system: FRONTMATTER_SYSTEM, prompt: frontmatterPrompt({ path: file.path, text, neighbours, chats, guidance }), model: this.smallJobModel() }, () => undefined, signal);
        const fields = readFrontmatterSuggestions(reply, current());
        if (!fields) throw new Error('Claude did not reply in the form asked for');
        return fields;
      },
      apply: async (values) => {
        await this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
          Object.assign(front, values);
          if ('updated' in front) front.updated = today();
        });
        const n = Object.keys(values).length;
        new Notice(`${n} propert${n === 1 ? 'y' : 'ies'} of “${file.basename}” updated.`);
      },
    }).open();
  }

  /** Pick up where you left off: Claude's suggestions of chats to carry on (see pickUp.ts, PickUpModal). */
  async openPickUp(): Promise<void> {
    // Listed first, so that the reminders kept can be shown with their chats' titles.
    if (!this.lastListing) await this.listChats().catch(() => []);
    new PickUpModal(this.app, {
      load: async (signal, fresh) => {
        // Listed now: what was worked on since the kept list was made is told by it.
        await this.listChats().catch(() => []);
        const kept = fresh ? null : keptToday(this.pickUp, Date.now(), (id) => this.lastListing?.find((item) => item.id === id)?.updatedAt);
        if (kept) return kept;
        const made = await this.suggestPickUp(signal);
        if (!made || signal.aborted) return made && { ...made, at: Date.now() };
        // Kept for the rest of the day: only the chats suggested, not every one looked at.
        const at = Date.now();
        const suggested = new Set(made.suggestions.map((suggestion) => suggestion.id));
        this.pickUp.kept = { day: localDay(at), at, suggestions: made.suggestions, note: made.note, candidates: made.candidates.filter((candidate) => suggested.has(candidate.id)) };
        void this.saveSettings();
        return { ...made, at };
      },
      details: (id) => this.pickUpDetails(id),
      open: async (id, step) => {
        const title = this.lastListing?.find((item) => item.id === id)?.title ?? 'Chat';
        const view = await this.openChatById(id, title);
        if (!view) new Notice('That chat could not be opened: it may have been deleted.');
        else if (step) view.addToInput(step);
      },
      hide: (id) => {
        this.pickUp.hidden[id] = Date.now();
        delete this.pickUp.later?.[id];
        void this.saveSettings();
      },
      ignoredCount: () => this.ignoredChats(),
      leftOut: (id) => leftOut(this.pickUp, id, Date.now()) || !!this.pickUp.later?.[id],
      clearIgnored: () => this.clearIgnoredChats(),
      skip: (id) => {
        (this.pickUp.skipped ??= {})[id] = Date.now() + SKIP_DAYS * DAY_MS;
        delete this.pickUp.later?.[id];
        void this.saveSettings();
      },
      openNote: (path) => void this.app.workspace.openLinkText(path, '', false),
      renderMarkdown: (markdown, el, component, leaving, parent) =>
        void renderSafely(this.app, markdown, el, component, {
          resolve: (name) => {
            const file = this.app.vault.getAbstractFileByPath(name) ?? this.app.metadataCache.getFirstLinkpathDest(name, '');
            return file instanceof TFile ? file.path : null;
          },
          open: (linktext, newTab) => {
            leaving();
            void this.app.workspace.openLinkText(linktext, '', newTab);
          },
          preview: (linktext, event, target) => this.app.workspace.trigger('hover-link', { event, source: VIEW_TYPE, hoverParent: parent, targetEl: target, linktext }),
        }),
      previewNote: (path, event, target, parent) => this.app.workspace.trigger('hover-link', { event, source: VIEW_TYPE, hoverParent: parent, targetEl: target, linktext: path }),
      remindLater: (suggestion) => {
        (this.pickUp.later ??= {})[suggestion.id] = { why: suggestion.why, next: suggestion.next, at: Date.now(), days: [] };
        void this.saveSettings();
      },
      forget: (id) => {
        if (!this.pickUp.later?.[id]) return;
        delete this.pickUp.later[id];
        void this.saveSettings();
      },
      reminders: (before) => {
        // Kept as they are while the chats are not listed yet (just after Obsidian starts).
        const listing = this.lastListing;
        if (!listing) return [];
        const before_ = JSON.stringify(this.pickUp.later ?? {});
        const shown = remindersNow(this.pickUp, Date.now(), before, (id) => listing.some((item) => item.id === id));
        // Saved only when a day was counted or a reminder let go of.
        if (JSON.stringify(this.pickUp.later ?? {}) !== before_) void this.saveSettings();
        return shown.flatMap(({ id, why, next, left }) => {
          const item = listing.find((listed) => listed.id === id);
          return item ? [{ chat: { id, title: item.title, updatedAt: item.updatedAt, older: false, exchanges: [], clues: [] }, suggestion: { id, why, next }, left }] : [];
        });
      },
    }).open();
  }

  /**
   * What a suggested chat is about, from the plugin's own records: the notes it changed, was sent
   * with or mentioned, each with its folder and tags, and the memos saved from it. Nothing is asked.
   */
  private pickUpDetails(id: string): ChatDetails {
    const tagsOf = (file: TFile) => {
      const cache = this.app.metadataCache.getFileCache(file);
      const listed = cache?.frontmatter?.tags;
      const front = Array.isArray(listed) ? listed.map(String) : typeof listed === 'string' ? [listed] : [];
      const inline = (cache?.tags ?? []).map((tag) => tag.tag.replace(/^#/, ''));
      return [...new Set([...front, ...inline])];
    };
    const notes: ChatDetails['notes'] = [];
    const seen = new Set<string>();
    for (const [index, how] of [
      [this.noteChats, 'changed'],
      [this.noteRefs, 'sent with a message'],
      [this.noteMentions, 'mentioned'],
    ] as const) {
      for (const [path, ids] of Object.entries(index)) {
        if (!ids.includes(id) || seen.has(path)) continue;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || this.isMemo(file)) continue;
        seen.add(path);
        notes.push({ path, name: file.basename, folder: file.parent?.path ?? '/', tags: tagsOf(file), how });
      }
    }
    const memos = this.memoNotes(id).map((file) => {
      const status = this.app.metadataCache.getFileCache(file)?.frontmatter?.status;
      return { path: file.path, name: file.basename, tags: tagsOf(file), status: typeof status === 'string' ? status : '' };
    });
    return { notes, memos };
  }

  /**
   * The chats to pick up, suggested on the model for small jobs from short excerpts of the recent
   * chats and of older ones with a clue that something was left open (see chatsToLookAt, candidateOf);
   * read locally from their session files and the memos saved from them. Null when Claude Code cannot run.
   */
  private async suggestPickUp(signal: AbortSignal): Promise<{ suggestions: Suggestion[]; note: string; candidates: Candidate[] } | null> {
    const launch = this.claudeLaunch();
    const dir = this.vaultRoot();
    if (typeof launch === 'string' || !dir) return null;
    const now = Date.now();
    const { recent, older } = chatsToLookAt(await this.listChats(), this.pickUp, now);
    const memoNext = async (id: string) =>
      (await Promise.all(this.memoNotes(id).map(async (file) => memoSection(await this.app.vault.cachedRead(file), 'Next')))).filter((next) => next.trim() !== '');
    const look = async (item: HistoryItem, isOlder: boolean) =>
      candidateOf(item, isOlder, await lastMessages(item.id, dir, ownMessage, PICK_UP_MESSAGES, PICK_UP_BYTES).catch(() => []), this.ticks[item.id] ?? {}, await memoNext(item.id));
    const candidates: Candidate[] = [];
    for (const item of recent) candidates.push(await look(item as HistoryItem, false));
    // Older chats, in a random order, only with a clue that something was left open; no more read than PICK_UP_OLDER_READS.
    for (const item of older.slice(0, PICK_UP_OLDER_READS)) {
      if (candidates.filter((candidate) => candidate.older).length >= OLDER_LOOKED_AT || signal.aborted) break;
      const candidate = await look(item as HistoryItem, true);
      if (candidate.clues.length > 0) candidates.push(candidate);
    }
    if (signal.aborted) return { suggestions: [], note: '', candidates };
    if (candidates.length === 0) return { suggestions: [], note: 'No chats from the last six months to look at.', candidates };
    const reply = await runOneShot(launch, { system: PICK_UP_SYSTEM, prompt: pickUpPrompt(candidates, now), model: this.smallJobModel(), effort: 'low' }, () => undefined, signal);
    const read = readPickUp(reply, candidates);
    if (!read) throw new Error('Claude did not reply in the form asked for');
    return { ...read, candidates };
  }

  /**
   * Opens a chat by its session id in the panel, as listed when it was (its copies with it): a kept
   * side chat whose panel has closed, a passage a memo came from. The panel that shows it, once
   * shown (another panel, when that one held it already); null when it could not be.
   */
  /** `into`: the panel to open it in (the one a map follows), when it is still open; else the panel the plugin opens. */
  async openChatById(id: string, title: string, into?: ChatView | null): Promise<ChatView | null> {
    const view = into && !into.isClosing() ? into : await this.activateView();
    if (into && view === into) await this.app.workspace.revealLeaf(into.leaf);
    const listed = this.lastListing?.find((item) => item.id === id);
    const opened = await view?.openChat(listed ? { ...listed, title } : { id, title, updatedAt: Date.now(), fromPanel: this.isPanelChat(id) });
    if (!opened) return null;
    return this.chatViews().find((each) => each.holdsChat(id)) ?? view ?? null;
  }

  /**
   * A link from a memo note (see memos.ts chatLink) or the Memos table: opens its chat, then goes to
   * the passage's message (`msg`) and its words in it (`find`; alone, searched for in the chat),
   * quotes it in the input to carry on from it (`quote`), or goes to the memo's first passage from
   * that chat (`memo`, the memo's name, or its path in a table written before).
   */
  private async openChatLink(params: Record<string, string>): Promise<void> {
    const id = params.chat;
    if (!id || !isChatId(id)) return;
    const dir = this.vaultRoot();
    if (dir && (await sessionStamp(id, dir)) === null) {
      new Notice('Source chat not found on this computer: deleted, or saved on another computer or with the vault in another folder. The passage stays readable in the memo.');
      return;
    }
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

  /** Whether `file` is a memo note (`type: memo`). */
  isMemo(file: TFile): boolean {
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.type === 'memo';
  }

  /**
   * Continue from a memo: you choose what of it goes along (see ContinueMemoModal), and a new chat
   * opens in a tab with that as a draft in its input, the related notes as `@` mentions.
   */
  async continueFromMemo(file: TFile): Promise<void> {
    const note = await this.app.vault.cachedRead(file);
    const listed = this.app.metadataCache.getFileCache(file)?.frontmatter?.notes;
    // Its links that are memos are offered as linked memos, the rest as related notes.
    const notes: string[] = [];
    const linked: LinkedMemo[] = [];
    for (const link of Array.isArray(listed) ? listed.map(String) : []) {
      const target = this.app.metadataCache.getFirstLinkpathDest(link.replace(/^\[\[|\]\]$/g, '').split('|')[0], file.path);
      if (target && target.path !== file.path && this.isMemo(target)) {
        const text = await this.app.vault.cachedRead(target);
        linked.push({ name: target.basename, why: memoSection(text, 'Why'), passages: savedPassages(text) });
      } else notes.push(link);
    }
    const parts = { why: memoSection(note, 'Why'), next: memoSection(note, 'Next'), passages: savedPassages(note), notes, linked };
    new ContinueMemoModal(this.app, file.basename, parts, async (chosen) => {
      const panel = await this.activateView();
      const view = panel && (await this.openChatTab(panel.leaf));
      if (!view) {
        new Notice('Could not open a new chat.');
        return;
      }
      view.startDraft(continueDraft({ name: file.basename, ...chosen }));
    }).open();
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
    if (!chatId) {
      await this.upgradeMemosBase();
      return existing;
    }
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
   * The Memos base brought up to date (see upgradeMemoBase) as it is: when Obsidian has loaded, so
   * that a base opened from the files, not from the panel, has Archived in place of Done too.
   */
  async upgradeMemosBase(): Promise<void> {
    const folder = this.memosFolder();
    const existing = this.app.vault.getAbstractFileByPath(`${folder === '/' ? '' : `${folder}/`}Memos.base`);
    if (!(existing instanceof TFile)) return;
    try {
      const parsed: unknown = parseYaml(await this.app.vault.read(existing));
      const upgraded = upgradeMemoBase(parsed);
      // Written only when something changed: not reformatted at every start.
      if (upgraded && JSON.stringify(upgraded) !== JSON.stringify(parsed)) await this.app.vault.modify(existing, stringifyYaml(upgraded));
    } catch (error) {
      log('updating the memos base failed', error);
    }
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
    const model = this.smallJobModel();
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
    // The Connections pane drawn again without it, staying where it is; when the panel it follows
    // shows no chat (it was just deleted from there), followed again for none.
    if (this.connectionsPanel?.connectionsChat()) void this.connectionsPane()?.refresh();
    else this.refollowConnections();
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
  /** `owner`: what holds the editor (a note's tab, a canvas card, a hover preview), by which the edit finds its note again (see InlineEditModal.accept). */
  async openInlineEdit(editor: Editor, file: TFile, owner: MarkdownFileInfo): Promise<void> {
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
      owner,
      from,
      to,
      original: editor.getRange(from, to),
      before: text.slice(Math.max(0, start - INLINE_CONTEXT_CHARS), start),
      after: text.slice(end, end + INLINE_CONTEXT_CHARS),
    };
    const conventions = await this.vaultConventions();
    const model = this.smallJobModel();
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
    // The summary names the model it ran on, which with none chosen is the one Claude Code's settings name.
    if (!this.configured.model) await this.loadConfigured();
    const model = this.smallJobModel();
    return runOneShot(
      launch,
      { system: summarySystem(conventions), prompt: summaryPrompt({ ...input, model: this.modelName(model) }), model, effort: 'medium' },
      () => undefined,
      signal,
    );
  }

  /** The model for small jobs (memo suggestions, inline edits, summaries): its own setting, else the chat's. */
  private smallJobModel(): string | undefined {
    return this.settings.smallJobModel || chatModel(this.settings.model);
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
    if (!cwd) return;
    this.configured = await configuredDefaults(cwd);
    setPlansDirectory(this.configured.plansDirectory, cwd);
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
    const pickUp = raw.pickUp && typeof raw.pickUp === 'object' ? raw.pickUp : null;
    this.pickUp = {
      hidden: pickUp?.hidden && typeof pickUp.hidden === 'object' ? pickUp.hidden : {},
      later: pickUp?.later && typeof pickUp.later === 'object' ? pickUp.later : {},
      skipped: pickUp?.skipped && typeof pickUp.skipped === 'object' ? pickUp.skipped : {},
      kept: pickUp?.kept && typeof pickUp.kept === 'object' && Array.isArray(pickUp.kept.suggestions) ? pickUp.kept : undefined,
    };
    this.chatProjects = raw.chatProjects && typeof raw.chatProjects === 'object' ? raw.chatProjects : {};
    this.chatLinks = raw.chatLinks && typeof raw.chatLinks === 'object' ? raw.chatLinks : {};
    this.chatSummaries = raw.chatSummaries && typeof raw.chatSummaries === 'object' ? raw.chatSummaries : {};
    this.frontmatterGuidance = raw.frontmatterGuidance && typeof raw.frontmatterGuidance === 'object' ? raw.frontmatterGuidance : {};
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
      // Logged here, as well as passed on: most callers do not wait for it, and a failed write has
      // no stack of the plugin's for the log's handler of unhandled errors to know it by.
      await this.saveData(this.dataToSave()).catch((error: unknown) => {
        log('saving the plugin data failed', error);
        throw error;
      });
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
      pickUp: this.pickUp,
      chatProjects: this.chatProjects,
      chatLinks: this.chatLinks,
      chatSummaries: this.chatSummaries,
      frontmatterGuidance: this.frontmatterGuidance,
    };
  }
}
