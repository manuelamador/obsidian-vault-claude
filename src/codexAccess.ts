// What a Codex chat may do without asking: the sandbox it runs in, when it asks, and who answers.
// The panel's mode menu offers these for a Codex chat, as it offers Claude Code's permission modes
// for a Claude chat; each turn carries the chat's choice (see CodexSession), so a change applies
// from the next message.

export type CodexAccess = 'readOnly' | 'ask' | 'default' | 'autoReview' | 'full';

/** Each choice's name in menus, its short name on the mode button, and what it lets Codex do. */
const ACCESS: Record<CodexAccess, { label: string; short: string; detail: string }> = {
  readOnly: { label: 'Read only', short: 'Read', detail: 'Codex reads, and asks before it changes anything' },
  ask: { label: 'Ask first', short: 'Ask', detail: 'Codex asks before any command not known to be safe' },
  default: { label: 'Default', short: 'Default', detail: 'Codex edits in the vault, and asks to go outside it or online' },
  autoReview: { label: 'Auto (reviewer)', short: 'Auto', detail: 'as Default, but a Codex reviewer answers its requests instead of you' },
  full: { label: 'Full access', short: 'Full', detail: 'Codex runs anything, anywhere, without asking' },
};

/** A Codex chat's model, effort and permissions as chosen in the panel, kept with its record to reopen it with; none, the settings' defaults. */
export interface CodexChoices {
  model?: string;
  effort?: string;
  access?: CodexAccess;
}

/** `value` as CodexChoices, what is not one left out (a hand-edited data.json). */
export function readCodexChoices(value: unknown): CodexChoices | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { model, effort, access } = value as Record<string, unknown>;
  return { ...(typeof model === 'string' && model ? { model } : {}), ...(typeof effort === 'string' && effort ? { effort } : {}), ...(isCodexAccess(access) ? { access } : {}) };
}

export function isCodexAccess(value: unknown): value is CodexAccess {
  return typeof value === 'string' && value in ACCESS;
}

/** The choices offered in menus; `full` only when "Offer bypass permissions" is on. */
export function codexAccessModes(allowFull: boolean): Record<string, string> {
  return Object.fromEntries(Object.entries(ACCESS).filter(([access]) => allowFull || access !== 'full').map(([access, { label }]) => [access, label]));
}

export function codexAccessShort(access: CodexAccess): string {
  return ACCESS[access].short;
}

export function codexAccessLabel(access: CodexAccess): string {
  return ACCESS[access].label;
}

export function codexAccessDetail(access: CodexAccess): string {
  return ACCESS[access].detail;
}

/**
 * What a turn sends Codex for `access` (see turn/start): its sandbox, its approval policy and who
 * reviews its requests. Sent with every turn, Default included, since a choice applies to the turns
 * after it until another replaces it. The vault, the turn's folder, is writable in workspace-write.
 */
export function codexTurnAccess(access: CodexAccess): { sandboxPolicy: Record<string, unknown>; approvalPolicy: string; approvalsReviewer: string } {
  const workspace = { type: 'workspaceWrite', networkAccess: false };
  switch (access) {
    case 'readOnly':
      return { sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
    case 'ask':
      return { sandboxPolicy: workspace, approvalPolicy: 'untrusted', approvalsReviewer: 'user' };
    case 'autoReview':
      return { sandboxPolicy: workspace, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' };
    case 'full':
      return { sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' };
    default:
      return { sandboxPolicy: workspace, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
  }
}
