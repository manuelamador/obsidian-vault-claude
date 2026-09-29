import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/** The platform's folder for application logs. */
function logDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'vault-claude');
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'vault-claude');
}

/**
 * Diagnostic log outside the vault. Records lifecycle events and errors, never message text. The
 * tests set VAULT_CLAUDE_LOG to a file of their own, so their runs stay out of the log Obsidian's is.
 */
export const LOG_PATH = process.env.VAULT_CLAUDE_LOG || join(logDir(), 'vault-claude.log');

/** Past this size the log is moved to `vault-claude.log.1` (replacing the previous one). */
const MAX_BYTES = 1_000_000;

let queue: string[] = [];
let flushing = false;

function format(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part instanceof Error) return `${part.name}: ${part.message}\n${part.stack ?? ''}`;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

// Writes are queued and flushed asynchronously, in order, so logging never blocks Obsidian's UI.
async function flush(): Promise<void> {
  flushing = true;
  try {
    await fs.mkdir(dirname(LOG_PATH), { recursive: true });
    while (queue.length > 0) {
      const chunk = queue.join('');
      queue = [];
      try {
        const { size } = await fs.stat(LOG_PATH);
        if (size > MAX_BYTES) await fs.rename(LOG_PATH, `${LOG_PATH}.1`);
      } catch {
        // No log file yet.
      }
      await fs.appendFile(LOG_PATH, chunk);
    }
  } catch {
    // Logging must never break the chat.
  } finally {
    flushing = false;
  }
}

export function log(...parts: unknown[]): void {
  queue.push(`${new Date().toISOString()} ${parts.map(format).join(' ')}\n`);
  if (!flushing) void flush();
}

/** An error's message, for a notice or a status line. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
