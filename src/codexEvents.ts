// Codex's app-server events (`codex app-server`, JSON-RPC over stdio) turned into the messages the
// panel draws for Claude Code (the Agent SDK's shapes), so that a Codex chat is drawn as a Claude
// chat is: its replies, its commands and file changes as tool calls, and the end of each turn.
// Kept free of `obsidian` imports so the tests can use it.

/** A message as the panel draws it (see SessionHandlers.onMessage); built loosely, as the SDK's types are wider than needed. */
export type DrawnMessage = Record<string, unknown> & { type: string };

/** The token counts of a turn, as Codex reports them (`thread/tokenUsage/updated`, its `last`). */
export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** A Codex thread item, as far as the panel reads it. */
export interface CodexItem {
  type: string;
  id: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  status?: string;
  changes?: { path: string; kind: { type: string }; diff: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | null;
  summary?: string[];
  query?: string;
}

const assistant = (sessionId: string, uuid: string, content: unknown[]): DrawnMessage => ({
  type: 'assistant',
  uuid,
  session_id: sessionId,
  parent_tool_use_id: null,
  message: { role: 'assistant', model: 'codex', content },
});

const toolResult = (sessionId: string, id: string, content: string, isError: boolean, structured?: unknown): DrawnMessage => ({
  type: 'user',
  uuid: `${id}:result`,
  session_id: sessionId,
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  ...(structured === undefined ? {} : { tool_use_result: structured }),
});

/** A hunk of a change, as Claude Code's edit results give it (`structuredPatch`): where it starts, and its lines marked +, - or space. */
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * Codex's diff of one file as hunks the changed-files card draws: a unified diff's `@@` hunks; a
 * diff with none (a file added or deleted whole) as one hunk of its lines, added or removed.
 */
export function diffHunks(diff: string, kind: string): PatchHunk[] {
  const lines = diff.replace(/\n$/, '').split('\n');
  const hunks: PatchHunk[] = [];
  let hunk: PatchHunk | null = null;
  for (const line of lines) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (head) {
      hunk = { oldStart: Number(head[1]), oldLines: Number(head[2] ?? 1), newStart: Number(head[3]), newLines: Number(head[4] ?? 1), lines: [] };
      hunks.push(hunk);
    } else if (hunk && /^[ +-]/.test(line)) {
      // Inside a hunk every line is content, `--- x` and `+++ x` included: the file headers come before the first hunk.
      hunk.lines.push(line);
    } else if (hunk && line === '') {
      hunk.lines.push(' ');
    }
  }
  if (hunks.length > 0 || !diff.trim()) return hunks;
  // No hunks: for a file added or deleted whole, Codex gives its content itself, each line as it is.
  const removed = kind === 'delete';
  return [{ oldStart: removed ? 1 : 0, oldLines: removed ? lines.length : 0, newStart: removed ? 0 : 1, newLines: removed ? 0 : lines.length, lines: lines.map((line) => `${removed ? '-' : '+'}${line}`) }];
}

/** The session's start, as Claude Code's init message gives it: its id and model. */
export function codexInit(sessionId: string, model: string | null, cwd: string): DrawnMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId, model: model ?? 'codex', cwd, tools: [], mcp_servers: [], permissionMode: 'default', slash_commands: [], uuid: `${sessionId}:init` };
}

/**
 * What the panel draws when Codex starts item `item`: a command or a file change as a tool call
 * (drawn running), else nothing until it completes.
 */
export function codexItemStarted(sessionId: string, item: CodexItem, cwd = ''): DrawnMessage[] {
  // A change to several files: a call per file, as Claude makes an edit per file. Its paths made
  // absolute, as Claude's are, for the vault's notes to be told among them.
  if (item.type === 'fileChange') {
    const absolute = (file: string) => (/^([/\\]|[A-Za-z]:)/.test(file) || !cwd ? file : `${cwd.replace(/[/\\]$/, '')}/${file}`);
    const uses = (item.changes ?? []).map((change, i) => ({ type: 'tool_use', id: `${item.id}:${i}`, name: change.kind.type === 'add' ? 'Write' : 'Edit', input: { file_path: absolute(change.path) } }));
    return uses.length > 0 ? [assistant(sessionId, `${item.id}:use`, uses)] : [];
  }
  const use = codexToolUse(item);
  return use ? [assistant(sessionId, `${item.id}:use`, [use])] : [];
}

