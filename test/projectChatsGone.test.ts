import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TFile } from 'obsidian';
import VaultClaudePlugin from '../src/main';

/** A plugin with two project notes whose added chats are `a`, `b` and `outside`, `a` respectively. */
function setup() {
  (globalThis as unknown as { window: unknown }).window ??= globalThis;
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  const files = ['Garden/Garden.md', 'Papers/Papers.md'].map((path) => Object.assign(new TFile(), { path }));
  const fronts: Record<string, Record<string, unknown>> = {
    'Garden/Garden.md': { type: 'project', folder: 'Garden', added: ['a', 'b', 'outside'], updated: '2026-01-01' },
    'Papers/Papers.md': { type: 'project', folder: 'Papers', added: ['a'], updated: '2026-01-01' },
  };
  (p as unknown as { app: unknown }).app = {
    workspace: { getLeavesOfType: () => [] },
    vault: { getMarkdownFiles: () => files, getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null },
    metadataCache: {
      getFileCache: (file: { path: string }) => ({ frontmatter: fronts[file.path] }),
      // Read again at once after a change (see indexed).
      on: (_name: string, callback: (file: unknown) => void) => {
        setTimeout(() => files.forEach(callback), 0);
        return {};
      },
      offref: () => undefined,
    },
    fileManager: { processFrontMatter: async (file: { path: string }, change: (front: Record<string, unknown>) => void) => change(fronts[file.path]) },
  };
  p.chats = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ];
  return { p, fronts };
}

test('a deleted chat leaves every project note it was added to', async () => {
  const { p, fronts } = setup();
  await p.dropFromProjects((id) => id === 'a');
  assert.deepEqual(fronts['Garden/Garden.md'].added, ['b', 'outside']);
  assert.deepEqual(fronts['Papers/Papers.md'].added, []);
  assert.notEqual(fronts['Papers/Papers.md'].updated, '2026-01-01');
});
