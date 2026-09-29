// Context and plan-usage figures, model names, and duration and token formatting for the panel.
// Kept free of `obsidian` imports.
import type { SDKControlGetContextUsageResponse, SDKControlGetUsageResponse, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

/** `claude-opus-5[1m]` → `Opus 5 · 1M`, `claude-haiku-4-5-20251001` → `Haiku 4.5`. */
export function prettyModel(id: string): string {
  const oneMillion = /\[1m\]$/i.test(id);
  const base = id.replace(/\[[^\]]*\]$/, '').replace(/^claude-/, '');
  const parts = base.split('-').filter((part) => !/^\d{8}$/.test(part));
  const family = parts.shift() ?? base;
  const version = parts.filter((part) => /^\d+$/.test(part)).join('.');
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ''}`;
  return oneMillion ? `${name} · 1M` : name;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2))}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Tokens in context, the window, and where auto-compaction starts (null when it is off). */
export function contextFigures(usage: SDKControlGetContextUsageResponse): { used: number; max: number; threshold: number | null } | null {
  const max = usage.maxTokens || usage.rawMaxTokens;
  if (!max) return null;
  let threshold: number | null = null;
  if (usage.isAutoCompactEnabled && usage.autoCompactThreshold) {
    const value = usage.autoCompactThreshold;
    // Normalise in case the threshold is reported as a fraction or a percentage.
    threshold = value <= 1 ? value * max : value <= 100 ? (value / 100) * max : value;
  }
  return { used: usage.totalTokens, max, threshold };
}

export type UsageLevel = 'normal' | 'warning' | 'critical';

export interface UsageWindow {
  /** In the hover card: `Session (5 hours)`, `All models, this week`, `Fable, this week`. */
  label: string;
  percent: number;
  resetsAt: number | null;
  level: UsageLevel;
}

/**
 * The plan's usage windows: from the structured `limits` list the usage call returns (labelled,
 * with the server's severity; not in the SDK's typings), else from the typed fields.
 */
export function usageWindows(usage: SDKControlGetUsageResponse): UsageWindow[] {
  const limits = usage.rate_limits;
  if (!usage.rate_limits_available || !limits) return [];
  const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
  const level = (percent: number, severity?: string): UsageLevel =>
    percent >= 95 || severity === 'critical' ? 'critical' : percent >= 80 || severity === 'warning' ? 'warning' : 'normal';
  type Limit = {
    kind?: string;
    percent?: number | null;
    severity?: string;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null } | null;
  };
  const structured = (limits as unknown as { limits?: Limit[] }).limits;
  if (Array.isArray(structured) && structured.some((limit) => typeof limit.percent === 'number')) {
    return structured
      .filter((limit) => typeof limit.percent === 'number')
      .map((limit) => {
        const percent = Math.round(limit.percent as number);
        const model = limit.scope?.model?.display_name ?? null;
        const kind = limit.kind ?? 'limit';
        const label =
          kind === 'session'
            ? 'Session (5 hours)'
            : kind === 'weekly_all'
              ? 'All models, this week'
              : model
                ? `${model}, this week`
                : kind.replace(/_/g, ' ');
        return { label, percent, resetsAt: time(limit.resets_at), level: level(percent, limit.severity) };
      });
  }
  const windows: UsageWindow[] = [];
  const add = (label: string, window: { utilization: number | null; resets_at: string | null } | null | undefined) => {
    if (!window || window.utilization === null) return;
    const percent = Math.round(window.utilization);
    windows.push({ label, percent, resetsAt: time(window.resets_at), level: level(percent) });
  };
  add('Session (5 hours)', limits.five_hour);
  add('All models, this week', limits.seven_day);
  // Per-model weekly caps, e.g. Fable, counted separately from the all-models week.
  for (const scoped of limits.model_scoped ?? []) add(`${scoped.display_name}, this week`, scoped);
  return windows;
}

/** For the hover card: this week's split by product, and extra usage. Neither is in the SDK's typings. */
export function planExtras(usage: SDKControlGetUsageResponse): string[] {
  type Money = { amount_minor: number; exponent: number; currency: string };
  const limits = usage.rate_limits as unknown as {
    seven_day_breakdown?: { rows?: { display_name?: string; percent?: number }[] } | null;
    spend?: { used?: Money | null; limit?: Money | null; enabled?: boolean; disabled_reason?: string | null } | null;
    extra_usage?: {
      is_enabled?: boolean;
      monthly_limit?: number | null;
      used_credits?: number | null;
      currency?: string | null;
      decimal_places?: number;
      disabled_reason?: string | null;
    } | null;
  } | null;
  const money = (minor: number, exponent: number, currency: string) => {
    const amount = minor / 10 ** exponent;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch {
      return `${amount.toFixed(exponent)} ${currency}`;
    }
  };
  const status = (enabled: boolean | undefined, reason: string | null | undefined) =>
    enabled ? 'on' : `off${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}`;
  const lines: string[] = [];
  const rows = (limits?.seven_day_breakdown?.rows ?? []).filter((row) => row.display_name && (row.percent ?? 0) > 0);
  if (rows.length > 0) lines.push(`This week by product: ${rows.map((row) => `${row.display_name} ${row.percent}%`).join(', ')}`);
  const spend = limits?.spend;
  const extra = limits?.extra_usage;
  if (spend?.used && spend.limit) {
    const { used, limit } = spend;
    lines.push(
      `Extra usage: ${money(used.amount_minor, used.exponent, used.currency)} of ${money(limit.amount_minor, limit.exponent, limit.currency)} · ${status(spend.enabled, spend.disabled_reason)}`,
    );
  } else if (extra && extra.monthly_limit != null && extra.used_credits != null) {
    const exponent = extra.decimal_places ?? 2;
    const currency = extra.currency ?? 'USD';
    lines.push(
      `Extra usage: ${money(extra.used_credits, exponent, currency)} of ${money(extra.monthly_limit, exponent, currency)} this month · ${status(extra.is_enabled, extra.disabled_reason)}`,
    );
  }
  return lines;
}

/** `today 2:00 PM`, or `Fri, Sep 18, 6:00 PM`, in the system's locale. */
export function resetTime(ms: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return `today ${time}`;
  return `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** Time until a usage window resets: `3d`, `1d 5h`, `2h`, `40m`; empty once it is past. */
