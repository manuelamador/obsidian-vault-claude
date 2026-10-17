import type { SDKControlGetContextUsageResponse, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { codexWindows, contextFigures, planExtras, prettyModel, resetTime, timeLeft, usageWindows, type UsageLevel, type UsageWindow } from './usageDisplay';

/** What the hover card shows: the chat's last context reading and model, and the last plan-usage reading. */
export interface UsageCardData {
  /** Compacts the chat now (its /compact), when it can be: a Claude chat with a reading, not working. */
  compact?: () => void;
  context: SDKControlGetContextUsageResponse | null;
  model: string | null;
  plan: SDKControlGetUsageResponse | null;
  planFetchedAt: number;
  /** In a Codex chat, Codex's usage limits, shown in place of Claude's plan usage; undefined in a Claude chat. */
  codex?: { limits: { planType: string | null; windows: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }[] } | null; fetchedAt: number };
}

/** The hover card: context, each plan limit with its bar and reset, this week's split, extra usage. */
export function renderUsageCard(card: HTMLElement, data: UsageCardData): void {
  card.empty();
  const section = (title: string) => {
    const el = card.createDiv({ cls: 'vc-usage-section' });
    el.createDiv({ cls: 'vc-usage-heading', text: title });
    return el;
  };

  const contextSection = section('Context');
  const figures = data.context ? contextFigures(data.context) : null;
  if (figures) {
    const { used, max, threshold } = figures;
    const pct = Math.min(100, (used / max) * 100);
    // Unknown (a Codex chat's reading says nothing of it): left out.
    const compaction = threshold !== null ? ` · auto-compacts at ${Math.round(threshold).toLocaleString()}` : data.context?.isAutoCompactEnabled === false ? ' · auto-compact is off' : '';
    usageRow(contextSection, {
      label: data.model ? prettyModel(data.model) : 'This chat',
      pct,
      value: `${used > 0 && pct < 1 ? '<1' : Math.round(pct)}%`,
      detail: `${used.toLocaleString()} of ${max.toLocaleString()} tokens${compaction}`,
      level: threshold !== null && used >= threshold * 0.9 ? 'warning' : 'normal',
    });
    if (data.compact) {
      const run = data.compact;
      const button = contextSection.createEl('button', { cls: 'vc-usage-compact', text: 'Compact now', attr: { 'aria-label': 'Summarise the conversation so far (/compact), freeing its context' } });
      button.addEventListener('click', () => run());
    }
  } else {
    contextSection.createDiv({ cls: 'vc-usage-note', text: 'Shown after the first reply.' });
  }

  if (data.codex) {
    const { limits, fetchedAt } = data.codex;
    const type = limits?.planType;
    const codexSection = section(type ? `Codex usage · ${type.charAt(0).toUpperCase()}${type.slice(1)}` : 'Codex usage');
    const windows = limits ? codexWindows(limits) : [];
    if (windows.length === 0) codexSection.createDiv({ cls: 'vc-usage-note', text: limits ? 'No limits reported for this sign-in.' : 'Not read yet.' });
    windowRows(codexSection, windows);
    if (limits) codexSection.createDiv({ cls: 'vc-usage-note', text: `As of ${new Date(fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}; read again after each reply.` });
    return;
  }
  const plan = data.plan;
  const kind = plan?.subscription_type;
  const planSection = section(kind ? `Plan usage · ${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : 'Plan usage');
  const windows = plan ? usageWindows(plan) : [];
  if (windows.length === 0) {
    planSection.createDiv({ cls: 'vc-usage-note', text: plan ? 'Plan limits do not apply to this sign-in.' : 'Not read yet.' });
  }
  windowRows(planSection, windows);
  if (plan) {
    for (const line of planExtras(plan)) planSection.createDiv({ cls: 'vc-usage-note', text: line });
    const asOf = new Date(data.planFetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    planSection.createDiv({ cls: 'vc-usage-note', text: `As of ${asOf}; read again after each reply.` });
  }
}

/** A row for each usage window: its share used, with when it resets. */
function windowRows(parent: HTMLElement, windows: UsageWindow[]): void {
  for (const window of windows) {
    const left = window.resetsAt ? timeLeft(window.resetsAt - Date.now()) : '';
    usageRow(parent, {
      label: window.label,
      pct: window.percent,
      value: `${window.percent}%`,
      detail: window.resetsAt ? `resets ${resetTime(window.resetsAt)}${left ? ` · ${left} left` : ''}` : '',
      level: window.level,
    });
  }
}

function usageRow(parent: HTMLElement, row: { label: string; pct: number; value: string; detail: string; level: UsageLevel }): void {
  const el = parent.createDiv({ cls: `vc-usage-row is-${row.level}` });
  const head = el.createDiv({ cls: 'vc-usage-row-head' });
  head.createSpan({ text: row.label });
  head.createSpan({ cls: 'vc-usage-value', text: row.value });
  const fill = el.createDiv({ cls: 'vc-usage-bar' }).createDiv({ cls: 'vc-usage-fill' });
  fill.style.width = `${Math.min(100, Math.max(0, row.pct))}%`;
  if (row.detail) el.createDiv({ cls: 'vc-usage-detail', text: row.detail });
}
