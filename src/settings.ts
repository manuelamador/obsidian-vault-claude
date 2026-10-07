import { App, Platform, PluginSettingTab, Setting } from 'obsidian';
import { delimiter } from 'path';
import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type VaultClaudePlugin from './main';
import { detectClaudePath } from './session';
import { prettyModel } from './usageDisplay';

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

export function denyRuleList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export interface VaultClaudeSettings {
  claudePath: string;
  model: string;
  /** Vault paths left out of the notes a chat lists, one pattern per line. */
  hiddenNotePaths: string;
  /** Offer the scratch chat: the history's first row, the link in an empty chat, the new-chat menu. */
  scratchChat: boolean;
  /** Hours the scratch chat is left alone before it starts over; one of SCRATCH_IDLE_CHOICES. */
  scratchIdleHours: number;
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
  phoneAccessName: string;
  phoneAccessAtStartup: boolean;
  phoneEveryChat: boolean;
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
  model: '',
  hiddenNotePaths: '*attachments/*',
  scratchChat: true,
  scratchIdleHours: 24,
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
  phoneAccessName: '',
  phoneAccessAtStartup: false,
  phoneEveryChat: false,
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
      .setDesc('Model for new chats. The model button in the panel header switches it for the current chat.')
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
      .setName('Model for small jobs')
      .setDesc('Model for Edit selection with Claude, Save summary as note, and the scratch chat. These are short requests where a smaller model answers faster and uses less of the plan.')
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
      .setName('Default effort')
      .setDesc('Effort for new chats. The effort menu in the panel header changes it for the current chat.')
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
      .setName('Default permission mode')
      .setDesc('Mode for new chats. It can be changed per chat from the panel header.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(permissionModes(settings.allowBypass))
          .setValue(settings.permissionMode)
          .onChange(async (value) => {
            settings.permissionMode = value as PermissionMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Offer bypass permissions')
      .setDesc(
        'Adds "Bypass permissions" to the mode menus: Claude runs every tool without asking. The deny rules below still apply. Takes effect in new chats.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.allowBypass).onChange(async (value) => {
          settings.allowBypass = value;
          if (!value && settings.permissionMode === 'bypassPermissions') settings.permissionMode = 'default';
          await this.plugin.saveSettings();
          this.plugin.refreshModeMenus();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('Deny rules')
      .setDesc(
        "One rule per line in Claude Code's permission-rule syntax, e.g. Bash(git reset:*). Matching actions are refused in every mode, bypass included. Lines starting with # are ignored. Takes effect in new chats.",
      )
      .addTextArea((area) => {
        area.setValue(settings.denyRules).onChange(async (value) => {
          settings.denyRules = value;
          await this.plugin.saveSettings();
        });
        area.inputEl.rows = 6;
      });

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
        "Reads every chat's session file again for the notes it changed, was sent and linked to, which the connections map and projects follow. Links removed by hand stay removed; chats put in a project by hand stay in it. Also in the command palette.",
      )
      .addButton((button) => button.setButtonText('Rebuild…').onClick(() => this.plugin.confirmRebuildConnections()));

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

    new Setting(containerEl).setName('Phone access').setHeading();

    new Setting(containerEl)
      .setDesc(
        'The phone button in the panel can put the chat on screen on your phone (Remote Control for that chat: continue it from the Claude app or claude.ai/code while the panel is open), or run Claude Code\'s Remote Control server in this vault so the phone can start new sessions here. Server sessions use the default permission mode above, with Bypass replaced by Ask first, and the Claude Code settings files; the deny rules above apply to panel chats only.',
      );

    new Setting(containerEl)
      .setName('Put every chat on the phone')
      .setDesc('Turn Remote Control on for each new panel chat as it starts. Each chat appears as its own session in the Claude app.')
      .addToggle((toggle) =>
        toggle.setValue(settings.phoneEveryChat).onChange(async (value) => {
          settings.phoneEveryChat = value;
          await this.plugin.saveSettings();
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
      .setName('Start phone access with Obsidian')
      .setDesc(
        'Start the vault\'s phone server (claude remote-control) whenever Obsidian opens, so the Claude app can start new sessions in this vault. ' +
          'It does not put panel chats on the phone: that is "Put every chat on the phone" above. ' +
          'The server keeps one Claude Code process running while Obsidian is open. When off, start it from the phone button\'s menu.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.phoneAccessAtStartup).onChange(async (value) => {
          settings.phoneAccessAtStartup = value;
          await this.plugin.saveSettings();
        }),
      );

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