export function timeLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 2) return `${days}d`;
  if (days === 1) return hours === 24 ? '1d' : `1d ${hours - 24}h`;
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

/** `42s`, `3m 12s`, `1h 05m`; `precise` gives tenths under ten seconds (`4.2s`). */
export function formatDuration(ms: number, precise = false): string {
  const seconds = Math.max(0, ms) / 1000;
  if (precise && seconds < 10) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * `12s · 43k in · 820 out` for a finished turn, with the breakdown as a tooltip. The SDK's
 * per-turn usage covers the main agent loop; subagents' tokens are not included.
 */
export function turnStats(result: SDKResultMessage): { text: string; title: string } {
  const usage = result.usage;
  const cached = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + cached + written;
  const output = usage.output_tokens ?? 0;
  const seconds = result.duration_ms / 1000;
  return {
    text: `${formatDuration(result.duration_ms, true)} · ${formatTokens(input)} in · ${formatTokens(output)} out`,
    title: [
      `Input: ${input.toLocaleString()} tokens (${cached.toLocaleString()} read from cache, ${written.toLocaleString()} written to cache)`,
      `Output: ${output.toLocaleString()} tokens`,
      `Steps: ${result.num_turns}`,
      `Time: ${seconds.toFixed(1)} s (${(result.duration_api_ms / 1000).toFixed(1)} s waiting for the model)`,
      'Main agent only; subagents not counted.',
    ].join('\n'),
  };
}