/** What the panel draws when Codex completes item `item`: a reply's text, thinking, or a tool call's result. */
export function codexItemCompleted(sessionId: string, item: CodexItem): DrawnMessage[] {
  switch (item.type) {
    case 'agentMessage':
      return item.text?.trim() ? [assistant(sessionId, item.id, [{ type: 'text', text: item.text }])] : [];
    case 'reasoning': {
      const thinking = (item.summary ?? []).join('\n\n').trim();
      return thinking ? [assistant(sessionId, item.id, [{ type: 'thinking', thinking, signature: '' }])] : [];
    }
    case 'commandExecution': {
      const output = item.aggregatedOutput ?? '';
      const failed = item.status === 'failed' || item.status === 'declined' || (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0);
      return [toolResult(sessionId, item.id, output || (failed ? `Exit code ${item.exitCode ?? '?'}` : ''), failed)];
    }
    case 'fileChange': {
      // One result per file, each with its hunks, as an edit tool's result carries them.
      const failed = item.status === 'failed' || item.status === 'declined';
      return (item.changes ?? []).map((change, i) => toolResult(sessionId, `${item.id}:${i}`, change.diff, failed, failed ? undefined : { structuredPatch: diffHunks(change.diff, change.kind.type), type: change.kind.type === 'add' ? 'create' : 'update' }));
    }
    case 'mcpToolCall': {
      const failed = item.status === 'failed' || Boolean(item.error);
      const text = item.error?.message ?? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? ''));
      return [toolResult(sessionId, item.id, text, failed)];
    }
    case 'webSearch':
      return [toolResult(sessionId, item.id, '', false)];
    default:
      return [];
  }
}

/** Item `item` as a tool call the panel draws: a command as Bash, an MCP tool by its name, a web search; null for the rest (a file change is drawn per file: see codexItemStarted). */
export function codexToolUse(item: CodexItem): Record<string, unknown> | null {
  switch (item.type) {
    case 'commandExecution':
      return { type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command ?? '' } };
    case 'mcpToolCall':
      return { type: 'tool_use', id: item.id, name: `mcp__${item.server ?? 'codex'}__${item.tool ?? 'tool'}`, input: (item.arguments as Record<string, unknown> | null) ?? {} };
    case 'webSearch':
      return { type: 'tool_use', id: item.id, name: 'WebSearch', input: { query: item.query ?? '' } };
    default:
      return null;
  }
}

/** A turn's end, as Claude Code's result message gives it: success, an error with its text, or stopped. */
export function codexTurnResult(sessionId: string, turn: { status: string; error?: { message?: string } | null; durationMs?: number | null }, usage: CodexUsage | null, sent: string[]): DrawnMessage {
  const failed = turn.status === 'failed';
  const duration = turn.durationMs ?? 0;
  return {
    type: 'result',
    subtype: failed ? 'error_during_execution' : 'success',
    is_error: failed,
    result: failed ? (turn.error?.message ?? 'Codex stopped with an error.') : '',
    // An error result carries its errors, as Claude Code's does.
    ...(failed ? { errors: [turn.error?.message ?? 'Codex stopped with an error.'] } : {}),
    duration_ms: duration,
    duration_api_ms: duration,
    num_turns: 1,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: {
      input_tokens: (usage?.inputTokens ?? 0) - (usage?.cachedInputTokens ?? 0),
      cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
      cache_creation_input_tokens: 0,
      output_tokens: usage?.outputTokens ?? 0,
    },
    user_message_uuids: sent,
    uuid: `${sessionId}:result:${Date.now()}`,
  };
}

/**
 * A saved Codex thread's turns (as `thread/read` gives them) as the panel draws a saved chat: its
 * messages in order, a message of yours as a user message, each item as it is drawn live (see
 * codexItemStarted and codexItemCompleted); with the structured results of its file changes, by
 * call, for the changed-files cards.
 */
export function codexTranscript(sessionId: string, turns: { items?: CodexItem[] }[], cwd = ''): { transcript: DrawnMessage[]; edits: Map<string, unknown> } {
  const transcript: DrawnMessage[] = [];
  const edits = new Map<string, unknown>();
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const content = (item as { content?: { type?: string; text?: string }[] }).content ?? [];
        // The context the panel sent before the message (a project's, included chats': see CodexSession.addContext) is not yours to show.
        const parts = content as { type?: string; text?: string; url?: string }[];
        const text = parts.flatMap((part) => (part.type === 'text' && part.text && !/^\s*<(project_context|linked_chats)>/.test(part.text) ? [part.text] : [])).join('\n\n');
        // Images sent as data URLs, as the chat draws a message's images (see codexInput); others by a note of them.
        const images = parts.flatMap((part): Record<string, unknown>[] => {
          const data = part.type === 'image' && part.url ? /^data:([^;]+);base64,(.*)$/s.exec(part.url) : null;
          return data ? [{ type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } }] : part.type === 'image' || part.type === 'localImage' ? [{ type: 'text', text: '[image]' }] : [];
        });
        if (!text.trim() && images.length === 0) continue;
        const shown = images.length === 0 ? text : [...images, ...(text.trim() ? [{ type: 'text', text }] : [])];
        transcript.push({ type: 'user', uuid: item.id, session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: shown } });
        continue;
      }
      for (const message of [...codexItemStarted(sessionId, item, cwd), ...codexItemCompleted(sessionId, item)]) {
        transcript.push(message);
        const result = (message.message as { content?: { type?: string; tool_use_id?: string }[] } | undefined)?.content?.[0];
        if (message.tool_use_result !== undefined && result?.tool_use_id) edits.set(result.tool_use_id, message.tool_use_result);
      }
    }
  }
  return { transcript, edits };
}
