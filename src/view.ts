import {
  Component,
  ItemView,
  Keymap,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  Scope,
  TFile,
  TFolder,
  View,
  normalizePath,
  setIcon,
  type TAbstractFile,
  type WorkspaceLeaf,
} from 'obsidian';
import type {
  EffortLevel,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { agentTranscript, branchChat, branchChatFrom, chatTitle, cutChat, uncutChat, deleteCutLeftovers, sentUuidOf, deleteSessionIfAny, entryBefore, formatDate, lastMessages, loadChat, messageDates, loadTranscript, queuedTaken, isPlanFile, readPlanFile, sessionTitle, subagentFile, type HistoryItem, type LoadedChat } from './history';
import { EarlierDrawing, historyParts } from './earlierTurns';
import {
  filePathOf,
  imageFromBlob,
  mimeForExtension,
  pastedFiles,
  toImageBlock,
  type Attachment,
  type FileAttachment,
  type ImageAttachment,
  type SelectionAttachment,
} from './attachments';
import { chipFor, closeImage, renderChip } from './chip';
import { hintAbove } from './hint';
import { estimateTokens, formatTokens, mentionTargets, removeMentions } from './contextSize';
import { MemoModal, type MemoChoice } from './memoModal';
import { BOOKMARK_TAG, cleanTags, freeMemoTitle, linkedChatIds, removeChatLinks, memoNoteMarkdown, memoNoteName, passageNeedle, quickMemoTitle, type MemoPassage, type MemoSources } from './memos';
import { FindBar, findRanges, revealIn } from './findBar';
import { addFoldToggle } from './foldToggle';
import { hiddenPaths } from './pathFilter';
import { renderPlainText } from './plainText';
import { selectionWithMath } from './mathSource';
import { trackTask } from './backgroundTasks';
import { followDraftNotes, movedPath, NOTE_CHAT_ICONS, type NoteChatEntry } from './noteChats';
import { PromptNav } from './promptNav';
import { SideChat } from './sideChat';
import { answeredText, readQuestions, renderQuestionCard } from './questionCard';
import { ChoiceModal, ConfirmModal, HistoryModal, RenameModal, confirmDelete } from './historyModal';
import { LOG_PATH, errorText, log } from './log';
import { join as joinPath } from 'path';
import type VaultClaudePlugin from './main';
import type { ChatDraft, ChatProjectState } from './main';
import { contextHash, type ContextPart } from './projects';
import { ChatPicker, LinksList } from './linksList';
import { ProjectPicker } from './projectModals';
import { neutralizeRemoteMedia, openableHref, sweepRemoteMedia } from './safeMarkdown';
import { ClaudeSession, type PermissionRequest, type SessionHandlers, type UserContent } from './session';
import { SCRATCH_IDLE_CHOICES, chatModel, denyRuleList, idleLabel, modeShort, permissionModes, type ToolDisplay } from './settings';
import { summarizeTool, toolLabel, vaultRelative } from './toolSummary';
import { ChangesCard, agentDiffs, isOwnChange, openFileAtLine, savedChangedFiles, toolDiffs, type EditDiff } from './editDiff';
import { linkFileNames } from './fileLinks';
import { lineDiff } from './wordDiff';
import {
  applyTicks,
  baseName,
  branchTitle,
  chatToMarkdown,
  COMPACTION_DETAIL,
  compactionText,
  messagePrompt,
  promptBubble,
  lineRange,
  noticeHeader,
  parseTaskNotifications,
  startsTurn,
  withQuote,
  replyKey,
  type BranchSource,
  type Chip,
  type ContentBlock,
  type TaskNotice,
} from './chatText';
import { summaryNote } from './chatSummary';
import { CommandSuggest } from './commandSuggest';
import { MenuButton } from './menuButton';
import { NotePicker } from './notePicker';
import { renderUsageCard } from './usageCard';
import { readingLines, widgetSelection, type NoteContext } from './readingSelection';
import {
  contextFigures,
  formatDuration,
  prettyModel,
  timeLeft,
  turnStats,
  usageWindows,
} from './usageDisplay';

/** The most chats the back arrow goes through. */
const NAV_DEPTH = 50;

export const VIEW_TYPE = 'vault-claude-chat';
/** A chat opened from the history with more turns than this opens on its last ones; the rest are drawn when needed. */
const TAIL_TURNS = 10;
/** How long the notes button waits for drawing to settle before counting the chat's notes (see countNotesSoon). */
const NOTES_COUNT_DELAY_MS = 250;
/** Turns drawn at a time when scrolling up reaches the top of what is drawn. */
const EARLIER_STEP_TURNS = 10;
/** How far back from the end of the session file the prompts the turn in progress answers are looked for, by uuid. */
const TURN_PROMPT_MAX_BYTES = 8 * 1024 * 1024;

const MAX_NOTE_CHARS = 100_000;
/** A message you send that is longer than this is shown folded to its first lines. */
const LONG_MESSAGE_LINES = 8;
/** How a modifier click is named in tooltips, as on this platform. */
const MOD_CLICK = Platform.isMacOS ? '⌘-click' : 'Ctrl-click';
/**
 * How an Option (Alt) click is named in tooltips. It saves a bookmark: ⌘-click takes what it opens
 * to a tab away from the panel, and a bookmark opens nothing.
 */
const ALT_CLICK = Platform.isMacOS ? '⌥-click' : 'Alt-click';
const LONG_MESSAGE_CHARS = 700;
const MAX_PREVIEW_LINES = 60;
const PLAN_USAGE_INTERVAL_MS = 60_000;

/** Where a message not sent went back to (see ChatView.unsend), for its notice. */
function unsentWhere(back: 'input' | 'draft' | null, attachments: boolean): string {
  if (back === 'input') return ' It is back in the input.';
  if (back === 'draft') return ` It is back in that chat's input${attachments ? ', without its attachments' : ''}.`;
  return '';
}

/** `n` and `word`, made plural unless `n` is 1: "1 chat", "3 chats". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Chats and their background tasks, for a notice: "2 chats and 1 background task". */
function chatsAndTasks(chats: number, tasks: number): string {
  return tasks > 0 ? `${plural(chats, 'chat')} and ${plural(tasks, 'background task')}` : plural(chats, 'chat');
}

/** Text over a passage's budget cut at MAX_NOTE_CHARS, saying so with `note`. */
function capped(text: string, note: string): string {
  return text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS)}\n[Truncated at ${MAX_NOTE_CHARS} characters${note}]` : text;
}

/** A chat's status in the history, most pressing first. */
function chatStatus(approvals: number, busy: boolean, tasks: number, remoteUrl: string | null, otherwise: string): string {
  // Background tasks outlive the reply that started them, so they are named beside whatever else
  // the chat is doing rather than only when it is doing nothing else.
  const running = tasks > 0 ? `${plural(tasks, 'task')} in the background` : '';
  const state = approvals > 0 ? 'Waiting for your approval' : busy ? 'Working' : remoteUrl ? 'On your phone' : running ? '' : otherwise;
  return [state, running].filter(Boolean).join(' · ');
}

/** The messages a reply frame answers, as it names them; undefined from older Claude Code, which names none. */
function answeredBy(message: SDKMessage & { type: 'stream_event' | 'assistant' }): string[] | undefined {
  return message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : undefined);
}

/**
 * The tool results in a message of yours, each with its tool call's id and whether it failed. The
 * structured result belongs to the message, so it goes with a result only when that is the only one.
 */
function toolResults(content: Exclude<SDKUserMessage['message']['content'], string>, structured: unknown): { id: string; isError: boolean; structured: unknown }[] {
  const results = content.flatMap((block) => (block.type === 'tool_result' ? [block] : []));
  return results.map((block) => ({ id: block.tool_use_id, isError: block.is_error === true, structured: results.length === 1 ? structured : undefined }));
}

function clearSettle(entry: BackgroundChat): void {
  if (entry.settleTimer !== null) window.clearTimeout(entry.settleTimer);
  entry.settleTimer = null;
}

/** A note's name as Obsidian shows it: its file name without the extension. */
function noteName(path: string): string {
  return baseName(path).replace(/\.[^.]*$/, '');
}

/** Drafts of chats that have no id yet live in the panel, not in the plugin's data. */
function isLocalDraft(key: string): boolean {
  return key === '' || key === 'scratch';
}

/** A note's name on its chip, with the lines selected in it. */
function contextLabel(note: NoteContext): string {
  const name = note.file.basename;
  if (!note.selection.trim()) return name;
  if (!note.fromLine) return `${name} · selection`;
  return `${name} · ${note.fromLine === note.toLine ? `line ${note.fromLine}` : `lines ${note.fromLine}–${note.toLine}`}`;
}

/** What goes with a message for the attached note, for its chip's tooltip: its path, and the text selected in it. */
function contextWhat(note: NoteContext): string {
  const path = "the note's path (Claude reads the note if it needs to)";
  const firstLine = note.selection.trim().split('\n')[0];
  if (!firstLine) return path;
  const preview = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  return `${path} and the selected text, ${formatTokens(estimateTokens(note.selection.length))} (“${preview}”)`;
}

/** A note, file or folder a message @-mentions (see ChatView.mentionedItems). */
interface Mention {
  item: TFile | TFolder;
  /** A note goes with its text unless sent as a path only; anything else goes as a path. */
  note: boolean;
}

const APPEND_SYSTEM_PROMPT =
  'The user is chatting with you from a sidebar panel inside Obsidian; the working directory is their vault. ' +
  'Replies render as Obsidian Markdown: [[wikilinks]] to notes are clickable, and callouts and $…$ / $$…$$ math render.';
/** Added for a side chat (see SideChat); `seen`: it has a copy of the chat it was opened beside. */
function sideChatPrompt(seen: boolean): string {
  const where = seen
    ? 'a question asked beside the conversation, in a small pane, which does not change it. What you have of that conversation is a copy, made when the side chat started, running in a process of its own: anything still running in the original (subagents, background tasks, a reply in progress) goes on there, out of your sight, and its results come there, not here. Do not take work you cannot see as stopped or failed; say you cannot see it from here. Plan mode here is the side chat\'s own read-only setting, not the original conversation\'s mode.'
    : 'a question asked beside a conversation, in a small pane. You have not seen that conversation: work from what the user quotes or tells you.';
  return ` This is a side chat: ${where} Answer briefly and directly. You can read files but not change them. When you do not know why something happened, say so rather than guess.`;
}

interface ToolGroup {
  el: HTMLElement;
  header: HTMLElement;
  list: HTMLElement;
  entries: ToolEntry[];
}

/**
 * Where output is drawn: the element new turns go in, the turn being drawn, its open group of tool
 * calls, the reply text still streaming into it, and whether the turn has written text. The chat on
 * screen draws into `liveDraw`; earlier turns of a long chat are drawn into one of their own (see
 * drawSavedTurn), which leaves the chat on screen as it is.
 */
interface DrawState {
  parent: HTMLElement;
  turn: HTMLElement | null;
  group: ToolGroup | null;
  liveText: HTMLElement | null;
  turnHadText: boolean;
}

interface ToolEntry {
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  lineEl: HTMLElement | null;
  group: ToolGroup | null;
}

interface Approval {
  request: PermissionRequest;
  resolve: (result: PermissionResult) => void;
  /** For a plan: the note it is being edited in, kept with the request while its chat is in the background. */
  notePath?: string | null;
  /** Its card has been shown once: drawn again (its chat back from the background), it is not logged again. */
  shown?: boolean;
  /** For a plan: its text as shown, against which its note is found edited or not. */
  plan?: string;
  /** The chat it was asked in, whose plan note it keeps (see ChatView.withdrawPlanNote). */
  chatKey: string | null;
  /** What its withdrawal does where it is now: its card's, or its background chat's (see ChatView.onWithdrawn). */
  onAbort?: () => void;
}

/** `/plan`, offered among the slash commands: the panel handles it (see ChatView.send). */
const PLAN_COMMAND: SlashCommand = { name: 'plan', description: 'Switch this chat to Plan mode, and plan what follows', argumentHint: '<what to plan>' };

/** A finished reply's step (see ChatView.foldSteps): a run of tool calls or thinking, or an approval card. */
function isStep(el: HTMLElement): boolean {
  return el.hasClass('vc-tools') || el.hasClass('vc-permission');
}

/** The answer to a plan, questions or an approval still waiting when the panel closes (see ChatView.onClose). */
const PANEL_CLOSED_ANSWER = 'Not answered: the Claude panel was closed. Nothing was approved.';

/** How long a chat whose waiting requests were just answered has to take the answers before its process is ended (see ChatView.closeAfterAnswer). */
const ANSWER_WAIT_MS = 3000;
/** How long the notice after Remove or Move from here on offers Undo. */
const REMOVAL_UNDO_MS = 10_000;

/** A plan request without the plan's text: its file is read this many times, this far apart, until it is written (see showPlan). */
const PLAN_READ_ATTEMPTS = 40;
const PLAN_READ_PAUSE_MS = 250;

/** What a chat waiting on `request` is waiting for, after "Claude": an approval, or an answer to its questions. */
function waitingFor(request: PermissionRequest): string {
  return request.toolName === 'AskUserQuestion' ? 'has a question for you' : 'is waiting for your approval';
}

/** A chat that was still working when another one was opened; it keeps running off screen. */
interface BackgroundChat {
  session: ClaudeSession;
  chatId: string | null;
  title: string | null;
  busy: boolean;
  approvals: Approval[];
  /** Queued messages not yet taken up when the chat went to the background. */
  pendingIds: Set<string>;
  waitedForQueue: boolean;
  mode: PermissionMode;
  modelOverride: string | undefined;
  effortOverride: EffortLevel | undefined;
  /** The model and effort the chat runs, as last reported or set; shown again when it comes back. */
  currentModel: string | null;
  currentEffort: EffortLevel | null;
  fastMode: boolean;
  notice: Notice | null;
  /** Set while the chat is on the phone; such a chat is kept running when idle. */
  remoteUrl: string | null;
  /** Background tasks still running in its process; the chat is kept running until they finish. */
  tasks: Set<string>;
  /** Closes the chat if no turn follows its last background task (see settleBackground). */
  settleTimer: number | null;
  /** Its tool calls still running, so that an edit finishing off screen links the notes it changed. */
  toolCalls: Map<string, { name: string; input: Record<string, unknown> }>;
  /** The messages its turn in progress answers (see ChatView.turnPrompts), for when it is shown again. */
  turnPrompts: string[];
  /** The messages sent from the panel (see ChatView.sentIds), so that one is not drawn again as sent from elsewhere. */
  sentIds: Set<string>;
  /** The mode its approved plan returns to (see ChatView.modeBeforePlan). */
  modeBeforePlan: PermissionMode;
  /** Its messages still queued, by id, with their text and chips: not yet in its file, so drawn again from here. */
  queued: Map<string, { text: string; chips: Chip[] }>;
  /** A new chat sent to the background before its id came: what it chose (see ChatView.startOf), kept under its id at its init. */
  start: ChatStart | null;
}

/** What a new chat chose before it has an id: its project state, with the note it starts from, and the chats and notes its first message linked. */
interface ChatStart {
  state: ChatProjectState;
  chats: string[];
  notes: string[];
}

/** A background chat with nothing left to keep its process for: not working, no tasks, not on the phone, nothing waiting on you. */
function isIdle(entry: BackgroundChat): boolean {
  return !entry.busy && entry.tasks.size === 0 && !entry.remoteUrl && entry.approvals.length === 0;
}

/**
 * Shown at a reply's end whatever its place among the steps (CSS order), and so neither a step nor
 * in their way: the card of changed files, created where the first file changed, the reply's
 * buttons, and its status line.
 */
function isTrailer(el: HTMLElement): boolean {
  return el.hasClass('vc-changes') || el.hasClass('vc-turn-actions') || el.hasClass('vc-activity');
}

/** Short labels for the effort menu's button; the menu shows the full ones. */
const EFFORT_SHORT: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-high', max: 'Max' };
/** `Opus 5 · 1M` → `Opus 5`: the context size is in the menu and the meter. */
const shortModel = (label: string) => label.replace(/ · 1M$/, '');
/** While the chat is pinned to the bottom, the bar over it is brought up to date this often. */
const NAV_PINNED_MS = 250;
/** How often streamed text is written to the screen: ten times a second. */
const LIVE_FLUSH_MS = 100;
/** How often the working icon and the dot step: four times a second. */
const MOTION_MS = 250;
/** How long an idle background chat waits, after its last background task, for the turn that reads the result. */
const BACKGROUND_SETTLE_MS = 30_000;
/** The scratch chat's fixed title. */
const SCRATCH_TITLE = 'Scratch';
/** The uuid shape the SDK echoes back in a result's `user_message_uuids`. */
type MessageId = ReturnType<typeof crypto.randomUUID>;
/** Notes listed per group in the notes menu. */
const MAX_NOTES_LISTED = 20;

/** A note the chat touched: what a click opens, what the menu shows, and the vault file it is, if any. */
interface NoteLink {
  target: string;
  label: string;
  path?: string;
}

/** Why fast mode is on but not running, from the session's `fast_mode_state` and `fast_mode_disabled_reason`. */
function fastModeBlock(fast: { state?: string; reason?: string }): string {
  if (fast.state === 'cooldown') return 'paused after a rate limit, so replies use standard speed for now';
  const reasons: Record<string, string> = {
    free: 'not available on this plan',
    preference: "turned off by your organization's settings",
    extra_usage_disabled: 'extra usage is turned off for this account',
    network_error: 'its availability could not be checked (network error)',
    not_first_party: 'only available with the Anthropic API directly',
    disabled_by_env: 'turned off by an environment variable',
    model_not_allowed: "this model is not among your organization's allowed models",
    sdk_opt_in_required: 'not turned on for this session',
    pending: 'its availability is still being checked',
  };
  return reasons[fast.reason ?? ''] ?? 'unavailable right now';
}

/** What a chat tab's icon and tooltip show; `done` and `error` last until the tab has been seen. */
type TabState = 'idle' | 'working' | 'approval' | 'done' | 'error';
const TAB_ICONS: Record<TabState, string> = { idle: 'bot', working: 'loader', approval: 'hand', done: 'check', error: 'x' };
const TAB_LABELS: Record<TabState, string> = {
  idle: '',
  working: 'working',
  approval: 'waiting for approval',
  done: 'finished',
  error: 'stopped with an error',
};

export class ChatView extends ItemView {
  private session: ClaudeSession | null = null;
  private sessionToken: object | null = null;
  private resumeId: string | null = null;
  private chatId: string | null = null;
  private chatName: string | null = null;
  /** Set once the title shown is Claude Code's generated one rather than the first message. */
  private titleFromClaude = false;
  // Not `titleEl`: ItemView already has one (the view header's title), and redeclaring it
  // as a field replaces Obsidian's element with undefined, which leaves the panel blank.
  private chatTitleEl!: HTMLElement;
  private saveButton!: HTMLButtonElement;
  /** Owns the components of rendered Markdown; replaced on each new chat so they are unloaded. */
  private chatComponent!: Component;
  /** Set when a session from outside the panel is opened: resuming it forks a copy. */
  private forkOnResume = false;
  private mode: PermissionMode;
  /** The mode before Plan mode, which an approved plan returns to (see changeMode). */
  private modeBeforePlan: PermissionMode = 'default';
  /** The line above the input while in Plan mode, with a way out (see updatePlanCue). */
  private planEl!: HTMLElement;
  private modelOverride: string | undefined;
  /** Whether this panel is showing the scratch chat, which starts over when it has been idle. */
  private scratch = false;
  /** Deletes the chat on screen; in the scratch chat, clears it. */
  private deleteButton!: HTMLElement;
  private notesButton!: HTMLElement;
  /** How many notes the chat changed or mentioned, on the notes button; kept current by countNotesSoon. */
  private notesCount!: HTMLElement;
  private notesCountTimer: number | null = null;
  /** The chats this panel showed, to go back and forward through (see navigate); not saved. */
  private navBack: { id: string; title: string }[] = [];
  private navForward: { id: string; title: string }[] = [];
  /** Set while the arrows open a chat, which is then not remembered as a move of its own. */
  private navigating = false;
  private backButton!: HTMLElement;
  private forwardButton!: HTMLElement;
  /** Fast mode for this chat, and what the session last reported about it. */
  private fastMode = false;
  private fastState: { state?: string; reason?: string } | null = null;
  private fastButton!: HTMLElement;
  /** Each reply's card of changed files, by the element the reply is drawn in. */
  private changeCards = new WeakMap<HTMLElement, ChangesCard>();
  private currentModel: string | null = null;
  private effortOverride: EffortLevel | undefined;
  /** Effort the session reported it will send (after model-support downgrades). */
  private currentEffort: EffortLevel | null = null;
  private effortMenu!: MenuButton;
  private modelsRequested = false;
  /** Vault path of the note attached to the chat on screen, which goes with each message. */
  private attachedNote: string | null = null;

  private busy = false;
  private interrupted = false;
  private turnStartedAt = 0;
  private statusTimer: number | null = null;
  /** Steps the working indicators; a CSS animation would ask for a frame sixty times a second. */
  private motionTimer: number | null = null;
  /** A minute of the plan-usage countdown passed while the panel was hidden. */
  private planStale = false;
  private motionStep = 0;
  /** Approvals waiting on you in the chat on screen. */
  private get pendingApprovals(): number {
    return this.openApprovals.length;
  }
  private stickToBottom = true;

  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  /** Live activity row kept at the end of the running turn. */
  private activityEl: HTMLElement | null = null;
  private activityLabel: HTMLElement | null = null;
  private activityTime: HTMLElement | null = null;
  private phase = 'Working…';
  private stopButton!: HTMLButtonElement;
  private contextRow!: HTMLElement;
  /** The button that appears over text selected in the chat and quotes it in the next message. */
  private quoteButton!: HTMLButtonElement;
  /** Text in the chat is selected, on screen or scrolled out of it: scrolling moves the button, or brings it back. */
  private quoteTracking = false;
  /** What the chips above the input last showed, so an unchanged selection does not redraw them. */
  private contextKey = '';
  /** A chat not started yet: what it chose to send (see ChatProjectState), which goes to the plugin's record once it has an id. */
  private projectLocal: ChatProjectState = {};
  private noteChatsEl!: HTMLElement;
  private draftEl!: HTMLElement;
  /** The note this chat's message is being written in, while one is open. */
  private draftPath: string | null = null;
  /** Chats offered for the note in front: those that changed it, the chat a saved note came from, those it was sent with. */
  private noteChatList: NoteChatEntry[] = [];
  /** The line's last text, so an unchanged note does not rewrite it. */
  private noteChatsText: string | null = null;
  /** Notes sent before the chat had an id; they are linked to it once Claude Code gives it one. */
  private notesToLink: string[] = [];
  /** Chats linked from messages sent before the chat had an id (see linkSentChats). */
  private chatsToLink: string[] = [];
  /** Set once the panel starts closing: another closing panel must not hand it chats. */
  private closing = false;
  /** Drafts of chats with no id yet (a new chat, a new scratch chat): they exist only in this panel. */
  private localDrafts = new Map<string, ChatDraft>();
  /** Background tasks running in the chat on screen's process: switching away keeps it running for them. */
  private tasks = new Set<string>();
  /** Ids of the messages sent from this panel in the chat on screen, to tell its replies from other turns. */
  private sentIds = new Set<string>();
  /** The last turn drawn from a chat's saved messages while it is still running (see renderHistory). */
  private unfinishedTurn: HTMLElement | null = null;
  /** The messages the turn in progress answers, as sent here or named by its first reply frame; empty between turns, or when not known. */
  private turnPrompts: string[] = [];
  private draftSaveTimer: number | null = null;
  private modeMenu!: MenuButton;
  private phoneButton!: HTMLButtonElement;
  private modelMenu!: MenuButton;
  private meterEl!: HTMLElement;
  private contextText!: HTMLElement;
  private planText!: HTMLElement;
  private contextBar!: HTMLElement;
  private contextFill!: HTMLElement;
  private compactMark!: HTMLElement;
  /** Details of context and plan usage, shown while the pointer rests on the meter. */
  private usageCard!: HTMLElement;
  private lastContext: SDKControlGetContextUsageResponse | null = null;

  /** Where output is drawn (see DrawState): `liveDraw`, except while earlier turns are drawn. */
  private liveDraw!: DrawState;
  private draw!: DrawState;
  /** Streamed text not yet put on screen, the timer that will put it there, and when it last did. */
  private livePending = '';
  /** When the bar over the chat was last brought up to date while the chat was pinned to the bottom. */
  private navCheckedAt = 0;
  private liveTimer: number | null = null;
  private lastFlushAt = 0;
  /** Markdown source of each rendered reply text, for "Copy reply". */
  private readonly markdownSource = new WeakMap<HTMLElement, string>();
  /** Checkboxes flipped by the reader in each rendered reply text (positions), for Copy and Insert. */
  private readonly replyTicks = new WeakMap<HTMLElement, Set<number>>();
  private readonly tools = new Map<string, ToolEntry>();
  /** A subagent's calls in the running reply, until their results: its edits join the reply's changed files. */
  private readonly agentCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
  private lastMarkdownView: MarkdownView | null = null;
  /** Another kind of view (a canvas, a calendar) is in front in the main area, so no note is (see followFront). */
  private otherViewInFront = false;
  /** The last selection made in reading view, kept after the click into the panel clears the page's. */
  private readingSelection: { view: MarkdownView; file: TFile; text: string; fromLine: number; toLine: number } | null = null;
  private selectionTimer: number | null = null;
  /** Equations shown as selected (see markSelectedMath). */
  private selectedMath = new Set<HTMLElement>();
  private attachments: Attachment[] = [];
  private trayEl!: HTMLElement;
  /** Mentioned notes to send by their path only, not with their text, by path (see renderTray). */
  private readonly pathOnlyMentions = new Set<string>();
  /** What the tray's mention chips show, to redraw it only when that changes (see followMentions). */
  private mentionKey = '';
  /** A short message under the header (see flashHint), and when it goes. */
  private hintEl: HTMLElement | null = null;
  /** The memo saves under way, one after another (see saveMemo). */
  private memoSaves: Promise<unknown> = Promise.resolve();
  private hintTimer: number | null = null;
  /** A Memos table to bring to the chat on screen, once its title and id are both set (see setChatTitle). */
  private memosTimer: number | null = null;
  /** The memos the input mentions, whose Send boxes are ticked (see followMemoBoxes). */
  private mentionedMemos = new Set<string>();
  /** The input's text when its chat came on screen, and the undos since that redo may redo (see setUndoFloor). */
  private undoFloor = '';
  private undosSinceFloor = 0;
  /** Slash-command suggestions above the input. */
  private suggest!: CommandSuggest;
  /** The last message sent in this chat (or the last prompt of a reopened one), for ↑ in an empty input. */
  private lastSent: string | null = null;
  /** The chat on screen's turns not drawn yet, and their drawing (see renderHistory); null when all are drawn. */
  private earlier: EarlierDrawing | null = null;
  /** Counts the chats opened or started in this panel: an open still reading its file gives way when it changes. */
  private chatGeneration = 0;
  private findBar!: FindBar;
  /** "Memo" beside Quote and Side chat over a selection in the chat (see saveMemoFromSelection). */
  private memoButton!: HTMLButtonElement;
  /** A question asked beside the chat, in a pane over its messages (see SideChat). */
  private sideChat!: SideChat;
  /** Beside the Quote button over a selection: asks about the selection in the side chat. */
  private sideButton!: HTMLButtonElement;
  /** Side sessions started as a copy of their chat: resumed after a failure, they are told so again. */
  private readonly sideForks = new Set<string>();
  /** Kept side chats whose process is still ending, with what says it has ended (see keepSideChat). */
  private readonly keptEnding = new Map<string, () => void>();
  private promptNav!: PromptNav;
  /** Summary requests in progress, stopped if the panel closes. */
  private readonly summaryRuns = new Set<AbortController>();
  /**
   * Messages sent while Claude was working, by uuid. Claude Code either folds one into the
   * running turn or runs it as the next turn; the turn's result lists the uuids it consumed.
   */
  /** Messages sent while a reply runs, by the uuid the result echoes back. */
  /** Messages sent and not yet answered; `text`, a queued one's, by which it is known should Claude Code save it under an id of its own. */
  private readonly pending = new Map<string, { bubble: HTMLElement; running: boolean; id: MessageId; text?: string; chips?: Chip[] }>();
  /** Working chats moved off screen by opening another chat. */
  private readonly background = new Set<BackgroundChat>();
  /** Approval cards currently on screen, so they can move with their chat to the background. */
  private openApprovals: Approval[] = [];
  private historyButton!: HTMLButtonElement;
  /** claude.ai link while the chat on screen has Remote Control on. */
  private remoteUrl: string | null = null;
  /** Set once "Put every chat on the phone" has been applied to the current session. */
  private remoteRequested = false;
  /** A chat in this panel finished while the panel was hidden; shown on the tab until it is seen. */
  private unseen: 'done' | 'error' | null = null;
  private tabKey = '';

  constructor(leaf: WorkspaceLeaf, private readonly plugin: VaultClaudePlugin) {
    super(leaf);
    this.mode = plugin.settings.permissionMode;
    this.modelOverride = chatModel(plugin.settings.model);
    this.effortOverride = plugin.settings.effort || undefined;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    // Tells apart several Claude tabs (tab tooltips show this), and says what the tab's icon means.
    const base = this.chatName ? `Claude: ${this.chatName}` : 'Claude';
    const tasks = this.runningTasks();
    const labels = [TAB_LABELS[this.tabState()], tasks > 0 ? `${plural(tasks, 'task')} in the background` : ''].filter(Boolean);
    return labels.length > 0 ? `${base} (${labels.join(', ')})` : base;
  }

  /** Background tasks running in this panel: in the chat on screen and in its background chats. */
  private runningTasks(): number {
    // Guarded like tabState: Obsidian may ask for the title before the fields are initialised.
    const background = this.background ? [...this.background] : [];
    return (this.tasks?.size ?? 0) + background.reduce((sum, entry) => sum + entry.tasks.size, 0);
  }

  getIcon(): string {
    const state = this.tabState();
    return this.scratch && state === 'idle' ? 'eraser' : TAB_ICONS[state];
  }

  /** Waiting for approval, then working, in any of this panel's chats; else a finish not yet seen. */
  private tabState(): TabState {
    // Guarded: Obsidian may ask for the icon before the fields below are initialised.
    const background = this.background ? [...this.background] : [];
    if (this.pendingApprovals > 0 || background.some((entry) => entry.approvals.length > 0)) return 'approval';
    if (this.busy || background.some((entry) => entry.busy)) return 'working';
    return this.unseen ?? 'idle';
  }

  /**
   * Redraws the tab's icon and tooltip when its state or title changed. `updateHeader` and
   * `tabHeaderEl` are not in Obsidian's typings; without them the tab keeps the robot icon.
   */
  private updateTab(): void {
    const state = this.tabState();
    const tasks = this.runningTasks();
    const key = `${state}|${tasks}|${this.scratch}|${this.chatName ?? ''}`;
    if (key === this.tabKey) return;
    this.tabKey = key;
    const leaf = this.leaf as unknown as { updateHeader?: () => void; tabHeaderEl?: HTMLElement };
    leaf.updateHeader?.();
    for (const each of ['working', 'approval', 'done', 'error'] as const) leaf.tabHeaderEl?.toggleClass(`vc-tab-${each}`, state === each);
    // A dot on the icon, whatever its state: tasks outlive the reply that started them.
    leaf.tabHeaderEl?.toggleClass('vc-tab-tasks', tasks > 0);
  }

  /** Whether the panel is visible: its tab selected and its sidebar open. */
  private isOnScreen(): boolean {
    return this.containerEl.isShown();
  }

  /** Clears a finished-but-unseen tab, and the chat's mark in the history, once the panel is visible. */
  private markSeen(): void {
    this.seeChat();
    if (this.planStale && this.isOnScreen() && this.plugin.planUsage) {
      this.planStale = false;
      this.renderPlanUsage(this.plugin.planUsage);
    }
    if (this.isOnScreen() && this.busy) {
      this.flushLive();
      this.tickStatus();
      this.scrollToBottom();
    }
    if (!this.unseen || !this.isOnScreen()) return;
    this.unseen = null;
    this.updateTab();
  }

  /** The chat on screen is seen, if the panel is visible: the history drops its New reply mark. */
  private seeChat(): void {
    const id = this.chatId ?? this.resumeId;
    if (id && this.isOnScreen()) this.plugin.markChatSeen(id);
  }

  async onOpen(): Promise<void> {
    try {
      this.buildPanel();
    } catch (error) {
      log('building the panel failed', error);
      this.contentEl.empty();
      this.contentEl.createDiv({
        cls: 'vc-notice vc-notice-error',
        text: `The Claude panel failed to open: ${errorText(error)}. Details are in ${LOG_PATH}.`,
      });
    }
  }

  private buildPanel(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('vc-root');
    this.applyPanelMargin();
    this.chatComponent = this.addChild(new Component());

    // Top row: the chat title with its save and notes buttons, then phone, history and new chat.
    const header = root.createDiv({ cls: 'vc-header' });
    // Back and forward through the chats shown in this panel, as Obsidian's arrows go through notes.
    const nav = header.createDiv({ cls: 'vc-nav' });
    this.backButton = nav.createEl('button', { cls: 'clickable-icon' });
    setIcon(this.backButton, 'arrow-left');
    this.registerDomEvent(this.backButton, 'click', () => void this.navigate('back'));
    this.forwardButton = nav.createEl('button', { cls: 'clickable-icon' });
    setIcon(this.forwardButton, 'arrow-right');
    this.registerDomEvent(this.forwardButton, 'click', () => void this.navigate('forward'));
    this.chatTitleEl = header.createDiv({ cls: 'vc-chat-title' });
    this.registerDomEvent(this.chatTitleEl, 'click', () => this.renameCurrentChat());
    const titleActions = header.createDiv({ cls: 'vc-chat-title-actions' });
    this.saveButton = titleActions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Save as note' } });
    setIcon(this.saveButton, 'file-down');
    this.registerDomEvent(this.saveButton, 'click', (evt) => {
      const menu = new Menu();
      menu.addItem((item) => item.setTitle('Save chat as note').setIcon('file-down').onClick(() => void this.saveChatAsNote()));
      menu.addItem((item) => item.setTitle('Save summary as note').setIcon('file-text').onClick(() => void this.saveSummaryAsNote()));
      menu.showAtMouseEvent(evt);
    });
    const mapButton = titleActions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Connections: its notes, its project and the chats that share them' } });
    setIcon(mapButton, 'waypoints');
    this.registerDomEvent(mapButton, 'click', () => this.openConnections());
    const sideChatButton = titleActions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Side chat: ask about this chat without changing it' } });
    setIcon(sideChatButton, 'messages-square');
    // Minimised, it opens again; open, it closes.
    this.registerDomEvent(sideChatButton, 'click', () => (this.sideChat.isMinimised() ? this.sideChat.restore() : this.sideChat.isOpen() ? this.sideChat.close() : this.openSideChat()));
    this.deleteButton = titleActions.createEl('button', { cls: 'clickable-icon vc-delete-chat' });
    setIcon(this.deleteButton, 'trash-2');
    this.deleteButton.hide();
    this.registerDomEvent(this.deleteButton, 'click', () => (this.scratch ? void this.plugin.clearScratchChat() : this.deleteCurrentChat()));
    this.phoneButton = header.createEl('button', { cls: 'clickable-icon vc-phone' });
    setIcon(this.phoneButton, 'smartphone');
    this.registerDomEvent(this.phoneButton, 'click', (evt) => this.onPhoneClick(evt));
    this.updatePhoneButton();
    const chatHint = MOD_CLICK;
    const memosButton = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': `All memos, in a table (${chatHint}: this chat's)` } });
    setIcon(memosButton, 'sticky-note');
    this.registerDomEvent(memosButton, 'click', (evt) => {
      const chatId = this.chatId ?? this.resumeId ?? '';
      // All memos; this chat's with the modifier, for a chat that has started.
      const forChat = Keymap.isModEvent(evt) !== false;
      void this.plugin.openChatMemos(chatId, this.chatName ?? 'New chat', !forChat || !chatId);
      const said = !chatId
        ? forChat
          ? 'This chat has no memos yet: all memos are shown.'
          : 'All memos.'
        : forChat
          ? "This chat's memos. Click the memo button for all of them."
          : `All memos. ${chatHint} the memo button for this chat's.`;
      this.flashHint(said);
    });
    this.historyButton = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Chat history' } });
    setIcon(this.historyButton, 'history');
    this.registerDomEvent(this.historyButton, 'click', () => void this.openHistory());
    const newTabHint = MOD_CLICK;
    const newButton = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': `New chat (${newTabHint}: in a new tab; right-click for more)` } });
    setIcon(newButton, 'square-pen');
    this.registerDomEvent(newButton, 'contextmenu', (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => item.setTitle('New chat in a new tab').setIcon('square-pen').onClick(() => void this.plugin.openChatTab(this.leaf).then((view) => view?.focusInput())));
      menu.addItem((item) => item.setTitle('Pick up where you left off').setIcon('history').onClick(() => void this.plugin.openPickUp()));
      if (this.plugin.settings.scratchChat) {
        menu.addItem((item) => item.setTitle('Open scratch chat').setIcon('eraser').onClick(() => void this.openScratch()));
        menu.addItem((item) => item.setTitle('Clear scratch chat').setIcon('trash-2').onClick(() => void this.plugin.clearScratchChat()));
        menu.addItem((item) => {
          item.setTitle('Scratch chat starts over after').setIcon('timer');
          const choices = (item as unknown as { setSubmenu(): Menu }).setSubmenu();
          for (const hours of SCRATCH_IDLE_CHOICES) {
            choices.addItem((choice) =>
              choice
                .setTitle(idleLabel(hours))
                .setChecked(hours === this.plugin.settings.scratchIdleHours)
                .onClick(() => void this.plugin.setScratchIdle(hours)),
            );
          }
        });
      }
      menu.showAtMouseEvent(evt);
    });
    this.registerDomEvent(newButton, 'click', (evt) => {
      if (Keymap.isModEvent(evt)) void this.plugin.openChatTab(this.leaf).then((view) => view?.focusInput());
      else this.startNewChat();
    });
    this.setChatTitle(null);

    this.meterEl = root.createDiv({ cls: 'vc-meter' });
    const meterRow = this.meterEl.createDiv({ cls: 'vc-meter-row' });
    // Context: the share used with a short bar beside it; plan usage at the right.
    const contextGroup = meterRow.createDiv({ cls: 'vc-meter-context-group' });
    this.contextText = contextGroup.createDiv({ cls: 'vc-meter-context' });
    this.contextBar = contextGroup.createDiv({ cls: 'vc-meter-bar' });
    this.planText = meterRow.createDiv({ cls: 'vc-meter-plan' });
    this.contextFill = this.contextBar.createDiv({ cls: 'vc-meter-fill' });
    this.compactMark = this.contextBar.createDiv({ cls: 'vc-meter-compact' });
    this.usageCard = this.meterEl.createDiv({ cls: 'vc-usage-card' });
    this.usageCard.hide();
    let hoverTimer: number | null = null;
    this.register(() => {
      if (hoverTimer !== null) window.clearTimeout(hoverTimer);
    });
    this.registerDomEvent(this.meterEl, 'mouseenter', () => {
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        this.refreshUsageCard();
        this.usageCard.show();
      }, 300);
    });
    // The card sits inside the meter, so moving onto it does not count as leaving.
    this.registerDomEvent(this.meterEl, 'mouseleave', () => {
      if (hoverTimer !== null) window.clearTimeout(hoverTimer);
      hoverTimer = null;
      this.usageCard.hide();
    });
    this.resetContextMeter();
    if (this.plugin.planUsage) this.renderPlanUsage(this.plugin.planUsage);
    void this.plugin.loadConfigured().then(() => this.populateModelSelect());
    void this.plugin.refreshStatus().then(() => {
      this.populateModelSelect();
      if (this.plugin.planUsage) this.renderPlanUsage(this.plugin.planUsage);
    });
    // The per-turn activity timer, if one is running when the panel closes.
    this.register(() => this.stopStatusTimer());
    this.register(() => {
      if (this.notesCountTimer !== null) window.clearTimeout(this.notesCountTimer);
    });
    // The time left until each window resets counts down between readings.
    this.registerInterval(
      window.setInterval(() => {
        if (!this.plugin.planUsage) return;
        if (this.isOnScreen()) this.renderPlanUsage(this.plugin.planUsage);
        else this.planStale = true;
      }, 60_000),
    );

    const messagesWrap = root.createDiv({ cls: 'vc-messages-wrap' });
    this.messagesEl = messagesWrap.createDiv({ cls: 'vc-messages' });
    // What is drawn in the panel after a reply is rendered (an embed, another plugin's post-processor),
    // and the side chat's, is swept as it comes in (see sweepRemoteMedia): replies are swept before
    // they go in (see renderMarkdown), this catches the rest.
    const sweeper = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target instanceof Element) sweepRemoteMedia(record.target, true);
          continue;
        }
        for (const node of Array.from(record.addedNodes)) if (node instanceof Element && node.isConnected) sweepRemoteMedia(node);
      }
    });
    sweeper.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'data', 'style', 'href', 'xlink:href', 'background', 'poster'] });
    this.register(() => sweeper.disconnect());
    this.draw = this.liveDraw = { parent: this.messagesEl, turn: null, group: null, liveText: null, turnHadText: false };
    this.promptNav = new PromptNav(messagesWrap, this.messagesEl, () => this.earlier?.listed() ?? []);
    this.quoteButton = messagesWrap.createEl('button', { cls: 'vc-quote-button', text: 'Quote', attr: { 'aria-label': 'Quote the selected text in your next message' } });
    this.quoteButton.hide();
    // Pressing it must not clear the selection it is about to quote.
    this.registerDomEvent(this.quoteButton, 'mousedown', (evt) => evt.preventDefault());
    this.registerDomEvent(this.quoteButton, 'click', () => {
      this.quoteSelection();
      this.hideSelectionButtons();
    });
    this.sideButton = messagesWrap.createEl('button', { cls: 'vc-quote-button vc-side-button', text: 'Side chat', attr: { 'aria-label': 'Ask about the selected text in a side chat' } });
    this.sideButton.hide();
    this.registerDomEvent(this.sideButton, 'mousedown', (evt) => evt.preventDefault());
    this.registerDomEvent(this.sideButton, 'click', () => this.openSideChat());
    this.memoButton = messagesWrap.createEl('button', {
      cls: 'vc-quote-button vc-side-button vc-memo-button',
      text: 'Memo',
      attr: { 'aria-label': `Save the selected passages as a memo (${ALT_CLICK}: at once, as a bookmark)` },
    });
    this.memoButton.hide();
    this.registerDomEvent(this.memoButton, 'mousedown', (evt) => evt.preventDefault());
    this.registerDomEvent(this.memoButton, 'click', (evt) => this.saveMemoFromSelection(evt.altKey));
    this.sideChat = new SideChat(messagesWrap, {
      startSession: (handlers, id, own) => this.startSideSession(handlers, id, own),
      renderMarkdown: (markdown, el, component) => void this.renderMarkdown(markdown, el, component),
      deleteSession: (id) => this.deleteSideSession(id),
      keep: (id, unsent) => this.keepSideChat(id, unsent),
      openKept: (id) => void this.openKeptSideChat(id),
      sendWithModifier: () => this.plugin.settings.sendWithModifier,
    });
    // Links in its replies open and preview as in the chat's.
    this.registerDomEvent(this.sideChat.el, 'click', (evt) => this.onMessagesClick(evt));
    this.registerDomEvent(this.sideChat.el, 'mouseover', (evt) => this.onMessagesHover(evt));
    this.register(() => this.promptNav.destroy());
    this.findBar = new FindBar(root, messagesWrap, this.messagesEl, {
      count: (needle) => this.earlier?.count(needle) ?? 0,
      drawTo: async (needle) => (await this.earlier?.drawTo(needle)) ?? false,
    });
    // ⌘F / Ctrl+F while the panel has focus.
    this.scope = new Scope(this.app.scope);
    this.scope.register(['Mod'], 'f', () => {
      this.openFind();
      return false;
    });
    // ⌥↑ / ⌥↓ (Alt on Windows) go to the previous or next message you sent. In a message being
    // written they are left to the input, which moves the cursor by paragraph.
    const stepKey = (delta: -1 | 1) => (evt: KeyboardEvent) => {
      if (evt.target === this.inputEl && this.inputEl.value) return true;
      this.stepMessage(delta);
      return false;
    };
    this.scope.register(['Alt'], 'ArrowUp', stepKey(-1));
    this.scope.register(['Alt'], 'ArrowDown', stepKey(1));
    // A right-click on selected text offers to quote it in the next message.
    this.registerDomEvent(this.messagesEl, 'contextmenu', (evt) => {
      const selected = this.selectedInChat();
      if (!selected) return;
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => item.setTitle('Quote in your next message').setIcon('text-quote').onClick(() => this.quoteText(selected)));
      menu.addItem((item) => item.setTitle('Ask in a side chat').setIcon('messages-square').onClick(() => this.openSideChat(selected)));
      menu.addItem((item) => item.setTitle('Copy').setIcon('copy').onClick(() => void navigator.clipboard.writeText(selected)));
      menu.showAtMouseEvent(evt);
    });
    this.registerDomEvent(this.messagesEl, 'mouseover', (evt) => this.onMessagesHover(evt));
    this.registerDomEvent(this.messagesEl, 'click', (evt) => {
      this.onMessagesClick(evt);
      // Folding and unfolding moves the messages.
      this.promptNav.schedule();
    });
    this.registerDomEvent(this.messagesEl, 'scroll', () => {
      if (this.quoteTracking) this.placeQuoteButton();
      this.checkEarlier();
      const el = this.messagesEl;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      // Pinned at the bottom as a reply streams in, the chat scrolls under the bar, and which of
      // your messages it names changes when one passes the top. That is slow next to the scrolling,
      // which comes every frame, so the bar is brought up to date four times a second.
      if (atBottom && this.stickToBottom) {
        const now = Date.now();
        if (now - this.navCheckedAt < NAV_PINNED_MS) return;
        this.navCheckedAt = now;
      }
      this.stickToBottom = atBottom;
      this.promptNav.schedule();
    });
    this.renderWelcome();

    const footer = root.createDiv({ cls: 'vc-footer' });
    this.noteChatsEl = footer.createDiv({ cls: 'vc-note-chats vc-note-chats-offer' });
    this.noteChatsEl.hide();
    this.registerDomEvent(this.noteChatsEl, 'click', (evt) => this.openNoteChats(evt));
    this.contextRow = footer.createDiv({ cls: 'vc-context-row' });
    this.registerDomEvent(this.contextRow, 'click', (evt) => this.onContextClick(evt));
    this.draftEl = footer.createDiv({ cls: 'vc-note-chats vc-draft-line' });
    this.draftEl.hide();
    this.planEl = footer.createDiv({ cls: 'vc-plan-line' });
    this.planEl.hide();
    this.registerDomEvent(this.draftEl, 'click', (evt) => {
      if ((evt.target as HTMLElement).closest('.vc-draft-close')) void this.discardDraft();
      else void this.sendDraft();
    });
    this.trayEl = footer.createDiv({ cls: 'vc-tray' });
    this.trayEl.hide();
    this.inputEl = footer.createEl('textarea', {
      cls: 'vc-input',
      attr: { rows: '3', placeholder: this.placeholderText() },
    });
    // The panel's own `/plan` (see send) beside Claude Code's commands, which leave it out.
    this.suggest = new CommandSuggest(footer, this.inputEl, () =>
      this.plugin.commands.some((command) => command.name === 'plan') ? this.plugin.commands : [...this.plugin.commands, PLAN_COMMAND],
    );
    this.registerDomEvent(this.inputEl, 'keydown', (evt) => this.onInputKeydown(evt));
    this.registerDomEvent(this.inputEl, 'input', () => this.inputEdited());
    // Undo in the input stays within the chat on screen. The window keeps one undo history, and the
    // input's text is swapped from code when the chat changes, which that history does not record:
    // undoing past the swap would bring back, or mangle, what was typed in another chat. So undo
    // stops at the text the chat came back with, and redo only redoes what was undone since.
    this.registerDomEvent(this.inputEl, 'beforeinput', (evt: InputEvent) => {
      if (evt.inputType === 'historyUndo') {
        if (this.inputEl.value === this.undoFloor) evt.preventDefault();
        else this.undosSinceFloor += 1;
      } else if (evt.inputType === 'historyRedo') {
        if (this.undosSinceFloor === 0) evt.preventDefault();
        else this.undosSinceFloor -= 1;
      } else {
        this.undosSinceFloor = 0;
      }
    });
    this.registerDomEvent(this.inputEl, 'blur', () => this.suggest.hide());
    this.registerDomEvent(this.inputEl, 'paste', (evt) => {
      const files = pastedFiles(evt.clipboardData);
      if (files.length === 0) return;
      evt.preventDefault();
      void this.attachExternalFiles(files);
    });
    const actions = footer.createDiv({ cls: 'vc-actions' });
    // Attach, then the model, effort and permission mode for the next message. In a narrow panel
    // they wrap onto a second line, leaving Send in place.
    const tools = actions.createDiv({ cls: 'vc-actions-tools' });
    const attachButton = tools.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Attach files' } });
    setIcon(attachButton, 'paperclip');
    const picker = tools.createEl('input', { attr: { type: 'file', multiple: '' } });
    picker.hide();
    this.registerDomEvent(attachButton, 'click', () => picker.click());
    // The notes this chat changed or mentioned, beside the paperclip, with how many there are.
    this.notesButton = tools.createEl('button', { cls: 'clickable-icon vc-notes-button', attr: { 'aria-label': 'Notes in this chat' } });
    setIcon(this.notesButton.createSpan({ cls: 'vc-notes-icon' }), 'file-text');
    this.notesCount = this.notesButton.createSpan({ cls: 'vc-notes-count' });
    this.registerDomEvent(this.notesButton, 'click', (evt) => this.openNotesMenu(evt));
    this.registerDomEvent(picker, 'change', () => {
      const files = Array.from(picker.files ?? []);
      picker.value = '';
      void this.attachExternalFiles(files);
    });
    this.modelMenu = new MenuButton(tools, 'Model', (value) => void this.changeModel(value));
    this.effortMenu = new MenuButton(tools, 'Effort', (value) => void this.changeEffort(value));
    this.modeMenu = new MenuButton(tools, 'Permission mode', (value) => void this.changeMode(value as PermissionMode));
    this.fastButton = tools.createEl('button', { cls: 'clickable-icon vc-fast' });
    setIcon(this.fastButton, 'zap');
    this.registerDomEvent(this.fastButton, 'click', () => void this.toggleFastMode());
    this.populateModeSelect();
    this.populateModelSelect();

    // Files dropped anywhere on the panel: from Finder, or from Obsidian's file explorer.
    // Over an open side chat, the drop is the side chat's, and it is the one outlined.
    const outline = (side: boolean | null) => {
      root.toggleClass('is-drop-target', side === false);
      this.sideChat.el.toggleClass('is-drop-target', side === true);
    };
    this.registerDomEvent(root, 'dragover', (evt) => {
      if (!this.isFileDrag(evt)) return;
      evt.preventDefault();
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'copy';
      outline(this.overSideChat(evt));
    });
    this.registerDomEvent(root, 'dragleave', (evt) => {
      if (!root.contains(evt.relatedTarget as Node | null)) outline(null);
    });
    this.registerDomEvent(root, 'drop', (evt) => {
      outline(null);
      if (!this.isFileDrag(evt)) return;
      evt.preventDefault();
      evt.stopPropagation();
      void this.onDrop(evt);
    });

    // Esc anywhere in the panel stops Claude; an Esc already used (closing the command list) does not.
    this.registerDomEvent(root, 'keydown', (evt) => {
      // Esc ends a reply only; background tasks are stopped with the button, on purpose.
      if (evt.key !== 'Escape' || evt.defaultPrevented || !this.busy) return;
      evt.preventDefault();
      this.interruptTurn();
    });

    this.stopButton = actions.createEl('button', { text: 'Stop' });
    this.stopButton.hide();
    this.registerDomEvent(this.stopButton, 'click', () => this.stop());
    const draftButton = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Write this message in a note' } });
    setIcon(draftButton, 'square-pen');
    this.registerDomEvent(draftButton, 'click', () => void this.editDraft());
    const sendButton = actions.createEl('button', { text: 'Send', cls: 'mod-cta' });
    this.registerDomEvent(sendButton, 'click', () => void this.send());

    // The main area's tab in front when the panel opens.
    this.followFront(this.app.workspace.getMostRecentLeaf());
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        this.followFront(leaf);
        this.updateContextChip();
        this.markSeen();
      }),
    );
    // A tab can change what it shows in place (a note opened from a canvas in its own tab), which
    // changes no leaf: what is in front is looked at again.
    this.registerEvent(this.app.workspace.on('file-open', () => this.followActiveLeaf()));
    // Selections in the editor and in reading view, and in the chat; redrawn shortly after the
    // selection settles. In every window: the panel's own (a popout, say) and the notes' may differ.
    const onSelection = () => {
      this.markSelectedMath();
      if (this.selectionTimer !== null) window.clearTimeout(this.selectionTimer);
      this.selectionTimer = window.setTimeout(() => {
        this.selectionTimer = null;
        this.onSelectionChange();
        this.placeQuoteButton();
      }, 150);
    };
    const selectionDocs = new Set<Document>();
    const listen = (doc: Document) => {
      if (selectionDocs.has(doc)) return;
      selectionDocs.add(doc);
      doc.addEventListener('selectionchange', onSelection);
    };
    listen(document);
    listen(this.contentEl.ownerDocument);
    this.registerEvent(this.app.workspace.on('window-open', (_, win) => listen(win.document)));
    this.registerEvent(
      this.app.workspace.on('window-close', (_, win) => {
        win.document.removeEventListener('selectionchange', onSelection);
        selectionDocs.delete(win.document);
      }),
    );
    const stopMigrating = this.contentEl.onWindowMigrated?.((win) => listen(win.document));
    this.register(() => {
      stopMigrating?.();
      for (const doc of selectionDocs) doc.removeEventListener('selectionchange', onSelection);
    });
    this.updateContextChip();

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.updateStatusBarClearance();
        this.markSeen();
      }),
    );
    this.registerDomEvent(root, 'pointerdown', () => this.markSeen());
    this.registerEvent(this.app.workspace.on('css-change', () => this.updateStatusBarClearance()));
    this.app.workspace.onLayoutReady(() => window.requestAnimationFrame(() => this.updateStatusBarClearance()));
  }

  onResize(): void {
    this.updateStatusBarClearance();
    this.markSeen();
  }

  applyPanelMargin(): void {
    this.contentEl.style.setProperty('--vc-side-margin', `${this.plugin.settings.panelMargin}px`);
  }

  async onClose(): Promise<void> {
    this.closing = true;
    this.plugin.panelClosing(this);
    closeImage();
    this.sideChat.close();
    this.saveDraft();
    // Another panel takes the running chats over; with none, they stop and the notice says so.
    const heir = this.plugin.otherChatView(this);
    if (heir) this.handOver(heir);
    else this.reportStopped();
    // What still waits on you in the chat on screen (none when it moved to another panel) is answered
    // before its process ends: its record then says the panel was closed, rather than that the request
    // was cut off, which Claude reads as an error when the chat is opened again.
    const refused = this.refuseOpenApprovals(PANEL_CLOSED_ANSWER);
    // Nothing left scheduled to run against a closed panel, nor holding on to its page: Find's
    // highlights are the app's, and keep the matches' elements until cleared.
    this.findBar.close();
    this.earlier?.stop();
    this.dropLive();
    if (this.selectionTimer !== null) window.clearTimeout(this.selectionTimer);
    this.selectionTimer = null;
    if (this.memosTimer !== null) window.clearTimeout(this.memosTimer);
    this.memosTimer = null;
    if (this.hintTimer !== null) window.clearTimeout(this.hintTimer);
    this.hintTimer = null;
    for (const run of this.summaryRuns) run.abort();
    this.sessionToken = null;
    if (refused && this.session) this.closeAfterAnswer(this.session, PANEL_CLOSED_ANSWER);
    else this.closeSession(this.session);
    this.session = null;
    for (const entry of [...this.background]) this.dropBackground(entry, true);
    this.stopStatusTimer();
  }

  /**
   * The chats this panel keeps running — the one on screen while it works, those in its background,
   * and their background tasks — move to another panel rather than stopping with this one. Idle
   * chats are not moved: they hold nothing that is running, and resume from their saved session.
   */
  private handOver(heir: ChatView): void {
    this.detachToBackground();
    const moving = [...this.background];
    this.background.clear();
    for (const entry of moving) heir.adoptBackground(entry);
    this.updateBackgroundIndicator();
    if (moving.length === 0) return;
    const tasks = moving.reduce((sum, entry) => sum + entry.tasks.size, 0);
    new Notice(`${chatsAndTasks(moving.length, tasks)} moved to another Claude panel, still running.`);
  }

  /** Whether this panel is closing, so it can take over nothing. */
  isClosing(): boolean {
    return this.closing;
  }

  /**
   * Takes over a chat from a panel that is closing; it keeps running here. A timer the old panel
   * set to close it once idle is its no longer, so an idle chat is given one of this panel's.
   */
  adoptBackground(entry: BackgroundChat): void {
    clearSettle(entry);
    if (this.closing) {
      // Several panels closing at once: nowhere left to run.
      this.closeSession(entry.session);
      return;
    }
    this.background.add(entry);
    entry.session.setHandlers(this.backgroundHandlers(entry));
    if (isIdle(entry)) this.settleBackground(entry);
    this.updateBackgroundIndicator();
  }

  /**
   * Closing the last panel ends the Claude processes it holds — the chat on screen, the chats
   * running in its background, and their background tasks. Said plainly, since nothing asks first:
   * Obsidian tells a view it has been closed, not that it is about to be.
   */
  private reportStopped(): void {
    const background = [...this.background];
    const chats = background.length + (this.busy || this.tasks.size > 0 ? 1 : 0);
    if (chats === 0) return;
    const tasks = this.tasks.size + background.reduce((sum, entry) => sum + entry.tasks.size, 0);
    new Notice(`Closing the panel stopped ${chatsAndTasks(chats, tasks)}. The conversations are saved: reopen one from the history to carry on.`);
  }

  newChat(): void {
    this.leaveDraft();
    // A chat that is still working keeps running in the background instead of being stopped.
    this.detachToBackground();
    this.unseen = null;
    this.lastSent = null;
    this.findBar.close();
    this.sessionToken = null;
    this.closeSession(this.session);
    this.session = null;
    this.remoteUrl = null;
    this.remoteRequested = false;
    this.updatePhoneButton();
    this.openApprovals = [];
    this.resumeId = null;
    this.chatId = null;
    this.notesToLink = [];
    this.chatsToLink = [];
    this.tasks = new Set();
    this.updateStopButton();
    this.sentIds = new Set();
    this.scratch = false;
    this.setChatTitle(null);
    this.titleFromClaude = false;
    this.forkOnResume = false;
    this.currentModel = null;
    this.modelOverride = chatModel(this.plugin.settings.model);
    this.currentEffort = null;
    this.effortOverride = this.plugin.settings.effort || undefined;
    this.fastMode = false;
    this.fastState = null;
    // Plan mode belongs to the chat it was entered in: a new chat starts in the mode before it, unless
    // new chats start in Plan mode by the settings. Other modes stay with the panel, as before.
    if (this.mode === 'plan' && this.plugin.settings.permissionMode !== 'plan') {
      this.mode = this.modeBeforePlan === 'plan' ? this.plugin.settings.permissionMode : this.modeBeforePlan;
      this.showMode();
    }
    // What a plan approved in this chat returns to: this chat's own mode, not another chat's.
    this.modeBeforePlan = this.mode === 'plan' ? 'default' : this.mode;
    this.draftPath = null;
    this.updateDraftLine();
    this.populateModelSelect();
    this.resetContextMeter();
    this.finishTurnUi();
    this.pending.clear();
    this.tools.clear();
    this.agentCalls.clear();
    this.draw.turn = null;
    this.draw.group = null;
    this.earlier?.stop();
    this.earlier = null;
    this.chatGeneration += 1;
    this.removeChild(this.chatComponent);
    this.chatComponent = this.addChild(new Component());
    this.messagesEl.empty();
    this.hideSelectionButtons();
    this.sideChat?.close();
    this.promptNav.schedule();
    this.renderWelcome();
    this.attachments = [];
    this.renderTray();
    this.restoreDraft();
    this.inputEl.focus();
  }

  /** Which chat the draft belongs to: its id, or the scratch chat or a new chat before it has one. */
  private draftKey(): string {
    return this.chatId ?? this.resumeId ?? (this.scratch ? 'scratch' : '');
  }

  /** A chat's draft: kept with the chat once it has an id, and in this panel before that. */
  private readDraft(key: string): ChatDraft | undefined {
    return isLocalDraft(key) ? this.localDrafts.get(key) : this.plugin.chatDraft(key);
  }

  private writeDraft(key: string, draft: ChatDraft): void {
    if (!isLocalDraft(key)) {
      this.plugin.setChatDraft(key, draft);
      return;
    }
    if (draft.text?.trim() || draft.note) this.localDrafts.set(key, draft);
    else this.localDrafts.delete(key);
  }

  /** Stores what the chat on screen holds: the text typed and not sent, and its attached note. */
  private saveDraft(): void {
    if (this.draftSaveTimer !== null) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = null;
    this.writeDraft(this.draftKey(), { text: this.inputEl.value, note: this.attachedNote ?? undefined });
  }

  /** Typing is saved a second after it stops, so a restart finds it; a switch saves at once. */
  private scheduleDraftSave(): void {
    if (this.draftSaveTimer !== null) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => this.saveDraft(), 1000);
  }

  /** Keeps the chat being left as it is, and clears the input for the next one. */
  private leaveDraft(): void {
    this.saveDraft();
    this.inputEl.value = '';
    this.setUndoFloor();
    this.growInput();
  }

  /** Puts back the unsent text and attached note of the chat on screen; a new chat starts as the setting says. */
  private restoreDraft(): void {
    const key = this.draftKey();
    const draft = this.readDraft(key);
    this.inputEl.value = draft?.text ?? '';
    this.setUndoFloor();
    this.growInput();
    const fresh = draft === undefined && isLocalDraft(key);
    this.attachedNote = draft?.note ?? (fresh && this.plugin.settings.attachActiveNote ? (this.activeNote()?.file.path ?? null) : null);
    this.projectLocal = {};
    this.updateContextChip();
  }

  /** The chat has a new id (its first message, or a fork): its draft moves to it. */
  private moveDraft(from: string): void {
    if (from === this.draftKey()) return;
    this.writeDraft(from, {});
    this.saveDraft();
  }

  // ---- Phone access ------------------------------------------------------

  updatePhoneButton(): void {
    const { state, activeSessions, error } = this.plugin.remote.status;
    const chatOn = this.remoteUrl !== null;
    const button = this.phoneButton;
    button.toggleClass('is-on', chatOn || state === 'connected');
    button.toggleClass('is-starting', !chatOn && state === 'starting');
    button.toggleClass('is-error', !chatOn && state === 'error');
    const parts: string[] = [];
    if (chatOn) parts.push('This chat is on your phone');
    if (state === 'connected') {
      parts.push(`The phone can start sessions in this vault as "${this.plugin.phoneAccessName()}"${activeSessions ? ` (${activeSessions} active)` : ''}`);
    } else if (state === 'starting') {
      parts.push('Vault phone access: connecting…');
    } else if (state === 'error') {
      parts.push(`Vault phone access stopped: ${error ?? 'unknown error'}`);
    }
    button.setAttr('aria-label', parts.length > 0 ? `${parts.join('. ')}. Click for options.` : 'Phone access. Click for options.');
  }

  private onPhoneClick(evt: MouseEvent): void {
    const menu = new Menu();
    const chatUrl = this.remoteUrl;
    if (chatUrl) {
      menu.addItem((item) => item.setTitle('Open this chat in claude.ai/code').setIcon('external-link').onClick(() => window.open(chatUrl)));
      menu.addItem((item) =>
        item
          .setTitle('Copy link to this chat')
          .setIcon('copy')
          .onClick(() => {
            navigator.clipboard.writeText(chatUrl).catch((error: unknown) => log('copying the link failed', error));
          }),
      );
      menu.addItem((item) => item.setTitle('Take this chat off the phone').setIcon('square').onClick(() => void this.setChatRemote(false)));
    } else {
      menu.addItem((item) =>
        item.setTitle('Continue this chat on your phone').setIcon('smartphone').onClick(() => void this.setChatRemote(true)),
      );
    }
    // Across every panel; offered when a chat other than the one on screen is on the phone.
    const total = this.plugin.phoneChatCount();
    if (total > (chatUrl ? 1 : 0)) {
      menu.addItem((item) =>
        item.setTitle(`Take all chats off the phone (${total})`).setIcon('x-circle').onClick(() => void this.plugin.takeAllOffPhone()),
      );
    }
    menu.addSeparator();
    const { remote } = this.plugin;
    if (remote.isRunning()) {
      const vaultUrl = remote.status.url;
      if (vaultUrl) {
        menu.addItem((item) =>
          item.setTitle('Open vault sessions in claude.ai/code').setIcon('external-link').onClick(() => window.open(vaultUrl)),
        );
      }
      menu.addItem((item) => item.setTitle('Stop new phone sessions in this vault').setIcon('square').onClick(() => remote.stop()));
    } else {
      menu.addItem((item) =>
        item.setTitle('Let the phone start new sessions in this vault').setIcon('folder-open').onClick(() => this.plugin.startRemote()),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /**
   * Puts the chat on screen on the phone (Remote Control for its session) or takes it off.
   * A chat that has not started yet is started, or resumed, without sending a message.
   */
  private async setChatRemote(on: boolean): Promise<void> {
    if (!on) {
      const session = this.session;
      try {
        await session?.enableRemoteControl(false);
      } catch (error) {
        log('disabling remote control failed', error);
      }
      if (session === this.session) {
        this.remoteUrl = null;
        this.updatePhoneButton();
      } else {
        // The chat went to the background meanwhile: its entry is off the phone, and closes once idle.
        const entry = [...this.background].find((candidate) => candidate.session === session);
        if (entry) {
          entry.remoteUrl = null;
          if (isIdle(entry)) this.settleBackground(entry);
        }
        this.updateBackgroundIndicator();
      }
      return;
    }
    const session = this.ensureSession();
    if (!session) return;
    try {
      session.ensureStarted();
      const response = (await session.enableRemoteControl(true, this.chatName ?? 'Obsidian chat')) as { session_url?: string } | null;
      if (!response?.session_url) throw new Error('Claude Code returned no link');
      if (session !== this.session) {
        // The chat went to the background meanwhile; its entry keeps the link (and the process).
        const entry = [...this.background].find((candidate) => candidate.session === session);
        if (entry) entry.remoteUrl = response.session_url;
        this.updateBackgroundIndicator();
        return;
      }
      this.remoteUrl = response.session_url;
      log('remote control on for chat', { chatId: this.chatId });
      const url = response.session_url;
      new Notice(
        createFragment((frag) => {
          frag.appendText('This chat is on your phone: open Code in the Claude app, or ');
          const open = frag.createEl('a', { text: 'claude.ai/code', href: '#' });
          open.addEventListener('click', (evt) => {
            evt.preventDefault();
            window.open(url);
          });
          frag.appendText('.');
        }),
        10_000,
      );
    } catch (error) {
      log('enabling remote control failed', error);
      if (session !== this.session) return;
      new Notice(`Could not put this chat on your phone: ${errorText(error)}`);
      this.remoteUrl = null;
    }
    this.updatePhoneButton();
  }

  /** Chats of this panel on the phone: the one on screen and background ones. */
  phoneChats(): number {
    return [...this.background].filter((entry) => entry.remoteUrl).length + (this.remoteUrl ? 1 : 0);
  }

  /**
   * Takes this panel's chats off the phone and returns how many. Idle background chats are closed
   * (they resume from disk); one still working stays until it finishes, then closes as usual; the
   * chat on screen stays open. The plugin runs this for every panel.
   */
  async takeOffPhone(): Promise<number> {
    let count = 0;
    for (const entry of [...this.background]) {
      if (!entry.remoteUrl) continue;
      count += 1;
      entry.remoteUrl = null;
      if (entry.busy || entry.approvals.length > 0 || entry.tasks.size > 0) {
        entry.session.enableRemoteControl(false).catch((error) => log('disabling remote control failed', error));
      } else {
        this.background.delete(entry);
        entry.notice?.hide();
        this.closeSession(entry.session);
      }
    }
    if (this.remoteUrl) {
      count += 1;
      await this.setChatRemote(false);
    }
    this.updateBackgroundIndicator();
    return count;
  }

  /** The id of the chat on screen; null for a chat not started, or the scratch chat. */
  currentChatId(): string | null {
    return this.scratch ? null : this.chatId;
  }

  /**
   * The chat whose connections the Connections pane shows: this one, or one opened from outside the
   * panel, its session the original's until a message makes its copy (`lookOnly`: its map is looked
   * at, nothing changed for it, which would be saved on the original and not reach the copy).
   */
  connectionsChat(): { id: string; lookOnly: boolean } | null {
    if (this.scratch) return null;
    if (this.chatId) return { id: this.chatId, lookOnly: false };
    return this.resumeId ? { id: this.resumeId, lookOnly: true } : null;
  }

  /** The chat's home project: its own once started, else its attached note's; none for the scratch chat. */
  private homeProjectFile(): TFile | null {
    if (this.scratch) return null;
    if (this.chatId) return this.plugin.homeProject(this.chatId);
    return this.attachedNote ? this.plugin.projectForPath(this.attachedNote) : null;
  }

  /** What this chat, new and without an id yet, has chosen (see ChatStart). */
  private startOf(): ChatStart {
    const state: ChatProjectState = { ...this.projectLocal };
    if (this.attachedNote) state.start = this.attachedNote;
    return { state, chats: [...this.chatsToLink], notes: [...this.notesToLink] };
  }

  /** Keeps what a chat sent to the background chose before its id came, now that it has id `id`. */
  private adoptStart(id: string, start: ChatStart): void {
    this.plugin.adoptProjectState(id, start.state);
    for (const path of start.notes) this.plugin.linkNoteRef(path, id);
    if (start.chats.length > 0) this.plugin.linkChats(id, start.chats);
  }

  private projectStateNow(): ChatProjectState {
    return this.chatId ? this.plugin.projectState(this.chatId) : this.projectLocal;
  }

  private setProjectStateNow(state: ChatProjectState): void {
    if (this.chatId) this.plugin.setProjectState(this.chatId, state);
    else this.projectLocal = state;
  }

  /**
   * What goes with the next message from the chat's projects and the chats it includes (see
   * contextBlock), by part, with their fingerprints. `text`: the message it goes with, whose links to
   * chats count as this chat's (see linksTo).
   */
  private async projectContext(text: string): Promise<{ parts: ContextPart[]; hashes: Record<string, string> }> {
    const home = this.homeProjectFile();
    const state = this.projectStateNow();
    // Sent already, or waiting to go with a message Claude Code has not taken up yet.
    const sent = new Set([...(state.sent ?? []), ...(this.session?.waitingContext() ?? [])]);
    // What went is marked by key: a project's path; `parent:` and its path for an enclosing project's Instructions; `chat:` and an id.
    const parts: ContextPart[] = [];
    const hashes: Record<string, string> = {};
    // The Instructions of the projects holding its home project's folder, the outermost first.
    for (const parent of home ? this.plugin.enclosingProjects(home) : []) {
      const key = `parent:${parent.path}`;
      if (sent.has(key)) continue;
      const read = await this.plugin.projectParts(parent);
      if (!read.instructions) continue;
      parts.push({ key, project: { name: parent.basename, note: parent.path, instructions: read.instructions, role: 'parent' } });
      // Only its Instructions go: a change to its Context alone sends nothing again.
      hashes[key] = contextHash({ context: '', instructions: read.instructions });
    }
    if (home && !sent.has(home.path)) {
      const read = await this.plugin.projectParts(home);
      if (read.context || read.instructions) {
        parts.push({ key: home.path, project: { name: home.basename, note: home.path, context: read.context, instructions: read.instructions, role: 'home' } });
        hashes[home.path] = contextHash(read);
      }
    }
    // The chats it links to and includes: each one's digest, once.
    for (const id of this.includedChats(text)) {
      const key = `chat:${id}`;
      if (sent.has(key)) continue;
      parts.push({ key, chat: { id, title: this.plugin.chatTitleOf(id), digest: await this.plugin.linkedChatDigest(id) } });
      hashes[key] = this.chatStamp(id);
    }
    return { parts, hashes };
  }

  /**
   * Whether context under `key` (see projectContext) is still to go with the chat on screen: a
   * project it is still in, a chat it still links to and includes. What waits to go is checked again
   * whenever these change (see projectsChanged).
   */
  private contextWanted(key: string): boolean {
    const home = this.homeProjectFile();
    if (key.startsWith('chat:')) {
      const id = key.slice('chat:'.length);
      const linked = [...this.linksTo(''), ...this.chatsToLink.map((each) => ({ id: each }))].some((link) => link.id === id);
      return linked && (this.projectStateNow().includeChats ?? []).includes(id);
    }
    if (key.startsWith('parent:')) return home !== null && this.plugin.enclosingProjects(home).some((parent) => `parent:${parent.path}` === key);
    return home?.path === key;
  }

  /** Whether what went under `key` (see projectContext) changed since: a project's Context or Instructions, or a linked chat. */
  private sentChanged(key: string): boolean {
    const state = this.projectStateNow();
    const was = state.sentHash?.[key];
    if (!(state.sent?.includes(key) ?? false) || was === undefined) return false;
    if (key.startsWith('chat:')) return this.chatStamp(key.slice('chat:'.length)) !== was;
    const parent = key.startsWith('parent:');
    const now = this.plugin.projectHashNow(parent ? key.slice('parent:'.length) : key, parent);
    return now !== null && now !== was;
  }

  /** Whether project `path`'s context (its own, or an enclosing project's Instructions) went with this chat and changed since. */
  private projectUpdated(path: string): boolean {
    const file = this.app.vault.getAbstractFileByPath(path);
    const parents = file instanceof TFile ? this.plugin.enclosingProjects(file).map((parent) => `parent:${parent.path}`) : [];
    return [path, ...parents].some((key) => this.sentChanged(key));
  }

  /** When chat `id` last changed, as what went of it is marked: its last activity, and its summary's. */
  private chatStamp(id: string): string {
    const item = this.plugin.listedChats()?.find((each) => each.id === id);
    return `${item?.updatedAt ?? 0}|${this.plugin.chatSummaries[id]?.at ?? 0}`;
  }

  /**
   * The chats this one links to: those recorded, and those linked in the message being typed
   * (recorded when it is sent); `text`, that message, when it has left the input already (see send).
   */
  private linksTo(text = this.inputEl.value): { id: string; pending: boolean }[] {
    const recorded = this.chatId && !this.scratch ? (this.plugin.chatLinks[this.chatId] ?? []) : [];
    const typed = linkedChatIds(text).filter((id) => id !== this.chatId && !recorded.includes(id));
    return [...recorded.map((id) => ({ id, pending: false })), ...typed.map((id) => ({ id, pending: true }))];
  }

  /** The chats that link to this one. */
  private linksFrom(): string[] {
    const id = this.chatId;
    if (!id || this.scratch) return [];
    return Object.keys(this.plugin.chatLinks).filter((other) => other !== id && this.plugin.chatLinks[other].includes(id));
  }

  /** The chats this one links to whose digests are to go with it (see ChatProjectState.includeChats). */
  /** `to`: its links, when read already (see linksTo). */
  private includedChats(text?: string, to = this.linksTo(text)): string[] {
    const include = this.projectStateNow().includeChats ?? [];
    return to
      .map((link) => link.id)
      .filter((id) => include.includes(id));
  }

  /** Links this chat to chat `id`: at once once it has started; before, by adding a link to it to the input (recorded when sent). */
  private linkChatHere(id: string): void {
    if (this.scratch || id === this.chatId) return;
    if (this.chatId) {
      this.plugin.linkChats(this.chatId, [id]);
      this.projectsChanged();
    } else this.addToInput(this.plugin.chatMarkdownLink(id), 'Chat linked: recorded when the message is sent');
  }


  /** Mentions chat `id` in the message being typed: a link to it, which links the chats once sent. */
  mentionChat(id: string): void {
    if (this.scratch) {
      new Notice('The scratch chat does not link to other chats.');
      return;
    }
    this.addToInput(this.plugin.chatMarkdownLink(id), `“${this.plugin.chatTitleOf(id)}” mentioned: linked when the message is sent`);
  }

  /** The chat's links (see LinksList), drawn under the chat's map in Connections: those it links to, each to include or not, and those linking to it. */
  linksPane(): LinksList {
    const titleOf = (id: string) => this.plugin.chatTitleOf(id);
    const when = (id: string) => {
      const item = this.plugin.listedChats()?.find((each) => each.id === id);
      return item ? formatDate(item.updatedAt) : 'not found';
    };
    const update = (change: (state: ChatProjectState) => ChatProjectState) => {
      this.setProjectStateNow(change({ ...this.projectStateNow() }));
      this.projectsChanged();
    };
    return new LinksList({
      rows: () => {
        const state = this.projectStateNow();
        return [
          ...this.linksTo().map(({ id, pending }) => ({
            id,
            title: titleOf(id),
            when: when(id),
            direction: 'to' as const,
            pending,
            include: state.includeChats?.includes(id) ?? false,
            sent: state.sent?.includes(`chat:${id}`) ?? false,
            updated: this.sentChanged(`chat:${id}`),
            summarised: this.plugin.chatSummaries[id] !== undefined,
          })),
          ...this.linksFrom().map((id) => ({ id, title: titleOf(id), when: when(id), direction: 'from' as const, pending: false, include: false, sent: false, updated: false, summarised: false })),
        ];
      },
      digest: (id) => this.plugin.linkedChatDigest(id),
      setInclude: (id, on) => update((state) => ({ ...state, includeChats: [...(state.includeChats ?? []).filter((each) => each !== id), ...(on ? [id] : [])] })),
      sendAgain: (id) => update((state) => ({ ...state, sent: state.sent?.filter((key) => key !== `chat:${id}`) })),
      unlink: (id) => {
        if (this.chatId && (this.plugin.chatLinks[this.chatId] ?? []).includes(id)) this.plugin.unlinkChat(this.chatId, id);
        // Linked in the message being typed: its link there goes.
        const value = removeChatLinks(this.inputEl.value, id);
        if (value !== this.inputEl.value) {
          this.inputEl.value = value;
          this.inputEdited();
        }
        update((state) => ({ ...state, includeChats: state.includeChats?.filter((each) => each !== id), sent: state.sent?.filter((key) => key !== `chat:${id}`) }));
      },
      open: (id) => void this.plugin.openChatById(id, titleOf(id), this),
      summarise: async (id, signal) => {
        await this.plugin.summariseLinkedChat(id, signal);
        this.projectsChanged();
      },
      forgetSummary: (id) => {
        this.plugin.forgetLinkedSummary(id);
        this.projectsChanged();
      },
      chooseChat: () => void this.openHistory(true),
    });
  }

  /** Why the chat is in its project, in a few words (see homeOf). */
  private projectWhy(): string {
    const home = this.homeProjectFile();
    if (!home) return '';
    const reason = this.chatId ? this.plugin.homeReason(this.chatId)?.reason : null;
    if (!this.chatId) return `Project “${home.basename}”: the attached note is in its folder.`;
    if (!reason || reason.why === 'added') return `Project “${home.basename}”, chosen by you.`;
    if (reason.why === 'start') return `Project “${home.basename}”: it started with ${reason.note}, in its folder.`;
    return `Project “${home.basename}”: ${reason.count} of the notes it worked on are in its folder.`;
  }


  /**
   * For a chat with no project, the one to offer in a click: the attached note's (the project note
   * itself, or a note in a project's folder); else that of a chat it is linked with.
   */
  private projectSuggestion(): TFile | null {
    if (!this.chatId) return null;
    // The attached note, a deliberate choice; not whichever note happens to be in front.
    const attached = this.attachedNote ? this.app.vault.getAbstractFileByPath(this.attachedNote) : null;
    if (attached instanceof TFile) {
      if (this.plugin.isProjectNote(attached)) return attached;
      const holding = this.plugin.projectForPath(attached.path);
      if (holding) return holding;
    }
    return this.linkedProjectSuggestion();
  }

  /** The project of a chat this one links to or that links to it (the most recent link first), if any. */
  private linkedProjectSuggestion(): TFile | null {
    if (!this.chatId) return null;
    for (const id of [...this.linksTo().map((link) => link.id), ...this.linksFrom()]) {
      const home = this.plugin.homeProject(id);
      if (home) return home;
    }
    return null;
  }

  /** What the links chip shows, to tell when it must be drawn again. */
  private linksChipKey(): string {
    const to = this.linksTo();
    const included = this.includedChats(undefined, to);
    return JSON.stringify([to, this.linksFrom().length, included, included.filter((id) => this.sentChanged(`chat:${id}`))]);
  }

  /** The links chip: how many chats this one is linked with (0 too, so linking one is a click away), marked when one included changed since it went. */
  private drawLinksChip(): void {
    if (this.scratch) return;
    const to = this.linksTo();
    const count = to.length + this.linksFrom().length;
    const included = this.includedChats();
    const chip = this.contextRow.createDiv({ cls: `vc-context-chip vc-links-chip${count === 0 ? ' is-empty' : ''}` });
    setIcon(chip.createSpan({ cls: 'vc-context-clip' }), 'link');
    chip.createSpan({ cls: 'vc-context-name', text: String(count) });
    const updated = included.some((id) => this.sentChanged(`chat:${id}`));
    if (updated) chip.createSpan({ cls: 'vc-project-updated', attr: { 'aria-hidden': 'true' } });
    const waiting = included.filter((id) => !(this.projectStateNow().sent ?? []).includes(`chat:${id}`)).length;
    if (count === 0) return void chip.setAttr('aria-label', 'Linked with no chats. Click to link one.');
    chip.setAttr(
      'aria-label',
      `Linked with ${count} chat${count === 1 ? '' : 's'}${waiting > 0 ? `; ${waiting} included, to go with your next message` : ''}${updated ? '; an included chat changed since it went' : ''}. Click to see them.`,
    );
  }

  /** Whether the chip row offers a project: a started chat without one (its project removed by hand too: its notes no longer place it, but it can be added again). */
  private offersProject(): boolean {
    return !this.scratch && this.chatId !== null && !this.homeProjectFile();
  }

  /**
   * After a memo or note is saved from a chat with no project: saved notes go to the plugin's own
   * folders, which give a chat no project, so a notice offers the projects to add it to, the most
   * recently changed first. Nothing when the chat was taken out of its project by hand (the No
   * project chip still offers one).
   * `id`: the chat saved from, read before the save; nothing when the panel shows another chat since.
   */
  private offerProjectAfterSave(id: string): void {
    if (this.chatId !== id || !this.offersProject() || this.projectStateNow().declined) return;
    const projects = this.plugin.projectNotes().sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (projects.length === 0) return;
    const add = (file: TFile) => void this.plugin.setHomeProject(id, file).then(() => new Notice(`This chat is now in “${file.basename}”.`));
    const notice = new Notice(
      createFragment((frag) => {
        frag.appendText('This chat has no project. Add it to: ');
        projects.slice(0, 3).forEach((file, i) => {
          if (i > 0) frag.appendText(' · ');
          frag.createEl('a', { text: file.basename, href: '#' }).addEventListener('click', (evt) => {
            evt.preventDefault();
            notice.hide();
            add(file);
          });
        });
        if (projects.length > 3) {
          frag.appendText(' · ');
          frag.createEl('a', { text: 'Other…', href: '#' }).addEventListener('click', (evt) => {
            evt.preventDefault();
            notice.hide();
            new ProjectPicker(this.app, projects.map((file) => ({ path: file.path, name: file.basename })), 'Add this chat to…', (chosen) => {
              const file = this.app.vault.getAbstractFileByPath(chosen.path);
              if (file instanceof TFile) add(file);
            }).open();
          });
        }
      }),
      12000,
    );
  }

  /**
   * The Connections pane (see ConnectionsView), showing the chat or (`atProject`) its project, and
   * with `links` the chat's links unfolded under the map (the links chip's). Once the chat has started;
   * one opened from outside the panel is shown look-only until its first message (see connectionsChat).
   */
  openConnections(atProject = false, links = false): void {
    if (!this.connectionsChat()) {
      new Notice(this.scratch ? 'The scratch chat has no connections.' : 'Send a message first: a chat has connections once it has started.');
      return;
    }
    void this.plugin.openConnections(this, atProject, links);
  }

  /** Projects changed (a chat joined or left one, its Context changed): the chip shows it. */
  projectsChanged(): void {
    // What waits to go with a message already sent, and is no longer wanted, does not go.
    this.session?.withdrawContext((key) => !this.contextWanted(key));
    this.contextKey = '';
    this.updateContextChip();
  }

  /** Whether chat `id` is on screen here or running in this panel's background. */
  holdsChat(id: string): boolean {
    return this.chatId === id || [...this.background].some((entry) => entry.chatId === id);
  }

  /** Shows chat `id`, which this panel holds (see holdsChat), bringing it back from the background if needed. */
  async showHeldChat(id: string): Promise<void> {
    await this.app.workspace.revealLeaf(this.leaf);
    const entry = [...this.background].find((candidate) => candidate.chatId === id);
    if (entry) await this.attachBackground(entry);
  }

  /** Status labels for the history: the chat on screen here and this panel's background chats. */
  chatStatuses(): Map<string, string> {
    const statuses = new Map<string, string>();
    // By either id: a chat reopened from the history has no id of its own until its first message.
    const onScreen = this.chatId ?? this.resumeId;
    if (onScreen) statuses.set(onScreen, chatStatus(this.pendingApprovals, this.busy, this.tasks.size, this.remoteUrl, 'Open'));
    for (const entry of this.background) {
      // Kept running for a reason; 'In the background' only if none of them is known.
      if (entry.chatId) statuses.set(entry.chatId, chatStatus(entry.approvals.length, entry.busy, entry.tasks.size, entry.remoteUrl, 'In the background'));
    }
    return statuses;
  }

  /**
   * A turn the panel did not start: sent from the phone, or one Claude Code started itself (a
   * background agent finishing, say). `answering`: the uuids of the messages it answers, from its
   * first reply frame, which are those messages' uuids in the session file; absent from older
   * Claude Code, when the latest prompt stands in for them. Resolves once the prompts are shown.
   */
  private async beginRemoteTurn(answering?: string[]): Promise<void> {
    this.beginTurn(answering);
    const turn = this.draw.turn;
    const id = this.chatId;
    const root = this.plugin.vaultRoot();
    if (!turn || !id || !root) return;
    // The prompts are not echoed on the stream, but they are at the end of the session file before
    // the reply starts. They show as in the chat drawn from history (see promptBubble): a background-
    // task notice on its own shows as the notice already drawn, and a turn answering no new message
    // of yours (all ids unknown to the file) shows none rather than an old one again.
    const wanted = answering ? new Set(answering) : null;
    let messages: SessionMessage[];
    try {
      messages = wanted
        ? await lastMessages(id, root, (message) => wanted.has(message.uuid), wanted.size, TURN_PROMPT_MAX_BYTES)
        : await lastMessages(id, root, startsTurn);
    } catch (error) {
      log('reading the remote prompt failed', error);
      return;
    }
    if (!turn.isConnected) return;
    for (const message of messages) {
      if (!startsTurn(message)) continue;
      const prompt = messagePrompt(message);
      const shown = prompt && promptBubble(prompt.text, prompt.images);
      if (!shown || shown === 'stopped') continue;
      // Already drawn (sent here before the panel was reloaded, say, so not known as sent here): not again.
      if (Array.from(this.messagesEl.querySelectorAll<HTMLElement>('.vc-user')).some((drawn) => drawn.dataset.uuid === message.uuid || drawn.dataset.sentUuid === message.uuid)) {
        this.sentIds.add(message.uuid);
        continue;
      }
      // A message queued here, saved by Claude Code under an id of its own: it is this panel's,
      // already shown, and now taken up.
      const queued = [...this.pending].find(([, entry]) => entry.text !== undefined && entry.text.trim() === shown.text.trim());
      if (queued) {
        this.sentIds.add(message.uuid);
        this.markDelivered(queued[0]);
        continue;
      }
      const bubble = this.renderUserBubble(shown.text, shown.chips, undefined, message.uuid);
      bubble.createDiv({ cls: 'vc-origin-label', text: this.remoteUrl ? 'Sent from your phone' : 'Sent outside the panel' });
      turn.before(bubble);
    }
  }

  // ---- Background chats --------------------------------------------------

  /** Moves a working chat off screen; it keeps running and is closed once it has finished. */
  private detachToBackground(): void {
    const session = this.session;
    // Idle chats are simply closed (they resume from disk), except one that is on the phone or
    // has background tasks running, which closing the process would kill.
    if (!session || (!this.busy && !this.remoteUrl && this.tasks.size === 0)) return;
    const entry: BackgroundChat = {
      session,
      chatId: this.chatId,
      title: this.chatName,
      busy: this.busy,
      remoteUrl: this.remoteUrl,
      approvals: [],
      pendingIds: new Set(this.pending.keys()),
      // Those still queued, not yet in the session file: drawn again when the chat is shown again.
      queued: new Map([...this.pending].filter(([, sent]) => sent.bubble.hasClass('is-queued') && sent.text !== undefined).map(([id, sent]) => [id, { text: sent.text ?? '', chips: sent.chips ?? [] }])),
      waitedForQueue: false,
      mode: this.mode,
      modelOverride: this.modelOverride,
      effortOverride: this.effortOverride,
      currentModel: this.currentModel,
      currentEffort: this.currentEffort,
      fastMode: this.fastMode,
      notice: null,
      tasks: this.tasks,
      settleTimer: null,
      // A subagent's calls in flight too: its edits change notes as well.
      toolCalls: new Map([
        ...[...this.tools].filter(([, tool]) => tool.status === 'running').map(([id, tool]) => [id, { name: tool.name, input: tool.input }] as const),
        ...this.agentCalls,
      ]),
      turnPrompts: this.turnPrompts,
      sentIds: this.sentIds,
      modeBeforePlan: this.modeBeforePlan,
      start: this.chatId || this.scratch ? null : this.startOf(),
    };
    this.tasks = new Set();
    for (const approval of this.openApprovals) this.adoptApproval(entry, approval);
    this.openApprovals = [];
    session.setHandlers(this.backgroundHandlers(entry));
    this.background.add(entry);
    this.sessionToken = null;
    this.session = null;
    this.updateBackgroundIndicator();
    if (entry.approvals.length > 0) this.notifyBackground(entry, waitingFor(entry.approvals[0].request), true);
  }

  /** Keeps a permission request of a background chat open until the chat is shown again. */
  private adoptApproval(entry: BackgroundChat, approval: Approval): void {
    entry.approvals.push(approval);
    this.onWithdrawn(approval, () => {
      entry.approvals = entry.approvals.filter((open) => open !== approval);
      approval.resolve({ behavior: 'deny', message: 'Cancelled.' });
      // Nothing waits on you there any more: its notice and the tab's sign go.
      if (entry.approvals.length === 0) entry.notice?.hide();
      this.updateBackgroundIndicator();
    });
  }

  /**
   * What withdrawing `approval` does now (null: nothing more), in place of what it did where it was
   * before: a card drawn again, or its chat sent to the background, leaves no listener behind.
   */
  private onWithdrawn(approval: Approval, handler: (() => void) | null): void {
    if (approval.onAbort) approval.request.signal.removeEventListener('abort', approval.onAbort);
    approval.onAbort = handler ?? undefined;
    if (handler) approval.request.signal.addEventListener('abort', handler, { once: true });
  }

  private backgroundHandlers(entry: BackgroundChat): SessionHandlers {
    return {
      onMessage: (message) => {
        if (trackTask(entry.tasks, message)) {
          this.updateBackgroundIndicator();
          if (entry.tasks.size === 0 && !entry.busy) this.settleBackground(entry);
        }
        if (message.type === 'system' && message.subtype === 'init' && entry.chatId !== message.session_id) {
          entry.chatId = message.session_id;
          this.plugin.recordChat(message.session_id, entry.title ?? 'Untitled chat');
          if (entry.start) this.adoptStart(message.session_id, entry.start);
          entry.start = null;
        } else if (message.type === 'stream_event') {
          clearSettle(entry);
          if (!entry.busy) {
            entry.busy = true;
            entry.turnPrompts = [];
            this.updateBackgroundIndicator();
          }
          // From the turn's first frame of its own that names them: a subagent's frame names none.
          if (message.parent_tool_use_id === null && entry.turnPrompts.length === 0) entry.turnPrompts = answeredBy(message) ?? [];
        } else if (message.type === 'assistant') {
          // A subagent's calls too: its edits change notes as well.
          for (const block of message.message.content) {
            if (block.type === 'tool_use') entry.toolCalls.set(block.id, { name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
          }
        } else if (message.type === 'user' && typeof message.message.content !== 'string') {
          this.linkBackgroundEdits(entry, message.message.content, message.tool_use_result);
        } else if (message.type === 'result') {
          entry.busy = false;
          entry.turnPrompts = [];
          for (const id of message.user_message_uuids ?? []) entry.pendingIds.delete(id);
          if (entry.pendingIds.size > 0 && !entry.waitedForQueue) {
            // A queued message not taken up by this turn runs as the next one.
            entry.waitedForQueue = true;
            this.updateBackgroundIndicator();
            return;
          }
          // Queued messages still listed have had their own turn without being reported back.
          entry.pendingIds.clear();
          entry.waitedForQueue = false;
          if (entry.remoteUrl || entry.tasks.size > 0) {
            // On the phone: kept running so it can be continued there. With background tasks
            // running: kept for them, and Claude takes up their results in a turn of its own.
            this.updateBackgroundIndicator();
            return;
          }
          const succeeded = message.subtype === 'success' && !message.is_error;
          if (message.duration_ms >= this.plugin.settings.notifyAfterSeconds * 1000) {
            this.systemNotify(succeeded ? 'Claude finished' : 'Claude stopped with an error', entry.title ?? 'A chat', () => void this.showChat(entry));
          }
          this.finishBackground(entry, succeeded);
        }
      },
      onPermission: (request) =>
        new Promise<PermissionResult>((resolve) => {
          this.adoptApproval(entry, this.newApproval(request, resolve, entry.chatId));
          this.notifyBackground(entry, waitingFor(request), true);
          this.systemNotify(`Claude ${waitingFor(request)}`, entry.title ?? 'A chat', () => void this.showChat(entry));
        }),
      onEnd: (error) => {
        // Ended on its own (not by finishBackground or the panel closing, which remove it first).
        if (!this.background.delete(entry)) return;
        if (!this.isOnScreen()) this.unseen = 'error';
        if (entry.chatId) this.plugin.markChatUnseen(entry.chatId, 'error');
        this.updateBackgroundIndicator();
        const reason = error ? `stopped with an error (${error.message})` : 'stopped unexpectedly';
        log('background chat ended', { chatId: entry.chatId, error: error?.message ?? null });
        this.notifyBackground(entry, reason, true);
      },
    };
  }

  /**
   * Links the notes a background chat's finished edits changed, as the chat on screen does when it
   * draws them (see renderEdit): an edit made now, so the chat becomes the note's newest.
   */
  private linkBackgroundEdits(entry: BackgroundChat, content: Exclude<SDKUserMessage['message']['content'], string>, structured: unknown): void {
    const root = this.plugin.vaultRoot();
    for (const result of toolResults(content, structured)) {
      const call = entry.toolCalls.get(result.id);
      entry.toolCalls.delete(result.id);
      if (!call || result.isError || !root || !entry.chatId || entry.chatId === this.plugin.scratch?.id) continue;
      for (const diff of toolDiffs(call.name, call.input, result.structured)) {
        const path = vaultRelative(diff.file, root);
        if (path && isOwnChange(diff)) this.plugin.linkNoteChat(path, entry.chatId);
      }
    }
  }

  /**
   * The last background task of an idle chat has ended. Claude Code normally answers with a turn
   * that reads its result, and that turn's end closes the chat; if none starts, it is closed here.
   */
  /** The background chat whose process is `session`, if one is. */
  private entryOf(session: ClaudeSession): BackgroundChat | undefined {
    return [...this.background].find((entry) => entry.session === session);
  }

  private settleBackground(entry: BackgroundChat): void {
    clearSettle(entry);
    entry.settleTimer = window.setTimeout(() => {
      entry.settleTimer = null;
      if (this.background.has(entry) && isIdle(entry)) {
        this.finishBackground(entry, true);
      }
    }, BACKGROUND_SETTLE_MS);
  }

  /** Closes `session`; until its process has exited, its file is not deleted (see VaultClaudePlugin.processEnding). */
  private closeSession(session: ClaudeSession | null): void {
    if (!session) return;
    if (session.sessionId) this.plugin.processEnding(session.sessionId, session.ended);
    session.close();
  }

  /** Stops chat `id` if it runs in this panel's background, without a word: it has been let go of (the scratch chat, cleared). */
  closeBackgroundChat(id: string): void {
    for (const entry of [...this.background]) if (entry.chatId === id) this.dropBackground(entry);
    this.updateBackgroundIndicator();
  }

  /**
   * Refuses what waits on you in the chat on screen with `message`; a plan's note keeps its edits for
   * the chat's next plan, as on Esc. Whether there was anything to refuse.
   */
  private refuseOpenApprovals(message: string): boolean {
    const refused = this.openApprovals.length > 0;
    for (const approval of this.openApprovals) {
      this.onWithdrawn(approval, null);
      void this.withdrawPlanNote(approval);
      approval.resolve({ behavior: 'deny', message });
    }
    this.openApprovals = [];
    return refused;
  }

  /**
   * Ends `session` once Claude Code has taken the answers just given to its waiting requests (its
   * next message), or after ANSWER_WAIT_MS: ended at once, its process would be gone before the
   * answers reached it, and its record would say they were cut off. Nothing more of it is shown, and
   * anything else it asks is refused with `message`.
   */
  private closeAfterAnswer(session: ClaudeSession, message: string): void {
    // Its process is ending from now on: deleting its chat meanwhile waits for it to exit.
    if (session.sessionId) this.plugin.processEnding(session.sessionId, session.ended);
    let open = true;
    const close = () => {
      if (!open) return;
      open = false;
      window.clearTimeout(timer);
      this.closeSession(session);
    };
    const timer = window.setTimeout(close, ANSWER_WAIT_MS);
    session.setHandlers({
      onMessage: (next) => {
        if (next.type === 'user' || next.type === 'assistant' || next.type === 'result') close();
      },
      onPermission: async () => ({ behavior: 'deny', message }),
      onEnd: () => close(),
    });
  }

  /** Stops a background chat: its approvals refused, its timer and notice gone, its process closed. */
  /**
   * `keep`: a plan's note keeps your edits for the chat's next plan, as on screen (the panel closing:
   * the chat can be reopened); otherwise it goes (the chat let go of or deleted).
   */
  private dropBackground(entry: BackgroundChat, keep = false): void {
    const answered = entry.approvals.length > 0;
    for (const approval of entry.approvals) {
      void this.withdrawPlanNote(approval, keep);
      approval.resolve({ behavior: 'deny', message: 'Chat closed.' });
    }
    clearSettle(entry);
    entry.notice?.hide();
    this.background.delete(entry);
    // As on screen: the answers reach Claude Code before its process ends.
    if (answered) this.closeAfterAnswer(entry.session, 'Chat closed.');
    else this.closeSession(entry.session);
  }

  private finishBackground(entry: BackgroundChat, succeeded: boolean): void {
    clearSettle(entry);
    this.background.delete(entry);
    this.closeSession(entry.session);
    if (!this.isOnScreen()) this.unseen = succeeded ? 'done' : 'error';
    // In the background, so not seen whether or not this panel is visible.
    if (entry.chatId) this.plugin.markChatUnseen(entry.chatId, succeeded ? 'done' : 'error');
    this.updateBackgroundIndicator();
    this.notifyBackground(entry, succeeded ? 'has finished' : 'stopped with an error', false);
  }

  private notifyBackground(entry: BackgroundChat, what: string, persist: boolean): void {
    entry.notice?.hide();
    const fragment = createFragment((frag) => {
      frag.appendText(`Claude ${what} in “${entry.title ?? 'a chat'}”. `);
      // A chat that ended before Claude Code assigned it an id has nothing to reopen.
      if (!entry.chatId && !this.background.has(entry)) return;
      const open = frag.createEl('a', { text: 'Open', href: '#' });
      open.addEventListener('click', (evt) => {
        evt.preventDefault();
        entry.notice?.hide();
        void this.showChat(entry);
      });
    });
    entry.notice = new Notice(fragment, persist ? 0 : 8000);
  }

  private async showChat(entry: BackgroundChat): Promise<void> {
    await this.app.workspace.revealLeaf(this.leaf);
    if (this.background.has(entry)) {
      await this.attachBackground(entry);
    } else if (entry.chatId) {
      await this.openChat({ id: entry.chatId, title: entry.title ?? 'Chat', updatedAt: Date.now(), fromPanel: true });
    }
  }

  /** Brings a background chat back on screen: its transcript so far, then its live session. */
  private async attachBackground(entry: BackgroundChat): Promise<void> {
    const opening = this.showOpening(entry.title);
    try {
      await this.showBackground(entry);
    } finally {
      opening.remove();
    }
  }

  private async showBackground(entry: BackgroundChat): Promise<void> {
    const read = await this.readForOpening(entry.chatId);
    if (!read) return;
    // Its session goes on whether or not its saved messages could be read.
    const chat = read.chat ?? { transcript: [], edits: new Map() };
    if (!this.background.has(entry)) {
      // It finished while the transcript was loading.
      if (entry.chatId) await this.openChat({ id: entry.chatId, title: entry.title ?? 'Chat', updatedAt: Date.now(), fromPanel: true });
      return;
    }
    this.newChat();
    this.background.delete(entry);
    clearSettle(entry);
    this.tasks = entry.tasks;
    this.updateStopButton();
    entry.notice?.hide();
    this.messagesEl.empty();
    this.chatId = entry.chatId;
    this.resumeId = entry.chatId;
    this.setChatTitle(entry.title);
    this.mode = entry.mode;
    this.modeBeforePlan = entry.modeBeforePlan;
    this.modelOverride = entry.modelOverride;
    this.effortOverride = entry.effortOverride;
    this.fastMode = entry.fastMode;
    this.fastState = null;
    this.populateModeSelect();
    this.populateModelSelect();
    const working = entry.busy || entry.approvals.length > 0;
    this.renderHistory(chat, working, read.readMs);
    // The turn in progress, as drawn from the saved messages: the reply goes on in it.
    const unfinished = working ? this.unfinishedTurn : null;
    const drawnTools = new Map(this.tools);
    // Its turns in the background recorded none.
    this.recordMentions();
    const token = {};
    this.sessionToken = token;
    this.session = entry.session;
    entry.session.setHandlers(this.foregroundHandlers(token));
    this.remoteUrl = entry.remoteUrl;
    this.updatePhoneButton();
    // Ids still waiting after a turn already passed them over are running as their own turn.
    for (const id of entry.pendingIds) this.pending.set(id, { bubble: createDiv(), running: entry.waitedForQueue, id: id as MessageId });
    this.sentIds = entry.sentIds;
    if (working) {
      this.beginTurn(entry.turnPrompts, unfinished);
      // Its calls still running go on: drawn ones are shown running again, and the rest (a
      // subagent's) are followed, so that an edit finishing now is shown and links its notes.
      for (const [id, call] of entry.toolCalls) {
        const tool = drawnTools.get(id);
        if (!tool) {
          this.agentCalls.set(id, call);
          continue;
        }
        tool.status = 'running';
        tool.lineEl?.addClass('is-running');
        this.tools.set(id, tool);
        if (tool.group) this.updateToolGroup(tool.group);
      }
    }
    // Messages still queued: shown again, in the turn running, marked as queued; unless its file has
    // them already (taken up mid-turn, see queuedTaken), drawn above under the id they were sent with.
    for (const [id, queued] of entry.queued) {
      const waiting = this.pending.get(id);
      if (!waiting || waiting.running) continue;
      const drawn = Array.from(this.messagesEl.querySelectorAll<HTMLElement>('.vc-user')).find((bubble) => bubble.dataset.uuid === id || bubble.dataset.sentUuid === id);
      this.pending.set(id, { ...waiting, bubble: drawn ?? this.drawQueued(queued.text, queued.chips), text: queued.text, chips: queued.chips });
    }
    for (const approval of entry.approvals) this.renderApprovalCard(approval);
    this.currentModel = entry.currentModel;
    this.currentEffort = entry.currentEffort;
    this.populateModelSelect();
    this.updateBackgroundIndicator();
    this.restoreDraft();
    this.seeChat();
    this.scrollToBottom(true);
    this.plugin.chatShown(this);
  }

  private updateBackgroundIndicator(): void {
    const entries = [...this.background];
    const working = entries.filter((entry) => entry.busy || entry.approvals.length > 0 || entry.tasks.size > 0).length;
    const onPhone = entries.filter((entry) => entry.remoteUrl).length;
    this.historyButton.toggleClass('has-background', working > 0);
    const parts = [working ? `${working} working in the background` : '', onPhone ? `${onPhone} on your phone` : ''].filter(Boolean);
    this.historyButton.setAttr('aria-label', parts.length > 0 ? `Chat history (${parts.join(', ')})` : 'Chat history');
    this.updateTab();
  }

  // ---- Title -------------------------------------------------------------

  private setChatTitle(title: string | null): void {
    // The scratch chat keeps its name, whatever Claude Code called the session.
    if (this.scratch) title = SCRATCH_TITLE;
    this.chatName = title;
    this.chatTitleEl.setText(title ?? 'New chat');
    this.chatTitleEl.setAttr('title', title ?? '');
    this.chatTitleEl.toggleClass('is-new', title === null);
    this.updateChatButtons();
    this.updateTab();
    // Once the chat's id is set too, which follows the title when a chat opens; once for several titles at a time.
    if (this.memosTimer !== null) window.clearTimeout(this.memosTimer);
    this.memosTimer = window.setTimeout(() => {
      this.memosTimer = null;
      if (!this.closing) void this.plugin.followChatMemos(this.chatId ?? this.resumeId ?? '', this.chatName ?? 'New chat');
    }, 0);
  }

  /** The title-row buttons, shown once the chat has a Claude Code session. */
  private updateChatButtons(): void {
    const hasSession = (this.chatId ?? this.resumeId) !== null;
    this.notesButton?.toggle(hasSession);
    this.countNotesSoon();
    this.updateNavButtons();
    this.saveButton.toggle(hasSession);
    this.chatTitleEl.toggleClass('is-renamable', this.chatId !== null && !this.scratch);
    this.deleteButton?.toggle(this.scratch || hasSession);
    this.deleteButton?.setAttr('aria-label', this.scratch ? 'Clear the scratch chat: it starts over' : 'Delete this chat');
    if (this.noteChatsEl) this.updateNoteChats(this.activeNote()?.file ?? null);
    // Not while Claude works: the placeholder then says that a message would be queued.
    if (this.inputEl && !this.busy) this.inputEl.placeholder = this.placeholderText();
  }

  /**
   * Deletes the chat on screen, once confirmed: this panel starts a new chat, one still working is
   * stopped, and the chat's saved session goes once its process has ended (see deleteChat).
   */
  private deleteCurrentChat(): void {
    const id = this.chatId ?? this.resumeId;
    if (!id) return;
    if (this.plugin.chatHolder(id, this)) {
      new Notice('This chat is open in another panel too. Start a new chat there, then delete it.');
      return;
    }
    confirmDelete(this.app, this.chatName ?? 'Untitled chat', this.chatId !== null, () => {
      // Another chat opened while the dialog was up: that one is not deleted.
      if ((this.chatId ?? this.resumeId) !== id) return;
      this.newChat();
      this.closeBackgroundChat(id);
      void this.plugin.deleteChat(id);
    });
  }

  /** What the empty input says: the scratch chat's text warns that it does not keep. */
  private placeholderText(): string {
    if (this.scratch) return 'Ask something quick — this chat clears itself…';
    return this.mode === 'plan' ? 'Describe what to plan…' : 'Ask Claude about this vault…';
  }

  /** Renames the chat on screen; only chats with their own panel session (not an unforked outside one). */
  renameCurrentChat(): void {
    if (this.scratch) {
      new Notice('The scratch chat keeps its name.');
      return;
    }
    const id = this.chatId;
    if (!id) {
      if (this.resumeId) new Notice('Send a message first: this chat started outside the panel and gets its own copy then.');
      return;
    }
    new RenameModal(this.app, this.chatName ?? '', (title) => void this.plugin.renameChatTitle(id, title)).open();
  }

  /** Called for every rename (from this panel, another one, or the history). */
  onChatRenamed(id: string, title: string): void {
    if (id === this.chatId && !this.scratch) {
      this.titleFromClaude = true;
      this.setChatTitle(title);
    }
    for (const entry of this.background) {
      if (entry.chatId === id) entry.title = title;
    }
  }

  /**
   * The input grows with what you type, up to two fifths of the panel, and shrinks back when it
   * empties. A drag handle would have to grow the box downwards, off the bottom of the panel.
   */
  /**
   * What a change to the input's text brings, typed or put there from code (setRangeText fires no
   * input event): command suggestions, its size, the mention chips, the draft.
   */
  private inputEdited(): void {
    this.suggest.update();
    this.growInput();
    this.scheduleDraftSave();
    // A chat linked in the text shows on the links chip.
    this.updateContextChip();
  }

  /** The text the chat came back with, below which undo does not go (see the beforeinput listener). */
  private setUndoFloor(): void {
    this.undoFloor = this.inputEl.value;
    this.undosSinceFloor = 0;
  }

  /** Fits the input to its text, and the tray to the mentions in it (see followMentions). */
  private growInput(): void {
    this.followMentions();
    const input = this.inputEl;
    input.style.height = 'auto';
    const max = Math.max(120, this.contentEl.clientHeight * 0.4);
    input.style.height = `${Math.min(input.scrollHeight, max)}px`;
  }

  focusInput(): void {
    this.inputEl.focus();
  }

  stopTurn(): void {
    this.stop();
  }

  /**
   * A system notification, shown only while Obsidian is not the app in front (the in-app
   * notices cover the rest). Clicking it brings Obsidian forward and runs `onClick`.
   */
  private systemNotify(title: string, body: string, onClick?: () => void): void {
    if (!this.plugin.settings.notifyWhenDone || activeDocument.hasFocus() || typeof Notification === 'undefined') return;
    try {
      const notification = new Notification(title, { body });
      notification.onclick = () => {
        window.focus();
        onClick?.();
        notification.close();
      };
    } catch (error) {
      log('system notification failed', error);
    }
  }

  /** Adopts Claude Code's generated title once it differs from the first-message title. */
  private async refreshTitle(): Promise<void> {
    const id = this.chatId;
    const root = this.plugin.vaultRoot();
    if (!id || !root || this.titleFromClaude || this.scratch) return;
    try {
      const title = await sessionTitle(id, root);
      if (!title || id !== this.chatId || title === this.chatName) return;
      this.titleFromClaude = true;
      this.setChatTitle(title);
      this.plugin.renameChat(id, title);
    } catch (error) {
      log('reading the session title failed', error);
    }
  }

  // ---- History -----------------------------------------------------------

  /** The history window; with `linking`, choosing a chat links this one to it rather than opening it (the links' Link a chat…). */
  async openHistory(linking = false): Promise<void> {
    const root = this.plugin.vaultRoot();
    if (!root) return;
    // The chats as last listed show at once, and those listed now replace them if anything changed;
    // before the first listing, the modal opens empty and its rows arrive with it.
    const shown = this.plugin.listedChats();
    // Linking: only the chats that can be linked, not this one, the scratch chat or those linked already.
    const linked = new Set(linking ? this.linksTo().map((link) => link.id) : []);
    const rows = (items: HistoryItem[]) => {
      const all = this.historyRows(items);
      return linking ? all.filter((item) => !item.scratch && item.id !== this.chatId && !linked.has(item.id)) : all;
    };
    const modal: HistoryModal = new HistoryModal(
      this.app,
      shown && rows(shown),
      this.plugin.listChats().then(
        (items) => rows(items),
        (error: unknown) => {
          log('listing history failed', error);
          if (shown) return null;
          new Notice('Could not read the chat history.');
          modal.close();
          return [];
        },
      ),
      {
        pick: (item, newTab) => {
          if (!linking) return void this.pickChat(item, newTab);
          if (item.scratch || item.id === this.chatId) return void new Notice(item.scratch ? 'The scratch chat cannot be linked.' : 'A chat cannot be linked to itself.');
          if (this.linksTo().some((link) => link.id === item.id)) return void new Notice(`Already linked to “${item.title}”.`);
          this.linkChatHere(item.id);
          new Notice(`Linked to “${item.title}”.`);
        },
        togglePin: (item) => this.plugin.togglePin(item.id),
        rename: (item, title) => void this.plugin.renameChatTitle(item.id, title),
        remove: (item) => (item.scratch ? this.plugin.clearScratchChat().then(() => true) : this.plugin.deleteChat(item.id)),
        searchText: (item) => this.plugin.chatSearchText(item.id),
        stopTasks: (item) => void this.plugin.stopChatTasks(item.id),
        noteLinks: () => ({ changed: this.plugin.noteChats, sent: this.plugin.noteRefs, mentioned: this.plugin.noteMentions }),
        openNote: (path) => void this.app.workspace.openLinkText(path, '', 'tab'),
        projectOf: (folder) => this.plugin.projectOfFolder(folder)?.path ?? null,
        // Without the prefix new projects are named with, which every one would match.
        projectName: (item) => this.plugin.homeProject(item.id)?.basename.replace(/^Claude Project — /, '') ?? null,
        createProject: (folder) => void this.plugin.openCreateProject({ folder }),
        // Choosing a row links it already, when linking: no Link button on the rows too.
        link: this.scratch || linking ? undefined : (item) => this.linkChatHere(item.id),
        isLinked: (item) => item.id === this.chatId || this.linksTo().some((link) => link.id === item.id),
      },
    );
    if (linking) modal.setPlaceholder(`Link “${this.chatName ?? 'this chat'}” to… (search titles, projects, prompts and replies)`);
    modal.open();
  }

  /** Opens a chat picked in the history, here or in a new Claude tab beside this one. */
  private async pickChat(item: HistoryItem, newTab: boolean): Promise<void> {
    const target = newTab ? await this.plugin.openChatTab(this.leaf) : this;
    if (!target) {
      new Notice('Could not open a new tab.');
      return;
    }
    await (item.scratch ? target.openScratch() : target.openChat(item));
  }

  /**
   * The history's rows, from the vault's sessions as listed (see listHistory, copied here): each
   * chat's title as recorded now, its status, pin and running tasks, and the scratch chat first.
   */
  private historyRows(listed: HistoryItem[]): HistoryItem[] {
    // Side chats' sessions are copies made for them, not chats.
    const sideSessions = new Set(this.plugin.sideSessions);
    const titles = new Map(this.plugin.chats.map((chat) => [chat.id, chat.title]));
    const items = listed.filter((item) => !sideSessions.has(item.id)).map((item) => ({ ...item, title: titles.get(item.id) ?? item.title }));
    // Chats open or running in any panel, this one included.
    for (const [id, status] of this.plugin.chatStatuses()) {
      const item = items.find((candidate) => candidate.id === id);
      if (item) item.status = status;
    }
    const pinned = new Set(this.plugin.pinned);
    const withTasks = this.plugin.chatsWithTasks();
    for (const item of items) {
      item.pinned = pinned.has(item.id);
      item.tasksRunning = withTasks.has(item.id);
    }
    // The scratch chat is listed under its own name, first, however Claude Code titled its session.
    if (this.plugin.settings.scratchChat) {
      const scratch = this.plugin.scratch;
      const row = (scratch && items.find((item) => item.id === scratch.id)) ?? {
        id: scratch?.id ?? SCRATCH_TITLE,
        title: SCRATCH_TITLE,
        updatedAt: scratch?.usedAt ?? 0,
        fromPanel: true,
      };
      if (!items.includes(row)) items.unshift(row);
      Object.assign(row, { title: SCRATCH_TITLE, fromPanel: true, scratch: true, pinned: false });
    }
    return items;
  }

  /**
   * Opens a chat from the history; `branch` is set when it is a branch just made from another chat.
   * False only when its saved messages could not be read; true also when it is shown in the panel
   * holding it, or gave way to a chat picked meanwhile.
   */
  async openChat(item: HistoryItem, branch?: BranchSource): Promise<boolean> {
    const started = performance.now();
    const from = this.navPlace();
    const opened = await this.openChatHere(item, branch);
    const shown = performance.now();
    if (opened) this.remember(from);
    this.plugin.chatShown(this);
    // Once the browser has laid out and painted what was drawn: the wait as seen.
    window.requestAnimationFrame(() =>
      window.setTimeout(() => {
        log(`chat opened in ${Math.round(performance.now() - started)} ms: shown after ${Math.round(shown - started)} ms, then laid out and painted`);
      }, 0),
    );
    return opened;
  }

  private async openChatHere(item: HistoryItem, branch?: BranchSource): Promise<boolean> {
    // The latest pick wins: an open still reading its file gives way (see showSavedChat).
    this.chatGeneration += 1;
    // Already on screen: reopening would start a second process on the same session.
    if (item.id === this.chatId) return true;
    const running = [...this.background].find((entry) => entry.chatId === item.id);
    if (running) {
      await this.attachBackground(running);
      return true;
    }
    // Open in another panel: shown there rather than started a second time here.
    const holder = this.plugin.chatHolder(item.id, this);
    if (holder) {
      await holder.showHeldChat(item.id);
      return true;
    }
    const root = this.plugin.vaultRoot();
    if (!root) return false;
    const opening = this.showOpening(item.title);
    try {
      // A kept side chat whose process is still ending: read once nothing writes to its file, unless
      // another chat was picked meanwhile.
      const generation = this.chatGeneration;
      const waitStart = performance.now();
      await this.plugin.sessionEnded(item.id);
      const waited = Math.round(performance.now() - waitStart);
      if (waited > 50) log(`opening a chat: waited ${waited} ms for its process to end`);
      if (generation !== this.chatGeneration) return true;
      return await this.showSavedChat(item, branch);
    } finally {
      opening.remove();
    }
  }

  /** Shows a chat read from its file; false when it could not be read (see openChat). */
  private async showSavedChat(item: HistoryItem, branch?: BranchSource): Promise<boolean> {
    const read = await this.readForOpening(item.id);
    if (!read) return true;
    const { chat } = read;
    if (!chat || chat.transcript.length === 0) {
      // No messages: its file holds only what Claude Code notes about a session, as when it was
      // deleted while its process still ran, which wrote that again as it exited.
      // The scratch chat quietly starts over instead (see openScratch).
      if (!item.scratch) new Notice(chat ? 'That chat has no messages to show.' : 'Could not load that chat.');
      return false;
    }
    this.newChat();
    this.messagesEl.empty();
    this.resumeId = item.id;
    this.chatId = item.fromPanel ? item.id : null;
    // Set before the messages are drawn: the scratch chat's replies offer to carry it on as a chat.
    this.scratch = item.scratch === true;
    this.setChatTitle(item.title);
    this.forkOnResume = !item.fromPanel;
    if (branch) {
      this.mode = branch.mode;
      this.modelOverride = branch.modelOverride;
      this.effortOverride = branch.effortOverride;
      this.populateModeSelect();
      this.populateModelSelect();
    }
    this.messagesEl.createDiv({
      cls: 'vc-muted vc-resumed',
      text: branch?.scratch
        ? 'Carried on from the scratch chat'
        : branch
          ? `Branch of “${branch.title}”`
          : `${item.title} · last active ${formatDate(item.updatedAt)}${item.copied ? ' · a copy of a chat from outside the panel' : ''}`,
    });
    this.renderHistory(chat, false, read.readMs);
    const afterDraw = performance.now();
    this.recordMentions();
    const end = this.messagesEl.createDiv({
      cls: 'vc-muted vc-resumed',
      text: branch?.scratch
        ? 'New messages continue this chat; the scratch chat is unchanged.'
        : branch
          ? 'New messages continue the branch; the original chat is unchanged.'
          : item.fromPanel
          ? 'New messages continue this chat.'
          : 'Started outside the panel. New messages continue in a copy; the original session is unchanged.',
    });
    // Copied before: what was said in its copies is not here, so the latest is offered first.
    const latest = !item.fromPanel ? item.copies?.[0] : undefined;
    if (latest) {
      const copies = item.copies?.length ?? 0;
      end.setText(`Started outside the panel, and copied before: ${copies === 1 ? 'your copy' : `the latest of your ${copies} copies`} was last active ${formatDate(latest.updatedAt)}. `);
      const link = end.createSpan({ cls: 'vc-welcome-link', text: 'Open that copy' });
      link.addEventListener('click', () => void this.openChat(latest));
      end.appendText('. New messages here start another copy; the original session is unchanged.');
    }
    const beforeDraft = performance.now();
    this.restoreDraft();
    const draft = performance.now();
    this.seeChat();
    this.scrollToBottom(true);
    log(`opening a chat: mentions ${Math.round(beforeDraft - afterDraw)} ms; draft ${Math.round(draft - beforeDraft)} ms; seen and scrolled ${Math.round(performance.now() - draft)} ms`);
    return true;
  }

  /**
   * Reads a chat being opened: its messages and diffs (null when they cannot be read) and how long
   * that took, for the log; or null altogether when another chat was opened, or a new one started,
   * while it was read.
   */
  private async readForOpening(id: string | null): Promise<{ chat: LoadedChat | null; readMs: number } | null> {
    const generation = ++this.chatGeneration;
    const started = performance.now();
    const root = this.plugin.vaultRoot();
    let chat: LoadedChat | null = null;
    if (id && root) {
      try {
        chat = await loadChat(id, root);
      } catch (error) {
        log('loading transcript failed', error);
      }
    }
    return this.chatGeneration === generation ? { chat, readMs: Math.round(performance.now() - started) } : null;
  }

  /**
   * A line over the messages while a chat is opened: its file read and its last turns drawn. It
   * fades in after a moment, so a chat that opens at once does not flash it. Removed by the caller.
   */
  private showOpening(title: string | null): HTMLElement {
    return (this.messagesEl.parentElement ?? this.messagesEl).createDiv({ cls: 'vc-opening', text: `Opening “${title ?? 'chat'}”…` });
  }

  /**
   * Draws a chat from the history. A long one draws only its last turns; the earlier ones are kept
   * as data, with a line above the drawn ones, and drawn when needed: scrolling up to the top, Show
   * all on the line, find stepping back into them, or the list of your messages going to one.
   * `readMs`: how long the chat's file took to read, for the log.
   */
  private renderHistory(chat: LoadedChat, running: boolean, readMs: number): void {
    const drawStart = performance.now();
    const { tail, earlier } = historyParts(chat.transcript, TAIL_TURNS);
    // Only the diffs are kept for the earlier turns, not the whole chat read.
    const { edits } = chat;
    // Made first, so that its line goes in above the last turns, drawn below it.
    const drawing: EarlierDrawing | null =
      earlier.length === 0
        ? null
        : new EarlierDrawing(earlier, this.messagesEl, {
            scroller: this.messagesEl,
            drawTurn: (turn, holder) => this.drawSavedTurn(turn, holder, edits),
            held: () => this.contentEl.ownerDocument.querySelector('.modal-container, body > .menu') !== null,
            caughtUp: (done) => {
              if (done && this.earlier === drawing) this.earlier = null;
              this.promptNav.schedule();
              this.findBar.refresh();
              this.checkEarlier();
            },
          });
    this.renderTranscript(tail, { running, edits });
    log(
      `opening a chat: ${chat.transcript.length} messages; file read in ${readMs} ms;`,
      `last ${tail.length} drawn in ${Math.round(performance.now() - drawStart)} ms; ${earlier.length} earlier turns kept undrawn`,
    );
    if (!drawing) return;
    this.earlier = drawing;
    // Once the chat is scrolled to its end: drawn turns shorter than the panel need the next ones at once.
    void Promise.resolve().then(() => this.checkEarlier());
  }

  /** Scrolled to within a screen of the top of what is drawn: the next earlier turns. */
  private checkEarlier(): void {
    const el = this.messagesEl;
    const earlier = this.earlier;
    if (earlier?.idle && el.scrollTop < el.clientHeight) void earlier.draw(EARLIER_STEP_TURNS);
  }

  /**
   * Draws one of a long chat's earlier turns into `holder`, with a draw state of its own: the chat
   * on screen, whose last reply may still be streaming (a chat brought back from the background),
   * is left as it is.
   */
  private drawSavedTurn(turn: SessionMessage[], holder: HTMLElement, edits: Map<string, unknown>): void {
    const live = this.draw;
    this.draw = { parent: holder, turn: null, group: null, liveText: null, turnHadText: false };
    try {
      this.renderTranscript(turn, { edits, earlier: true });
      this.recordMentions(holder);
      this.countNotesSoon();
    } finally {
      this.draw = live;
    }
  }

  /** Whether output goes to the chat on screen: its phase, scrolling and streamed text are touched only then. */
  private drawingLive(): boolean {
    return this.draw === this.liveDraw;
  }

  /**
   * Draws saved messages into the current draw state. `running`: the chat is still working, so the
   * last reply is unfinished. `edits`: the tool results with diffs, by tool_use_id, which the
   * transcript lacks. `earlier`: one of a long chat's earlier turns (see drawSavedTurn), which
   * leaves the model shown and the message ↑ brings back as they are.
   */
  private renderTranscript(
    transcript: SessionMessage[],
    { running = false, edits, earlier = false }: { running?: boolean; edits?: Map<string, unknown>; earlier?: boolean } = {},
  ): void {
    const added: string[] = [];
    let lastModel: string | null = null;
    let lastPrompt: string | null = null;
    // How long each kind of part took to draw, for the log.
    const spent: Record<string, number> = {};
    const timed = <T>(kind: string, run: () => T): T => {
      const start = performance.now();
      try {
        return run();
      } finally {
        spent[kind] = (spent[kind] ?? 0) + performance.now() - start;
      }
    };
    // Each message's errors are caught below, so the flag is always cleared after the loop.
    this.drawingSaved = true;
    for (const message of transcript) {
      if (message.parent_tool_use_id !== null) continue;
      // One message that cannot be drawn is left out, not the rest of the chat: an error here would
      // otherwise stop the chat opening, and a chat brought back from the background would lose
      // its running session, which is attached after its saved messages are drawn.
      try {
        if (message.type === 'system') {
          const boundary = message.message as { subtype?: string; trigger?: unknown; preTokens?: unknown } | null;
          if (boundary?.subtype === 'compact_boundary') this.renderCompaction(boundary.trigger, boundary.preTokens);
          continue;
        }
        const content = (message.message as { content?: unknown } | null)?.content;
        const model = (message.message as { model?: unknown } | null)?.model;
        if (message.type === 'assistant' && typeof model === 'string' && model !== '<synthetic>') lastModel = model;
        if (message.type === 'user') {
          if (Array.isArray(content)) {
            for (const block of content as ContentBlock[]) {
              if (block.type !== 'tool_result' || !block.tool_use_id) continue;
              timed('tool results', () => this.finishTool(block.tool_use_id ?? '', block.is_error === true, edits?.get(block.tool_use_id ?? ''), true));
            }
          }
          const prompt = messagePrompt(message);
          if (prompt) lastPrompt = timed('prompts', () => this.renderHistoricUser(prompt.text, prompt.images, message.uuid, sentUuidOf(message))) ?? lastPrompt;
        } else if (message.type === 'assistant' && Array.isArray(content)) {
          let textIndex = 0;
          for (const block of content as ContentBlock[]) {
            if (block.type === 'text' && block.text?.trim()) {
              const text = block.text;
              timed('replies', () => this.finishText(text, replyKey(message.uuid, textIndex)));
              textIndex += 1;
            } else if (block.type === 'thinking' && block.thinking) {
              const thinking = block.thinking;
              timed('thinking', () => this.renderThinking(thinking));
            }
            else if (block.type === 'tool_use' && block.id && block.name) {
              const input = (block.input ?? {}) as Record<string, unknown>;
              const [id, name] = [block.id, block.name];
              timed('tool calls', () => this.addTool(id, name, input));
              added.push(block.id);
            }
          }
          const turn = this.draw.turn;
          if (turn) timed('branch points', () => this.setBranchPoint(turn, content as ContentBlock[], message.uuid));
        }
      } catch (error) {
        log('drawing a saved message failed', error);
      }
    }
    this.drawingSaved = false;
    // Tool calls with no recorded result (after an interrupt, or a message that failed to draw) are
    // closed out as done: left running, they would hold the phase on their label.
    for (const id of added) {
      const entry = this.tools.get(id);
      if (entry?.status !== 'running') continue;
      entry.status = 'done';
      entry.lineEl?.removeClass('is-running');
      if (entry.group) this.updateToolGroup(entry.group);
    }
    if (transcript.length >= 50 && !earlier) log('drawing a chat, by part:', Object.entries(spent).map(([kind, ms]) => `${kind} ${Math.round(ms)} ms`).join('; '));
    const turns = [...this.draw.parent.querySelectorAll<HTMLElement>('.vc-turn')];
    // The turn still running is finished when it ends (see showBackground).
    this.unfinishedTurn = running ? (turns.pop() ?? null) : null;
    for (const turn of turns) this.finishTurnActions(turn);
    this.draw.turn = null;
    this.draw.group = null;
    if (earlier) return;
    if (lastPrompt) this.lastSent = lastPrompt;
    // A resumed chat continues on the model it last used; show that until the session reports in.
    if (lastModel) {
      this.currentModel = lastModel;
      this.populateModelSelect();
    }
  }

  /**
   * A saved prompt of yours (see promptBubble): its background-task notices, then its bubble and a
   * new turn for the reply, or the Stopped notice. Returns the bubble's text, for ↑.
   */
  /** `sentUuid`: the id a queued message was sent with, when its file holds it under another (see sentUuidOf). */
  private renderHistoricUser(raw: string, images: Chip[] = [], uuid?: string, sentUuid?: string): string | null {
    if (raw.includes('<task-notification>')) for (const notice of parseTaskNotifications(raw).notices) this.renderTaskNotice(notice);
    const bubble = promptBubble(raw, images);
    if (bubble === 'stopped') this.renderNotice('Stopped.', 'vc-muted');
    if (!bubble || bubble === 'stopped') return null;
    try {
      const drawn = this.renderUserBubble(bubble.text, bubble.chips, undefined, uuid);
      if (sentUuid) drawn.dataset.sentUuid = sentUuid;
    } finally {
      // The reply gets a turn of its own even when the bubble could not be drawn whole, rather than
      // joining the exchange before it.
      this.draw.turn = this.draw.parent.createDiv({ cls: 'vc-turn' });
      this.draw.group = null;
      this.dropLive();
      this.draw.liveText = null;
    }
    return bubble.text || null;
  }

  // ---- Branches ----------------------------------------------------------

  /**
   * Records where a branch cut after this reply would end: the reply's latest message, unless
   * that is a tool call (a copy ending on a call with no result is not a finished conversation).
   */
  private setBranchPoint(turn: HTMLElement, blocks: { type?: string }[], uuid: string): void {
    if (blocks.some((block) => block.type === 'tool_use')) delete turn.dataset.branchUuid;
    else turn.dataset.branchUuid = uuid;
  }

  /** A reply's text as Markdown, with the reader's checkbox ticks; read when Copy or Insert is clicked. */
  private replyMarkdown(textEls: HTMLElement[]): string {
    return textEls
      .map((el) => applyTicks(this.markdownSource.get(el) ?? '', this.replyTicks.get(el) ?? new Set()))
      .join('\n\n');
  }

  /**
   * A finished reply's steps — tool calls, thinking and approvals — fold into one line; a click
   * opens them. Only a run of two or more: a lone group is already one line. What Claude wrote
   * stays where it is and stays open, so a reply that speaks between steps can still be read.
   */
  private foldSteps(turn: HTMLElement): void {
    if (turn.hasClass('has-folded-steps')) return;
    turn.addClass('has-folded-steps');
    // Steps folded early, above a plan or questions (see foldStepsBefore), fold again with the rest.
    for (const early of Array.from(turn.querySelectorAll<HTMLElement>(':scope > .vc-steps'))) {
      early.replaceWith(...Array.from(early.querySelector('.vc-steps-body')?.children ?? []));
    }
    // Text that was only white space between two steps does not end their run, which would split one
    // fold into two with nothing between: it is removed. Judged by its source, not by what is on
    // screen, since a reply's Markdown is still being rendered when a chat opened from the history folds.
    const runs: HTMLElement[][] = [];
    let run: HTMLElement[] = [];
    let gap: HTMLElement[] = [];
    for (const el of Array.from(turn.children) as HTMLElement[]) {
      if (isTrailer(el)) continue;
      if (isStep(el)) {
        for (const empty of gap) empty.remove();
        run.push(el);
        gap = [];
      } else if (run.length > 0 && this.isBlankText(el)) {
        gap.push(el);
      } else {
        if (run.length > 0) runs.push(run);
        run = [];
        gap = [];
      }
    }
    if (run.length > 0) runs.push(run);
    for (const steps of runs) if (steps.length >= 2) this.foldRun(turn, steps);
  }

  /**
   * The run of steps just before `card` (a plan, or questions, waiting on you), folded into one line
   * so the card stands out while the reply is still going; at its end they fold again with the rest
   * of its steps (see foldSteps). A lone step is already one line.
   */
  private foldStepsBefore(card: HTMLElement): void {
    const turn = card.parentElement;
    if (!turn?.hasClass('vc-turn') || turn.hasClass('has-folded-steps')) return;
    const run: HTMLElement[] = [];
    for (let el = card.previousElementSibling as HTMLElement | null; el; el = el.previousElementSibling as HTMLElement | null) {
      // The reply's status line is kept last (see scrollToBottom), and so sits just before a card when it arrives.
      if (isTrailer(el)) continue;
      if (isStep(el)) run.unshift(el);
      // Text with nothing in it (white space between steps) is passed over, left where it is.
      else if (!this.isBlankText(el)) break;
    }
    if (run.length >= 2) this.foldRun(turn, run);
  }

  /**
   * Text that is only white space, judged by its source, not by what is on screen: a reply's
   * Markdown is still being rendered when a chat opened from the history folds.
   */
  private isBlankText(el: HTMLElement): boolean {
    return el.hasClass('vc-text') && !(this.markdownSource.get(el) ?? el.textContent ?? '').trim();
  }

  /** One run of consecutive steps, folded in place. */
  private foldRun(turn: HTMLElement, steps: HTMLElement[]): void {
    const fold = turn.createDiv({ cls: 'vc-steps is-collapsed' });
    turn.insertBefore(fold, steps[0]);
    // `data-expand`: find in chat opens the fold to show a match inside it.
    const header = fold.createDiv({ cls: 'vc-steps-header', attr: { 'data-expand': '' } });
    const body = fold.createDiv({ cls: 'vc-steps-body' });
    for (const el of steps) body.appendChild(el);
    const tools = body.querySelectorAll('.vc-tools:not(.vc-thinking) .vc-tool').length;
    const thoughts = body.querySelectorAll(':scope > .vc-thinking').length;
    const parts = [tools && plural(tools, 'tool call'), thoughts && plural(thoughts, 'thought')].filter(Boolean);
    setIcon(header.createSpan({ cls: 'vc-tools-chevron' }), 'chevron-right');
    header.createSpan({ cls: 'vc-tools-text', text: `Steps: ${parts.join(', ') || plural(steps.length, 'step')}` });
    const failed = body.querySelectorAll('.vc-tool.is-error').length;
    if (failed > 0) header.createSpan({ cls: 'vc-tools-failed', text: `${failed} failed` });
    header.addEventListener('click', () => fold.toggleClass('is-collapsed', !fold.hasClass('is-collapsed')));
  }

  /**
   * Adds the hover buttons to a finished reply: reply to it, copy or insert its text, save it as a
   * memo, and branch from it if it has a branch point; in the scratch chat, the branch carries it on
   * as a chat.
   */
  private finishTurnActions(turn: HTMLElement, stats?: { text: string; title: string }): void {
    // A finished reply's changed files fold to their header; a click opens the list again.
    this.changeCards.get(turn)?.fold(true);
    this.foldSteps(turn);
    if (turn.hasClass('has-actions')) return;
    // The reply's text parts, including those folded into its steps.
    const textEls = Array.from(turn.querySelectorAll<HTMLElement>(':scope > .vc-text, :scope > .vc-steps > .vc-steps-body > .vc-text')).filter(
      (child) => (this.markdownSource.get(child) ?? '').trim().length > 0,
    );
    const uuid = turn.dataset.branchUuid;
    if (textEls.length === 0 && !uuid && !stats) return;
    turn.addClass('has-actions');
    const actions = turn.createDiv({ cls: 'vc-turn-actions' });
    if (stats) actions.createSpan({ cls: 'vc-turn-stats', text: stats.text, attr: { title: stats.title } });
    if (textEls.length > 0) {
      // Answering a reply further up: it goes into the input as a quote, and the cursor with it.
      const reply = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Reply to this' } });
      setIcon(reply, 'reply');
      reply.addEventListener('click', () => this.quoteText(this.replyMarkdown(textEls)));
      const copy = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Copy reply' } });
      setIcon(copy, 'copy');
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(this.replyMarkdown(textEls)).then(
          () => {
            setIcon(copy, 'check');
            window.setTimeout(() => setIcon(copy, 'copy'), 1500);
          },
          (error: unknown) => {
            log('copying the reply failed', error);
            new Notice('Could not copy the reply.');
          },
        );
      });
      const insert = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Insert into note' } });
      setIcon(insert, 'file-input');
      insert.addEventListener('click', (evt) => this.onInsertClick(evt, this.replyMarkdown(textEls)));
      const memo = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': `Save as a memo (${ALT_CLICK}: at once, as a bookmark)` } });
      setIcon(memo, 'sticky-note');
      memo.addEventListener('click', (evt) => {
        const passages = this.replyPassages(turn, textEls);
        if (evt.altKey) void this.saveBookmark(passages);
        else void this.openMemoForm(passages);
      });
    }
    if (uuid) {
      turn.addClass('has-branch');
      const branch = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': this.scratch ? 'Continue as a chat' : 'Branch from here' } });
      setIcon(branch, this.scratch ? 'message-square-plus' : 'git-branch');
      branch.addEventListener('click', (evt) => this.onBranchClick(evt, uuid));
      // A scratch reply that made a note offers, in view, to carry on with it in a chat of its own.
      const note = this.scratch ? this.changeCards.get(turn)?.createdNotes()[0] : undefined;
      if (note) {
        const button = turn.createDiv({ cls: 'vc-continue-line', attr: { 'data-no-find': '' } }).createEl('button', { cls: 'vc-continue-button' });
        setIcon(button.createSpan({ cls: 'vc-continue-icon' }), 'message-square-plus');
        button.createSpan({ text: `Continue in a chat about “${noteName(note)}”` });
        button.addEventListener('click', () => void this.branch(uuid, true));
      }
    }
  }

  /** Writes a reply to a new note, beside the saved chats, and opens it. */
  private async replyToNewNote(markdown: string, title: string): Promise<void> {
    try {
      const path = await this.savedNotePath(formatDate(Date.now()).slice(0, 10), title || 'Claude reply');
      const file = await this.app.vault.create(path, `${markdown}\n`);
      await this.app.workspace.getLeaf('tab').openFile(file);
      new Notice(`Saved to ${path}.`);
    } catch (error) {
      log('saving the reply as a note failed', error);
      new Notice(`Could not save the reply: ${errorText(error)}`);
    }
  }

  /** `upTo`: the message the branch from this reply ends with. */
  private onBranchClick(evt: MouseEvent, upTo: string): void {
    const what = this.scratch ? 'Continue as a chat' : 'Branch';
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(`${what} in a new tab`).setIcon('plus-square').onClick(() => void this.branch(upTo, true)));
    menu.addItem((item) => item.setTitle(`${what} in this panel`).setIcon(this.scratch ? 'message-square-plus' : 'git-branch').onClick(() => void this.branch(upTo, false)));
    menu.showAtMouseEvent(evt);
  }

  /** A message of yours, `uuid`: copy it and what follows to a new chat, move it there or to another chat, or remove it from here on. */
  private onMessageMenu(evt: MouseEvent, uuid: string, text: string): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle('Copy from here on to a new chat').setIcon('copy-plus').onClick(() => void this.branch(undefined, true, uuid)));
    menu.addItem((item) => item.setTitle('Move from here on to a new chat').setIcon('square-arrow-out-up-right').onClick(() => this.moveToNewChat(uuid)));
    menu.addItem((item) => item.setTitle('Send this message to another chat…').setIcon('send').onClick(() => void this.sendToOtherChat(uuid, text)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Remove from here on').setIcon('trash-2').setWarning(true).onClick(() => this.confirmRemoveFrom(uuid)));
    menu.showAtMouseEvent(evt);
  }

  /**
   * What removing from message `uuid` on takes: how many messages of yours and replies, and the notes
   * those replies changed (which stay as they are). Null, with a notice, when it cannot be done now:
   * while Claude works, in a chat not started in the panel (whose copy is made on its next message),
   * or while another panel has the chat open.
   */
  private removalFrom(uuid: string): { id: string; messages: number; replies: number; notes: string[] } | null {
    const id = this.chatId;
    if (!id || !this.plugin.vaultRoot()) {
      new Notice(this.resumeId ? 'This chat started outside the panel: send a message first, which makes its copy here.' : 'Nothing to remove yet.');
      return null;
    }
    if (this.scratch) {
      new Notice('The scratch chat is cleared rather than cut: use Start over, or copy what you want to keep to a new chat first.');
      return null;
    }
    const blocked = this.cutBlocked(id);
    if (blocked) {
      new Notice(blocked);
      return null;
    }
    const bubble = this.messagesEl.querySelector<HTMLElement>(`.vc-user[data-uuid="${uuid}"]`);
    if (!bubble) return null;
    const order = [...this.messagesEl.querySelectorAll<HTMLElement>('.vc-user, .vc-turn')];
    // Nothing would be left: a chat with no message cannot be opened again.
    if (order[0] === bubble && !this.earlier) {
      new Notice('This is the chat’s first message: delete the chat instead, from the history.');
      return null;
    }
    const after = order.slice(order.indexOf(bubble));
    const turns = after.filter((el) => el.hasClass('vc-turn'));
    const notes = [...new Set(turns.flatMap((turn) => this.changeCards.get(turn)?.changedNotes() ?? []))];
    return { id, messages: after.filter((el) => el.hasClass('vc-user')).length, replies: turns.length, notes };
  }

  /**
   * Why chat `id` cannot be cut now, or null when it can: its process is ended for the cut, which
   * would stop a reply, a message waiting, a background task or the phone link, and another panel
   * holding it would go on writing to its file.
   */
  private cutBlocked(id: string): string | null {
    if (this.plugin.chatHolder(id, this)) return 'This chat is open in another panel too. Open another chat there first.';
    if ([...this.background].some((entry) => entry.chatId === id)) return 'This chat is still running in the background. Wait for it to finish.';
    if (this.chatId !== id) return null;
    if (this.busy || this.pending.size > 0) return 'Claude is still working. Stop it, or wait for the reply, then remove.';
    if (this.tasks.size > 0) return 'A background task of this chat is still running, and ending the chat would stop it. Wait for it to end.';
    if (this.remoteUrl) return 'This chat is on your phone, and ending it would end that link. Take it off the phone first.';
    return null;
  }

  /** What a removal takes, in words: "this message and 2 replies", and the notes changed that stay. */
  private removalWords(removal: { messages: number; replies: number; notes: string[] }): string {
    const messages = removal.messages > 1 ? `this message, ${removal.messages - 1} later one${removal.messages === 2 ? '' : 's'}` : 'this message';
    const replies = removal.replies === 0 ? '' : ` and ${removal.replies} repl${removal.replies === 1 ? 'y' : 'ies'}`;
    const notes = removal.notes.length === 0 ? '' : ` The notes they changed stay as they are: ${removal.notes.join(', ')}.`;
    return `${messages}${replies}.${notes}`;
  }

  private confirmRemoveFrom(uuid: string): void {
    const removal = this.removalFrom(uuid);
    if (!removal) return;
    new ConfirmModal(this.app, 'Remove from here on', `This removes ${this.removalWords(removal)} For 10 seconds afterwards, Undo in the notice at the top right puts it back.`, 'Remove', () => void this.removeFrom(removal.id, uuid, true)).open();
  }

  /**
   * Removes message `uuid` and everything after it from chat `id`, on screen, in place, so the chat
   * keeps its id and what is linked to it: its process is ended, its file cut (see cutChat), and it is
   * opened again (unless `reopen` is false). A notice offers to put it back; `copy`, the chat the part
   * removed was moved to, goes when it is. What it left beside the file goes once the offer has
   * passed (see deleteCutLeftovers). Whether it was removed.
   */
  private async removeFrom(id: string, uuid: string, reopen: boolean, copy?: string): Promise<boolean> {
    const root = this.plugin.vaultRoot();
    if (!root) return false;
    // Checked again: the chat may have changed while the dialog was open, or a copy was made.
    const blocked = this.chatId === id ? this.cutBlocked(id) : 'The chat is no longer on screen.';
    if (blocked) {
      new Notice(`Not removed: ${blocked}`);
      return false;
    }
    const item: HistoryItem = { id, title: this.chatName ?? 'Untitled chat', updatedAt: Date.now(), fromPanel: true };
    // The notes the part removed changed, read while it is still on screen.
    const changed = this.removalFrom(uuid)?.notes ?? [];
    // Its process ends first, and its file is cut once it has exited: it writes to the file as it exits.
    this.newChat();
    await this.plugin.processesEnded(id);
    let done: { kept: string; cut: string };
    try {
      done = await cutChat(id, root, uuid);
    } catch (error) {
      log('removing from a message failed', error);
      new Notice(`Could not remove it: ${errorText(error)}`);
      await this.openChat(item);
      return false;
    }
    log('removed from a message', { chat: id, from: uuid });
    // Notes only the removed part changed no longer list the chat as having changed them.
    const dropped = await this.plugin.unlinkRemovedEdits(id, changed);
    // What went with the part removed (project context, a summary of it) is no longer in the chat.
    this.plugin.contextLeft(id, true);
    if (reopen) await this.openChat(item);
    let undoing = false;
    let leftovers = 0;
    const later = () => {
      leftovers = window.setTimeout(() => void deleteCutLeftovers(id, root, done).catch((error: unknown) => log('deleting what a removal left failed', error)), REMOVAL_UNDO_MS + 1000);
    };
    later();
    const notice = createFragment((el) => {
      el.appendText(copy ? `Moved from “${item.title}”. ` : `Removed from “${item.title}”. `);
      el.createEl('a', { text: 'Undo' }).addEventListener('click', () => {
        if (undoing) return;
        undoing = true;
        window.clearTimeout(leftovers);
        void this.undoRemove(item, done, dropped, copy).then((put) => {
          if (put) return;
          undoing = false;
          later();
        });
      });
    });
    new Notice(notice, REMOVAL_UNDO_MS);
    return true;
  }

  /**
   * Puts back what removeFrom took, when nothing was added to the chat since, and the note links it
   * dropped (`dropped`); `copy`, the chat it was moved to, is deleted. The chat is shown again.
   * Whether it was put back.
   */
  private async undoRemove(item: HistoryItem, done: { kept: string; cut: string }, dropped: string[], copy?: string): Promise<boolean> {
    const root = this.plugin.vaultRoot();
    if (!root) return false;
    const blocked = this.cutBlocked(item.id) ?? (copy ? this.cutBlocked(copy) : null);
    if (blocked) {
      new Notice(`It could not be put back: ${blocked}`);
      return false;
    }
    if (this.chatId === item.id || (copy && this.chatId === copy)) this.newChat();
    await this.plugin.processesEnded(item.id);
    const put = await uncutChat(item.id, root, done).catch((error: unknown) => {
      log('undoing a removal failed', error);
      return false;
    });
    if (put) {
      for (const path of dropped) this.plugin.linkNoteChat(path, item.id, false);
      // The moved part is back where it was: its copy would hold it a second time.
      if (copy) await this.plugin.deleteChat(copy);
    }
    new Notice(put ? `Put back in “${item.title}”.` : 'It could not be put back: the chat has changed since.');
    await this.openChat(item);
    return put;
  }

  /** Copies message `uuid` and what follows to a new chat, removes them here, and shows the new chat. */
  private moveToNewChat(uuid: string): void {
    const removal = this.removalFrom(uuid);
    if (!removal) return;
    new ConfirmModal(this.app, 'Move to a new chat', `This moves ${this.removalWords(removal)}`, 'Move', async () => {
      // All of it to the end, as all of it is cut here.
      const copy = await this.branch(undefined, false, uuid, false, true);
      if (!copy) return;
      if (!(await this.removeFrom(removal.id, uuid, false, copy))) {
        // Not cut here: the copy would hold the same messages a second time, and goes.
        await this.plugin.deleteChat(copy);
        return;
      }
      // The copy holds the part moved: the notes that part changed list it.
      for (const path of removal.notes) this.plugin.linkNoteChat(path, copy, false);
      await this.openChat({ id: copy, title: this.plugin.chatTitleOf(copy), updatedAt: Date.now(), fromPanel: true });
    }).open();
  }

  /**
   * Sends message `uuid`'s text to another chat, chosen: it goes into that chat's input to send there.
   * It may be removed here first, with what followed it. Its attachments are not carried.
   */
  private async sendToOtherChat(uuid: string, text: string): Promise<void> {
    const chats = (await this.plugin.listChats().catch(() => [] as HistoryItem[])).filter((item) => !item.scratch && item.id !== this.chatId).map((item) => ({ id: item.id, title: item.title }));
    if (chats.length === 0) {
      new Notice('There is no other chat to send it to.');
      return;
    }
    new ChatPicker(
      this.app,
      chats,
      (target) => {
        const id = this.chatId;
        const send = async (remove: boolean) => {
          if (remove && (!id || !(await this.removeFrom(id, uuid, false)))) return;
          const view = await this.plugin.openChatById(target.id, target.title);
          if (!view) {
            new Notice('That chat could not be opened. The message is in your clipboard.');
            await navigator.clipboard.writeText(text).catch(() => undefined);
            return;
          }
          view.addToInput(text, 'Message moved here');
        };
        const removal = this.chatId ? this.removalFrom(uuid) : null;
        if (!removal) return void send(false);
        new ChoiceModal(this.app, `Send to “${target.title}”`, `Its text goes into that chat's input. Removing it here as well takes ${this.removalWords(removal)}`, [
          ['Remove here and send', () => void send(true)],
          ['Send, keep it here', () => void send(false)],
        ]).open();
      },
      'Send this message to…',
    ).open();
  }

  async branchIntoNewTab(): Promise<void> {
    await this.branch(undefined, true);
  }

  /**
   * Copies this chat into a new one (up to `upTo`, or all of it; from message `start` of yours on,
   * or from its beginning) and opens the copy in a new tab or in place of this chat, which then
   * keeps running in the background if it is working. A copy of the scratch chat carries it on as a
   * chat of its own, linked to the notes it changed; a copy from a message on, or of the scratch
   * chat, is named for what it holds (see copyTitle). The chat copied stays as it is. `open` false:
   * the copy is made and recorded only. Its id; null when none was made.
   */
  private async branch(upTo: string | undefined, newTab: boolean, start?: string, open = true, whole = false): Promise<string | null> {
    const source = this.chatId ?? this.resumeId;
    const root = this.plugin.vaultRoot();
    if (!source || !root) {
      new Notice('Nothing to branch yet.');
      return null;
    }
    // The last finished reply: a reply in progress, or one stopped before it finished, is left out.
    const finished = this.messagesEl.querySelectorAll<HTMLElement>('.vc-turn.has-branch');
    const lastFinished = finished[finished.length - 1]?.dataset.branchUuid;
    if (!upTo && (this.busy || start) && !whole) {
      upTo = lastFinished;
      if (!upTo) {
        new Notice('Nothing to branch yet: Claude has not finished a reply in this chat.');
        return null;
      }
    }
    // `whole`: the copy goes to the end, whatever is there (the chat is idle).
    const repliesTo = upTo ?? lastFinished;
    const startBubble = start ? this.messagesEl.querySelector<HTMLElement>(`.vc-user[data-uuid="${start}"]`) : null;
    const replies = startBubble && repliesTo ? this.repliesFrom(startBubble, repliesTo) : [];
    if (start && replies.length === 0) {
      new Notice('Nothing to copy yet: Claude has not finished replying to that message.');
      return null;
    }
    const from: BranchSource = {
      title: this.chatName ?? 'Untitled chat',
      mode: this.mode,
      modelOverride: this.modelOverride,
      effortOverride: this.effortOverride,
      scratch: this.scratch,
    };
    const title = start ? this.copyTitle(replies, startBubble) : this.scratch ? this.continuedTitle(upTo) : branchTitle(from.title);
    let id: string;
    try {
      id = start ? await branchChatFrom(source, root, title, start, upTo) : await branchChat(source, root, title, upTo);
    } catch (error) {
      log('branching failed', error);
      new Notice(`Could not ${start ? 'copy' : 'branch'} this chat: ${errorText(error)}`);
      return null;
    }
    log('branched chat', { from: source, to: id, upTo: upTo ?? null });
    this.plugin.recordChat(id, title);
    // The scratch chat links no notes; carried on as a chat, the notes it changed are that chat's.
    if (from.scratch) await this.linkChangedNotes(id, root);
    if (!open) return id;
    const target = newTab ? await this.plugin.openChatTab(this.leaf) : this;
    if (!target) {
      new Notice('Could not open a new tab. The branch is in the chat history.');
      return null;
    }
    await target.openChat({ id, title, updatedAt: Date.now(), fromPanel: true }, from);
    return id;
  }

  /** The name of the scratch chat carried on up to reply `upTo` (the last finished one when unset); see copyTitle. */
  private continuedTitle(upTo: string | undefined): string {
    const turns = [...this.messagesEl.querySelectorAll<HTMLElement>('.vc-turn.has-branch')];
    const turn = upTo ? turns.find((each) => each.dataset.branchUuid === upTo) : turns[turns.length - 1];
    if (!turn) return 'Untitled chat';
    // The prompt's bubble comes before its turn, after any background-task notices.
    let el = turn.previousElementSibling;
    while (el && !el.hasClass('vc-user') && !el.hasClass('vc-turn')) el = el.previousElementSibling;
    return this.copyTitle([turn], el?.hasClass('vc-user') ? el : null);
  }

  /** A copy's name: the first note its `replies` created, else the text of `prompt`, the message of yours it begins with or answers. */
  private copyTitle(replies: HTMLElement[], prompt: Element | null): string {
    for (const reply of replies) {
      const note = this.changeCards.get(reply)?.createdNotes()[0];
      if (note) return noteName(note);
    }
    return chatTitle(prompt?.querySelector('.vc-user-text')?.textContent ?? '');
  }

  /** The finished replies from message `start` of yours on, up to and including reply `upTo`: the reply holding it (a message sent while Claude worked), if any, and those after it. */
  private repliesFrom(start: HTMLElement, upTo: string): HTMLElement[] {
    // In the order they are drawn.
    const order = [...this.messagesEl.querySelectorAll<HTMLElement>('.vc-user, .vc-turn.has-branch')];
    const turns = order.filter((el) => el.hasClass('vc-turn'));
    const end = turns.findIndex((turn) => turn.dataset.branchUuid === upTo);
    const at = order.indexOf(start);
    return turns.slice(0, end + 1).filter((turn) => turn.contains(start) || order.indexOf(turn) > at);
  }

  /** Links the notes chat `id`'s saved edits changed to it, as edits made now (see renderEdit). */
  private async linkChangedNotes(id: string, root: string): Promise<void> {
    try {
      const { transcript, edits } = await loadChat(id, root);
      for (const file of savedChangedFiles(transcript, edits)) {
        const path = vaultRelative(file, root);
        if (path) this.plugin.linkNoteChat(path, id);
      }
    } catch (error) {
      log('linking the notes of a chat carried on from the scratch chat failed', error);
    }
  }

  // ---- Replies and chats into notes --------------------------------------

  /** Inserts a reply into the note last worked in, at the cursor or at the end. */
  private onInsertClick(evt: MouseEvent, markdown: string): void {
    const view = this.lastMarkdownView;
    const file = view?.file ?? null;
    const stillOpen = view !== null && this.app.workspace.getLeavesOfType('markdown').some((leaf) => leaf.view === view);
    const menu = new Menu();
    // A new note is always on offer; the other two need a note you were working in.
    menu.addItem((item) =>
      item
        .setTitle('Save as a new note')
        .setIcon('file-plus')
        .onClick(() =>
          new RenameModal(this.app, this.chatName ?? 'Claude reply', (title) => void this.replyToNewNote(markdown, title), 'New note').open(),
        ),
    );
    if (!view || !file || !stillOpen) {
      menu.showAtMouseEvent(evt);
      return;
    }
    menu.addItem((item) =>
      item
        .setTitle(`Insert at cursor in “${file.basename}”`)
        .setIcon('text-cursor-input')
        .onClick(() => {
          view.editor.replaceSelection(markdown);
          new Notice(`Inserted into “${file.basename}”.`);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle(`Append to “${file.basename}”`)
        .setIcon('arrow-down-to-line')
        .onClick(() => {
          this.app.vault
            .process(file, (data) => `${data.replace(/\s+$/, '')}\n\n${markdown}\n`)
            .then(() => new Notice(`Appended to “${file.basename}”.`))
            .catch((error: unknown) => {
              log('appending the reply failed', error);
              new Notice('Could not append the reply.');
            });
        }),
    );
    menu.showAtMouseEvent(evt);
  }

  /** This chat's id, title, today's date and transcript, for saving it; null (with a notice) when there is none. */
  private async chatForSaving(): Promise<{ id: string; title: string; date: string; transcript: SessionMessage[] } | null> {
    const id = this.chatId ?? this.resumeId;
    const root = this.plugin.vaultRoot();
    if (!id || !root) {
      new Notice('Nothing to save yet.');
      return null;
    }
    try {
      const transcript = await loadTranscript(id, root);
      return { id, title: this.chatName ?? 'Untitled chat', date: formatDate(Date.now()).slice(0, 10), transcript };
    } catch (error) {
      log('loading transcript failed', error);
      new Notice('Could not read this chat.');
      return null;
    }
  }

  /** A free path for a new note in the saved-chats folder, `<date> <title><suffix>.md`; creates the folder if needed. */
  private async savedNotePath(date: string, title: string, suffix = '', subfolder = ''): Promise<string> {
    const setting = this.plugin.settings.savedChatsFolder.trim();
    const folder = normalizePath([setting, subfolder].filter(Boolean).join('/'));
    const name = `${date} ${title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Chat'}${suffix}`;
    const pathFor = (copy: string) => `${folder ? `${folder}/` : ''}${name}${copy}.md`;
    let path = pathFor('');
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n += 1) path = pathFor(` (${n})`);
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    return path;
  }

  /** Writes this chat's prompts and replies to a new note in the saved-chats folder and opens it. */
  async saveChatAsNote(): Promise<void> {
    const chat = await this.chatForSaving();
    if (!chat) return;
    const { id, title, date, transcript } = chat;
    try {
      const path = await this.savedNotePath(date, title);
      const file = await this.app.vault.create(path, chatToMarkdown(title, id, transcript, date, this.plugin.ticks[id]));
      await this.app.workspace.getLeaf('tab').openFile(file);
      new Notice(`Saved to ${path}.`);
      this.offerProjectAfterSave(id);
    } catch (error) {
      log('saving the chat failed', error);
      new Notice(`Could not save the chat: ${errorText(error)}`);
    }
  }

  /**
   * Asks Claude for a summary of this chat (one request with no tools, following the vault's
   * CLAUDE.md, on the summary model), saves it next to the saved chats and opens it.
   */
  async saveSummaryAsNote(): Promise<void> {
    const chat = await this.chatForSaving();
    if (!chat) return;
    const { id, title, date, transcript } = chat;
    // The prompts and replies, as Save chat as note writes them, without that note's frontmatter.
    const conversation = chatToMarkdown(title, id, transcript, date, this.plugin.ticks[id]).replace(/^---\n[\s\S]*?\n---\n\n/, '');
    const controller = new AbortController();
    this.summaryRuns.add(controller);
    const progress = new Notice(
      createFragment((frag) => {
        frag.appendText(`Summarizing “${title}”… `);
        const cancel = frag.createEl('a', { text: 'Cancel', href: '#' });
        cancel.addEventListener('click', (evt) => {
          evt.preventDefault();
          controller.abort();
          new Notice('Summary cancelled.');
        });
      }),
      0,
    );
    try {
      const answer = await this.plugin.summarizeChat({ title: `${title} — summary`, date, sessionId: id, transcript: conversation }, controller.signal);
      if (controller.signal.aborted) return;
      const path = await this.savedNotePath(date, title, ' — summary');
      const file = await this.app.vault.create(path, summaryNote(answer, { date, sessionId: id }));
      await this.app.workspace.getLeaf('tab').openFile(file);
      new Notice(`Saved the summary to ${path}.`);
      this.offerProjectAfterSave(id);
    } catch (error) {
      // Cancelled (from the notice, or by closing the panel): already reported, nothing saved.
      if (controller.signal.aborted) return;
      log('summarizing the chat failed', error);
      new Notice(`Could not summarize the chat: ${errorText(error)}`);
    } finally {
      progress.hide();
      this.summaryRuns.delete(controller);
    }
  }

  /** Attaches text selected in a note ("Ask Claude about selection") and focuses the input. */
  attachSelection(selection: SelectionAttachment): void {
    this.addAttachment(selection);
  }

  // ---- Input -------------------------------------------------------------

  private onInputKeydown(evt: KeyboardEvent): void {
    if (this.suggest.handleKey(evt)) return;
    // ↑ in an empty input brings back the last message, to edit and send again (after Stop, say).
    const plainKey = !evt.shiftKey && !evt.altKey && !evt.metaKey && !evt.ctrlKey && !evt.isComposing;
    if (evt.key === 'ArrowUp' && plainKey && this.inputEl.value === '' && this.lastSent) {
      evt.preventDefault();
      this.inputEl.value = this.lastSent;
      this.growInput();
      const end = this.inputEl.value.length;
      this.inputEl.setSelectionRange(end, end);
      return;
    }
    if (evt.key === 'Enter' && !evt.isComposing) {
      const modifier = evt.metaKey || evt.ctrlKey;
      const shouldSend = this.plugin.settings.sendWithModifier ? modifier : !evt.shiftKey && !modifier;
      if (shouldSend) {
        evt.preventDefault();
        void this.send();
      }
      return;
    }
    if (evt.key === '@') {
      evt.preventDefault();
      const start = this.inputEl.selectionStart;
      const end = this.inputEl.selectionEnd;
      const chats = this.scratch ? [] : (this.plugin.listedChats() ?? []).filter((item) => !item.scratch && item.id !== this.chatId).map((item) => ({ id: item.id, title: item.title }));
      new NotePicker(this.app, chats, (item) => {
        // A chat: a link to it, which links the chats once the message is sent.
        const text = item === null ? '@' : 'id' in item ? `${this.plugin.chatMarkdownLink(item.id)} ` : `@[[${this.mentionTarget(item)}]] `;
        this.inputEl.setRangeText(text, start, end, 'end');
        this.inputEl.focus();
        this.inputEdited();
      }).open();
    }
  }

  /** What goes inside `@[[…]]`: a note's link text, another file's path, a folder's path with a trailing `/`. */
  /** A link to note `file`, as the vault's links name it: `[[Name]]`, or its path where the name is not unique. */
  private wikilink(file: TFile): string {
    return `[[${this.app.metadataCache.fileToLinktext(file, '', true)}]]`;
  }

  private mentionTarget(item: TAbstractFile): string {
    if (item instanceof TFolder) return `${item.path}/`;
    if (item instanceof TFile && item.extension === 'md') return this.app.metadataCache.fileToLinktext(item, '', true);
    return item.path;
  }

  // ---- Attachments -------------------------------------------------------

  /**
   * The chips above the input: the files, images and selections attached to the next message, then
   * one for each note, file or folder its text @-mentions, which only editing the text takes away. A
   * mentioned note goes with its text, which its chip sizes; a click sends only its path, and another
   * takes the text again.
   */
  private renderTray(): void {
    const mentions = this.mentionedItems(this.inputEl.value);
    this.mentionKey = this.mentionsKey(mentions);
    this.trayEl.empty();
    this.trayEl.toggle(this.attachments.length + mentions.length > 0);
    this.attachments.forEach((attachment, index) => {
      renderChip(this.trayEl, chipFor(attachment), () => {
        this.attachments.splice(index, 1);
        this.renderTray();
      });
    });
    for (const { item, note } of mentions) {
      if (!note) {
        const folder = item instanceof TFolder;
        const label = folder ? `${item.name}/` : item.name;
        const what = folder ? 'Claude lists or reads it' : 'Claude reads the file';
        renderChip(this.trayEl, { label, icon: folder ? 'folder' : 'file', detail: 'path only', tooltip: `${label}: only its path goes; ${what} if it needs to` });
        continue;
      }
      const name = (item as TFile).basename;
      if (this.pathOnlyMentions.has(item.path)) {
        const chip = renderChip(this.trayEl, {
          label: name,
          icon: 'file-text',
          detail: 'path only',
          tooltip: `${name}: only its path goes; Claude reads the note if it needs to. Click to send its text.`,
        });
        chip.addClass('is-toggle');
        chip.addEventListener('click', () => {
          this.pathOnlyMentions.delete(item.path);
          this.renderTray();
        });
        continue;
      }
      const size = formatTokens(estimateTokens(Math.min((item as TFile).stat?.size ?? 0, MAX_NOTE_CHARS)));
      const chip = renderChip(this.trayEl, {
        label: name,
        icon: 'file-text',
        detail: size,
        tooltip: `${name}: its text goes with the message (${size}). Click to send only its path.`,
      });
      chip.addClass('is-toggle');
      chip.addEventListener('click', () => {
        this.pathOnlyMentions.add(item.path);
        this.renderTray();
      });
    }
  }

  /** Redraws the tray when the mentions in the input change; it follows each keystroke, so only then. */
  private followMentions(): void {
    if (!this.trayEl) return;
    const mentions = this.mentionedItems(this.inputEl.value);
    // A note no longer mentioned is no longer sent as a path only: mentioned again, it goes with its text.
    for (const path of this.pathOnlyMentions) if (!mentions.some(({ item }) => item.path === path)) this.pathOnlyMentions.delete(path);
    this.followMemoBoxes(mentions);
    if (this.mentionsKey(mentions) !== this.mentionKey) this.renderTray();
  }

  /**
   * A memo's Send box in the Memos base follows the input: ticked while the memo is mentioned in it,
   * cleared once it is not (sent, its mention deleted, another chat's text in the input).
   */
  private followMemoBoxes(mentions: Mention[]): void {
    const memos = new Set(
      mentions.filter(({ item }) => item instanceof TFile && this.app.metadataCache.getFileCache(item)?.frontmatter?.type === 'memo').map(({ item }) => item.path),
    );
    for (const path of memos) if (!this.mentionedMemos.has(path)) this.setMemoBox(path, true);
    for (const path of this.mentionedMemos) if (!memos.has(path)) this.setMemoBox(path, false);
    this.mentionedMemos = memos;
  }

  /**
   * A short message just under the panel's header, for a few seconds: a notice would sit over the
   * header's buttons, the very ones it is about.
   */
  private flashHint(text: string): void {
    const wrap = this.messagesEl.parentElement ?? this.contentEl;
    this.hintEl ??= wrap.createDiv({ cls: 'vc-hint' });
    this.hintEl.setText(text);
    // Below the bar naming the prompt, when it shows, clear of its buttons too.
    const bar = wrap.querySelector<HTMLElement>('.vc-question-bar');
    this.hintEl.style.top = `${(bar?.isShown() ? bar.offsetHeight : 0) + 8}px`;
    this.hintEl.show();
    if (this.hintTimer !== null) window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      this.hintTimer = null;
      this.hintEl?.hide();
    }, 3500);
  }

  /** Ticks or clears a memo's Send box; cleared only when no other panel still has the memo in its input. */
  private setMemoBox(path: string, on: boolean): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || (this.app.metadataCache.getFileCache(file)?.frontmatter?.send === true) === on) return;
    if (!on && this.plugin.mentionedElsewhere(path, this)) return;
    this.app.fileManager
      .processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        frontmatter.send = on;
      })
      .catch((error: unknown) => log('setting a memo box failed', error));
  }

  /** Whether the input @-mentions the file at `path`. */
  mentions(path: string): boolean {
    return this.mentionedItems(this.inputEl.value).some(({ item }) => item.path === path);
  }

  /** Takes the input's @-mentions of the file at `path` out: its memo's Send box was cleared in the Memos base. */
  unmention(path: string): void {
    const text = removeMentions(this.inputEl.value, (target) => this.mentionedItems(`@[[${target}]]`)[0]?.item.path === path);
    if (text === this.inputEl.value) return;
    this.inputEl.value = text;
    this.inputEdited();
  }

  private mentionsKey(mentions: Mention[]): string {
    return JSON.stringify([mentions.map(({ item }) => item.path), [...this.pathOnlyMentions]]);
  }

  /** The notes, files and folders `text` @-mentions that are in the vault, each once, in order. */
  private mentionedItems(text: string): Mention[] {
    const mentions: Mention[] = [];
    const seen = new Set<string>();
    for (const target of mentionTargets(text)) {
      // Folders and files other than notes go by path; Claude lists, searches or reads them itself.
      const item = target.endsWith('/') ? this.app.vault.getAbstractFileByPath(normalizePath(target)) : this.app.metadataCache.getFirstLinkpathDest(target, '');
      if (!(item instanceof TFolder) && !(item instanceof TFile)) continue;
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      mentions.push({ item, note: item instanceof TFile && item.extension === 'md' });
    }
    return mentions;
  }

  /** `uuid`: the message's own, in the chat's file; with it, the bubble offers to copy the chat from it on. */
  private renderUserBubble(text: string, chips: Chip[], parent: HTMLElement = this.draw.parent, uuid?: string): HTMLElement {
    const bubble = parent.createDiv({ cls: 'vc-user' });
    if (uuid) {
      bubble.dataset.uuid = uuid;
      const copy = bubble.createEl('button', { cls: 'clickable-icon vc-user-action', attr: { 'aria-label': 'Copy, move or remove from here on' } });
      setIcon(copy, 'arrow-down-from-line');
      copy.addEventListener('click', (evt) => this.onMessageMenu(evt, uuid, text));
    }
    if (text) {
      bubble.createDiv({ cls: 'vc-user-text', text });
      // A long message (pasted text, say) shows its first lines; the link unfolds it.
      const lines = text.split('\n').length;
      if (lines > LONG_MESSAGE_LINES || text.length > LONG_MESSAGE_CHARS) {
        addFoldToggle(bubble, 'vc-user-toggle', lines > 1 ? `Show all (${lines} lines)` : 'Show all');
      }
    }
    if (chips.length > 0) {
      const row = bubble.createDiv({ cls: 'vc-user-attachments' });
      for (const chip of chips) renderChip(row, chip);
    }
    return bubble;
  }

  /** Clears a queued message's mark; `forget` drops it from the pending list. */
  private markDelivered(id: string, forget = true): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.bubble.removeClass('is-queued');
    entry.bubble.querySelector('.vc-queued-label')?.remove();
    if (forget) this.pending.delete(id);
    else entry.running = true;
  }

  private addAttachment(attachment: Attachment): void {
    this.attachments.push(attachment);
    this.renderTray();
    this.inputEl.focus();
  }

  private async attachExternalFiles(files: File[]): Promise<void> {
    // Read while another chat is opened: they were meant for the chat they were given to.
    const generation = this.chatGeneration;
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const image = await imageFromBlob(file, file.name || 'Pasted image');
        if (generation !== this.chatGeneration) return;
        if (image) {
          this.addAttachment(image);
          continue;
        }
      }
      const path = filePathOf(file);
      if (!path) {
        new Notice(`Could not attach ${file.name || 'the file'}: its location on disk is not available.`);
        continue;
      }
      this.addAttachment({ kind: 'file', name: file.name || baseName(path), path });
    }
  }

  /** `generation`: the chat it was given to (see chatGeneration); nothing is attached once another is open. */
  private async attachVaultFile(file: TFile, generation = this.chatGeneration): Promise<void> {
    if (generation !== this.chatGeneration) return;
    if (file.extension === 'md') {
      const mention = `@[[${this.mentionTarget(file)}]] `;
      this.inputEl.setRangeText(mention, this.inputEl.selectionStart, this.inputEl.selectionEnd, 'end');
      this.inputEl.focus();
      this.inputEdited();
      return;
    }
    const image = await this.vaultImage(file);
    // Read while another chat is opened: it was meant for the chat it was given to.
    if (generation !== this.chatGeneration) return;
    if (image) {
      this.addAttachment(image);
      return;
    }
    const root = this.plugin.vaultRoot();
    this.addAttachment({ kind: 'file', name: file.name, path: root ? joinPath(root, file.path) : file.path });
  }

  /** A vault image as an attachment; null for any other file, or an image that cannot be read. */
  private async vaultImage(file: TFile): Promise<ImageAttachment | null> {
    const mediaType = mimeForExtension(file.extension);
    return mediaType ? imageFromBlob(new Blob([await this.app.vault.readBinary(file)], { type: mediaType }), file.name) : null;
  }

  /** Files being dragged from Obsidian's file explorer (its drag manager is not in the public API). */
  private draggedVaultFiles(): TFile[] {
    type Draggable = { type?: string; file?: TAbstractFile; files?: TAbstractFile[] };
    const manager = (this.app as unknown as { dragManager?: { draggable?: Draggable | null } }).dragManager;
    const dragged = manager?.draggable;
    if (!dragged) return [];
    const items = dragged.type === 'file' ? [dragged.file] : dragged.type === 'files' ? (dragged.files ?? []) : [];
    return items.filter((item): item is TFile => item instanceof TFile);
  }

  private isFileDrag(evt: DragEvent): boolean {
    return this.draggedVaultFiles().length > 0 || (evt.dataTransfer?.types.includes('Files') ?? false);
  }

  private async onDrop(evt: DragEvent): Promise<void> {
    // Both sources are read before the first await: the drag state is cleared once the drop ends.
    const vaultFiles = this.draggedVaultFiles();
    const external = Array.from(evt.dataTransfer?.files ?? []);
    if (this.overSideChat(evt)) {
      await this.dropOnSideChat(vaultFiles, external);
      return;
    }
    if (vaultFiles.length > 0) {
      const generation = this.chatGeneration;
      for (const file of vaultFiles) await this.attachVaultFile(file, generation);
    } else {
      await this.attachExternalFiles(external);
    }
  }

  /** Whether a drag is over the side chat, open: what is dropped there is its own. */
  private overSideChat(evt: DragEvent): boolean {
    return this.sideChat.isOpen() && this.sideChat.el.contains(evt.target as Node | null);
  }

  /** Images dropped on the side chat go with its next question; it takes no other files. */
  private async dropOnSideChat(vaultFiles: TFile[], external: File[]): Promise<void> {
    const images: ImageAttachment[] = [];
    const others: string[] = [];
    for (const file of vaultFiles) {
      const image = await this.vaultImage(file);
      if (image) images.push(image);
      else others.push(file.name);
    }
    for (const file of external) {
      const image = file.type.startsWith('image/') ? await imageFromBlob(file, file.name || 'Dropped image') : null;
      if (image) images.push(image);
      else others.push(file.name);
    }
    this.sideChat.attach(images);
    if (others.length > 0) new Notice(`The side chat takes images only; left out: ${others.join(', ')}.`);
  }

  // ---- Sending -----------------------------------------------------------

  private async send(): Promise<void> {
    // `/plan`, as in a terminal: the chat goes into Plan mode, and what follows is the message. Claude
    // Code takes the command only in a terminal, and answers "/plan isn't available in this environment".
    const typed = this.inputEl.value.trim();
    const plan = /^\/plan(?=\s|$)/i.exec(typed);
    if (plan) {
      // Switching now would change the reply that is running, not only this message: it waits.
      if (this.busy) {
        new Notice('Claude is still working. Send /plan once it has finished, or stop it first.');
        return;
      }
      const rest = typed.slice(plan[0].length).trim();
      if (this.mode !== 'plan') {
        await this.changeMode('plan');
        // Refused (see changeMode): nothing is sent, the text stays to try again.
        if ((this.mode as PermissionMode) !== 'plan') return;
      }
      this.inputEl.value = rest;
      this.growInput();
      if (!rest && this.attachments.length === 0) {
        this.saveDraft();
        new Notice('Plan mode: Claude plans first, and asks before carrying the plan out.');
        return;
      }
    }
    const text = this.inputEl.value.trim();
    if (!text && this.attachments.length === 0) return;
    const session = this.ensureSession();
    if (!session) return;
    // Slash commands must reach Claude Code as plain text; attachments wait for the next message.
    const slash = text.startsWith('/');
    const attachments = slash ? [] : this.attachments;
    if (!slash) {
      this.attachments = [];
      this.renderTray();
    }
    // ↑ brings back what was typed, `/plan` included, so it can be sent again the same way.
    if (text) this.lastSent = plan ? typed : text;
    // Taken before the input empties, which lets them go (see followMentions).
    const pathOnly = new Set(this.pathOnlyMentions);
    this.inputEl.value = '';
    this.growInput();
    this.saveDraft();
    this.suggest.hide();
    this.messagesEl.querySelector('.vc-welcome')?.remove();
    const chips = attachments.map(chipFor);
    const uuid = crypto.randomUUID();
    // Sent while Claude works: shown where the conversation is now, marked until a turn takes it up.
    const queued = this.busy;
    // A queued message may be saved folded into the reply rather than under its own id: no copy from it.
    const bubble = queued ? this.drawQueued(text, chips) : this.renderUserBubble(text, chips, this.messagesEl, uuid);
    if (queued) {
      this.pending.set(uuid, { bubble, running: false, id: uuid, text, chips });
      this.scrollToBottom(true);
    }
    // The chat it was typed in, for its draft should another chat be opened while it is prepared.
    const draftKey = this.draftKey();
    let built: { content: UserContent; notes: string[] };
    // The chat's projects' context, once (see projectContext); never with a slash command.
    let project: Awaited<ReturnType<ChatView['projectContext']>> = { parts: [], hashes: {} };
    try {
      if (!slash) project = await this.projectContext(text);
      built = slash ? { content: text, notes: [] } : await this.buildContent(text, attachments, pathOnly);
    } catch (error) {
      // A mentioned note could not be read: nothing is sent, and the message goes back to the input.
      log('the message could not be prepared', error);
      const back = this.unsend({ uuid, bubble, session, draftKey, text, attachments, pathOnly });
      new Notice(`The message was not sent: ${errorText(error)}.${unsentWhere(back, attachments.length > 0)}`);
      return;
    }
    const { content, notes } = built;
    if (session !== this.session) {
      // Another chat was opened while the mentioned notes were read.
      const back = this.unsend({ uuid, bubble, session, draftKey, text, attachments, pathOnly });
      new Notice(`The chat changed before the message was sent, so it was not sent.${unsentWhere(back, attachments.length > 0)}`);
      return;
    }
    if (!this.chatName) this.setChatTitle(chatTitle(text || attachments[0]?.name || ''));
    this.sentIds.add(uuid);
    // The turn may have ended while the prompt was being built.
    if (!this.busy) {
      this.markDelivered(uuid);
      this.beginTurn([uuid]);
    }
    // Claude Code queues it and folds it into the running reply at its next pause.
    session.send(content, undefined, uuid);
    this.linkSentNotes(notes);
    this.linkSentChats(linkedChatIds(text));
    // The project's context and linked chats' digests go outside the message's text (see
    // ClaudeSession.addContext), marked as sent once Claude Code has taken them up: a session that
    // never starts leaves them to go with the next message.
    if (project.parts.length > 0) {
      session.addContext(project.parts, (sessionId, keys) => {
        if (sessionId) this.plugin.markContextSent(sessionId, keys, project.hashes);
        this.projectsChanged();
      });
    }
  }

  /**
   * A queued message's bubble, where the conversation is now (in the turn running), marked until a
   * turn takes it up. A queued message may be saved folded into the reply rather than under its own
   * id: no copy from it.
   */
  private drawQueued(text: string, chips: Chip[]): HTMLElement {
    const bubble = this.renderUserBubble(text, chips, this.draw.turn ?? this.messagesEl, undefined);
    bubble.addClass('is-queued');
    const label = bubble.createDiv({ cls: 'vc-queued-label' });
    label.appendText('Queued: Claude reads this at its next step · ');
    // Claude Code holds it and folds it in at its next pause; this ends the step so it is read now.
    const now = label.createSpan({ cls: 'vc-welcome-link', text: 'send now' });
    now.setAttr('aria-label', 'End the current step so this message is read now');
    now.addEventListener('click', () => this.interruptTurn());
    this.draw.group = null;
    return bubble;
  }

  /**
   * A message not sent after all (see send): its bubble gone, and not waited for, here or in the
   * chat it was typed in, gone to the background meanwhile (which closes if that was all it waited
   * for); its text back in that chat's input, here or in its draft. Where it went back to.
   */
  private unsend(sent: { uuid: string; bubble: HTMLElement; session: ClaudeSession; draftKey: string; text: string; attachments: Attachment[]; pathOnly: ReadonlySet<string> }): 'input' | 'draft' | null {
    sent.bubble.remove();
    this.pending.delete(sent.uuid as MessageId);
    for (const entry of this.background) {
      if (entry.session !== sent.session || !entry.pendingIds.delete(sent.uuid)) continue;
      if (entry.pendingIds.size === 0 && entry.waitedForQueue) {
        entry.waitedForQueue = false;
        if (isIdle(entry)) this.settleBackground(entry);
      }
    }
    // The chat on screen, or one that is its like (a new chat after a new chat): its input.
    if (sent.session === this.session || sent.draftKey === this.draftKey()) {
      this.restoreUnsent(sent.text, sent.attachments, sent.pathOnly);
      // A new chat's opening lines, taken away for the message, come back.
      if (this.messagesEl.childElementCount === 0) this.renderWelcome();
      return 'input';
    }
    if (!sent.text) return null;
    const draft = this.readDraft(sent.draftKey) ?? {};
    this.writeDraft(sent.draftKey, { ...draft, text: draft.text?.trim() ? `${sent.text}\n${draft.text}` : sent.text });
    return 'draft';
  }

  /** Puts a message that was not sent back in the input, before anything typed since, with its attachments and path-only mentions. */
  private restoreUnsent(text: string, attachments: Attachment[], pathOnly: ReadonlySet<string>): void {
    const typed = this.inputEl.value;
    this.inputEl.value = typed.trim() ? `${text}\n${typed}` : text;
    this.attachments = [...attachments, ...this.attachments];
    for (const path of pathOnly) this.pathOnlyMentions.add(path);
    this.inputEdited();
    this.renderTray();
  }

  /**
   * The notes a message carried remember this chat, so opening one offers it again. Before the
   * chat has an id they wait, and the init message links them; the scratch chat links nothing.
   */
  private linkSentNotes(paths: string[]): void {
    if (this.scratch) {
      this.notesToLink = [];
      return;
    }
    this.notesToLink.push(...paths);
    if (!this.chatId) return;
    for (const path of this.notesToLink) this.plugin.linkNoteRef(path, this.chatId);
    this.notesToLink = [];
  }

  /**
   * The chats a message links to (see linkedChatIds: a chat mentioned, or linked before the chat
   * started) are linked to this chat: shown on its map and in its links, and their projects offered.
   * Before the chat has an id they wait, as notes do.
   */
  private linkSentChats(ids: string[]): void {
    if (this.scratch) return;
    this.chatsToLink.push(...ids);
    if (!this.chatId || this.chatsToLink.length === 0) return;
    this.plugin.linkChats(this.chatId, this.chatsToLink);
    this.chatsToLink = [];
  }

  /** The message for Claude Code, and the vault notes it carries. */
  /** `pathOnly`: mentioned notes sent by their path only, not with their text (see renderTray). */
  private async buildContent(text: string, attachments: Attachment[], pathOnly: ReadonlySet<string> = new Set()): Promise<{ content: UserContent; notes: string[] }> {
    const files = attachments.filter((attachment): attachment is FileAttachment => attachment.kind === 'file');
    const images = attachments.filter((attachment): attachment is ImageAttachment => attachment.kind === 'image');
    const selections = attachments.filter((attachment): attachment is SelectionAttachment => attachment.kind === 'selection');
    const { prompt, notes } = await this.buildPrompt(text, files, selections, pathOnly);
    if (images.length === 0) return { content: prompt, notes };
    const blocks: Exclude<UserContent, string> = images.map(toImageBlock);
    if (prompt) blocks.push({ type: 'text', text: prompt });
    return { content: blocks, notes };
  }

  private ensureSession(): ClaudeSession | null {
    if (this.session) return this.session;
    const launch = this.plugin.launchOrNotice();
    if (!launch) return null;
    const { settings } = this.plugin;
    const token = {};
    this.sessionToken = token;
    this.session = new ClaudeSession(
      {
        ...launch,
        permissionMode: this.mode,
        model: this.modelOverride,
        effort: this.effortOverride,
        fastMode: this.fastMode,
        appendSystemPrompt: APPEND_SYSTEM_PROMPT,
        // Resumes a chat opened from history, or the same chat after a crash.
        resume: this.resumeId ?? undefined,
        forkSession: this.forkOnResume,
        allowBypass: settings.allowBypass,
        denyRules: denyRuleList(settings.denyRules),
        // Its multiple-choice questions are answered in the chat (see renderApprovalCard); a side
        // chat leaves them off, and asks in plain text.
        askQuestions: true,
        showThinking: true,
      },
      this.foregroundHandlers(token),
    );
    return this.session;
  }

  /** Handlers for the chat on screen; `token` goes stale once the chat is replaced or closed. */
  private foregroundHandlers(token: object): SessionHandlers {
    const current = () => this.sessionToken === token;
    return {
      onMessage: (message) => {
        if (current()) this.onMessage(message);
      },
      onPermission: (request) =>
        current() ? this.askPermission(request) : Promise.resolve({ behavior: 'deny', message: 'Chat closed.' }),
      onEnd: (error, stderrTail) => {
        if (current()) this.onSessionEnd(error, stderrTail);
      },
    };
  }

  private async buildPrompt(
    text: string,
    files: FileAttachment[] = [],
    selections: SelectionAttachment[] = [],
    pathOnly: ReadonlySet<string> = new Set(),
  ): Promise<{ prompt: string; notes: string[] }> {
    const blocks: string[] = [];
    // The notes that go with the message: the attached note, mentioned notes, attached selections.
    const notes = new Set<string>();
    const note = this.attachedContext();
    if (note) {
      notes.add(note.file.path);
      let block = `Note attached to this chat: ${note.file.path}`;
      // An attached selection replaces the editor's live one, which is usually the same text.
      if (note.selection && selections.length === 0) {
        const lines = note.fromLine ? ` (lines ${note.fromLine}–${note.toLine})` : '';
        const heading = note.reading
          ? `Text selected in reading view, as rendered${note.fromLine ? `; it is within lines ${note.fromLine}–${note.toLine} of the note` : ''}:`
          : `Selected text${lines}:`;
        block += `\n${heading}\n<selection>\n${note.selection}\n</selection>`;
      }
      blocks.push(block);
    }
    const root = this.plugin.vaultRoot();
    const absolute = (vaultPath: string) => (root ? joinPath(root, vaultPath) : vaultPath);
    for (const { item: file, note: isNote } of this.mentionedItems(text)) {
      if (file instanceof TFolder) {
        blocks.push(`Mentioned folder: ${absolute(file.path)}`);
        continue;
      }
      if (!isNote) {
        blocks.push(`Mentioned file: ${absolute(file.path)}`);
        continue;
      }
      notes.add(file.path);
      if (pathOnly.has(file.path)) {
        blocks.push(`Mentioned note: ${absolute(file.path)}`);
        continue;
      }
      const content = await this.app.vault.cachedRead(file as TFile);
      const body = capped(content, '; read the file for the rest.');
      blocks.push(`<note path="${file.path}">\n${body}\n</note>`);
    }
    for (const selection of selections) {
      notes.add(selection.path);
      const body = capped(selection.text, '.');
      blocks.push(`<selection note="${selection.path}" lines="${lineRange(selection.fromLine, selection.toLine)}">\n${body}\n</selection>`);
    }
    if (files.length > 0) blocks.push(files.map((file) => `Attached file: ${file.path}`).join('\n'));
    if (blocks.length === 0) return { prompt: text, notes: [] };
    return { prompt: `<obsidian_context>\n${blocks.join('\n\n')}\n</obsidian_context>\n\n${text}`, notes: [...notes] };
  }

  /**
   * Follows the tab in front. A note becomes the note in front; another kind of view in the main area
   * or a popout (a canvas, a calendar) leaves none in front; a Claude panel or a sidebar leaves it as
   * it was, so that a click into the panel keeps the note being asked about. Obsidian's own active
   * file would not do: it stays the last note while another kind of view is in front.
   */
  /** Looks again at the tab in front, which a tab showing something else in place does not announce. */
  private followActiveLeaf(): void {
    this.followFront(this.app.workspace.getActiveViewOfType(View)?.leaf ?? null);
    this.updateContextChip();
  }

  private followFront(leaf: WorkspaceLeaf | null): void {
    if (leaf?.view instanceof MarkdownView) {
      this.lastMarkdownView = leaf.view;
      this.otherViewInFront = false;
    } else if (leaf && !(leaf.view instanceof ChatView)) {
      const { leftSplit, rightSplit } = this.app.workspace;
      const root = leaf.getRoot();
      if (root !== leftSplit && root !== rightSplit) this.otherViewInFront = true;
    }
  }

  private activeNote(): NoteContext | null {
    if (this.otherViewInFront) return null;
    const view = this.lastMarkdownView;
    const file = view?.file ?? this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return null;
    if (view && view.file === file && view.getMode() === 'source') {
      const { editor } = view;
      const selected = editor.getSelection();
      // Live Preview draws a callout, table, embed or equation as a widget, and a selection inside
      // one never reaches the editor: it is mapped back to its lines through CodeMirror instead.
      const widget = selected ? null : widgetSelection(view, editor.getValue());
      if (widget) return { file, selection: widget.text, fromLine: widget.fromLine, toLine: widget.toLine, reading: true };
      return {
        file,
        selection: selected,
        fromLine: editor.getCursor('from').line + 1,
        toLine: editor.getCursor('to').line + 1,
        reading: false,
      };
    }
    const kept = this.readingSelection;
    if (view && view.file === file && view.getMode() === 'preview' && kept && kept.view === view && kept.file === file) {
      return { file, selection: kept.text, fromLine: kept.fromLine, toLine: kept.toLine, reading: true };
    }
    return { file, selection: '', fromLine: 0, toLine: 0, reading: false };
  }

  /**
   * Keeps a reading-view selection when one is made or cleared inside the note; a selection
   * elsewhere (the panel's input, another pane) leaves it alone. Then redraws the chip.
   */
  private onSelectionChange(): void {
    const view = this.lastMarkdownView;
    const selection = activeWindow.getSelection();
    const anchor = selection?.anchorNode ?? null;
    if (view?.file && selection && anchor && view.getMode() === 'preview' && view.previewMode.containerEl.contains(anchor)) {
      const text = selection.isCollapsed ? '' : selection.toString();
      if (!text.trim()) {
        this.readingSelection = null;
      } else {
        const lines = readingLines(view, selection.getRangeAt(0), text) ?? { fromLine: 0, toLine: 0 };
        this.readingSelection = { view, file: view.file, text, ...lines };
      }
    }
    this.updateContextChip();
  }

  /**
   * The chips above the input: the note attached to this chat, with the lines selected in it while
   * it is open, and an offer to attach the note in front when it is another one.
   */
  private updateContextChip(): void {
    const active = this.activeNote();
    this.updateNoteChats(active?.file ?? null);
    const attached = this.attachedContext();
    // Called on every selection change — each keystroke in a note moves the cursor — so the DOM is
    // left alone unless what the chips show has changed.
    const project = this.homeProjectFile();
    const state = project ? this.projectStateNow() : null;
    const key = JSON.stringify([
      attached && [attached.file.path, contextLabel(attached), contextWhat(attached)],
      active && [active.file.path, contextLabel(active)],
      project && [project.path, state?.sent?.includes(project.path), this.projectUpdated(project.path)],
      this.offersProject() && [this.projectSuggestion()?.path, this.projectStateNow().declined],
      this.linksChipKey(),
    ]);
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.contextRow.empty();
    if (project) {
      const chip = this.contextRow.createDiv({ cls: 'vc-context-chip vc-project-chip' });
      setIcon(chip.createSpan({ cls: 'vc-context-clip' }), 'folder-kanban');
      chip.createSpan({ cls: 'vc-context-name', text: project.basename });
      const sent = state?.sent?.includes(project.path);
      const updated = this.projectUpdated(project.path);
      if (updated) chip.createSpan({ cls: 'vc-project-updated', attr: { 'aria-hidden': 'true' } });
      chip.setAttr(
        'aria-label',
        `${this.projectWhy()} ${updated ? 'Its Context or Instructions changed since they went with this chat: Send its context again is in the Project menu.' : sent ? 'Its context went with this chat.' : 'Its Context goes with your next message.'} Click to see the project on the map.`,
      );
    } else if (this.offersProject()) {
      // One chip says there is none; a second offers the likeliest project in one click.
      const declined = this.projectStateNow().declined;
      const offer = this.contextRow.createDiv({ cls: 'vc-context-chip vc-context-offer vc-project-offer' });
      setIcon(offer.createSpan({ cls: 'vc-context-clip' }), 'folder-kanban');
      offer.createSpan({ cls: 'vc-context-name', text: 'No project' });
      offer.setAttr(
        'aria-label',
        declined
          ? 'This chat was taken out of its project, so its notes no longer place it in one. Click to choose a project, or make one.'
          : 'A project’s Context, a summary of its notes and chats, goes with every chat in it. Click to choose a project, or make one.',
      );
      const suggested = this.projectSuggestion();
      if (suggested) {
        const chip = this.contextRow.createDiv({ cls: 'vc-context-chip vc-project-suggestion' });
        setIcon(chip.createSpan({ cls: 'vc-context-clip' }), 'plus');
        chip.createSpan({ cls: 'vc-context-name', text: `Add to ${suggested.basename}` });
        chip.setAttr('aria-label', `Put this chat in “${suggested.basename}”: its Context then goes with your next message`);
      }
    }
    this.drawLinksChip();
    if (attached) {
      const chip = this.contextRow.createDiv({ cls: 'vc-context-chip is-attached' });
      setIcon(chip.createSpan({ cls: 'vc-context-clip' }), 'paperclip');
      chip.createSpan({ cls: 'vc-context-name', text: contextLabel(attached) });
      chip.createSpan({ cls: 'vc-context-remove', text: '×', attr: { 'aria-label': 'Detach this note from the chat' } });
      chip.setAttr('aria-label', `Sent with each message: ${contextWhat(attached)}. Click to open it.`);
    }
    // A project note is never offered as an attachment: the project chips stand for it.
    if (active && active.file.path !== attached?.file.path && !this.plugin.isProjectNote(active.file)) {
      const offer = this.contextRow.createDiv({ cls: 'vc-context-chip vc-context-offer' });
      setIcon(offer.createSpan({ cls: 'vc-context-clip' }), 'plus');
      offer.createSpan({ cls: 'vc-context-name', text: contextLabel(active) });
      offer.setAttr('aria-label', attached ? `Attach this note instead of “${attached.file.basename}”` : 'Attach this note: it goes with each message in this chat');
    }
    this.contextRow.toggle(this.contextRow.childElementCount > 0);
  }

  /** The attached note, with what is selected in it when it is the note in front. */
  private attachedContext(): NoteContext | null {
    if (!this.attachedNote) return null;
    const active = this.activeNote();
    if (active && active.file.path === this.attachedNote) return active;
    const file = this.app.vault.getAbstractFileByPath(this.attachedNote);
    return file instanceof TFile ? { file, selection: '', fromLine: 0, toLine: 0, reading: false } : null;
  }

  private onContextClick(evt: MouseEvent): void {
    const target = evt.target as HTMLElement;
    if (target.closest('.vc-project-chip')) this.openConnections(true);
    else if (target.closest('.vc-links-chip')) this.openConnections(false, true);
    else if (target.closest('.vc-project-suggestion')) {
      const suggested = this.projectSuggestion();
      if (suggested && this.chatId) void this.plugin.setHomeProject(this.chatId, suggested).then(() => new Notice(`This chat is now in “${suggested.basename}”.`));
    }
    else if (target.closest('.vc-project-offer')) this.openConnections();
    else if (target.closest('.vc-context-remove')) this.attachNote(null);
    else if (target.closest('.vc-context-offer')) this.attachNote(this.activeNote()?.file.path ?? null);
    else if (target.closest('.vc-context-chip') && this.attachedNote) void this.app.workspace.openLinkText(this.attachedNote, '', Keymap.isModEvent(evt));
  }

  /**
   * Follows a note, or a folder's notes, that moved to `to` or was deleted (`to` null), wherever this
   * panel holds it by path: the drafts of chats not started yet, the note attached to the chat on
   * screen, the draft note it writes in, and files and selections waiting in the tray (see
   * VaultClaudePlugin.noteMoved).
   */
  followNote(from: string, to: string | null): void {
    followDraftNotes(this.localDrafts, from, to, (key) => this.localDrafts.delete(key));
    // A plan being edited in a note, here or in a chat in the background.
    for (const approval of [...this.openApprovals, ...[...this.background].flatMap((entry) => entry.approvals)]) {
      const plan = approval.notePath ? movedPath(approval.notePath, from, to) : undefined;
      if (plan !== undefined) approval.notePath = plan;
    }
    const attached = this.attachedNote === null ? undefined : movedPath(this.attachedNote, from, to);
    if (attached !== undefined) this.attachNote(attached);
    const draftNote = this.draftPath === null ? undefined : movedPath(this.draftPath, from, to);
    if (draftNote !== undefined) {
      this.draftPath = draftNote;
      this.updateDraftLine();
    }
    const root = this.plugin.vaultRoot();
    if (!root) return;
    let trayChanged = false;
    this.attachments = this.attachments.flatMap((attachment): Attachment[] => {
      if (attachment.kind === 'image') return [attachment];
      // A file by its absolute path; a selection by its note's path in the vault.
      const inVault = attachment.kind === 'file' ? vaultRelative(attachment.path, root) : attachment.path;
      const moved = inVault === undefined ? undefined : movedPath(inVault, from, to);
      if (inVault === undefined || moved === undefined) return [attachment];
      // A selection keeps its text when its note is deleted; a file goes.
      if (moved === null) {
        if (attachment.kind === 'file') trayChanged = true;
        return attachment.kind === 'file' ? [] : [attachment];
      }
      trayChanged = true;
      if (attachment.kind === 'selection') {
        const name = attachment.name === noteName(inVault) ? noteName(moved) : attachment.name;
        return [{ ...attachment, name, path: moved }];
      }
      // Its name follows the file's, unless it was given another.
      const name = attachment.name === baseName(inVault) ? baseName(moved) : attachment.name;
      return [{ ...attachment, name, path: joinPath(root, moved) }];
    });
    if (trayChanged) this.renderTray();
  }

  /** Attaches a note to the chat on screen, in place of any other; null detaches it. Kept with the chat. */
  private attachNote(path: string | null): void {
    this.attachedNote = path;
    this.saveDraft();
    this.updateContextChip();
  }

  /** The line above the input: the chats about the note in front (see noteChatEntries). */
  private updateNoteChats(file: TFile | null): void {
    const all = file ? this.plugin.noteChatEntries(file) : [];
    const isOnScreen = (entry: NoteChatEntry) => entry.id === this.chatId || entry.id === this.resumeId;
    this.noteChatList = all.filter((entry) => !isOnScreen(entry));
    const count = this.noteChatList.length;
    // The chat on screen is not offered; when it is about this note too, the count says "other".
    const other = all.some(isOnScreen) ? 'other ' : '';
    // Open chats are held by a panel: clicking one shows it there rather than starting it again.
    const held = this.noteChatList.length > 0 ? this.plugin.openChats() : new Set<string>();
    const open = this.noteChatList.filter((entry) => held.has(entry.id)).length;
    const openPart = open === 0 ? '' : count === 1 ? ' · open' : ` · ${open} open`;
    // The note's name is on the chip just below.
    const text = count > 0 ? `${count} ${other}chat${count === 1 ? '' : 's'} about this note${openPart}` : '';
    if (text === this.noteChatsText) return;
    this.noteChatsText = text;
    this.noteChatsEl.toggle(count > 0);
    if (count === 0) return;
    this.noteChatsEl.setText(text);
    this.noteChatsEl.setAttr('aria-label', count === 1 ? 'Open it · ⌥-click to take it off this note' : 'Choose one to open');
  }

  /** A chat was taken off a note (see VaultClaudePlugin.removeNoteChat): the line above the input is counted again. */
  noteLinksChanged(): void {
    this.noteChatsText = null;
    this.updateContextChip();
  }

  /**
   * The notes this chat touched, newest first: those it changed (from the cards of changed files)
   * and those it mentioned: linked in replies (a note's name in bold or code too), read by Claude
   * (its tool lines), and sent with your messages. Each with the vault file it resolves to.
   */
  private notesInChat(root: HTMLElement = this.messagesEl): { changed: NoteLink[]; mentioned: NoteLink[] } {
    const changed: NoteLink[] = [];
    const mentioned: NoteLink[] = [];
    const seen = new Map<NoteLink[], Set<string>>([
      [changed, new Set<string>()],
      [mentioned, new Set<string>()],
    ]);
    const add = (list: NoteLink[], target: string | null | undefined, label: string, path: string | undefined) => {
      const taken = seen.get(list);
      if (!target || !taken || taken.has(target)) return;
      taken.add(target);
      list.push({ target, label, path });
    };
    const hidden = hiddenPaths(this.plugin.settings.hiddenNotePaths);
    for (const el of [...root.querySelectorAll<HTMLElement>('[data-path], a.internal-link')].reverse()) {
      const path = el.dataset.path;
      if (path && hidden(path)) continue;
      if (path) {
        // A folder, say, from a search's tool line, is not a file.
        const file = this.app.vault.getAbstractFileByPath(path) instanceof TFile ? path : undefined;
        add(el.closest('.vc-changes') ? changed : mentioned, path, path, file);
        continue;
      }
      // A link: left out when the file it resolves to is one the settings leave out (an image in
      // attachments, say). Resolved rather than read, since a note's name may hold a dot.
      const target = el.dataset.href ?? el.getAttribute('href');
      const linked = target ? this.app.metadataCache.getFirstLinkpathDest(target.split('#')[0], '') : null;
      if (linked && hidden(linked.path)) continue;
      add(mentioned, target, el.textContent ?? '', linked?.path);
    }
    // A note Claude changed belongs under Changed, even when a later reply only mentions it.
    const wasChanged = new Set(changed.map((note) => note.target));
    return { changed, mentioned: mentioned.filter((note) => !wasChanged.has(note.target)) };
  }

  /**
   * Records the notes this chat mentions, as its notes menu lists them, so that the history's notes
   * view finds the chat under them. `root`: where to look: the chat, a turn just finished or drawn,
   * or a reply's text once its Markdown and links are in (see renderMarkdown). `id`: the chat's
   * (see mentionsChat), taken when the drawing began.
   */
  private recordMentions(root: HTMLElement = this.messagesEl, id = this.mentionsChat()): void {
    if (!id) return;
    for (const note of this.notesInChat(root).mentioned) if (note.path) this.plugin.linkNoteMention(note.path, id);
  }

  /** The chat whose mentions are recorded: this one, a chat from outside the panel under its own session; not the scratch chat, which links no notes. */
  private mentionsChat(): string | null {
    return this.scratch ? null : (this.chatId ?? this.resumeId);
  }

  /**
   * Updates the count on the notes button, once a burst of drawing (a chat opened, a reply's links
   * rendered) has settled: counting reads the whole chat.
   */
  private countNotesSoon(): void {
    if (this.notesCountTimer !== null || !this.notesCount) return;
    this.notesCountTimer = window.setTimeout(() => {
      this.notesCountTimer = null;
      const { changed, mentioned } = this.notesInChat();
      const count = changed.length + mentioned.length;
      this.notesCount.setText(count > 0 ? String(count) : '');
      this.notesButton.toggleClass('has-notes', count > 0);
    }, NOTES_COUNT_DELAY_MS);
  }

  /** The notes button's menu: what this chat changed, then what it mentioned. */
  private openNotesMenu(evt: MouseEvent): void {
    const { changed, mentioned } = this.notesInChat();
    // The memos saved from this chat (see saveMemo), which its replies do not show.
    const chatId = this.chatId ?? this.resumeId;
    const memos: NoteLink[] = (chatId ? this.plugin.memoNotes(chatId) : []).map((file) => ({ target: file.path, label: file.basename, path: file.path }));
    const listed = new Set(memos.map((memo) => memo.target));
    const others = (entries: NoteLink[]) => entries.filter((entry) => !listed.has(entry.target));
    const menu = new Menu();
    if (changed.length === 0 && mentioned.length === 0 && memos.length === 0) {
      menu.addItem((item) => item.setTitle('No notes in this chat').setDisabled(true));
    } else {
      // A heading naming the menu, with its hint once, above the sections.
      menu.addItem((item) => item.setTitle('Notes in this chat · ⌥-click to attach').setIsLabel(true));
      menu.addSeparator();
    }
    const section = (title: string, entries: NoteLink[], icon: string) => {
      if (entries.length === 0) return;
      if (title) menu.addItem((item) => item.setTitle(title).setIsLabel(true));
      for (const entry of entries.slice(0, MAX_NOTES_LISTED)) {
        menu.addItem((item) =>
          item
            .setTitle(entry.label || entry.target)
            .setIcon(icon)
            .onClick((click) => {
              if (click.altKey) this.attachNoteFromMenu(entry);
              else void this.app.workspace.openLinkText(entry.target, '', Keymap.isModEvent(click));
            }),
        );
      }
    };
    if (memos.length > 0 && chatId) {
      menu.addItem((item) => item.setTitle('Memos').setIsLabel(true));
      menu.addItem((item) =>
        item
          .setTitle("This chat's memos in a table")
          .setIcon('table')
          .onClick(() => void this.plugin.openChatMemos(chatId, this.chatName ?? 'Chat')),
      );
    }
    section(memos.length > 0 && chatId ? '' : 'Memos', memos, 'sticky-note');
    section('Changed', others(changed), 'file-pen');
    section('Mentioned', others(mentioned), 'file-text');
    menu.showAtMouseEvent(evt);
  }

  /** ⌥-click in the notes menu: the note becomes an `@` mention in the input instead of opening. */
  private attachNoteFromMenu(entry: NoteLink): void {
    const file = this.app.metadataCache.getFirstLinkpathDest(entry.target, '');
    if (!file) {
      new Notice(`Could not attach “${entry.label || entry.target}”: the note was not found.`);
      return;
    }
    void this.attachVaultFile(file);
  }

  /** Opens a chat known only by its id and title, as the history would. */
  private openChatId(id: string, title: string): Promise<boolean> {
    return this.openChat({ id, title, updatedAt: Date.now(), fromPanel: this.plugin.isPanelChat(id) });
  }

  /** The chat on screen as the back and forward arrows hold it: none for a new chat or the scratch chat. */
  private navPlace(): { id: string; title: string } | null {
    const id = this.chatId ?? this.resumeId;
    return id && !this.scratch ? { id, title: this.chatName ?? 'Chat' } : null;
  }

  /** After a move from `from` to another chat, not by the arrows: `from` goes on the back list and the forward list empties. */
  private remember(from: { id: string; title: string } | null): void {
    const now = this.navPlace();
    if (this.navigating || !from || from.id === now?.id) return;
    this.navBack.push(from);
    if (this.navBack.length > NAV_DEPTH) this.navBack.shift();
    this.navForward = [];
    this.updateNavButtons();
  }

  /** Back to the chat shown before, or forward again; the chat left goes on the other list. A chat that cannot be opened is passed over. */
  private async navigate(way: 'back' | 'forward'): Promise<void> {
    const [from, to] = way === 'back' ? [this.navBack, this.navForward] : [this.navForward, this.navBack];
    const here = this.navPlace();
    while (from.length > 0) {
      const target = from.pop();
      if (!target || target.id === here?.id) continue;
      // Open in another panel: shown there, and this panel stays where it is, its arrows too.
      const holder = this.plugin.chatHolder(target.id, this);
      if (holder) {
        from.push(target);
        await holder.showHeldChat(target.id);
        break;
      }
      this.navigating = true;
      try {
        if (!(await this.openChatId(target.id, this.plugin.chatTitleOf(target.id) === 'Chat' ? target.title : this.plugin.chatTitleOf(target.id)))) continue;
      } finally {
        this.navigating = false;
      }
      if (here) to.push(here);
      break;
    }
    this.updateNavButtons();
  }

  /** The arrows: each on only when there is somewhere to go, naming it. */
  private updateNavButtons(): void {
    if (!this.backButton) return;
    const back = this.navBack[this.navBack.length - 1];
    const forward = this.navForward[this.navForward.length - 1];
    this.backButton.toggleClass('is-disabled', !back);
    this.backButton.setAttr('aria-label', back ? `Back to “${back.title}”` : 'No chat to go back to');
    this.forwardButton.toggleClass('is-disabled', !forward);
    this.forwardButton.setAttr('aria-label', forward ? `Forward to “${forward.title}”` : 'No chat to go forward to');
  }

  /** New chat, as its button and command start one: the chat left can be gone back to. */
  startNewChat(): void {
    const from = this.navPlace();
    this.newChat();
    this.remember(from);
    this.plugin.chatShown(this);
  }

  /** Opens the chat offered for the note in front, or a menu of them. */
  private openNoteChats(evt: MouseEvent): void {
    const entries = this.noteChatList;
    if (entries.length === 0) return;
    const open = (entry: { id: string; title: string }) => {
      const note = this.activeNote()?.file.path ?? null;
      void this.openChatId(entry.id, entry.title).then(() => {
        // Only when this panel shows it: a chat already open elsewhere is shown in its own panel.
        if (this.chatId !== entry.id && this.resumeId !== entry.id) return;
        // The chat was opened from this note, so the note is attached to it.
        if (note) this.attachNote(note);
      });
    };
    // ⌥-click takes a chat off the note instead.
    const note = this.activeNote()?.file.path;
    const pick = (entry: NoteChatEntry, event: MouseEvent | KeyboardEvent) => {
      if (event.altKey && note) this.plugin.removeNoteChat(note, entry.id, entry.title);
      else open(entry);
    };
    if (entries.length === 1) {
      pick(entries[0], evt);
      return;
    }
    const menu = new Menu();
    menu.addItem((item) => item.setTitle('⌥-click takes a chat off this note').setIsLabel(true));
    const held = this.plugin.openChats();
    const groups: [string, NoteChatEntry[]][] = [
      ['Changed it', entries.filter((entry) => entry.why === 'changed')],
      ['Sent it with a message', entries.filter((entry) => entry.why === 'sent')],
    ];
    const labelled = groups.every(([, group]) => group.length > 0);
    for (const [label, group] of groups) {
      if (group.length === 0) continue;
      if (labelled) menu.addItem((item) => item.setTitle(label).setIsLabel(true));
      for (const entry of group) {
        const title = held.has(entry.id) ? `${entry.title} · open` : entry.title;
        menu.addItem((item) => item.setTitle(title).setIcon(NOTE_CHAT_ICONS[entry.why]).onClick((event) => pick(entry, event)));
      }
    }
    menu.showAtMouseEvent(evt);
  }

  populateModeSelect(): void {
    const modes = permissionModes(this.plugin.settings.allowBypass);
    if (!(this.mode in modes)) {
      // Bypass was switched off in settings while this chat used it.
      this.mode = 'default';
      this.session?.setPermissionMode('default').catch((error) => log('setPermissionMode failed', error));
    }
    // Nor does an approved plan return to it.
    if (!(this.modeBeforePlan in modes)) this.modeBeforePlan = 'default';
    this.modeMenu.clear();
    for (const [value, label] of Object.entries(modes)) this.modeMenu.add(value, label, modeShort(value));
    this.showMode();
  }

  /** The mode menu, its bypass warning and the plan cue, as the chat's mode is. */
  private showMode(): void {
    this.modeMenu.value = this.mode;
    this.modeMenu.el.toggleClass('is-bypass', this.mode === 'bypassPermissions');
    this.updatePlanCue();
  }

  private async changeMode(mode: PermissionMode): Promise<void> {
    const previous = this.mode;
    // What an approved plan returns to (see renderApprovalCard).
    if (mode === 'plan' && previous !== 'plan') this.modeBeforePlan = previous;
    this.mode = mode;
    this.showMode();
    const session = this.session;
    if (!session) {
      this.renderModeLine(previous, mode);
      return;
    }
    try {
      await session.setPermissionMode(mode);
      // Another chat opened meanwhile: the change was that chat's, and this one shows its own.
      if (session !== this.session) return;
      this.renderModeLine(previous, mode);
    } catch (error) {
      log('setPermissionMode failed', error);
      // In the background meanwhile: its entry keeps the mode that runs.
      if (session !== this.session) {
        const entry = this.entryOf(session);
        if (entry) entry.mode = previous;
        return;
      }
      new Notice(
        mode === 'bypassPermissions'
          ? 'This chat started before bypass was allowed. Start a new chat to use it.'
          : 'Could not change the permission mode.',
      );
      this.mode = previous;
      this.showMode();
    }
  }

  /**
   * The mode Claude Code reports for the chat (a status message), which changes without the panel
   * when Claude enters plan mode itself (its EnterPlanMode tool) or a plan is approved.
   */
  private followMode(mode: PermissionMode): void {
    const previous = this.mode;
    if (mode === previous) return;
    if (mode === 'plan') this.modeBeforePlan = previous;
    this.mode = mode;
    this.showMode();
    this.renderModeLine(previous, mode);
  }

  /** In Plan mode: a line above the input saying so, with a way back that approves nothing, a tinted input and its own placeholder. */
  private updatePlanCue(): void {
    if (!this.planEl) return;
    const planning = this.mode === 'plan';
    this.inputEl.toggleClass('is-plan-mode', planning);
    if (!this.busy) this.inputEl.placeholder = this.placeholderText();
    this.planEl.toggle(planning);
    if (!planning || this.planEl.childElementCount > 0) return;
    this.planEl.createSpan({ text: 'Plan mode: Claude plans, and changes nothing until you approve · ' });
    const leave = this.planEl.createSpan({ cls: 'vc-welcome-link', text: 'Leave plan mode' });
    leave.addEventListener('click', () => {
      void this.changeMode(this.modeBeforePlan === 'plan' ? 'default' : this.modeBeforePlan);
    });
  }

  /** A line in the chat where the permission mode changes; where Plan mode starts or ends, in its colour. */
  private renderModeLine(from: PermissionMode, to: PermissionMode): void {
    if (from === to) return;
    const name = permissionModes(true)[to] ?? to;
    if (to === 'plan') this.renderSettingLine('Plan mode: Claude plans, and changes nothing until you approve', true);
    else if (from === 'plan') this.renderSettingLine(`Left plan mode · back to ${name}`, true);
    else this.renderSettingLine(`Permission mode: ${name}`);
  }

  /** A line across the chat where one of its settings changes: the permission mode, or the model. */
  private renderSettingLine(text: string, plan = false): void {
    const line = (this.busy ? this.container() : this.messagesEl).createDiv({ cls: 'vc-notice vc-muted vc-setting-line', text });
    line.toggleClass('is-plan', plan);
    this.scrollToBottom();
  }

  /**
   * The Stop button: the reply in progress if there is one — which ends its background tasks too,
   * since Claude Code's interrupt does when the panel declares no stop control of its own — and
   * otherwise the background tasks that are still running after the reply ended.
   */
  private stop(): void {
    if (this.busy) this.interruptTurn();
    else this.stopTasks();
  }

  /** Stop shows while a reply runs, and after it for as long as the chat has background tasks running. */
  private updateStopButton(): void {
    if (!this.stopButton) return;
    const tasksOnly = !this.busy && this.tasks.size > 0;
    this.stopButton.toggle(this.busy || tasksOnly);
    this.stopButton.setText(tasksOnly ? `Stop ${plural(this.tasks.size, 'task')}` : 'Stop');
    this.stopButton.setAttr(
      'aria-label',
      tasksOnly ? 'Stop the tasks this chat is running in the background' : 'Stop the reply, and any tasks it started in the background',
    );
  }

  /** Chats this panel holds that have tasks running in the background: the one on screen and its background chats. */
  chatsWithTasks(): string[] {
    const ids: string[] = [];
    const onScreen = this.chatId ?? this.resumeId;
    if (onScreen && this.tasks.size > 0) ids.push(onScreen);
    for (const entry of this.background) if (entry.chatId && entry.tasks.size > 0) ids.push(entry.chatId);
    return ids;
  }

  /** Stops a chat's background tasks, on screen or in the background here; whether this panel held it. */
  stopTasksOf(id: string): boolean {
    if ((this.chatId ?? this.resumeId) === id && this.tasks.size > 0) {
      this.stopTasks();
      return true;
    }
    const entry = [...this.background].find((candidate) => candidate.chatId === id && candidate.tasks.size > 0);
    if (!entry) return false;
    for (const task of entry.tasks) entry.session.stopTask(task).catch((error: unknown) => log('stopping a task failed', error));
    new Notice(`Stopping ${entry.tasks.size === 1 ? 'the background task' : `${entry.tasks.size} background tasks`} in “${entry.title ?? 'a chat'}”.`);
    return true;
  }

  /** Stops every background task of the chat on screen; each ends with its own notification. */
  private stopTasks(): void {
    const session = this.session;
    if (!session || this.tasks.size === 0) return;
    for (const id of this.tasks) session.stopTask(id).catch((error: unknown) => log('stopping a task failed', error));
    new Notice(this.tasks.size === 1 ? 'Stopping the background task.' : `Stopping ${this.tasks.size} background tasks.`);
  }

  /** Ends the reply in progress. */
  private interruptTurn(): void {
    if (!this.busy || !this.session) return;
    this.interrupted = true;
    this.tickStatus();
    this.session.interrupt().catch((error: unknown) => log('interrupt failed', error));
  }

  // ---- Model and usage indicators ----------------------------------------

  private populateModelSelect(): void {
    const select = this.modelMenu;
    const models = this.plugin.models;
    select.clear();
    if (models.length === 0) {
      // Before Claude Code has listed its models: the one running, the one chosen, else Default.
      const chosen = this.modelOverride && this.modelOverride !== 'default' ? this.modelOverride : null;
      const label = this.currentModel ? prettyModel(this.currentModel) : (chosen ?? 'Default model');
      select.add(this.modelOverride ?? '', label, shortModel(label));
    } else {
      for (const model of models) {
        const resolved = prettyModel(model.resolvedModel ?? model.value);
        select.add(model.value, model.value === 'default' ? `Default (${resolved})` : resolved, shortModel(resolved));
      }
      if (this.modelOverride && !models.some((model) => model.value === this.modelOverride)) {
        select.add(this.modelOverride, prettyModel(this.modelOverride), shortModel(prettyModel(this.modelOverride)));
      }
    }
    const hasDefault = models.some((model) => model.value === 'default');
    let selected = hasDefault || this.modelOverride ? this.chosenModel() : (this.configuredOption() ?? '');
    // Once the running model is known it wins: a resumed chat keeps its own model, and /model can switch it.
    if (this.currentModel && models.length > 0) {
      const option = this.optionForModel(this.currentModel);
      if (option) {
        selected = option;
      } else {
        select.add(this.currentModel, prettyModel(this.currentModel), shortModel(prettyModel(this.currentModel)));
        selected = this.currentModel;
      }
    }
    select.value = selected;
    select.setTooltip(this.currentModel ? `Running ${prettyModel(this.currentModel)} (${this.currentModel})` : 'Model for this chat');
    this.populateEffortSelect();
    this.updateFastButton();
  }

  /**
   * The menu value of the model this chat runs until its session says: its choice ("Default" is
   * sent as such, and runs Anthropic's default); else the model Claude Code's settings name, which a
   * session started without a model runs; else Default.
   */
  private chosenModel(): string {
    return this.modelOverride ?? this.configuredOption() ?? 'default';
  }

  /** The menu value of the model Claude Code's settings name, if any. */
  private configuredOption(): string | null {
    return this.plugin.configured.model ? this.optionForModel(this.plugin.configured.model) : null;
  }

  /** Menu value for a model ID; among equivalent entries, prefer the chat's choice, then Default. */
  private optionForModel(modelId: string): string | null {
    const strip = (id: string) => id.replace(/\[[^\]]*\]$/, '');
    const models = this.plugin.models;
    let matches = models.filter((model) => model.value === modelId || model.resolvedModel === modelId);
    if (matches.length === 0) matches = models.filter((model) => strip(model.resolvedModel ?? model.value) === strip(modelId));
    if (matches.length === 0) return null;
    const preferred = this.modelOverride ?? 'default';
    return (matches.find((model) => model.value === preferred) ?? matches[0]).value;
  }

  /**
   * After a model or effort change: the effort the chat now asks for (its choice, else the
   * model's default), and both menus. The session reports its model and effort when it starts.
   */
  private syncEffort(): void {
    this.currentEffort = this.effortOverride ?? this.defaultEffort() ?? null;
    this.populateModelSelect();
  }

  /** Effort a session on this chat's model starts at: its per-model setting, else the global one. */
  private defaultEffort(): EffortLevel | undefined {
    const { configured } = this.plugin;
    const chosen = this.chosenModelInfo();
    const id = this.currentModel ?? chosen?.resolvedModel ?? this.modelOverride ?? configured.model;
    const base = id?.replace(/\[[^\]]*\]$/, '');
    return (base ? configured.modelEfforts?.[base] : undefined) ?? configured.effort;
  }

  /** Effort levels the chat's model supports; all levels while the model list is unknown. */
  private effortLevels(): EffortLevel[] {
    const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (this.plugin.models.length === 0) return all;
    const id = this.currentModel ?? this.chosenModel();
    const value = this.optionForModel(id) ?? id;
    const info = this.plugin.models.find((model) => model.value === value);
    if (!info) return all;
    return info.supportedEffortLevels ?? [];
  }

  private populateEffortSelect(): void {
    const select = this.effortMenu;
    const labels: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
    const levels = this.effortLevels();
    select.clear();
    if (levels.length === 0) {
      select.add('', 'No effort setting', 'No effort');
      select.disabled = true;
      select.setTooltip('This model has no effort setting');
      return;
    }
    select.disabled = false;
    const configured = this.defaultEffort();
    select.add('', configured ? `Default effort (${labels[configured]})` : 'Default effort', configured ? EFFORT_SHORT[configured] : 'Effort');
    for (const level of levels) select.add(level, `${labels[level]} effort`, EFFORT_SHORT[level]);
    // Show the effort the session reports it will send; before that, the chat's choice.
    const shown = this.currentEffort ?? this.effortOverride;
    select.value = shown && levels.includes(shown) ? shown : '';
    select.setTooltip(this.currentEffort ? `Running at ${labels[this.currentEffort]} effort` : 'Effort for this chat');
  }

  private async changeEffort(value: string): Promise<void> {
    const previous = this.effortOverride;
    this.effortOverride = value ? (value as EffortLevel) : undefined;
    const session = this.session;
    if (session) {
      try {
        await session.setEffort(this.effortOverride ?? null);
        if (session !== this.session) return;
        this.syncEffort();
      } catch (error) {
        log('setEffort failed', error);
        if (session !== this.session) {
          const entry = this.entryOf(session);
          if (entry) entry.effortOverride = previous;
          return;
        }
        new Notice('Could not change the effort.');
        // The menu goes back to the effort that runs.
        this.effortOverride = previous;
      }
    }
    this.populateEffortSelect();
  }

  private async changeModel(value: string): Promise<void> {
    // Default is sent as such: with no model, Claude Code runs the one its settings name, which may differ.
    const previous = this.modelOverride;
    this.modelOverride = value || undefined;
    const session = this.session;
    let switched = true;
    if (session) {
      try {
        await session.setModel(this.modelOverride);
        if (session !== this.session) return;
        const chosen = this.chosenModelInfo();
        this.currentModel = chosen?.resolvedModel ?? this.modelOverride ?? this.currentModel;
        // A model switch can change the effort too (per-model effort settings).
        this.syncEffort();
      } catch (error) {
        log('setModel failed', error);
        if (session !== this.session) {
          const entry = this.entryOf(session);
          if (entry) entry.modelOverride = previous;
          return;
        }
        new Notice('Could not switch the model.');
        // The menu stays on the model that runs (currentModel, which this left alone, still names it).
        this.modelOverride = previous;
        switched = false;
      }
    } else {
      // Nothing running yet (a chat reopened, or one not started): the choice is what it will run,
      // so the model read from the transcript must stop deciding what the menu shows.
      this.currentModel = null;
    }
    this.populateModelSelect();
    if (switched) this.renderSettingLine(`Model: ${this.modelMenu.label}`);
    // A model without fast mode turns it off.
    const chosen = this.chosenModelInfo();
    if (this.fastMode && chosen && !chosen.supportsFastMode) void this.toggleFastMode();
  }

  /** The model chosen for the chat, as Claude Code lists it; undefined when it lists none of that name. */
  private chosenModelInfo(): (typeof this.plugin.models)[number] | undefined {
    return this.plugin.models.find((model) => model.value === this.chosenModel());
  }

  /** The fast-mode button: shown for a model that supports fast mode (or while it is on); lit while it runs. */
  private updateFastButton(): void {
    if (!this.fastButton) return;
    const chosen = this.chosenModelInfo();
    this.fastButton.toggle(chosen?.supportsFastMode === true || this.fastMode);
    const blocked = this.fastMode && this.fastState && this.fastState.state !== 'on' ? fastModeBlock(this.fastState) : null;
    this.fastButton.toggleClass('is-on', this.fastMode && blocked === null);
    this.fastButton.toggleClass('is-blocked', blocked !== null);
    this.fastButton.setAttr(
      'aria-label',
      !this.fastMode
        ? 'Fast mode: faster output from the same model, at a higher cost'
        : blocked
          ? `Fast mode is on but not running: ${blocked}`
          : 'Fast mode is on (click to turn it off)',
    );
  }

  /** Turns fast mode on or off for this chat; a new chat starts with it off. */
  async toggleFastMode(): Promise<void> {
    const previous = this.fastMode;
    this.fastMode = !previous;
    this.fastState = null;
    this.updateFastButton();
    const session = this.session;
    try {
      await session?.setFastMode(this.fastMode);
    } catch (error) {
      log('setFastMode failed', error);
      if (session !== this.session) {
        const entry = session && this.entryOf(session);
        if (entry) entry.fastMode = previous;
        return;
      }
      new Notice('Could not switch fast mode.');
      // The button goes back to what runs.
      this.fastMode = previous;
      this.updateFastButton();
    }
  }

  /** What the session reports about fast mode; says once why when fast mode is on but not running. */
  private setFastState(state: string | undefined, reason: string | undefined): void {
    if (state === undefined && reason === undefined) return;
    const before = this.fastState;
    this.fastState = { state, reason };
    if (this.fastMode && state !== 'on' && (before?.state !== state || before?.reason !== reason)) {
      new Notice(`Fast mode isn't running: ${fastModeBlock(this.fastState)}.`);
    }
    this.updateFastButton();
  }

  private async loadModels(session: ClaudeSession): Promise<void> {
    try {
      const models = await session.supportedModels();
      if (models && models.length > 0) this.plugin.setModels(models);
    } catch (error) {
      log('supportedModels failed', error);
    }
    try {
      const commands = await session.supportedCommands();
      if (commands && commands.length > 0) this.plugin.setCommands(commands);
    } catch (error) {
      log('supportedCommands failed', error);
    }
    this.populateModelSelect();
  }

  private resetContextMeter(): void {
    // Blank until a reply brings a reading, in a new chat and in one opened from history alike.
    this.contextText.setText('');
    this.lastContext = null;
    this.contextFill.style.width = '0';
    // No empty track either; it appears with the first reading.
    this.contextBar.hide();
    this.compactMark.hide();
    this.meterEl.removeClass('is-near-compaction');
    this.meterEl.show();
  }

  private async refreshMeters(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      const context = await session.contextUsage();
      // Another chat may be on screen by now.
      if (context && session === this.session) this.renderContextUsage(context);
    } catch (error) {
      log('getContextUsage failed', error);
    }
    if (session !== this.session || Date.now() - this.plugin.planFetchedAt < PLAN_USAGE_INTERVAL_MS) return;
    try {
      const plan = await session.planUsage();
      if (plan) {
        this.plugin.setPlanUsage(plan);
        this.renderPlanUsage(plan);
      }
    } catch (error) {
      log('plan usage failed', error);
    }
  }

  private renderContextUsage(usage: SDKControlGetContextUsageResponse): void {
    // Reports the model after every turn, which catches a switch made with /model.
    if (usage.model && usage.model !== this.currentModel) {
      this.currentModel = usage.model;
      this.populateModelSelect();
    }
    const figures = contextFigures(usage);
    if (!figures) return;
    this.lastContext = usage;
    const { used, max, threshold } = figures;
    const pct = Math.min(100, (used / max) * 100);
    const shownPct = used > 0 && pct < 1 ? '<1' : String(Math.round(pct));
    // Just the share used; the hover card has the tokens and where auto-compaction starts.
    this.contextText.setText(`Context ${shownPct}%`);
    if (this.usageCard.isShown()) this.refreshUsageCard();
    this.contextFill.style.width = `${pct}%`;
    this.contextBar.show();
    this.compactMark.toggle(threshold !== null);
    if (threshold !== null) this.compactMark.style.left = `${Math.min(100, (threshold / max) * 100)}%`;
    this.meterEl.toggleClass('is-near-compaction', threshold !== null && used >= threshold * 0.9);
    this.meterEl.show();
  }

  private renderPlanUsage(usage: SDKControlGetUsageResponse): void {
    const windows = usageWindows(usage);
    this.planText.empty();
    windows.forEach((window, i) => {
      if (i > 0) this.planText.createSpan({ text: ' - ' });
      const left = window.resetsAt ? timeLeft(window.resetsAt - Date.now()) : '';
      // Bare figures, in the order session, week, per-model week; the hover card names them.
      // Only a figure near its limit is coloured, so the colour says which one.
      this.planText.createSpan({ cls: `vc-meter-figure is-${window.level}`, text: left ? `${window.percent}%(${left})` : `${window.percent}%` });
    });
    if (windows.length > 0) this.meterEl.show();
    if (this.usageCard.isShown()) this.refreshUsageCard();
  }

  private refreshUsageCard(): void {
    renderUsageCard(this.usageCard, {
      context: this.lastContext,
      model: this.currentModel,
      plan: this.plugin.planUsage,
      planFetchedAt: this.plugin.planFetchedAt,
    });
  }

  // ---- Stream handling ---------------------------------------------------

  /** When the session file was last read for queued messages taken up (see noticeQueuedTaken). */
  private queuedCheckedAt = 0;
  /** A saved chat's messages are being drawn (see renderTranscript): not scrolled message by message. */
  private drawingSaved = false;

  /**
   * Queued messages Claude Code has folded into the turn running: their "Queued" mark goes as soon as
   * its file says so (see queuedTaken), not only when the turn ends. Read at most every two seconds,
   * and only while one is queued.
   */
  private noticeQueuedTaken(): void {
    const queued = [...this.pending].filter(([, sent]) => sent.bubble.hasClass('is-queued') && sent.text !== undefined);
    const id = this.chatId;
    const root = this.plugin.vaultRoot();
    if (queued.length === 0 || !id || !root || Date.now() - this.queuedCheckedAt < 2000) return;
    this.queuedCheckedAt = Date.now();
    void queuedTaken(id, root).then((taken) => {
      if (id !== this.chatId) return;
      for (const [key, sent] of queued) {
        const text = sent.text?.trim() ?? '';
        // By the uuid it was sent with; else its prompt, which holds what was typed after any notes that went with it.
        if (taken.uuids.has(key) || (text && taken.texts.some((prompt) => prompt.includes(text)))) this.markDelivered(key, false);
      }
    });
  }

  private onMessage(message: SDKMessage): void {
    if (message.type === 'assistant' && message.parent_tool_use_id === null) this.noticeQueuedTaken();
    if (trackTask(this.tasks, message)) {
      this.updateStopButton();
      this.updateTab();
    }
    if (!this.busy && (message.type === 'stream_event' || message.type === 'assistant') && message.parent_tool_use_id === null) {
      // A reply to a message sent here is this panel's turn, even after another turn ended first.
      const answering = answeredBy(message);
      if ((answering ?? []).some((id) => this.sentIds.has(id))) this.beginTurn(answering);
      else void this.beginRemoteTurn(answering);
    }
    switch (message.type) {
      case 'system':
        if (message.subtype === 'status' && message.permissionMode) {
          this.followMode(message.permissionMode);
        } else if (message.subtype === 'init') {
          const draftWas = this.draftKey();
          // A chat from outside the panel, copied as it resumes: the copy names it.
          const copyOf = this.forkOnResume ? (this.resumeId ?? undefined) : undefined;
          this.resumeId = message.session_id;
          // A fork has its own id now; resuming it later (after a crash) must not fork again.
          this.forkOnResume = false;
          if (this.chatId !== message.session_id) {
            // What its projects sent and its choices, kept under its id (a fork keeps its original's); a
            // new chat's project follows from its attached note.
            const started = this.chatId === null;
            const start: ChatStart = started ? this.startOf() : { state: { ...this.projectStateNow() }, chats: [], notes: [] };
            this.chatId = message.session_id;
            if (this.scratch) this.plugin.setScratch(message.session_id);
            else {
              this.plugin.recordChat(message.session_id, this.chatName ?? 'Untitled chat', copyOf);
              this.plugin.adoptProjectState(message.session_id, start.state);
            }
            this.projectLocal = {};
            // A new chat has connections now: the Connections pane shows it.
            if (started) this.plugin.chatShown(this);
          }
          this.moveDraft(draftWas);
          this.linkSentNotes([]);
          this.linkSentChats([]);
          this.updateChatButtons();
          this.plugin.checkClaudeVersion(message.claude_code_version);
          this.currentModel = message.model;
          this.currentEffort = message.effort ?? null;
          this.setFastState(message.fast_mode_state, message.fast_mode_disabled_reason);
          this.populateModelSelect();
          if (!this.modelsRequested && this.session) {
            this.modelsRequested = true;
            void this.loadModels(this.session);
          }
          if (this.plugin.settings.phoneEveryChat && !this.scratch && !this.remoteUrl && !this.remoteRequested && this.session) {
            this.remoteRequested = true;
            void this.setChatRemote(true);
          }
        } else if (message.subtype === 'compact_boundary') {
          // Optional in practice, whatever the SDK's types say: a Claude Code release may leave it out.
          this.renderCompaction(message.compact_metadata?.trigger, message.compact_metadata?.pre_tokens);
          void this.refreshMeters();
          // The summary that replaces the conversation does not carry the context the hook added: it goes again.
          if (this.chatId) this.plugin.contextLeft(this.chatId, false);
        } else if (message.subtype === 'task_notification' && !message.ambient && !message.skip_transcript) {
          const { usage } = message;
          this.renderTaskNotice(
            {
              summary: message.summary,
              status: message.status,
              taskId: message.task_id,
              outputFile: message.output_file,
            details: [
              `Task ${message.task_id}`,
              `Output: ${message.output_file}`,
              usage
                ? `Usage: ${usage.total_tokens.toLocaleString()} tokens, ${usage.tool_uses} tool uses, ${Math.round(usage.duration_ms / 1000)} s`
                : '',
            ].filter((line) => line.length > 0),
            },
            true,
          );
        }
        break;
      case 'rate_limit_event':
        if (message.rate_limit_info.status === 'rejected') {
          const resets = message.rate_limit_info.resetsAt;
          this.renderNotice(`Plan usage limit reached${resets ? `; resets ${formatDate(resets * 1000)}` : ''}.`);
        }
        break;
      case 'stream_event': {
        if (message.parent_tool_use_id !== null) break;
        const { event } = message;
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'text') {
            this.startLiveText();
            this.setPhase('Writing…');
          } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            this.setPhase('Thinking…');
          } else if (block.type === 'tool_use') {
            this.setPhase(`${toolLabel(block.name)}…`);
          }
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          this.appendLive(event.delta.text);
        }
        break;
      }
      case 'assistant':
        // Subagent traffic (parent_tool_use_id set) stays inside its Agent tool line; only the edits of
        // one the reply is waiting for show, in its card. A background agent's show under its notice.
        if (message.parent_tool_use_id !== null) {
          if (this.tools.get(message.parent_tool_use_id)?.status !== 'running') break;
          for (const block of message.message.content) {
            if (block.type === 'tool_use') this.agentCalls.set(block.id, { name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
          }
          break;
        }
        let textIndex = 0;
        for (const block of message.message.content) {
          if (block.type === 'text') {
            if (!block.text.trim()) continue;
            this.finishText(block.text, replyKey(message.uuid, textIndex));
            textIndex += 1;
          } else if (block.type === 'thinking') this.renderThinking(block.thinking);
          else if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>;
            this.addTool(block.id, block.name, input);
          }
        }
        if (this.draw.turn) this.setBranchPoint(this.draw.turn, message.message.content, message.uuid);
        break;
      case 'user':
        if (typeof message.message.content === 'string') break;
        for (const result of toolResults(message.message.content, message.tool_use_result)) {
          if (message.parent_tool_use_id === null) {
            this.finishTool(result.id, result.isError, result.structured);
            continue;
          }
          const call = this.agentCalls.get(result.id);
          this.agentCalls.delete(result.id);
          if (call && !result.isError) this.renderEdit(call.name, call.input, result.structured, false);
        }
        break;
      case 'result': {
        this.setFastState(message.fast_mode_state, message.fast_mode_disabled_reason);
        for (const id of message.user_message_uuids ?? []) this.markDelivered(id);
        const turn = this.draw.turn;
        const wasBusy = this.busy;
        const failed = message.subtype !== 'success' || message.is_error;
        this.endTurn(message);
        if (turn) {
          this.finishTurnActions(turn, turnStats(message));
          // The earlier turns' were recorded when they were drawn.
          this.recordMentions(turn);
          this.countNotesSoon();
        }
        if (wasBusy && !this.isOnScreen()) {
          this.unseen = failed ? 'error' : 'done';
          if (this.chatId) this.plugin.markChatUnseen(this.chatId, failed ? 'error' : 'done');
          this.updateTab();
        }
        if (wasBusy && message.duration_ms >= this.plugin.settings.notifyAfterSeconds * 1000) {
          this.systemNotify(failed ? 'Claude stopped with an error' : 'Claude finished', this.chatName ?? 'Chat', () => {
            void this.app.workspace.revealLeaf(this.leaf);
          });
        }
        if (this.pending.size > 0 && this.session) {
          const waiting = [...this.pending.entries()].filter(([, entry]) => !entry.running);
          if (waiting.length > 0) {
            // Queued messages this turn did not take up run as the next turn.
            for (const [id] of waiting) this.markDelivered(id, false);
            this.beginTurn(waiting.map(([id]) => id));
          } else {
            // Already given their own turn and not reported back; stop tracking them.
            this.pending.clear();
          }
        }
        if (this.scratch) this.plugin.touchScratch();
        void this.refreshMeters();
        void this.refreshTitle();
        break;
      }
      default:
        break;
    }
  }

  private onSessionEnd(error: Error | undefined, stderrTail: string | undefined): void {
    this.session = null;
    this.sessionToken = null;
    this.remoteUrl = null;
    this.updatePhoneButton();
    // Its background tasks ended with its process: no word of them will come.
    if (this.tasks.size > 0) {
      this.tasks = new Set();
      this.updateStopButton();
      this.updateTab();
    }
    for (const { bubble } of this.pending.values()) {
      if (!bubble.hasClass('is-queued')) continue;
      bubble.addClass('is-unsent');
      bubble.querySelector('.vc-queued-label')?.setText('Not sent: the session ended');
    }
    this.pending.clear();
    if (error) {
      this.renderNotice(`Claude Code stopped: ${error.message}${stderrTail ? `\n\n${stderrTail}` : ''}`);
    }
    this.endTurn();
  }

  /** `prompts`: the messages the turn answers, when known (see turnPrompts). */
  /** `prompts`: the messages the turn answers, when known (see turnPrompts); `turn`: a turn already drawn that it goes on in. */
  private beginTurn(prompts: string[] = [], turn: HTMLElement | null = null): void {
    this.busy = true;
    this.turnPrompts = prompts;
    this.interrupted = false;
    this.draw.turnHadText = turn?.querySelector('.vc-text') != null;
    this.draw.turn = turn ?? this.messagesEl.createDiv({ cls: 'vc-turn' });
    this.dropLive();
    this.draw.liveText = null;
    this.draw.group = null;
    this.tools.clear();
    this.agentCalls.clear();
    this.turnStartedAt = Date.now();
    this.phase = 'Working…';
    this.activityEl = this.draw.turn.createDiv({ cls: 'vc-activity' });
    this.activityEl.createSpan({ cls: 'vc-spinner' });
    this.activityLabel = this.activityEl.createSpan({ cls: 'vc-activity-label' });
    this.activityTime = this.activityEl.createSpan({ cls: 'vc-activity-time' });
    this.inputEl.placeholder = 'Claude is working. A message sent now is queued; Esc stops.';
    this.updateStopButton();
    this.tickStatus();
    this.statusTimer = window.setInterval(() => this.tickStatus(), 1000);
    this.startMotion();
    this.scrollToBottom(true);
  }

  private endTurn(result?: SDKResultMessage): void {
    if (!this.busy) return;
    this.finishTurnUi();
    if (this.interrupted) {
      this.renderNotice('Stopped.', 'vc-muted');
    } else if (result) {
      if (result.subtype === 'success') {
        const text = result.result.trim();
        if (result.is_error) {
          if (!this.draw.turnHadText && text) this.renderNotice(text);
        } else if (!this.draw.turnHadText && text) {
          this.finishText(text);
        }
      } else {
        this.renderNotice(`Claude Code ended the turn (${result.subtype})${result.errors.length ? `: ${result.errors.join('; ')}` : ''}`);
      }
    }
    this.draw.turn = null;
    this.scrollToBottom();
  }

  private finishTurnUi(): void {
    // Anything streamed but not yet on screen belongs to the reply that just ended.
    this.flushLive();
    // Checked a last time: pinned updates are spaced out, and the last scroll may have been skipped.
    this.promptNav?.schedule();
    this.busy = false;
    this.turnPrompts = [];
    this.stopStatusTimer();
    this.updateTab();
    this.activityEl?.remove();
    this.activityEl = null;
    this.activityLabel = null;
    this.activityTime = null;
    this.inputEl.placeholder = this.placeholderText();
    this.updateStopButton();
    // A text block that streamed nothing but white space leaves no empty element behind.
    const live = this.draw.liveText;
    if (live && !live.textContent?.trim()) live.remove();
    else live?.removeClass('vc-live');
    this.draw.liveText = null;
  }

  private setPhase(phase: string): void {
    this.phase = phase;
    this.tickStatus();
  }

  private tickStatus(): void {
    this.updateTab();
    if (!this.activityEl || !this.activityLabel || !this.activityTime || !this.isOnScreen()) return;
    const waiting = this.pendingApprovals > 0;
    const asking = this.openApprovals.some((approval) => approval.request.toolName === 'AskUserQuestion');
    const label = this.interrupted ? 'Stopping…' : waiting ? (asking ? 'Waiting for your answer' : 'Waiting for your approval') : this.phase;
    this.activityLabel.setText(label);
    this.activityLabel.setAttr('title', label);
    this.activityTime.setText(formatDuration(Date.now() - this.turnStartedAt));
    this.activityEl.toggleClass('is-waiting', waiting);
  }

  private stopStatusTimer(): void {
    if (this.statusTimer !== null) window.clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.stopMotion();
  }

  /**
   * The working icon and the dot beside the activity line, stepped by a timer. As CSS animations
   * they kept a frame running for as long as a reply did — the compositor and the GPU process draw
   * every frame whether or not the picture changes, which is most of what the panel cost while
   * Claude worked. Four steps a second is motion enough to read as "working".
   */
  private startMotion(): void {
    this.stopMotion();
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    this.motionTimer = window.setInterval(() => this.stepMotion(), MOTION_MS);
    this.stepMotion();
  }

  /** The tab's own icon, which the panel turns while a reply runs. */
  private tabIcon(): SVGElement | null | undefined {
    const leaf = this.leaf as unknown as { tabHeaderEl?: HTMLElement };
    return leaf.tabHeaderEl?.querySelector<SVGElement>('.workspace-tab-header-inner-icon svg');
  }

  private stepMotion(): void {
    this.motionStep += 1;
    const icon = this.tabIcon();
    // 30 degrees a step: the icon is eight spokes, so 45 would land on the same shape every time.
    if (icon) icon.style.transform = `rotate(${(this.motionStep * 30) % 360}deg)`;
    // Half the rate of the icon, so the two do not pulse as one.
    this.activityEl?.querySelector('.vc-spinner')?.toggleClass('is-dim', this.motionStep % 2 === 0);
  }

  private stopMotion(): void {
    if (this.motionTimer !== null) window.clearInterval(this.motionTimer);
    this.motionTimer = null;
    this.tabIcon()?.style.removeProperty('transform');
  }

  // ---- Rendering ---------------------------------------------------------

  private container(): HTMLElement {
    // A reply can start without a message of yours (a resumed session picking up mid-exchange);
    // it gets a turn of its own, so its steps fold and it carries the reply's buttons.
    this.draw.turn ??= this.draw.parent.createDiv({ cls: 'vc-turn' });
    return this.draw.turn;
  }

  private startLiveText(): void {
    this.draw.group = null;
    this.draw.liveText = this.container().createDiv({ cls: 'vc-text vc-live' });
  }

  /**
   * A reply arrives as many small pieces. Each one put on screen on its own would append, read the
   * scroll height and set it back — a layout per token, and a raster pass for it — and nobody reads
   * at sixty updates a second. They are collected and written ten times a second instead, and a
   * hidden panel is not scrolled at all.
   */
  private appendLive(text: string): void {
    if (!this.draw.liveText) this.startLiveText();
    this.livePending += text;
    if (this.liveTimer !== null) return;
    const wait = Math.max(0, LIVE_FLUSH_MS - (Date.now() - this.lastFlushAt));
    this.liveTimer = window.setTimeout(() => {
      this.liveTimer = null;
      this.flushLive();
    }, wait);
  }

  private flushLive(): void {
    if (this.liveTimer !== null) window.clearTimeout(this.liveTimer);
    this.liveTimer = null;
    if (!this.livePending) return;
    this.lastFlushAt = Date.now();
    const text = this.livePending;
    this.livePending = '';
    this.draw.liveText?.append(text);
    if (this.isOnScreen()) this.scrollToBottom();
  }

  /** The finished reply replaces the streamed text, so what is still buffered is not needed. */
  private dropLive(): void {
    if (!this.drawingLive()) return;
    if (this.liveTimer !== null) window.clearTimeout(this.liveTimer);
    this.liveTimer = null;
    this.livePending = '';
  }

  /** `replyId`: the reply text's key (see replyKey), under which its checkbox ticks are kept. */
  private finishText(text: string, replyId?: string): void {
    this.dropLive();
    const el = this.draw.liveText ?? this.container().createDiv({ cls: 'vc-text' });
    this.draw.liveText = null;
    this.draw.group = null;
    this.draw.turnHadText = true;
    el.removeClass('vc-live');
    el.empty();
    this.markdownSource.set(el, text);
    // Its message, for a memo's link to go straight to it (see goToMessage).
    if (replyId) el.dataset.message = replyId;
    // Taken now: by the time the reply has rendered, another chat may be on screen.
    const chat = this.chatId ?? this.resumeId;
    void this.renderMarkdown(text, el).then(() => {
      if (chat && replyId) this.wireCheckboxes(el, chat, replyId);
    });
    if (this.busy && this.drawingLive()) this.setPhase('Working…');
    this.scrollToBottom();
  }

  /**
   * Makes a reply's checkboxes clickable and shows the reader's saved ticks. Ticks are kept as the
   * positions flipped from the reply's own `[ ]` / `[x]`, per chat and reply, in the plugin's data;
   * Claude never sees them.
   */
  private wireCheckboxes(el: HTMLElement, chat: string, replyId: string): void {
    const boxes = Array.from(el.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox'));
    if (boxes.length === 0) return;
    const written = boxes.map((box) => box.checked);
    const toggled = this.plugin.toggledTicks(chat, replyId);
    this.replyTicks.set(el, toggled);
    const show = (box: HTMLInputElement, checked: boolean) => {
      box.checked = checked;
      const item = box.closest('li');
      item?.toggleClass('is-checked', checked);
      item?.setAttr('data-task', checked ? 'x' : ' ');
    };
    boxes.forEach((box, index) => {
      box.disabled = false;
      show(box, written[index] !== toggled.has(index));
      box.addEventListener('click', (evt) => evt.stopPropagation());
      box.addEventListener('change', () => {
        if (box.checked === written[index]) toggled.delete(index);
        else toggled.add(index);
        show(box, box.checked);
        this.plugin.setTicks(chat, replyId, toggled);
      });
    });
  }

  private addTool(id: string, name: string, input: Record<string, unknown>): void {
    const display = this.plugin.settings.toolDisplay;
    const entry: ToolEntry = { name, input, status: 'running', lineEl: null, group: null };
    this.tools.set(id, entry);
    if (this.busy && this.drawingLive()) {
      const summary = summarizeTool(name, input, this.plugin.vaultRoot() ?? '');
      this.setPhase(summary.text ? `${toolLabel(name)}: ${summary.text}` : `${toolLabel(name)}…`);
    }
    if (display === 'hidden') return;
    if (!this.draw.group) this.draw.group = this.createToolGroup(display);
    entry.group = this.draw.group;
    this.draw.group.entries.push(entry);
    entry.lineEl = this.renderToolLine(this.draw.group.list, name, input);
    this.updateToolGroup(this.draw.group);
    this.scrollToBottom();
  }

  /** Marks a tool call finished; an edit to a file also joins the reply's changed files. `structured` is its tool_use_result (live only). */
  /** `saved`: a result drawn from a saved chat rather than one just made. */
  private finishTool(id: string, isError: boolean, structured?: unknown, saved = false): void {
    const entry = this.tools.get(id);
    if (!entry) return;
    if (!isError && entry.status === 'running') this.renderEdit(entry.name, entry.input, structured, saved);
    entry.status = isError ? 'error' : 'done';
    entry.lineEl?.removeClass('is-running');
    entry.lineEl?.toggleClass('is-error', isError);
    if (entry.group) this.updateToolGroup(entry.group);
    if (this.busy && this.drawingLive() && ![...this.tools.values()].some((other) => other.status === 'running')) this.setPhase('Working…');
  }

  /**
   * Claude's changes to files, by its edit tools or by a shell command, added to the reply's card
   * of changed files (kept at the reply's end).
   */
  private renderEdit(name: string, input: Record<string, unknown>, structured: unknown, saved: boolean): void {
    const root = this.plugin.vaultRoot() ?? '';
    // The plan Claude Code writes in plan mode is shown by its card, not as a changed file.
    const diffs = toolDiffs(name, input, structured).filter((diff) => !isPlanFile(diff.file));
    for (const diff of diffs) {
      const vaultPath = vaultRelative(diff.file, root);
      // The note remembers the chats that changed it, and offers them when you open it again. An
      // edit seen again in a saved chat only fills in a missing link: it does not make the chat newest.
      // A chat from outside the panel, under its own session until a message makes the panel's copy.
      const chat = this.chatId ?? this.resumeId;
      // A shell command's reported changes link only the files it names (see isOwnChange).
      if (vaultPath && chat && !this.scratch && isOwnChange(diff)) this.plugin.linkNoteChat(vaultPath, chat, !saved);
      const container = this.container();
      let card = this.changeCards.get(container);
      if (!card) {
        card = new ChangesCard(container, (path, text, hint, evt) => this.openDiffLine(path, text, hint, evt));
        this.changeCards.set(container, card);
      }
      card.add(diff, vaultPath);
    }
    if (diffs.length > 0) this.scrollToBottom();
  }

  /** Opens a note at a line of a diff in a card of changed files (see ChangesCard). */
  private openDiffLine(path: string, text: string, hint: number | undefined, evt: MouseEvent): void {
    void openFileAtLine(this.app, path, text, hint, Keymap.isModEvent(evt));
  }

  /**
   * The files a background agent changed, in a card under its notice, read from its transcript: the
   * file its task names as its output, else `fallback`, where the chat keeps its agents'. With `link`
   * (a notice arriving now), the notes are linked to this chat as edits made now.
   */
  private async showAgentChanges(notice: HTMLElement, outputFile: string | undefined, fallback: string | undefined, link: boolean): Promise<void> {
    const chatId = this.chatId;
    let diffs: EditDiff[];
    try {
      const transcript = await agentTranscript(outputFile, fallback);
      diffs = transcript ? agentDiffs(transcript) : [];
    } catch (error) {
      log('reading the changes of a background agent failed', error);
      return;
    }
    if (diffs.length === 0 || !notice.isConnected) return;
    const root = this.plugin.vaultRoot() ?? '';
    const card = new ChangesCard(createDiv(), (path, text, hint, evt) => this.openDiffLine(path, text, hint, evt));
    notice.querySelector(':scope > .vc-tools-header')?.after(card.el);
    for (const diff of diffs) {
      const vaultPath = vaultRelative(diff.file, root);
      if (link && vaultPath && chatId && chatId === this.chatId && !this.scratch && isOwnChange(diff)) this.plugin.linkNoteChat(vaultPath, chatId);
      card.add(diff, vaultPath);
    }
    card.fold(true);
  }

  private createToolGroup(display: ToolDisplay): ToolGroup {
    const el = this.container().createDiv({ cls: 'vc-tools' });
    const header = el.createDiv({ cls: 'vc-tools-header' });
    const list = el.createDiv({ cls: 'vc-tools-list' });
    if (display === 'summary') {
      list.hide();
      header.addEventListener('click', () => {
        list.toggle(!list.isShown());
        el.toggleClass('is-open', list.isShown());
      });
    } else {
      header.hide();
    }
    return { el, header, list, entries: [] };
  }

  private updateToolGroup(group: ToolGroup): void {
    const counts = new Map<string, number>();
    for (const entry of group.entries) {
      const label = toolLabel(entry.name);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const failed = group.entries.filter((entry) => entry.status === 'error').length;
    group.header.empty();
    setIcon(group.header.createSpan({ cls: 'vc-tools-chevron' }), 'chevron-right');
    group.header.createSpan({
      cls: 'vc-tools-text',
      text: [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(', '),
    });
    if (failed > 0) group.header.createSpan({ cls: 'vc-tools-failed', text: `${failed} failed` });
    group.el.toggleClass('is-running', group.entries.some((entry) => entry.status === 'running'));
  }

  private renderToolLine(parent: HTMLElement, name: string, input: Record<string, unknown>): HTMLElement {
    const line = parent.createDiv({ cls: 'vc-tool is-running' });
    line.createSpan({ cls: 'vc-tool-name', text: toolLabel(name) });
    const summary = summarizeTool(name, input, this.plugin.vaultRoot() ?? '');
    if (summary.text) {
      const span = line.createSpan({ cls: 'vc-tool-summary', text: summary.text });
      if (summary.vaultPath) {
        span.addClass('vc-file-link');
        span.dataset.path = summary.vaultPath;
      }
    }
    return line;
  }

  private askPermission(request: PermissionRequest): Promise<PermissionResult> {
    this.systemNotify(`Claude ${waitingFor(request)}`, this.chatName ?? 'Chat', () => {
      void this.app.workspace.revealLeaf(this.leaf);
    });
    return new Promise((resolve) => this.renderApprovalCard(this.newApproval(request, resolve, this.chatId ?? this.resumeId)));
  }

  /**
   * A permission request of chat `chatKey`, as the panel holds it. Withdrawn before it is answered
   * (Esc, or the chat closing), a plan's note is kept or put away (see withdrawPlanNote): once,
   * whether the request is on screen or in the background, and not listened for once answered.
   */
  private newApproval(request: PermissionRequest, resolve: (result: PermissionResult) => void, chatKey: string | null): Approval {
    const withdraw = () => void this.withdrawPlanNote(approval);
    const approval: Approval = {
      request,
      chatKey,
      resolve: (result) => {
        request.signal.removeEventListener('abort', withdraw);
        this.onWithdrawn(approval, null);
        resolve(result);
      },
    };
    request.signal.addEventListener('abort', withdraw, { once: true });
    return approval;
  }

  /** Shows an approval card; also re-shows one that waited while its chat was in the background. */
  private renderApprovalCard(approval: Approval): void {
    const { request, resolve } = approval;
    if (request.signal.aborted) {
      resolve({ behavior: 'deny', message: 'Cancelled.' });
      return;
    }
    const { toolName, input } = request;
    const summary = summarizeTool(toolName, input, this.plugin.vaultRoot() ?? '');
    const card = this.container().createDiv({ cls: 'vc-permission' });
    // A plan or questions wait on you: the steps that led to them fold into one line above them.
    if (toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion') this.foldStepsBefore(card);
    if (!approval.shown) log('approval asked', { tool: toolName });
    approval.shown = true;
    this.openApprovals.push(approval);
    this.draw.group = null;
    this.tickStatus();

    // `label`: what the card says once decided, before the tool and what it was for; a question's
    // card says its answers instead.
    const finish = (result: PermissionResult, label: string, said?: string) => {
      log('approval answered', { tool: toolName, behavior: result.behavior, as: label });
      // A card whose chat has since moved to the background only answers the request.
      const onScreen = this.openApprovals.includes(approval);
      this.openApprovals = this.openApprovals.filter((open) => open !== approval);
      if (onScreen) {
        if (this.busy) this.tickStatus();
        card.empty();
        card.removeClass('vc-question-card', 'vc-plan-card');
        card.addClass('is-decided');
        card.setText(said ?? `${label}: ${toolLabel(toolName)}${summary.text ? ` ${summary.text}` : ''}`);
        if (result.behavior === 'allow' && toolName === 'ExitPlanMode' && this.mode === 'plan') {
          // Claude Code was told the same mode in the approval (see renderPlanCard), and reports it.
          this.followMode(this.modeBeforePlan);
        }
      }
      resolve(result);
    };
    // Withdrawn by Claude Code: Esc stopped the reply, or the chat closed. A plan or questions say what
    // that means, since Plan mode stays on and nothing was approved or answered.
    const onAbort = () => {
      const why = this.interrupted ? ': you stopped the reply' : '';
      const said = toolName === 'ExitPlanMode' ? `Plan withdrawn${why}` : toolName === 'AskUserQuestion' ? `Questions withdrawn${why}` : undefined;
      finish({ behavior: 'deny', message: 'Cancelled.' }, 'Cancelled', said);
    };
    this.onWithdrawn(approval, onAbort);

    // Claude's multiple-choice questions: answered here, the answers going back as the tool's input.
    // Ones the card cannot read are refused at once, and Claude asks in plain text instead.
    const questions = toolName === 'AskUserQuestion' ? readQuestions(input) : null;
    if (toolName === 'AskUserQuestion' && !questions) {
      finish(
        { behavior: 'deny', message: 'The panel could not show these questions. Ask them in plain text instead.' },
        'Not shown',
        "Claude's questions could not be shown; it was asked to ask them in plain text",
      );
      return;
    }
    if (questions) {
      renderQuestionCard(card, questions, (answers) =>
        answers
          ? finish({ behavior: 'allow', updatedInput: { ...input, answers } }, 'Answered', `Answered: ${answeredText(questions, answers)}`)
          : finish({ behavior: 'deny', message: 'The user chose not to answer these questions.' }, 'Skipped', 'Questions skipped'),
      );
      this.scrollToBottom(true);
      return;
    }

    // The plan that ends plan mode: approved as it is or as edited in a note, or sent back with feedback.
    if (toolName === 'ExitPlanMode') {
      this.renderPlanCard(card, approval, finish);
      this.scrollToBottom(true);
      return;
    }

    card.createDiv({ cls: 'vc-permission-title', text: request.title ?? `Claude wants to use ${toolLabel(toolName)}` });
    this.renderPermissionDetail(card.createDiv({ cls: 'vc-permission-detail' }), request);
    if (request.decisionReason) card.createDiv({ cls: 'vc-muted', text: request.decisionReason });

    const buttons = card.createDiv({ cls: 'vc-permission-buttons' });
    buttons
      .createEl('button', { cls: 'mod-cta', text: 'Allow' })
      .addEventListener('click', () => finish({ behavior: 'allow', updatedInput: input }, 'Allowed'));
    const suggestions = request.suggestions ?? [];
    if (suggestions.length > 0) {
      // Scope "don't ask again" to this chat rather than writing to a settings file.
      const sessionOnly = suggestions.map((update) => ({ ...update, destination: 'session' })) as PermissionUpdate[];
      buttons
        .createEl('button', { text: 'Allow for this chat' })
        .addEventListener('click', () =>
          finish({ behavior: 'allow', updatedInput: input, updatedPermissions: sessionOnly }, 'Allowed for this chat'),
        );
    }
    buttons
      .createEl('button', { text: 'Deny' })
      .addEventListener('click', () => finish({ behavior: 'deny', message: 'The user denied this action.' }, 'Denied'));
    this.scrollToBottom(true);
  }

  /**
   * The card for a plan Claude asks to carry out (its ExitPlanMode request), which holds the plan's
   * Markdown. It can be edited in a note, in a Plans folder beside the saved chats; Approve sends the
   * note's text as the plan, which Claude Code passes on as "edited by user". Feedback declines the
   * plan with what to change, and Claude plans again; Reject declines it. The note is deleted once
   * the plan is answered, however it is.
   */
  private renderPlanCard(card: HTMLElement, approval: Approval, finish: (result: PermissionResult, label: string, said?: string) => void): void {
    const { input, signal } = approval.request;
    // The plan as shown: the request's own text, or else its plan file (see showPlan).
    let plan = typeof input.plan === 'string' ? input.plan.trim() : '';
    const noteFile = (): TFile | null => {
      const file = approval.notePath ? this.app.vault.getAbstractFileByPath(approval.notePath) : null;
      return file instanceof TFile ? file : null;
    };
    /** The plan as edited in its note (null when it has none, or was not changed), and the note gone. */
    const takeNote = async (): Promise<string | null> => {
      const file = noteFile();
      approval.notePath = null;
      if (!file) return null;
      const text = (await this.app.vault.read(file)).trim();
      await this.discardNote(file);
      return text && text !== plan.trim() ? text : null;
    };
    // A plan note kept, with its edits, from a plan withdrawn in this chat carries over to this one
    // (not to a card drawn again, its chat back from the background, which has its own).
    const { chatKey } = approval;
    const kept = chatKey && !approval.notePath ? this.plugin.planNotes[chatKey]?.path : undefined;
    const carried = kept !== undefined && this.app.vault.getAbstractFileByPath(kept) instanceof TFile;
    if (carried) approval.notePath = kept;

    // No title: the plan's own heading names it, and the framed card and its buttons say what it is.
    card.addClass('vc-plan-card');
    if (carried) {
      const line = card.createDiv({ cls: 'vc-muted vc-plan-carried' });
      line.appendText('Your edits to the plan you withdrew are in the plan note, and Approve sends them. ');
      line.createSpan({ cls: 'vc-welcome-link', text: "Use Claude's plan instead" }).addEventListener('click', () => {
        const file = noteFile();
        approval.notePath = null;
        if (file) void this.discardNote(file);
        editButton.setText('Edit in a note');
        line.remove();
      });
    }
    const body = card.createDiv({ cls: 'vc-permission-detail vc-plan' });
    const buttons = card.createDiv({ cls: 'vc-permission-buttons' });
    // The first answer holds: the card's controls go still while the note is read and put away.
    let deciding = false;
    let planShown = false;
    const decide = (answer: () => Promise<void>) => {
      if (deciding) return;
      deciding = true;
      for (const control of card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) control.disabled = true;
      answer().catch((error: unknown) => {
        log('answering a plan failed', error);
        new Notice(`Could not answer the plan: ${errorText(error)}`);
        deciding = false;
        for (const control of card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) control.disabled = false;
        // Still unseen: it is not approved or edited.
        approveButton.disabled = !planShown;
        editButton.disabled = !planShown;
      });
    };
    const approve = async () => {
      const edited = await takeNote();
      // The chat goes back to the mode it had before Plan mode, which Claude Code is told with the
      // approval (left to itself, it would return to Ask first).
      // Never to a mode the settings no longer offer (bypass switched off since).
      const offered = permissionModes(this.plugin.settings.allowBypass);
      const back = this.mode === 'plan' ? (this.modeBeforePlan in offered ? this.modeBeforePlan : 'default') : null;
      const returning = back && back !== 'default' ? { updatedPermissions: [{ type: 'setMode', mode: back, destination: 'session' }] as PermissionUpdate[] } : {};
      if (edited) finish({ behavior: 'allow', updatedInput: { ...input, plan: edited }, ...returning }, 'Approved', 'Plan approved, with your edits');
      else finish({ behavior: 'allow', updatedInput: input, ...returning }, 'Approved', 'Plan approved');
    };
    const approveButton = buttons.createEl('button', { cls: 'mod-cta', text: 'Approve' });
    approveButton.addEventListener('click', () => decide(approve));
    const editButton = buttons.createEl('button', { text: noteFile() ? 'Open the plan note' : 'Edit in a note' });
    // One note at a time: a second click while it is made waits for it.
    let making = false;
    editButton.addEventListener('click', () => {
      if (making) return;
      void (async () => {
        try {
          let file = noteFile();
          if (!file) {
            making = true;
            const path = await this.savedNotePath(formatDate(Date.now()).slice(0, 10), `Plan — ${this.chatName ?? 'New chat'}`, '', 'Plans');
            file = await this.app.vault.create(path, plan);
            // Answered or withdrawn while it was made: no plan to edit any more.
            if (deciding || card.hasClass('is-decided') || approval.request.signal.aborted) {
              await this.discardNote(file);
              return;
            }
            approval.notePath = file.path;
            if (chatKey) this.plugin.setPlanNote(chatKey, file.path, plan);
            editButton.setText('Open the plan note');
          }
          await this.app.workspace.getLeaf('tab').openFile(file);
          new Notice('Edit the plan there, then approve it, or send feedback, here.');
        } catch (error) {
          log('opening a plan note failed', error);
          new Notice(`Could not open the plan in a note: ${errorText(error)}`);
        } finally {
          making = false;
        }
      })();
    });
    buttons.createEl('button', { text: 'Reject' }).addEventListener('click', () =>
      decide(async () => {
        await takeNote();
        finish({ behavior: 'deny', message: 'The user rejected the plan.' }, 'Rejected', 'Plan rejected');
      }),
    );
    const feedbackRow = card.createDiv({ cls: 'vc-plan-feedback' });
    const feedback = feedbackRow.createEl('input', { attr: { type: 'text', placeholder: 'Or tell Claude what to change' } });
    const sendFeedback = () => {
      const text = feedback.value.trim();
      if (!text) return;
      decide(async () => {
        const edited = await takeNote();
        const message = `The user reviewed the plan and asks for changes: ${text}${edited ? `\n\nTheir edited version of the plan:\n\n${edited}` : ''}`;
        finish({ behavior: 'deny', message }, 'Sent back', `Plan sent back: “${text}”`);
      });
    };
    feedbackRow.createEl('button', { text: 'Send feedback' }).addEventListener('click', sendFeedback);
    feedback.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' || evt.isComposing) return;
      evt.preventDefault();
      sendFeedback();
    });
    // Nothing is approved or edited unseen: until the plan is shown, only feedback and Reject answer.
    const shown = (text: string) => {
      planShown = true;
      plan = text.trim();
      approval.plan = plan;
      // A note carried over is now told edited or not against this plan.
      const recorded = chatKey ? this.plugin.planNotes[chatKey] : undefined;
      if (chatKey && approval.notePath && (recorded?.path !== approval.notePath || recorded.plan !== plan)) this.plugin.setPlanNote(chatKey, approval.notePath, plan);
      body.empty();
      this.renderMarkdown(plan, body);
      approveButton.disabled = false;
      editButton.disabled = false;
    };
    if (plan) {
      shown(plan);
      return;
    }
    approveButton.disabled = true;
    editButton.disabled = true;
    body.setText('Reading the plan…');
    void this.showPlan(input.planFilePath, signal, card).then((text) => {
      if (text) shown(text);
      else if (!card.hasClass('is-decided')) body.setText("The plan could not be read. Send it back with feedback asking Claude to show it, or reject it.");
    });
  }

  /**
   * The text of the plan file a plan request names (see readPlanFile). Claude can ask to carry out
   * its plan in the same step it writes it: the request then comes before the file is written, and
   * without the plan's text, so it is read again for a few seconds until it is there.
   */
  private async showPlan(file: unknown, signal: AbortSignal, card: HTMLElement): Promise<string | null> {
    // Until the plan is answered, withdrawn, or its card taken off the screen (its chat in the background, drawn again on its return).
    for (let attempt = 0; attempt < PLAN_READ_ATTEMPTS && !signal.aborted && !card.hasClass('is-decided') && this.messagesEl.contains(card); attempt += 1) {
      const text = (await readPlanFile(file))?.trim();
      if (text) return text;
      await new Promise((resolve) => window.setTimeout(resolve, PLAN_READ_PAUSE_MS));
    }
    return null;
  }

  private renderPermissionDetail(el: HTMLElement, request: PermissionRequest): void {
    const { toolName, input } = request;
    const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
    const summary = summarizeTool(toolName, input, this.plugin.vaultRoot() ?? '');

    if (toolName === 'Bash' && str('command') !== undefined) {
      el.createEl('pre').createEl('code', { text: str('command') });
      const description = str('description');
      if (description) el.createDiv({ cls: 'vc-muted', text: description });
    } else {
      if (summary.text) {
        const line = el.createDiv({ text: summary.text });
        if (summary.vaultPath) {
          line.addClass('vc-file-link');
          line.dataset.path = summary.vaultPath;
        }
      }
      const oldText = str('old_string');
      const newText = str('new_string');
      if (toolName === 'Edit' && oldText !== undefined && newText !== undefined) {
        // A line diff, as the reply's changed files show afterwards: unchanged lines once, in grey.
        const pre = el.createEl('pre', { cls: 'vc-diff' });
        const sign = { same: ' ', del: '−', ins: '+' };
        for (const part of lineDiff(oldText, newText).slice(0, MAX_PREVIEW_LINES)) {
          pre.createDiv({ cls: `vc-diff-${part.type}`, text: `${sign[part.type]} ${part.text}` });
        }
      } else if (toolName === 'Write' && str('content') !== undefined) {
        el.createEl('pre', { text: (str('content') ?? '').split('\n').slice(0, MAX_PREVIEW_LINES).join('\n') });
      }
    }
    if (request.blockedPath) el.createDiv({ cls: 'vc-muted', text: `Path: ${request.blockedPath}` });
  }

  /** A summary of Claude's thinking: one folded line; the text, rendered on first open, on click. */
  private renderThinking(thinking: string): void {
    const text = thinking.trim();
    if (!text) return;
    const el = this.container().createDiv({ cls: 'vc-tools vc-thinking' });
    const header = el.createDiv({ cls: 'vc-tools-header' });
    setIcon(header.createSpan({ cls: 'vc-tools-chevron' }), 'chevron-right');
    const first = text.split('\n')[0].replace(/[*_`#]/g, '').trim();
    header.createSpan({ cls: 'vc-tools-text', text: `Thinking: ${first.length > 100 ? `${first.slice(0, 99)}…` : first}` });
    const body = el.createDiv({ cls: 'vc-tools-list vc-thinking-body' });
    body.hide();
    let rendered = false;
    header.addEventListener('click', () => {
      if (!rendered) {
        rendered = true;
        this.renderMarkdown(text, body.createDiv({ cls: 'vc-text' }));
      }
      body.toggle(!body.isShown());
      el.toggleClass('is-open', body.isShown());
    });
    this.draw.group = null;
    this.scrollToBottom();
  }

  /** Goes to the previous (-1) or next (1) message you sent. */
  stepMessage(delta: -1 | 1): void {
    this.promptNav.step(delta);
  }

  /** Opens the card listing every message you sent. */
  listMessages(): void {
    this.promptNav.openList();
  }

  isScratchChat(): boolean {
    return this.scratch;
  }

  /**
   * Opens the scratch chat: the one from before while it is still fresh, else a new one in its
   * place. It keeps one fixed title, stays out of the history list, and is never renamed.
   */
  async openScratch(): Promise<void> {
    if (!this.plugin.settings.scratchChat) {
      new Notice('The scratch chat is turned off in the settings.');
      return;
    }
    const id = this.plugin.scratchSession();
    if (this.scratch && id && id === this.chatId) return;
    // Shown in the panel holding it, or given way to a chat picked meanwhile, it is left as it is.
    if (id && (await this.openChat({ id, title: SCRATCH_TITLE, updatedAt: this.plugin.scratch?.usedAt ?? Date.now(), fromPanel: true, scratch: true }))) {
      if (this.resumeId === id) {
        this.scratch = true;
        this.setChatTitle(SCRATCH_TITLE);
        this.messagesEl.createDiv({ cls: 'vc-muted vc-resumed vc-scratch-line', text: this.scratchLineText() });
        this.scrollToBottom(true);
        this.focusInput();
      }
      return;
    }
    // None yet, or its session could not be read: start one; the one recorded is let go of.
    this.startScratchOver();
    await this.plugin.clearScratch(this);
  }

  /**
   * Starts a new scratch chat here in place of the chat shown, whose process is closed (or, if it
   * is working, keeps running in the background); the record of the old one is the plugin's to drop.
   */
  startScratchOver(): void {
    this.newChat();
    this.scratch = true;
    this.restoreDraft();
    this.modelOverride = this.plugin.settings.smallJobModel || chatModel(this.plugin.settings.model);
    this.populateModelSelect();
    this.setChatTitle(SCRATCH_TITLE);
    this.messagesEl.empty();
    this.renderWelcome();
    this.focusInput();
  }

  /** Redraws an empty chat's opening lines, after a setting changed what they say. */
  refreshWelcome(): void {
    const welcome = this.messagesEl.querySelector('.vc-welcome');
    if (!welcome) return;
    welcome.remove();
    this.renderWelcome();
  }

  /** The line over a reopened scratch chat: how long it may be left alone, and how long it has left. */
  private scratchLineText(): string {
    const idle = idleLabel(this.plugin.settings.scratchIdleHours);
    return `Scratch chat · starts over when left alone for ${idle} · ${timeLeft(this.plugin.scratchLeft())} left`;
  }

  /** Brings the lines about the scratch chat up to date after its idle time changed. */
  refreshScratchLines(): void {
    if (!this.scratch) return;
    this.messagesEl.querySelector('.vc-scratch-line')?.setText(this.scratchLineText());
    this.refreshWelcome();
  }

  /**
   * Keeps chat `id`, let go of as the scratch chat, as an ordinary one: shown here, as keepScratchAsChat
   * does; or running in this panel's background, recorded under Claude Code's title for it.
   */
  keepAsChat(id: string): void {
    if (this.scratch && this.chatId === id) {
      this.keepScratchAsChat();
      return;
    }
    const root = this.plugin.vaultRoot();
    const entry = [...this.background].find((candidate) => candidate.chatId === id);
    if (!root || !entry) return;
    const named = (title: string) => {
      entry.title = title;
      this.plugin.recordChat(id, title);
      this.plugin.renameChat(id, title);
    };
    named('Untitled chat');
    void sessionTitle(id, root)
      .then((title) => title && named(title))
      .catch((error: unknown) => log('reading the session title failed', error));
  }

  /** Keeps the scratch chat as an ordinary one: it joins the chat list and takes Claude's own title. */
  keepScratchAsChat(): void {
    if (!this.scratch) return;
    this.scratch = false;
    const id = this.chatId;
    if (id) {
      this.plugin.recordChat(id, this.chatName ?? 'Untitled chat');
      this.titleFromClaude = false;
      void this.refreshTitle();
    }
    this.updateChatButtons();
  }

  /**
   * Writes this chat's message in a note, so it can be composed with the editor's own help. One
   * draft per chat, in a Drafts folder beside the saved chats; sending it empties and removes it.
   */
  async editDraft(): Promise<void> {
    const open = this.draftFile();
    if (open) {
      await this.app.workspace.getLeaf('tab').openFile(open);
      new Notice('Write your message there, then send the draft.');
      return;
    }
    try {
      const title = this.chatName ?? 'New chat';
      const path = await this.savedNotePath(formatDate(Date.now()).slice(0, 10), title, '', 'Drafts');
      const file = await this.app.vault.create(path, this.inputEl.value);
      this.draftPath = file.path;
      this.inputEl.value = '';
      this.growInput();
      this.updateDraftLine();
      await this.app.workspace.getLeaf('tab').openFile(file);
      new Notice('Write your message there, then send the draft.');
    } catch (error) {
      log('opening a draft failed', error);
      new Notice(`Could not start a draft: ${errorText(error)}`);
    }
  }

  /** Sends `text` as the next message, as if it had been typed in. */
  async sendText(text: string): Promise<void> {
    this.inputEl.value = text;
    this.growInput();
    await this.send();
  }

  /** Sends what the draft note holds, then closes and removes it; an empty draft is only removed. */
  async sendDraft(): Promise<void> {
    const file = this.draftFile();
    if (!file) {
      this.draftPath = null;
      this.updateDraftLine();
      new Notice('No draft for this chat. Write this message in a note first.');
      return;
    }
    const text = (await this.app.vault.read(file)).trim();
    this.draftPath = null;
    this.updateDraftLine();
    this.closeNoteTabs(file);
    if (!text) {
      await this.discardNote(file);
      new Notice('The draft was empty: nothing was sent, and the note is gone.');
      return;
    }
    await this.sendText(text);
    await this.discardNote(file);
  }

  /** Whether this chat's draft is that note, so sending the note goes through the draft. */
  holdsDraft(path: string): boolean {
    return this.draftFile()?.path === path;
  }

  /** Closes note `file`'s tabs and moves it to the trash: a draft sent or thrown away, a plan answered or refused. */
  private async discardNote(file: TFile): Promise<void> {
    this.closeNoteTabs(file);
    this.plugin.forgetPlanNote(file.path);
    await this.plugin.trashNote(file.path);
  }

  /**
   * A withdrawn plan's note (its request cancelled: Esc, or Claude Code): kept, still open, for the
   * chat's next plan when it holds edits (see renderPlanCard), else deleted; deleted too when the
   * chat is let go of (`keep` false).
   */
  private async withdrawPlanNote(approval: Approval, keep = true): Promise<void> {
    const file = approval.notePath ? this.app.vault.getAbstractFileByPath(approval.notePath) : null;
    approval.notePath = null;
    if (!(file instanceof TFile)) return;
    const text = keep && approval.chatKey ? (await this.app.vault.read(file)).trim() : '';
    if (!text || text === (approval.plan ?? '').trim()) await this.discardNote(file);
  }

  /** Closes the tabs showing note `file`: a draft sent, or a plan answered, has nothing left to show. */
  private closeNoteTabs(file: TFile): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) leaf.detach();
    }
  }

  /** The draft note of this chat, while it is still there. */
  private draftFile(): TFile | null {
    const file = this.draftPath ? this.app.vault.getAbstractFileByPath(this.draftPath) : null;
    return file instanceof TFile ? file : null;
  }

  /** The line above the input while a draft is open: it sends the draft, and its × throws it away. */
  private updateDraftLine(): void {
    const file = this.draftFile();
    this.draftEl?.toggle(file !== null);
    if (!file) return;
    this.draftEl.empty();
    this.draftEl.createSpan({ text: `Draft in “${file.basename}” · click to send it` });
    this.draftEl.createSpan({ cls: 'vc-draft-close', text: '×', attr: { 'aria-label': 'Throw the draft away' } });
  }

  /** The × on the draft line: the note goes to the trash unsent, and its tabs close. */
  private async discardDraft(): Promise<void> {
    const file = this.draftFile();
    this.draftPath = null;
    this.updateDraftLine();
    if (!file) return;
    await this.discardNote(file);
    new Notice(`Draft “${file.basename}” thrown away.`);
  }

  /** Puts the text selected in the chat into the input as a quote, to ask about it. */
  quoteSelection(): void {
    const selected = this.selectedInChat();
    if (!selected) {
      new Notice('Select some text in the chat first.');
      return;
    }
    this.quoteText(selected);
  }

  /**
   * Shows the Quote button just above a selection in the chat, clear of the selected lines, or hides
   * it when there is none. Placed within the messages' wrapper, and kept inside it at the edges.
   */
  private placeQuoteButton(): void {
    const button = this.quoteButton;
    if (!button) return;
    const selection = this.messagesEl.ownerDocument.getSelection();
    this.quoteTracking = !!this.chatSelection() && !!selection && selection.rangeCount > 0 && this.messagesEl.contains(selection.focusNode);
    if (!this.quoteTracking || !selection) {
      if (button.isShown()) this.hideSelectionButtons();
      return;
    }
    const range = selection.getRangeAt(0);
    // Optional: a range without geometry (a test's document) has nowhere to put the button.
    const rects = [...(range.getClientRects?.() ?? [])].filter((rect) => rect.width > 0 || rect.height > 0);
    if (rects.length === 0) {
      this.hideSelectionButtons();
      return;
    }
    // The selected lines as one box: the button goes above the first, never over any of them.
    const first = rects[0];
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const wrap = button.parentElement?.getBoundingClientRect();
    const view = this.messagesEl.getBoundingClientRect();
    // Scrolled out of view: nothing to point at.
    if (!wrap || bottom < view.top || top > view.bottom) {
      this.hideSelectionButtons();
      return;
    }
    const side = this.sideButton;
    const memo = this.memoButton;
    button.show();
    side.show();
    memo.show();
    const width = button.offsetWidth;
    const height = button.offsetHeight;
    // Quote over the start of the selection, where reading began, and Side chat just after it: the
    // two kept inside the panel together.
    const gap = 6;
    const left = Math.max(4, Math.min(first.left - wrap.left, wrap.width - width - gap - side.offsetWidth - gap - memo.offsetWidth - 4));
    // Above the selection when there is room, below it otherwise.
    // 8 px: room for the pointer between the button and the text it points at.
    const above = top - wrap.top - height - 8;
    const below = above < view.top - wrap.top;
    const buttonTop = below ? bottom - wrap.top + 8 : above;
    button.toggleClass('is-below', below);
    button.style.left = `${left}px`;
    button.style.top = `${buttonTop}px`;
    side.style.left = `${left + width + gap}px`;
    side.style.top = `${buttonTop}px`;
    memo.style.left = `${left + width + gap + side.offsetWidth + gap}px`;
    memo.style.top = `${buttonTop}px`;
  }

  private hideSelectionButtons(): void {
    this.quoteButton?.hide();
    this.sideButton?.hide();
    this.memoButton?.hide();
  }

  // ---- Memos -------------------------------------------------------------

  /**
   * The selection in the chat as passages, one for each message it takes in, in the conversation's
   * order: who wrote the message, the selected part of it with equations as LaTeX, and plain words
   * from it to find it again by. Empty when nothing in the chat is selected.
   */
  selectedPassages(): MemoPassage[] {
    const selection = this.chatSelection();
    if (!selection || selection.rangeCount === 0) return [];
    const range = selection.getRangeAt(0);
    const doc = this.messagesEl.ownerDocument;
    const messages = [...this.messagesEl.querySelectorAll<HTMLElement>('.vc-user-text, .vc-text')].filter((el) => range.intersectsNode(el));
    const passages: MemoPassage[] = [];
    for (const el of messages) {
      // A message inside another taken whole (a background agent's result) is the outer one's.
      if (messages.some((other) => other !== el && other.contains(el))) continue;
      const part = doc.createRange();
      part.selectNodeContents(el);
      if (range.compareBoundaryPoints(range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
      const text = (selectionWithMath(part) ?? part.toString()).trim();
      if (!text) continue;
      // Words outside the equations: the chat's Find searches the text as drawn, without their LaTeX.
      const plain = part.cloneContents();
      const links = this.passageLinks(plain);
      for (const math of Array.from(plain.querySelectorAll('.math'))) math.replaceWith('\n');
      const message = el.closest<HTMLElement>('.vc-user')?.dataset.uuid ?? el.dataset.message;
      passages.push({ role: el.closest('.vc-user') ? 'you' : 'claude', text, needle: passageNeedle(plain.textContent ?? ''), links, ...(message ? { message } : {}) });
    }
    return passages;
  }

  /**
   * A whole reply as a memo's passages: the prompt it answered, as you wrote it, then the reply's
   * text with equations as LaTeX, each with plain words to find it by.
   */
  private replyPassages(turn: HTMLElement, textEls: HTMLElement[]): MemoPassage[] {
    const passages: MemoPassage[] = [];
    let before = turn.previousElementSibling;
    while (before && !before.hasClass('vc-user') && !before.hasClass('vc-turn')) before = before.previousElementSibling;
    const prompt = before?.hasClass('vc-user') ? (before.querySelector('.vc-user-text')?.textContent ?? '').trim() : '';
    const asked = (before as HTMLElement | null)?.dataset.uuid;
    if (prompt) passages.push({ role: 'you', text: prompt, needle: passageNeedle(prompt), ...(asked ? { message: asked } : {}) });
    const plain = textEls[0]?.cloneNode(true) as HTMLElement | undefined;
    for (const math of Array.from(plain?.querySelectorAll('.math') ?? [])) math.replaceWith('\n');
    const links = textEls.flatMap((el) => this.passageLinks(el));
    const reply = textEls[0]?.dataset.message;
    passages.push({ role: 'claude', text: this.replyMarkdown(textEls), needle: passageNeedle(plain?.textContent ?? ''), links, ...(reply ? { message: reply } : {}) });
    return passages;
  }

  /** The notes and files a drawn passage links to: its wikilinks by link text, the file names made links by vault path. */
  private passageLinks(root: ParentNode): string[] {
    const links = [...root.querySelectorAll<HTMLElement>('a.internal-link, .vc-file-link[data-path]')].map(
      (el) => el.dataset.path ?? el.dataset.href ?? el.getAttribute('href') ?? '',
    );
    return [...new Set(links.filter(Boolean))];
  }

  /**
   * The notes a memo is about, as wikilinks: the note attached to the chat, then the notes its
   * passages link to, each once. Files that are not notes, and links that find nothing, are left out.
   */
  private memoNotesFor(passages: MemoPassage[]): string[] {
    const targets = [...(this.attachedNote ? [this.attachedNote] : []), ...passages.flatMap((passage) => passage.links ?? [])];
    const notes: string[] = [];
    for (const target of targets) {
      const file = this.app.vault.getAbstractFileByPath(target) ?? this.app.metadataCache.getFirstLinkpathDest(target, '');
      if (!(file instanceof TFile) || file.extension !== 'md') continue;
      const link = this.wikilink(file);
      if (!notes.includes(link)) notes.push(link);
    }
    return notes;
  }

  /**
   * "Memo" over a selection in the chat: the form for saving the selected passages as a memo (see
   * MemoModal); `now` (an Option-click), saved at once as a bookmark (see saveBookmark).
   */
  saveMemoFromSelection(now = false): void {
    const passages = this.selectedPassages();
    this.hideSelectionButtons();
    if (passages.length === 0) {
      new Notice('Select the passages of the chat to save first.');
      return;
    }
    if (now) void this.saveBookmark(passages);
    else void this.openMemoForm(passages);
  }

  /** Where `passages` of the chat on screen come from, for a memo; null, with a notice, before the chat has started. */
  private memoSources(passages: MemoPassage[]): MemoSources | null {
    const chatId = this.chatId ?? this.resumeId;
    if (!chatId) {
      new Notice('This chat has not started yet: there is nothing to link a memo to.');
      return null;
    }
    return { vault: this.app.vault.getName(), chatId, chatTitle: this.chatName ?? 'Chat', date: formatDate(Date.now()).slice(0, 10), passages };
  }

  /** `passages` with the dates their messages were written (see MemoPassage.written), read from the chat's file. */
  private async datedPassages(chatId: string, passages: MemoPassage[]): Promise<MemoPassage[]> {
    const root = this.plugin.vaultRoot();
    // A reply text's key is its message's id, then its place in the message (see replyKey).
    const idOf = (passage: MemoPassage) => passage.message?.split('#')[0];
    const ids = passages.flatMap((passage) => idOf(passage) ?? []);
    const dates = root ? await messageDates(chatId, root, ids) : new Map<string, string>();
    return passages.map((passage) => {
      const written = dates.get(idOf(passage) ?? '');
      return written ? { ...passage, written } : passage;
    });
  }

  /** Saves `passages` as a memo at once, with no form and no suggestion: a bookmark, titled by their first words. */
  async saveBookmark(passages: MemoPassage[]): Promise<TFile | null> {
    const sources = this.memoSources(passages);
    if (!sources) return null;
    // Taken before the dates are read: by then another chat, with another note, may be on screen.
    const notes = this.memoNotesFor(passages);
    sources.passages = await this.datedPassages(sources.chatId, passages);
    const saved = await this.saveMemo({ title: '', description: '', why: '', tags: [], notes }, sources, true);
    if (saved) this.flashHint(`Memo saved: ${saved.basename}`);
    return saved;
  }

  /** The memo form for `passages` of the chat on screen, with Claude's suggestion of a title and description. */
  private async openMemoForm(passages: MemoPassage[]): Promise<void> {
    const sources = this.memoSources(passages);
    if (!sources) return;
    // Taken before the dates are read: by then another chat, with another note, may be on screen.
    const notes = this.memoNotesFor(passages);
    const memos = this.memosToOffer(sources.chatId);
    sources.passages = await this.datedPassages(sources.chatId, passages);
    // The panel closed meanwhile: no form opens over whatever is in front now.
    if (this.closing) return;
    new MemoModal(
      this.app,
      sources.passages,
      {
        memos,
        archived: (memo) => this.plugin.isArchived(memo),
        // Not those the settings hide from a chat's notes; the most recently edited first.
        notes: () =>
          this.app.vault
            .getMarkdownFiles()
            .filter((file) => !this.plugin.isHiddenPath(file.path))
            .sort((a, b) => b.stat.mtime - a.stat.mtime),
        links: notes,
        noteLink: (file) => this.wikilink(file),
        titleProblem: (title) => this.memoTitleProblem(title),
        suggest: (signal) => this.plugin.suggestMemo(sources.chatTitle, passages, signal),
      },
      (choice) => void this.saveMemo(choice, sources).then((saved) => saved && this.offerProjectAfterSave(sources.chatId)),
    ).open();
  }

  /**
   * The memos offered first to link a new memo to, in order: those about the note attached or in
   * front, then those saved from chat `chatId`, then the rest, the most recently changed first within
   * each, archived ones last.
   */
  private memosToOffer(chatId: string): TFile[] {
    const path = this.attachedNote ?? this.activeNote()?.file.path;
    const note = path ? this.app.vault.getAbstractFileByPath(path) : null;
    const link = note instanceof TFile ? this.wikilink(note) : null;
    // Archived memos last, in the same order among themselves.
    const rank = (memo: TFile) => {
      const frontmatter = this.app.metadataCache.getFileCache(memo)?.frontmatter;
      const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
      const archived = frontmatter?.archived === true ? 3 : 0;
      if (link && list(frontmatter?.notes).includes(link)) return archived;
      return archived + (list(frontmatter?.claude_chats).includes(chatId) ? 1 : 2);
    };
    // Each ranked once; a stable sort: within a rank, the most recently changed first, as memoNotes gives them.
    const ranked = this.plugin.memoNotes().map((memo) => ({ memo, rank: rank(memo) }));
    return ranked.sort((a, b) => a.rank - b.rank).map(({ memo }) => memo);
  }

  /** Why a new memo cannot be called `title`: note names are unique in the vault, and a link to the memo must find it. */
  private memoTitleProblem(title: string): string | null {
    const name = memoNoteName(title);
    if (!name) return 'Give the memo a title with letters or numbers in it.';
    return this.noteNameTaken(name) ? `A note named “${name}” already exists: give the memo another title.` : null;
  }

  /** Whether a note is called `name` anywhere in the vault: note names are unique, and a link to a memo must find it. */
  private noteNameTaken(name: string): boolean {
    return this.app.metadataCache.getFirstLinkpathDest(name, '') !== null;
  }

  /**
   * Writes the passages to a new memo note and links it to the chat. A memo with no title is a
   * bookmark, titled by the passages' first words. Its name is one no note has as it is written:
   * taken since the form checked it, the date and time are added. `quiet`: no notice (the caller says
   * it was saved).
   */
  saveMemo(choice: MemoChoice, sources: MemoSources, quiet = false): Promise<TFile | null> {
    // One at a time: two bookmarks of one passage saved together would otherwise take the same name.
    const saved = this.memoSaves.then(() => this.writeMemo(choice, sources, quiet));
    this.memoSaves = saved;
    return saved;
  }

  private async writeMemo(choice: MemoChoice, sources: MemoSources, quiet: boolean): Promise<TFile | null> {
    const bookmark = !choice.title.trim();
    const wanted = bookmark ? quickMemoTitle(sources.passages) : choice.title.trim();
    const stamp = formatDate(Date.now()).replace(':', '');
    // A title with nothing a note name can hold (only dots, say) gives a plain one.
    const title = freeMemoTitle(memoNoteName(wanted) ? wanted : 'Memo', stamp, (name) => this.noteNameTaken(name));
    choice = { ...choice, title, tags: bookmark ? cleanTags([...choice.tags, BOOKMARK_TAG]) : choice.tags };
    try {
      const path = await this.plugin.memosPath(`${memoNoteName(choice.title)}.md`);
      const file = await this.app.vault.create(path, memoNoteMarkdown({ title: choice.title, description: choice.description, why: choice.why, tags: choice.tags, notes: choice.notes, sources }));
      this.plugin.linkNoteChat(file.path, sources.chatId);
      const saved = file;
      if (quiet) return saved;
      const frag = createFragment((parts) => {
        parts.appendText(`Saved “${saved.basename}”. `);
        parts.createEl('a', { text: 'Open it', href: '#' }).addEventListener('click', (evt) => {
          evt.preventDefault();
          void this.app.workspace.getLeaf('tab').openFile(saved);
        });
      });
      new Notice(frag, 8000);
      return saved;
    } catch (error) {
      log('saving a memo failed', error);
      new Notice(`Could not save the memo: ${errorText(error)}`);
      return null;
    }
  }

  /** Puts `text` in the input of this chat, a new one, as a draft to add to, the cursor at its end (Continue from a memo). */
  startDraft(text: string): void {
    // Only what was chosen goes with it: not a note the new chat attached of itself (see restoreDraft).
    this.attachNote(null);
    this.inputEl.value = text;
    this.inputEdited();
    this.focusInput();
    this.inputEl.setSelectionRange(text.length, text.length);
    this.growInput();
  }

  /** Adds `text` to the input, on a line after anything already there, which stays (a suggested step to pick a chat up by, what another chat found). */
  addToInput(text: string, hint?: string): void {
    const typed = this.inputEl.value.trimEnd();
    this.inputEl.value = typed ? `${typed}\n\n${text}` : text;
    this.inputEdited();
    this.focusInput();
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
    this.growInput();
    // `hint` names what was added; without one, a draft there says the step went after it.
    if (hint) hintAbove(this.inputEl, typed ? `${hint}, after your draft` : hint);
    else if (typed) hintAbove(this.inputEl, 'Suggested step added after your draft');
  }

  /** Puts `text` in the input as a quote, to carry on from it (a link from a memo note). */
  quote(text: string): void {
    this.quoteText(text);
  }

  /**
   * A passage of the chat on screen (a link from a memo): its message, `message`, when the link names
   * it, drawn back to if it is earlier; else `needle` found with Find. A notice when neither is there.
   */
  async findPassage(needle: string, message?: string): Promise<void> {
    const generation = this.chatGeneration;
    if (message && (await this.goToMessage(message, needle))) return;
    // Another chat opened while earlier turns were drawn: the passage is not looked for in it.
    if (generation !== this.chatGeneration) return;
    if (needle && (await this.findBar.find(needle))) return;
    new Notice('The passage was not found in this chat: it may have been compacted away. It is kept in the memo note.');
  }

  /**
   * Scrolls to message `message` (your message's id, or a reply text's key), drawing earlier turns
   * back to it, and there to `needle` when its words are in it; the message is marked for a moment.
   * False when the chat has no such message.
   */
  private async goToMessage(message: string, needle: string): Promise<boolean> {
    // Compared, not put in a selector: the id comes from a link, and may be anything.
    const find = () =>
      Array.from(this.messagesEl.querySelectorAll<HTMLElement>('.vc-text, .vc-user')).find((el) => (el.hasClass('vc-user') ? el.dataset.uuid : el.dataset.message) === message) ?? null;
    let el = find();
    if (!el && this.earlier) {
      await this.earlier.drawToMessage(message.split('#')[0]);
      el = find();
    }
    if (!el) return false;
    const range = needle ? findRanges(el, needle)[0] : undefined;
    const target = el;
    const reveal = () => revealIn(this.messagesEl, target, range);
    reveal();
    // Again once the panel has settled, as a link's chat may still be drawing.
    (this.messagesEl.ownerDocument.defaultView ?? window).requestAnimationFrame(reveal);
    target.addClass('is-flashed');
    window.setTimeout(() => target.removeClass('is-flashed'), 1600);
    return true;
  }

  /** Opens the side chat, with `quote` (or the text selected in the chat) quoted in its input. */
  openSideChat(quote?: string): void {
    const quoted = quote ?? this.selectedInChat() ?? undefined;
    // Said when it goes into a side chat already open, whose input may hold a question being typed.
    const adding = this.sideChat.isOpen() && !!quoted;
    this.sideChat.open(quoted);
    this.hideSelectionButtons();
    if (adding) this.sideChat.hint('Selection added to the side chat');
  }

  /**
   * The side chat's session `id`, in Plan mode so it only reads: with `own`, that session resumed;
   * else a fork of the chat on screen, so it knows the conversation, or by the setting (or for a chat
   * not started yet) a new one that sees only what is asked, the quote included. A reply still in
   * progress is left out of the fork, which ends where that reply's prompts begin; a chat whose first
   * reply is in progress has nothing to fork. The id is held until the session is deleted or kept, so
   * one left open when Obsidian quits is deleted at the next start.
   */
  private async startSideSession(handlers: SessionHandlers, id: string, own: boolean): Promise<ClaudeSession | null> {
    const launch = this.plugin.launchOrNotice();
    if (!launch) return null;
    const { settings } = this.plugin;
    const chat = !own && settings.sideChatContext === 'chat' ? (this.chatId ?? this.resumeId) : null;
    const end = chat && this.turnPrompts.length > 0 ? await entryBefore(chat, launch.cwd, this.turnPrompts, TURN_PROMPT_MAX_BYTES).catch(() => undefined) : undefined;
    const fork = chat && end !== null ? { resume: chat, forkSession: true, sessionId: id, ...(end ? { resumeSessionAt: end } : {}) } : { sessionId: id };
    if ('forkSession' in fork) this.sideForks.add(id);
    const resume = own ? { resume: id } : fork;
    this.plugin.holdSideSession(id);
    return new ClaudeSession(
      {
        ...launch,
        permissionMode: 'plan',
        model: this.modelOverride,
        effort: this.effortOverride,
        appendSystemPrompt: APPEND_SYSTEM_PROMPT + sideChatPrompt(this.sideForks.has(id)),
        ...resume,
        denyRules: denyRuleList(settings.denyRules),
      },
      handlers,
    );
  }

  /**
   * Deletes a side chat's own session when it closes, or lets its id go when it never wrote one;
   * never the chat it was opened from. One that fails to go stays held, and is tried again at the
   * next start.
   */
  private deleteSideSession(id: string): void {
    this.sideForks.delete(id);
    const root = this.plugin.vaultRoot();
    if (!root || id === this.chatId || id === this.resumeId) return;
    deleteSessionIfAny(id, root).then(
      () => this.plugin.releaseSideSession(id),
      (error: unknown) => log('deleting a side chat failed', error),
    );
  }

  /**
   * Keeps a side chat's session as a chat of its own, at once: recorded in the history under the
   * name of the chat it was opened from, with `unsent` (typed in the side chat and not sent) in its
   * input, and no longer deleted at the next start. Until its process has ended, a panel opening it
   * from the history waits (see openKeptSideChat).
   */
  private keepSideChat(id: string, unsent: string): void {
    this.sideForks.delete(id);
    this.plugin.releaseSideSession(id);
    this.plugin.recordChat(id, `Side chat: ${this.chatName ?? 'Untitled chat'}`);
    this.plugin.setChatDraft(id, { text: unsent });
    this.keptEnding.set(id, this.plugin.sessionEnding(id));
  }

  /**
   * Opens a kept side chat once its process has ended: in a new tab beside this panel, or, when this
   * panel has closed meanwhile, where the plugin opens a chat.
   */
  private async openKeptSideChat(id: string): Promise<void> {
    this.keptEnding.get(id)?.();
    this.keptEnding.delete(id);
    const title = this.plugin.chats.find((chat) => chat.id === id)?.title ?? 'Side chat';
    try {
      if (this.closing) {
        await this.plugin.openChatById(id, title);
        return;
      }
      const view = await this.plugin.openChatTab(this.leaf);
      await view?.openChat({ id, title, updatedAt: Date.now(), fromPanel: true });
    } catch (error) {
      log('opening a kept side chat failed', error);
    }
  }

  /**
   * Marks the equations a selection in the panel takes in, which a quote carries whole (see
   * selectionWithMath): MathJax draws them in glyphs the browser does not highlight as selected.
   */
  private markSelectedMath(): void {
    const selection = this.contentEl.ownerDocument.getSelection();
    const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null;
    const common = range?.commonAncestorContainer;
    const root = common && this.contentEl.contains(common) ? (common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement) : null;
    const inside = root?.closest<HTMLElement>('.math');
    const marked = new Set<HTMLElement>();
    for (const el of inside ? [inside] : Array.from(root?.querySelectorAll<HTMLElement>('.math') ?? [])) if (range?.intersectsNode(el)) marked.add(el);
    for (const el of this.selectedMath) if (!marked.has(el)) el.removeClass('vc-math-selected');
    for (const el of marked) el.addClass('vc-math-selected');
    this.selectedMath = marked;
  }

  /** The selection, when it is inside the messages and not empty. */
  private chatSelection(): Selection | null {
    const selection = this.messagesEl.ownerDocument.getSelection();
    // Where the selection is, before what it says: a long selection in a note costs its length to read.
    if (!selection?.anchorNode || !this.messagesEl.contains(selection.anchorNode) || selection.isCollapsed) return null;
    // An equation alone holds no text of its own (see markSelectedMath), but quotes as its LaTeX.
    return selection.toString().trim() || (selection.rangeCount > 0 && selectionWithMath(selection.getRangeAt(0))) ? selection : null;
  }

  /** The text selected inside the messages, with equations as their LaTeX; null when there is none. */
  private selectedInChat(): string | null {
    const selection = this.chatSelection();
    if (!selection) return null;
    return (selection.rangeCount > 0 && selectionWithMath(selection.getRangeAt(0))) || selection.toString();
  }

  /** Adds a quote of `text` to the input, with the cursor after it. */
  private quoteText(text: string): void {
    const input = this.inputEl;
    input.value = withQuote(input.value, text);
    hintAbove(this.inputEl, 'Selection added to your message');
    this.focusInput();
    input.setSelectionRange(input.value.length, input.value.length);
    this.suggest.update();
    this.growInput();
  }

  openFind(): void {
    this.findBar.open();
  }

  /** "Attach to Claude" from the file explorer: the files and folders as `@` mentions in the input. */
  mentionItems(items: TAbstractFile[]): void {
    const mentions = items.filter((item) => item.path !== '/').map((item) => `@[[${this.mentionTarget(item)}]]`);
    if (mentions.length === 0) return;
    const current = this.inputEl.value.replace(/\s*$/, '');
    this.inputEl.value = `${current ? `${current} ` : ''}${mentions.join(' ')} `;
    this.inputEdited();
    const end = this.inputEl.value.length;
    this.inputEl.setSelectionRange(end, end);
    this.inputEl.focus();
  }

  /**
   * A background task completion: one collapsed line; details and result on click. An agent's changes
   * show under it: at once for one arriving `live`, their notes linked to this chat, else when opened.
   */
  private renderTaskNotice(notice: TaskNotice, live = false): void {
    const el = this.container().createDiv({ cls: 'vc-tools vc-task' });
    const root = this.plugin.vaultRoot();
    const chat = this.chatId ?? this.resumeId;
    const fallback = notice.taskId && chat && root ? subagentFile(chat, notice.taskId, root) : undefined;
    let changesRead = false;
    const readChanges = () => {
      if (changesRead || (!notice.outputFile && !fallback)) return;
      changesRead = true;
      void this.showAgentChanges(el, notice.outputFile, fallback, live);
    };
    if (live) readChanges();
    const header = el.createDiv({ cls: 'vc-tools-header' });
    setIcon(header.createSpan({ cls: 'vc-tools-chevron' }), 'chevron-right');
    const { title, rest } = noticeHeader(notice.summary);
    header.createSpan({ cls: 'vc-tools-text', text: title || 'Background task finished', attr: { title: title } });
    if (notice.status && notice.status !== 'completed') header.createSpan({ cls: 'vc-tools-failed', text: notice.status });
    const body = el.createDiv({ cls: 'vc-tools-list vc-task-body' });
    body.hide();
    for (const line of notice.details) body.createDiv({ text: line });
    const result = notice.result ?? rest;
    let resultRendered = false;
    header.addEventListener('click', () => {
      readChanges();
      // The result can be long Markdown; render it on first open only.
      if (!resultRendered && result) {
        resultRendered = true;
        this.renderMarkdown(result, body.createDiv({ cls: 'vc-text' }));
      }
      body.toggle(!body.isShown());
      el.toggleClass('is-open', body.isShown());
    });
    this.draw.group = null;
    this.scrollToBottom();
  }

  /**
   * Renders reply Markdown with remote images and media turned into links (see safeMarkdown.ts);
   * its components belong to `component`: by default the current chat's, unloaded when a new chat
   * starts.
   */
  private renderMarkdown(markdown: string, el: HTMLElement, component = this.chatComponent): Promise<void> {
    // Whatever holds rendered Markdown (a reply, a plan, a side chat's question) is styled alike, and
    // as notes are: Obsidian and themes style a note's code, quotes, lists and tables only under
    // `.markdown-rendered`, so the theme in use decides how they look here too.
    el.addClass('vc-markdown', 'markdown-rendered');
    if (renderPlainText(markdown, el)) return Promise.resolve();
    // The chat's own text (not a side chat's) records its mentions once its links are in.
    const chat = component === this.chatComponent ? this.mentionsChat() : null;
    // Rendered off the page and swept before it goes in, so an inline style that would load
    // something is gone before it is ever applied; what is drawn later is moved in when it is done.
    const holder = createDiv();
    const rendering = MarkdownRenderer.render(this.app, neutralizeRemoteMedia(markdown), holder, '', component);
    const moveIn = () => {
      sweepRemoteMedia(holder);
      el.append(...Array.from(holder.childNodes));
    };
    moveIn();
    // Whatever was drawn goes in, the render failed or not.
    return rendering
      .finally(moveIn)
      .then(() => {
        linkFileNames(el, (name) => this.vaultFileOf(name));
        if (chat) this.recordMentions(el, chat);
        if (component === this.chatComponent) this.countNotesSoon();
      })
      .catch((error: unknown) => log('rendering a reply failed', error));
  }

  /**
   * The vault path of the file `name` names: its path in the vault, or an absolute path inside it;
   * or, for a note, its name as a link resolves it. Another file's bare name (`main.ts`, say) is
   * not looked up, as it more often names a file outside the vault than one somewhere in it.
   */
  private vaultFileOf(name: string): string | null {
    const file = this.app.vault.getAbstractFileByPath(vaultRelative(name, this.plugin.vaultRoot() ?? '') ?? name);
    if (file instanceof TFile) return file.path;
    const note = this.app.metadataCache.getFirstLinkpathDest(name, '');
    return note?.extension === 'md' ? note.path : null;
  }

  private renderNotice(text: string, cls = 'vc-notice-error'): void {
    this.container().createDiv({ cls: `vc-notice ${cls}`, text });
    this.scrollToBottom();
  }

  /** A divider where Claude Code compacted the chat (see compactionText), in the reply it interrupted if any. */
  private renderCompaction(trigger: unknown, preTokens: unknown): void {
    (this.draw.turn ?? this.draw.parent).createDiv({
      cls: 'vc-notice vc-muted vc-compaction',
      text: compactionText(trigger, preTokens),
      attr: { 'aria-label': COMPACTION_DETAIL },
    });
    this.scrollToBottom();
  }

  private renderWelcome(): void {
    const el = this.messagesEl.createDiv({ cls: 'vc-welcome' });
    if (this.scratch) {
      el.createDiv({ text: 'Scratch chat' });
      el.createDiv({
        cls: 'vc-muted',
        text: `It starts over after ${idleLabel(this.plugin.settings.scratchIdleHours)} idle, or on Clear scratch chat. Save it as a note to keep anything.`,
      });
    } else {
      el.createDiv({ text: 'Claude Code, running in this vault' });
    }
    // The panel's keys.
    const mac = Platform.isMacOS;
    const send = this.plugin.settings.sendWithModifier ? (mac ? '⌘↩' : 'Ctrl+Enter') : mac ? '↩' : 'Enter';
    el.createDiv({ cls: 'vc-muted', text: `${send} send · ↑ last message · @ file · / command` });
    el.createDiv({ cls: 'vc-muted', text: `${mac ? '⌥↑↓' : 'Alt+↑↓'} your messages · ${mac ? '⌘F' : 'Ctrl+F'} find` });
    if (!this.scratch && this.plugin.settings.scratchChat) {
      const line = el.createDiv({ cls: 'vc-muted vc-welcome-scratch' });
      const link = line.createSpan({ cls: 'vc-welcome-link', text: 'Open the scratch chat' });
      line.appendText(' for daily odds and ends');
      link.addEventListener('click', () => void this.openScratch());
    }
    if (!this.scratch) {
      const line = el.createDiv({ cls: 'vc-muted vc-welcome-pick-up' });
      const link = line.createSpan({ cls: 'vc-welcome-link', text: 'Pick up where you left off' });
      line.appendText(': chats to carry on');
      link.addEventListener('click', () => void this.plugin.openPickUp());
    }
  }

  private onMessagesClick(evt: MouseEvent): void {
    const target = evt.target as HTMLElement;
    const link = target.closest<HTMLAnchorElement>('a.internal-link');
    if (link) {
      evt.preventDefault();
      const href = link.dataset.href ?? link.getAttribute('href');
      if (href) void this.app.workspace.openLinkText(href, '', Keymap.isModEvent(evt));
      return;
    }
    const fileLink = target.closest<HTMLElement>('.vc-file-link');
    if (fileLink?.dataset.path) {
      evt.preventDefault();
      void this.app.workspace.openLinkText(fileLink.dataset.path, '', Keymap.isModEvent(evt));
      return;
    }
    // Any other link opens as one in a note's reading view does, through window.open: Obsidian then
    // asks before handing a file or another app's link to the system, and warns of an executable.
    // Left to the browser, a click on a file:// link does nothing, refused from the app's page.
    const href = target.closest<HTMLAnchorElement>('a.external-link')?.getAttribute('href');
    if (href) {
      evt.preventDefault();
      if (!openableHref(href)) {
        new Notice(`This link cannot be opened: ${href.slice(0, 80)}`);
        return;
      }
      const pane = Keymap.isModEvent(evt);
      window.open(href, typeof pane === 'boolean' ? '' : pane);
    }
  }

  /**
   * Hands a link under the pointer to Obsidian's page preview: wikilinks in replies, and file names
   * such as those in the changed-files card.
   */
  private onMessagesHover(evt: MouseEvent): void {
    const link = (evt.target as HTMLElement).closest<HTMLElement>('a.internal-link, .vc-file-link');
    const linktext = link?.dataset.href ?? link?.dataset.path ?? link?.getAttribute('href');
    if (!link || !linktext) return;
    this.app.workspace.trigger('hover-link', { event: evt, source: VIEW_TYPE, hoverParent: this.leaf, targetEl: link, linktext, sourcePath: '' });
  }

  private scrollToBottom(force = false): void {
    // Earlier turns are drawn above the view, which their drawing keeps in place (see EarlierDrawing).
    if (!this.drawingLive()) return;
    // A saved chat being drawn is scrolled once, at its end: each scroll here would lay out all drawn so far again.
    if (this.drawingSaved) return;
    // New output is appended to the turn; move the activity row back to the end.
    if (this.activityEl && this.draw.turn && this.activityEl.parentElement === this.draw.turn) this.draw.turn.appendChild(this.activityEl);
    if (!force && !this.stickToBottom) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Obsidian's status bar floats over the bottom-right corner; keep the input and buttons clear of it. */
  private updateStatusBarClearance(): void {
    const root = this.contentEl;
    const bar = root.doc.querySelector<HTMLElement>('.status-bar');
    let clearance = 0;
    if (bar) {
      const barRect = bar.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const overlaps =
        barRect.height > 0 &&
        barRect.left < rootRect.right &&
        barRect.right > rootRect.left &&
        barRect.top < rootRect.bottom &&
        barRect.bottom > rootRect.top;
      if (overlaps) clearance = Math.ceil(rootRect.bottom - barRect.top);
    }
    root.style.setProperty('--vc-status-bar-clearance', `${clearance}px`);
  }
}
