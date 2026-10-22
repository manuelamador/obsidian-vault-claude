import { promises as fs } from 'fs';
import * as path from 'path';

/** Claude Code's default for `cleanupPeriodDays`, when its user settings name none. */
export const CLEANUP_DEFAULT_DAYS = 30;
/** The value offered: a hundred years, chats kept for good in practice. */
export const KEEP_DAYS = 36500;

/** `cleanupPeriodDays` in Claude Code's user settings: `null` when unset (the default applies). */
export type Retention = { days: number | null } | { error: string };

/** The file Claude Code reads it from, the one every project's cleanup follows. */
export function userSettingsFile(configDir: string): string {
  return path.join(configDir, 'settings.json');
}

/** The settings object in `text`; an error when it is not a JSON object (an empty file is an empty object). */
function parseSettings(text: string): { settings: Record<string, unknown> } | { error: string } {
  if (!text.trim()) return { settings: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { settings: parsed as Record<string, unknown> };
    return { error: 'it does not hold a JSON object' };
  } catch {
    return { error: 'it is not valid JSON' };
  }
}

/** `cleanupPeriodDays` as `file` sets it; a missing file sets nothing. */
export async function readRetention(file: string): Promise<Retention> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { days: null };
    return { error: 'it could not be read' };
  }
  const parsed = parseSettings(text);
  if ('error' in parsed) return parsed;
  const days = parsed.settings.cleanupPeriodDays;
  return { days: typeof days === 'number' && Number.isFinite(days) ? days : null };
}

/**
 * Sets `cleanupPeriodDays` in `file` to `days`, every other key left as it is, with the file's own
 * indentation; written to a temporary file and moved into place, so that Claude Code never reads half
 * of it. A file that is not a JSON object is not written: an error says why.
 */
export async function writeRetention(link: string, days: number): Promise<{ error: string } | null> {
  // A settings file kept elsewhere and linked here stays linked: the file it points to is written.
  const file = await fs.realpath(link).catch(() => link);
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { error: 'it could not be read' };
  }
  const parsed = parseSettings(text);
  if ('error' in parsed) return parsed;
  const indent = /^\{\s*\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const written = `${file}.vault-claude-${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(written, `${JSON.stringify({ ...parsed.settings, cleanupPeriodDays: days }, null, indent)}\n`);
    await fs.rename(written, file);
    return null;
  } catch {
    await fs.rm(written, { force: true }).catch(() => undefined);
    return { error: 'it could not be written' };
  }
}

/** `days` in words: whole years as years. */
export function daysText(days: number): string {
  if (days >= 365 && days % 365 === 0) return `${days / 365} ${days === 365 ? 'year' : 'years'}`;
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** How long Claude Code keeps chats, in words: `retention`'s days, or the default's. */
export function retentionText(retention: Retention): string {
  if ('error' in retention) return 'unknown';
  if (retention.days === null) return `${CLEANUP_DEFAULT_DAYS} days (Claude Code's default; cleanupPeriodDays is not set)`;
  return daysText(retention.days);
}
