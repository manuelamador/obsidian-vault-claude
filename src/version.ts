// Kept free of `obsidian` imports so the headless tests can use it.

/** Set at build time from the Agent SDK's package.json (`claudeCodeVersion`). */
declare const __CLAUDE_CODE_TARGET__: string | undefined;

/** The Claude Code version the bundled Agent SDK was released with. */
export const CLAUDE_CODE_TARGET = typeof __CLAUDE_CODE_TARGET__ === 'string' ? __CLAUDE_CODE_TARGET__ : '';

/** Patch releases apart before the difference is reported; Claude Code ships several a week. */
const MAX_PATCH_DRIFT = 20;

/**
 * A notice when the installed Claude Code is far from the version the SDK was released with
 * (another major or minor version, or more than MAX_PATCH_DRIFT patch releases); null otherwise.
 */
export function versionDrift(running: string, target: string): string | null {
  const parse = (version: string) => version.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;
  const a = parse(running);
  const b = parse(target);
  if (!a || !b) return null;
  if (a[0] === b[0] && a[1] === b[1] && Math.abs(a[2] - b[2]) <= MAX_PATCH_DRIFT) return null;
  const newer = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  return newer
    ? `Claude Code ${running} is well ahead of the version this plugin was built for (${target}). If something misbehaves, update the plugin.`
    : `Claude Code ${running} is older than this plugin expects (${target}). If something misbehaves, update it by running "claude update" in a terminal.`;
}
