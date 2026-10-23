// Codex processes as the process list shows them; kept free of `obsidian` imports so the tests can use it.

/** `ps -o etime` (`[[dd-]hh:]mm:ss`) in seconds. */
function elapsedSeconds(etime: string): number {
  const [days, rest] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86_400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * From `ps -axo etime=,command=`: how long the ChatGPT app's Codex app-server and Codex's shared
 * app-server (the daemon) have run, in seconds; null when either is not running.
 */
export function chatGptAndDaemonAges(listing: string): { chatGpt: number; daemon: number } | null {
  let chatGpt: number | null = null;
  let daemon: number | null = null;
  for (const line of listing.split('\n')) {
    const match = /^\s*(\S+)\s+(.*)$/.exec(line);
    if (!match || !/ app-server(\s|$)/.test(match[2])) continue;
    const age = elapsedSeconds(match[1]);
    if (/ChatGPT\.app\//.test(match[2])) chatGpt = Math.max(chatGpt ?? 0, age);
    else if (/app-server-daemon\//.test(match[2]) && /--remote-control|--managed-daemon/.test(match[2])) daemon = Math.max(daemon ?? 0, age);
  }
  return chatGpt === null || daemon === null ? null : { chatGpt, daemon };
}
