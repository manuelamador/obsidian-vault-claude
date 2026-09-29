import type { SDKControlGetContextUsageResponse, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { contextFigures, planExtras, prettyModel, resetTime, timeLeft, usageWindows, type UsageLevel } from './usageDisplay';

/** What the hover card shows: the chat's last context reading and model, and the last plan-usage reading. */
export interface UsageCardData {
  context: SDKControlGetContextUsageResponse | null;
  model: string | null;
  plan: SDKControlGetUsageResponse | null;
  planFetchedAt: number;
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
    const compaction = threshold !== null ? `auto-compacts at ${Math.round(threshold).toLocaleString()}` : 'auto-compact is off';
    usageRow(contextSection, {
      label: data.model ? prettyModel(data.model) : 'This chat',
      pct,
      value: `${used > 0 && pct < 1 ? '<1' : Math.round(pct)}%`,
      detail: `${used.toLocaleString()} of ${max.toLocaleString()} tokens · ${compaction}`,
      level: threshold !== null && used >= threshold * 0.9 ? 'warning' : 'normal',
    });
  } else {
    contextSection.createDiv({ cls: 'vc-usage-note', text: 'Shown after the first reply.' });
  }

  const plan = data.plan;
  const kind = plan?.subscription_type;
  const planSection = section(kind ? `Plan usage · ${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : 'Plan usage');
  const windows = plan ? usageWindows(plan) : [];
  if (windows.length === 0) {
    planSection.createDiv({ cls: 'vc-usage-note', text: plan ? 'Plan limits do not apply to this sign-in.' : 'Not read yet.' });
  }
  for (const window of windows) {
    const left = window.resetsAt ? timeLeft(window.resetsAt - Date.now()) : '';
    usageRow(planSection, {
      label: window.label,
      pct: window.percent,
      value: `${window.percent}%`,
      detail: window.resetsAt ? `resets ${resetTime(window.resetsAt)}${left ? ` · ${left} left` : ''}` : '',
      level: window.level,
    });
  }
  if (plan) {
    for (const line of planExtras(plan)) planSection.createDiv({ cls: 'vc-usage-note', text: line });
    const asOf = new Date(data.planFetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    planSection.createDiv({ cls: 'vc-usage-note', text: `As of ${asOf}; read again after each reply.` });
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
