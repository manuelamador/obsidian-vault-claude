import { App, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import { delimiter } from 'path';
import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type VaultClaudePlugin from './main';
import { detectClaudePath } from './session';
import { prettyModel } from './usageDisplay';
import { findCodex } from './codexSession';
import { codexAccessModes, type CodexAccess } from './codexAccess';

export type ToolDisplay = 'summary' | 'lines' | 'hidden';

/** Each permission mode's name in menus, and its short name on the panel's mode button. */
const MODES: Record<string, { label: string; short: string }> = {
  default: { label: 'Ask first', short: 'Ask' },
  acceptEdits: { label: 'Accept edits', short: 'Edits' },
  auto: { label: 'Auto (classifier)', short: 'Auto' },
  plan: { label: 'Plan only', short: 'Plan' },
  bypassPermissions: { label: 'Bypass permissions', short: 'Bypass' },
};

/** Permission modes offered in menus; `bypassPermissions` only when enabled in settings. */
export function permissionModes(allowBypass: boolean): Record<string, string> {
  return Object.fromEntries(Object.entries(MODES).filter(([mode]) => allowBypass || mode !== 'bypassPermissions').map(([mode, { label }]) => [mode, label]));
}

/** Mode `mode`'s short name, as the mode button shows it. */
export function modeShort(mode: string): string {
  return MODES[mode]?.short ?? mode;
}

/** Commands the vault's CLAUDE.md forbids without an explicit request, plus recursive deletion. */
const DEFAULT_DENY_RULES = [
  'Bash(git checkout:*)',
  'Bash(git reset:*)',
  'Bash(git restore:*)',
  'Bash(git clean:*)',
  'Bash(rm -rf:*)',
].join('\n');

/** The deny rules every chat runs with, one per line of the setting; blank lines and `#` comments left out. */
export function denyRuleList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export interface VaultClaudeSettings {
  claudePath: string;
  /** The Codex CLI for Codex chats (see CodexSession); empty finds it on PATH or where the ChatGPT app installs it. */
  codexPath: string;
  /** What runs a new chat: Claude Code, or Codex (as New Codex chat does). */
  newChatEngine: 'claude' | 'codex';
  /** What runs the small jobs (see smallJobModel): Claude Code, or Codex on its default model. */
  smallJobEngine: 'claude' | 'codex';
  /** Codex chats' model and reasoning effort to start with, and the small jobs' when run on Codex; empty for Codex's own. */
  codexModel: string;
  codexEffort: string;
  /** What new Codex chats may do without asking (see codexAccess.ts). */
  codexAccess: CodexAccess;
  smallJobCodexModel: string;
  model: string;
  /** Vault paths left out of the notes a chat lists, one pattern per line. */
  hiddenNotePaths: string;
  /** Offer the scratch chat: the history's first row, the link in an empty chat, the new-chat menu. */
  scratchChat: boolean;
  /** Hours the scratch chat is left alone before it starts over; one of SCRATCH_IDLE_CHOICES. */
  scratchIdleHours: number;
  /** What runs the scratch chat, as `claude:<model>` or `codex:<model>` (an empty model for that one's default); empty: as small jobs run. */
  scratchModel: string;
  /** Messages you send kept for ↑ in other chats (see VaultClaudePlugin.recordPrompt). */
  rememberPrompts: boolean;
  /** Zotero's works in the `@` picker, read through Zotero's local API (see zotero.ts). */
  zoteroMentions: boolean;
  /** Codex chats run through Codex's shared app-server (its daemon) when it runs, so the phone app can open them too (see codexLaunch). */
  phoneCodex: boolean;
  /** Codex chats kept out of Codex's own lists (the app, the phone): archived while not open in the panel. */
  codexHidden: boolean;
  /** What a side chat knows: the whole chat it was opened from (a fork of it), or only what is asked. */
  sideChatContext: 'chat' | 'quote';
  /** Model for inline edits, chat summaries and the scratch chat; empty for the chats' model. */
  smallJobModel: string;
  effort: EffortLevel | '';
  permissionMode: PermissionMode;
  toolDisplay: ToolDisplay;
  /** Left and right margin of the panel, in pixels. */
  panelMargin: number;
  sendWithModifier: boolean;
  /** A new chat starts with the note in front attached. Renamed from `includeActiveNote`, whose old default was on. */
  attachActiveNote: boolean;
  historyIncludesAllSessions: boolean;
  /** Vault folder where "Save chat as note" writes; empty for the vault root. */
  savedChatsFolder: string;
  /** Vault folder for memo notes (see MemoModal); empty for the vault root. */
  memosFolder: string;
  /** System notification when a long reply finishes (or approval is needed) while Obsidian is not in front. */
  notifyWhenDone: boolean;
  notifyAfterSeconds: number;
  allowBypass: boolean;
  denyRules: string;
  /** The features for Claude Code's Gmail connector (email and draft cards, Make a todo, Draft an email, mail read by chats); off without Gmail. */
  gmailFeatures: boolean;
  /** The note todos made from the chat go to (an email card's "Make a todo"), and its section. */
  todoNote: string;
  todoSection: string;
  phoneAccessName: string;
  /** Claude Code on the phone: the vault's Remote Control server, and Remote Control for every chat running in the panel (see setPhoneClaude). */
  phoneClaude: boolean;
  extraPath: string;
}

/** The times, in hours, the scratch chat can be left alone before it starts over. */
/** The `model` setting that leaves the model to Claude Code's own settings: chats then send none. */
const CLAUDE_CODE_MODEL = 'claude-code';

/**
 * The model new chats ask for, from the `model` setting: Default when it is empty (sent as such,
 * since with no model Claude Code runs the one its settings name, which may differ); none for
 * CLAUDE_CODE_MODEL; else the model chosen.
 */
export function chatModel(setting: string): string | undefined {
  return setting === CLAUDE_CODE_MODEL ? undefined : setting || 'default';
}

export const SCRATCH_IDLE_CHOICES = [1, 4, 12, 24, 72, 168];

/** A scratch idle time in words: "1 hour", "12 hours", "3 days", "1 week". */
export function idleLabel(hours: number): string {
  if (hours % 168 === 0) return hours === 168 ? '1 week' : `${hours / 168} weeks`;
  if (hours > 24 && hours % 24 === 0) return `${hours / 24} days`;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export function extraPathEntries(value: string): string[] {
  return value.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

export const DEFAULT_SETTINGS: VaultClaudeSettings = {
  claudePath: '',
  codexPath: '',
  newChatEngine: 'claude',
  smallJobEngine: 'claude',
  codexModel: '',
  codexEffort: '',
  codexAccess: 'default',
  smallJobCodexModel: '',
  model: '',
  hiddenNotePaths: '*attachments/*',
  scratchChat: true,
  scratchIdleHours: 24,
  scratchModel: '',
  rememberPrompts: true,
  zoteroMentions: false,
  phoneCodex: false,
  codexHidden: false,
  sideChatContext: 'chat',
  smallJobModel: 'sonnet',
  effort: '',
  permissionMode: 'default',
  toolDisplay: 'summary',
  panelMargin: 20,
  sendWithModifier: true,
  attachActiveNote: false,
  historyIncludesAllSessions: false,
  savedChatsFolder: 'Claude chats',
  memosFolder: 'Claude chats/Memos',
  notifyWhenDone: true,
  notifyAfterSeconds: 30,
  allowBypass: false,
  denyRules: DEFAULT_DENY_RULES,
  gmailFeatures: true,
  todoNote: 'Todo.md',
  todoSection: 'Open',
  phoneAccessName: '',
  phoneClaude: false,
  extraPath: '',
};

export class VaultClaudeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: VaultClaudePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const { settings } = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName('New chats run on')
      .setDesc('Claude Code or Codex. The other is a click away in a new chat, and New chat\'s right-click menu offers both.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ claude: 'Claude Code', codex: 'Codex' })
          .setValue(settings.newChatEngine)
          .onChange(async (value) => {
            settings.newChatEngine = value === 'codex' ? 'codex' : 'claude';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Small jobs run on')
      .setDesc('Claude Code or Codex, each on its model for small jobs below: Edit selection, Save summary as note, memo suggestions, Pick up where you left off, a project\'s Context, summaries of included chats and Suggest frontmatter updates.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ claude: 'Claude Code', codex: 'Codex' })
          .setValue(settings.smallJobEngine)
          .onChange(async (value) => {
            settings.smallJobEngine = value === 'codex' ? 'codex' : 'claude';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName('Claude Code').setHeading();

    const detected = detectClaudePath();
    new Setting(containerEl)
      .setName('Claude Code executable')
      .setDesc(
        detected
          ? `Leave empty to use ${detected}.`
          : Platform.isWin
            ? 'No claude.exe found; enter its full path. Claude Code must come from the native Windows installer (npm installs are not supported).'
            : 'No Claude Code executable found; enter its full path.',
      )
      .addText((text) =>
        text
          .setPlaceholder(detected ?? (Platform.isWin ? 'C:\\Users\\you\\.local\\bin\\claude.exe' : '/path/to/claude'))
          .setValue(settings.claudePath)
          .onChange(async (value) => {
            settings.claudePath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // Models Claude Code offers (cached from the last chat). The empty choice defers: to Claude
    // Code's default for chats, to the chats' model for inline edits and summaries. A model typed
    // in an earlier version, or no longer listed, stays selectable.
    const modelChoices = (current: string, empty: string): Record<string, string> => {
      const choices: Record<string, string> = { '': empty };
      for (const model of this.plugin.models) {
        if (model.value !== 'default') choices[model.value] = prettyModel(model.resolvedModel ?? model.value);
      }
      if (current && !(current in choices)) choices[current] = current;
      return choices;
    };
    // Default first (the empty setting); then, where Claude Code's settings name a model, that one,
    // which a chat sent no model runs; then the models Claude Code lists.
    const claudeDefault = this.plugin.models.find((model) => model.value === 'default');
    const configured = this.plugin.configured.model;
    const chatChoices = (): Record<string, string> => {
      const choices = modelChoices(settings.model, claudeDefault ? `Default (${prettyModel(claudeDefault.resolvedModel ?? 'default')})` : 'Default');
      if (configured || settings.model === CLAUDE_CODE_MODEL) {
        const { [CLAUDE_CODE_MODEL]: _left, '': first, ...rest } = choices;
        return { '': first, [CLAUDE_CODE_MODEL]: configured ? `Claude Code's setting (${prettyModel(configured)})` : "Claude Code's setting", ...rest };
      }
      return choices;
    };

    new Setting(containerEl)
      .setName('Default model')
      .setDesc('Model for new Claude Code chats. The model button in the panel header switches it for the current chat.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(
            chatChoices(),
          )
          .setValue(settings.model)
          .onChange(async (value) => {
            settings.model = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default effort')
      .setDesc('Effort for new Claude Code chats. The effort menu in the panel header changes it for the current chat.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ '': 'Claude Code default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })
          .setValue(settings.effort)
          .onChange(async (value) => {
            settings.effort = value as EffortLevel | '';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Model for small jobs')
      .setDesc('For small jobs run on Claude Code (see Small jobs run on). These are short requests where a smaller model answers faster and uses less of the plan.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(modelChoices(settings.smallJobModel, 'Same as chats'))
          .setValue(settings.smallJobModel)
          .onChange(async (value) => {
            settings.smallJobModel = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default permissions')
      .setDesc('Permission mode for new Claude chats; each chat can change it from the menu under the input. Codex chats have their own, under Codex.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(permissionModes(settings.allowBypass))
          .setValue(settings.permissionMode)
          .onChange(async (value) => {
            settings.permissionMode = value as PermissionMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName('Codex').setHeading();

    const codex = findCodex('');
    new Setting(containerEl)
      .setName('Codex executable')
      .setDesc(codex ? `Leave empty to use ${codex}. Codex runs with its own settings (~/.codex/config.toml).` : 'No Codex found; enter its full path, or install Codex.')
      .addText((text) =>
        text
          .setPlaceholder(codex ?? '/path/to/codex')
          .setValue(settings.codexPath)
          .onChange(async (value) => {
            settings.codexPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // Codex's models, as Codex lists them (see loadCodexModels); read when this tab is first shown.
    const codexModels = this.plugin.codexModels;
    if (codexModels.length === 0) void this.plugin.loadCodexModels()?.then(() => this.plugin.codexModels.length > 0 && this.display());
    const codexDefault = codexModels.find((model) => model.isDefault);
    const codexChoices = (current: string, empty: string): Record<string, string> => {
      const choices: Record<string, string> = { '': empty };
      for (const model of codexModels) choices[model.id] = model.name;
      if (current && !(current in choices)) choices[current] = current;
      return choices;
    };
    const codexDefaultName = codexDefault ? `Codex default (${codexDefault.name})` : 'Codex default';

    new Setting(containerEl)
      .setName('Default Codex model')
      .setDesc('Model for new Codex chats. The model button in the panel header switches it for the current chat.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(codexChoices(settings.codexModel, codexDefaultName))
          .setValue(settings.codexModel)
          .onChange(async (value) => {
            settings.codexModel = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    // The efforts the chosen model offers, else Codex's usual ones.
    const chosenCodex = codexModels.find((model) => model.id === settings.codexModel) ?? codexDefault;
    const codexEfforts: Record<string, string> = { '': chosenCodex?.defaultEffort ? `Model default (${chosenCodex.defaultEffort})` : 'Model default' };
    for (const effort of chosenCodex?.efforts.map((each) => each.value) ?? ['low', 'medium', 'high', 'xhigh']) codexEfforts[effort] = `${effort[0].toUpperCase()}${effort.slice(1)}`;
    if (settings.codexEffort && !(settings.codexEffort in codexEfforts)) codexEfforts[settings.codexEffort] = settings.codexEffort;
    new Setting(containerEl)
      .setName('Default Codex effort')
      .setDesc('Reasoning effort for new Codex chats. The effort menu in the panel header changes it for the current chat.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(codexEfforts)
          .setValue(settings.codexEffort)
          .onChange(async (value) => {
            settings.codexEffort = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default Codex permissions')
      .setDesc(
        'What new Codex chats may do without asking. Default: edit in the vault, and ask to go outside it or online. Auto (reviewer): a Codex model answers those requests instead of you. The deny rules below apply only to commands Codex asks about, so not in Full access. The mode menu in the panel header changes it for the current chat.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(codexAccessModes(settings.allowBypass))
          .setValue(settings.codexAccess)
          .onChange(async (value) => {
            settings.codexAccess = value as CodexAccess;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Codex model for small jobs')
      .setDesc('For small jobs run on Codex (see Small jobs run on). A smaller model answers faster and uses less of the plan.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(codexChoices(settings.smallJobCodexModel, 'Same as Codex chats'))
          .setValue(settings.smallJobCodexModel)
          .onChange(async (value) => {
            settings.smallJobCodexModel = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName('Chats').setHeading();

    new Setting(containerEl)
      .setName('Attach the open note to new chats')
      .setDesc(
        'Each chat has at most one attached note, which goes with every message, with the lines selected in it while it is open. When off, a new chat starts with none: the chip above the input offers the open note, and a click attaches it.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.attachActiveNote).onChange(async (value) => {
          settings.attachActiveNote = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Files left out of a chat\'s notes')
      .setDesc('Only notes (.md) are listed by the notes button, by a note\'s chat links, and when linking a memo. These patterns leave out more of them, one per line; * stands for any characters.')
      .addTextArea((text) =>
        text
          .setPlaceholder('*attachments/*')
          .setValue(settings.hiddenNotePaths)
          .onChange(async (value) => {
            settings.hiddenNotePaths = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Side chat knows')
      .setDesc('What a side chat is given: a copy of the whole chat it was opened from, or only what you ask it, the quoted text included. The copy answers with the whole conversation in mind; asking only what you quote is faster and uses less of the plan.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ chat: 'The whole chat', quote: 'Only what is asked' })
          .setValue(settings.sideChatContext)
          .onChange(async (value) => {
            settings.sideChatContext = value === 'quote' ? 'quote' : 'chat';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Remember sent messages for ↑')
      .setDesc('↑ in an empty input brings back messages you sent, in this chat and others. Off: only this chat\'s, and the messages kept from others are cleared. They are kept in the plugin\'s data file (the last 100, each up to 1,000 characters), which deleting a chat does not clear.')
      .addToggle((toggle) =>
        toggle.setValue(settings.rememberPrompts).onChange(async (value) => {
          settings.rememberPrompts = value;
          if (!value) this.plugin.promptHistory = [];
          await this.plugin.saveSettings();
        }),
      )
      .addButton((button) =>
        button.setButtonText('Clear').onClick(async () => {
          this.plugin.promptHistory = [];
          await this.plugin.saveSettings();
          new Notice('Sent messages kept for ↑ cleared.');
        }),
      );

    new Setting(containerEl)
      .setName('History includes all vault sessions')
      .setDesc(
        'Off: the history lists chats started from this panel. On: it also lists Claude Code sessions run in the vault folder from the terminal, the desktop app or an editor. Those open as a copy (a forked session), so the original session is left unchanged.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.historyIncludesAllSessions).onChange(async (value) => {
          settings.historyIncludesAllSessions = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Rebuild connections')
      .setDesc(
        "Reads every chat's session file again and adds the links it shows to notes it changed, was sent and linked to, which the connections map and projects follow. No link is taken away; links removed by hand stay removed, and chats put in a project by hand stay in it. Also in the command palette.",
      )
      .addButton((button) => button.setButtonText('Rebuild…').onClick(() => this.plugin.confirmRebuildConnections()));

    new Setting(containerEl)
      .setName('Notify when Claude finishes')
      .setDesc(
        'A system notification when a reply that took longer than the time below finishes, or when Claude is waiting for approval, while Obsidian is not the app in front. Clicking it brings the chat back.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.notifyWhenDone).onChange(async (value) => {
          settings.notifyWhenDone = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Notify after (seconds)')
      .setDesc('Replies that finish sooner than this never notify.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 300, 10)
          .setValue(settings.notifyAfterSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.notifyAfterSeconds = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName('Scratch chat').setHeading();

    new Setting(containerEl)
      .setName('Scratch chat')
      .setDesc('One chat for daily odds and ends, kept out of the chat list and starting over when left alone for the time below. Off: it is not offered in the history, an empty chat or the new-chat menu.')
      .addToggle((toggle) =>
        toggle.setValue(settings.scratchChat).onChange(async (value) => {
          settings.scratchChat = value;
          await this.plugin.saveSettings();
          if (!value) await this.plugin.stopScratch();
          this.plugin.refreshWelcomes();
        }),
      );

    new Setting(containerEl)
      .setName('Scratch chat starts over after')
      .setDesc('How long it is left alone before its conversation starts over. Also in the new-chat button’s right-click menu.')
      .addDropdown((dropdown) => {
        for (const hours of SCRATCH_IDLE_CHOICES) dropdown.addOption(String(hours), idleLabel(hours));
        dropdown.setValue(String(settings.scratchIdleHours)).onChange(async (value) => {
          await this.plugin.setScratchIdle(Number(value));
        });
      });

    // Claude Code's models and Codex's in one list: the choice says which runs the scratch chat.
    const scratchChoices: Record<string, string> = { '': 'Same as small jobs' };
    for (const [value, label] of Object.entries(modelChoices('', 'Claude Code default'))) scratchChoices[`claude:${value}`] = `Claude Code · ${label}`;
    scratchChoices['codex:'] = `Codex · ${codexDefaultName}`;
    for (const model of codexModels) scratchChoices[`codex:${model.id}`] = `Codex · ${model.name}`;
    if (settings.scratchModel && !(settings.scratchModel in scratchChoices)) scratchChoices[settings.scratchModel] = settings.scratchModel.replace(/^(claude|codex):/, (engine) => (engine === 'codex:' ? 'Codex · ' : 'Claude Code · '));
    new Setting(containerEl)
      .setName('Scratch chat model')
      .setDesc('What runs the scratch chat: a Claude Code model or a Codex one. A change takes effect when the scratch chat next starts over.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(scratchChoices)
          .setValue(settings.scratchModel)
          .onChange(async (value) => {
            settings.scratchModel = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName('Permissions for both engines').setHeading();

    new Setting(containerEl)
      .setName('Offer bypass permissions')
      .setDesc(
        'Adds the most permissive choice to the mode menus. Claude chats: "Bypass permissions", every tool without asking; the deny rules below still apply. Codex chats: "Full access", anything anywhere without asking; the deny rules do not apply there. Takes effect in new chats.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.allowBypass).onChange(async (value) => {
          settings.allowBypass = value;
          if (!value && settings.permissionMode === 'bypassPermissions') settings.permissionMode = 'default';
          if (!value && settings.codexAccess === 'full') settings.codexAccess = 'default';
          await this.plugin.saveSettings();
          this.plugin.refreshModeMenus();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('Deny rules')
      .setDesc(
        "One rule per line in Claude Code's permission-rule syntax, e.g. Bash(git reset:*); lines starting with # are ignored. Claude chats: any matching tool call is refused, in every mode, bypass included. Codex chats: only Bash(…) rules count, refusing a matching command Codex asks to run (not in Full access, where it asks nothing). Takes effect in new chats.",
      )
      .addTextArea((area) => {
        area.setValue(settings.denyRules).onChange(async (value) => {
          settings.denyRules = value;
          await this.plugin.saveSettings();
        });
        area.inputEl.rows = 6;
      });

    new Setting(containerEl).setName('Zotero').setHeading();

    new Setting(containerEl)
      .setName('Zotero in @')
      .setDesc(
        'Lists the works in your Zotero libraries (My Library and the groups) in the @ picker. A work picked goes with the message as its citation, its DOI and Zotero links, and where its PDF is on this computer, in Claude and Codex chats alike. Read through Zotero\'s local API on this computer while Zotero runs: the only requests the plugin makes itself.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.zoteroMentions).onChange(async (value) => {
          settings.zoteroMentions = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Gmail').setHeading();

    new Setting(containerEl)
      .setName('Gmail features')
      .setDesc("For Claude Code's Gmail connector: cards for the mail Claude reads and the drafts it writes, Make a todo from a message, Draft an email from this note, and the threads a chat read. Turn off if you do not have Gmail connected to Claude Code.")
      .addToggle((toggle) =>
        toggle.setValue(settings.gmailFeatures).onChange(async (value) => {
          settings.gmailFeatures = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (settings.gmailFeatures) {
      new Setting(containerEl)
        .setName('Todo note')
        .setDesc('Where "Make a todo" on an email card adds its line, at the end of this section of the note (made if missing), in the Tasks plugin\'s format.')
        .addText((text) =>
          text.setValue(settings.todoNote).onChange(async (value) => {
            settings.todoNote = value.trim() || 'Todo.md';
            await this.plugin.saveSettings();
          }),
        )
        .addText((text) =>
          text.setPlaceholder('Section').setValue(settings.todoSection).onChange(async (value) => {
            settings.todoSection = value.trim() || 'Open';
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl).setName('Saved notes').setHeading();

    new Setting(containerEl)
      .setName('Folder for saved chats')
      .setDesc('Where "Save chat as note" writes its notes, relative to the vault root; created if missing. Leave empty for the vault root.')
      .addText((text) =>
        text
          .setPlaceholder('Claude chats')
          .setValue(settings.savedChatsFolder)
          .onChange(async (value) => {
            settings.savedChatsFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Folder for memos')
      .setDesc('Where "Memo" writes a note for each memo, and the Memos table its file, relative to the vault root; created if missing. Leave empty for the vault root. Memos saved in an earlier folder are still listed; a Memos.base left there can be deleted.')
      .addText((text) =>
        text
          .setPlaceholder('Claude chats/Memos')
          .setValue(settings.memosFolder)
          .onChange(async (value) => {
            settings.memosFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName('Appearance and input').setHeading();


    new Setting(containerEl)
      .setName('Tool calls')
      .setDesc('Summary: one collapsed line per run of tool calls. One line each: a line per call. Hidden: permission prompts and errors only.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ summary: 'Summary', lines: 'One line each', hidden: 'Hidden' })
          .setValue(settings.toolDisplay)
          .onChange(async (value) => {
            settings.toolDisplay = value as ToolDisplay;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Panel side margins')
      .setDesc('Space left and right of the chat, the header and the input box, in pixels.')
      .addSlider((slider) =>
        slider
          .setLimits(8, 96, 4)
          .setValue(settings.panelMargin)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.panelMargin = value;
            await this.plugin.saveSettings();
            this.plugin.refreshPanelMargins();
          }),
      );

    new Setting(containerEl)
      .setName(`Send with ${Platform.isMacOS ? '⌘' : 'Ctrl'}+Enter`)
      .setDesc('When off, Enter sends and Shift+Enter inserts a newline.')
      .addToggle((toggle) =>
        toggle.setValue(settings.sendWithModifier).onChange(async (value) => {
          settings.sendWithModifier = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Phone access').setHeading();

    new Setting(containerEl).setDesc(
      'The phone button in the panel switches these too, and its colour shows which are on: the accent colour for Claude Code, green for Codex. What is switched on stays on the next time Obsidian starts.',

    );

    new Setting(containerEl)
      .setName('Claude Code on the phone')
      .setDesc(
        'Every Claude chat running in the panel can be continued from the Claude app or claude.ai/code, and the phone can start new sessions in this vault (Claude Code\'s Remote Control). Sessions started from the phone use the default permission mode above, with Bypass replaced by Ask first; the deny rules above apply to panel chats only.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.phoneClaude).onChange(async (value) => {
          await this.plugin.setPhoneClaude(value);
        }),
      );

    new Setting(containerEl)
      .setName('Name in the Claude app')
      .setDesc('How this vault appears in the Claude app. Takes effect the next time phone access starts.')
      .addText((text) =>
        text
          .setPlaceholder(`${this.app.vault.getName()} vault`)
          .setValue(settings.phoneAccessName)
          .onChange(async (value) => {
            settings.phoneAccessName = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Codex on the phone')
      .setDesc(
        "Codex chats go through Codex's shared app-server (its daemon, with remote control on), so Codex's phone app can open any of them, follow replies and write in them. Started by the panel when needed, and stopped when Obsidian quits; one started outside Obsidian is used as it is and left running.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.phoneCodex).onChange(async (value) => {
          await this.plugin.setPhoneCodex(value);
          // Turned off again when its app-server did not start.
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Keep Codex chats out of Codex's own lists")
      .setDesc(
        "Archives the panel's Codex chats in Codex while they are not open in the panel, so they do not appear in the Codex app or on the phone. The panel lists and reopens them as before.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.codexHidden).onChange(async (value) => {
          settings.codexHidden = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Advanced').setHeading();

    new Setting(containerEl)
      .setName('Extra PATH entries')
      .setDesc(
        `Directories added to PATH for commands Claude runs, separated by "${delimiter}".` +
          (Platform.isWin ? '' : ' Homebrew and ~/.local/bin are always included.'),
      )
      .addText((text) =>
        text.setValue(settings.extraPath).onChange(async (value) => {
          settings.extraPath = value.trim();
          await this.plugin.saveSettings();
        }),
      );
  }
}
