// A Claude chat's model, effort and permission mode as chosen in the panel, kept with its record so
// that it reopens with them (see setClaudeChoices); a Codex chat's are CodexChoices (codexAccess.ts).
import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeChoices {
  /** The model asked for; null for Claude Code's own setting (see chatModel), absent for none kept. */
  model?: string | null;
  effort?: EffortLevel;
  /** Never Plan: a chat reopened in planning would change nothing until a plan was approved. */
  mode?: PermissionMode;
}

/** The modes a chat may be reopened in (Plan left out); Bypass only where the settings still offer it (see populateModeSelect). */
const KEPT_MODES = new Set<string>(['default', 'acceptEdits', 'auto', 'bypassPermissions']);
const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

/** `value` as ClaudeChoices, what is not one left out (a hand-edited data.json). */
export function readClaudeChoices(value: unknown): ClaudeChoices | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { model, effort, mode } = value as Record<string, unknown>;
  return {
    ...(model === null || (typeof model === 'string' && model) ? { model: model as string | null } : {}),
    ...(typeof effort === 'string' && EFFORTS.has(effort) ? { effort: effort as EffortLevel } : {}),
    ...(typeof mode === 'string' && KEPT_MODES.has(mode) ? { mode: mode as PermissionMode } : {}),
  };
}
