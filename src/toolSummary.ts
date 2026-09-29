import * as nodePath from 'path';

/**
 * Vault-relative path, with `/` as Obsidian writes it, of an absolute path inside the vault;
 * undefined for anything else. `paths` is the path module to use (the smoke test passes `win32`).
 */
export function vaultRelative(file: string | undefined, vaultRoot: string, paths: typeof nodePath = nodePath): string | undefined {
  if (!file || !vaultRoot || !paths.isAbsolute(file)) return undefined;
  const relative = paths.relative(vaultRoot, file);
  if (!relative || relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return undefined;
  return relative.split(paths.sep).join('/');
}

export interface ToolSummary {
  /** One-line description shown next to the tool name. */
  text: string;
  /** Vault-relative path when the tool touches a file inside the vault. */
  vaultPath?: string;
}

export function toolLabel(name: string): string {
  if (name.startsWith('mcp__')) return name.split('__').slice(1).join(': ');
  return name;
}

function oneLine(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function summarizeTool(name: string, input: Record<string, unknown>, vaultRoot: string): ToolSummary {
  const str = (key: string): string | undefined => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
  const inVault = (p: string | undefined): string | undefined => vaultRelative(p, vaultRoot);

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = str('file_path') ?? str('notebook_path') ?? '';
      const vaultPath = inVault(file);
      return { text: vaultPath ?? file, vaultPath };
    }
    case 'Bash':
      return { text: oneLine(str('command') ?? '') };
    case 'Grep': {
      const where = str('path');
      return { text: oneLine(`${str('pattern') ?? ''}${where ? ` in ${inVault(where) ?? where}` : ''}`) };
    }
    case 'Glob':
      return { text: oneLine(str('pattern') ?? '') };
    case 'WebFetch':
      return { text: oneLine(str('url') ?? '') };
    case 'WebSearch':
      return { text: oneLine(str('query') ?? '') };
    case 'Task':
    case 'Agent':
      return { text: oneLine(str('description') ?? '') };
    case 'TodoWrite':
      return { text: 'update task list' };
    case 'TaskCreate':
      return { text: oneLine(str('subject') ?? '') };
    case 'TaskUpdate': {
      const status = str('status');
      return { text: oneLine(`#${str('taskId') ?? '?'}${status ? ` → ${status.replace('_', ' ')}` : ''}`) };
    }
    case 'Skill':
      return { text: oneLine(str('skill') ?? str('command') ?? '') };
    case 'ExitPlanMode':
      return { text: 'present plan' };
    default: {
      const first = Object.values(input).find((value): value is string => typeof value === 'string');
      return { text: first ? oneLine(first) : '' };
    }
  }
}
