// In Obsidian's renderer, `new AbortController()` yields a browser-realm AbortSignal that
// Node's `events.setMaxListeners(n, ...targets)` rejects as "not an EventTarget". The Agent
// SDK calls it on its own AbortController when a query starts, so the query throws before
// Claude Code is spawned. setMaxListeners only raises the MaxListenersExceededWarning
// threshold, so skipping it for such signals is harmless. Same approach as Claudian's
// `electronCompat.ts` (MIT).

type SetMaxListeners = ((...args: unknown[]) => unknown) & { __vaultClaudePatched?: boolean };

function isAbortSignalLike(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const candidate = target as Record<string, unknown>;
  return (
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}

export function patchSetMaxListenersForRenderer(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const events = require('events') as { setMaxListeners: SetMaxListeners };
  const original = events.setMaxListeners;
  if (original.__vaultClaudePatched) return;

  const patched: SetMaxListeners = function (this: unknown, ...args: unknown[]): unknown {
    try {
      return Reflect.apply(original, this, args);
    } catch (error) {
      const targets = args.slice(1);
      if (targets.length > 0 && targets.every(isAbortSignalLike)) return undefined;
      throw error;
    }
  };
  patched.__vaultClaudePatched = true;
  events.setMaxListeners = patched;
}
