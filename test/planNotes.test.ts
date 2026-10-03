import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TFile } from 'obsidian';
import VaultClaudePlugin from '../src/main';

/** A plugin over a vault of `notes` (path → text), recording what goes to the trash. */
function setup(notes: Record<string, string>) {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  p.vaultRoot = () => null;
  const trashed: string[] = [];
  (p as unknown as { app: unknown }).app = {
    workspace: { getLeavesOfType: () => [] },
    vault: {
      getAbstractFileByPath: (path: string) => (path in notes ? Object.assign(new TFile(), { path }) : null),
      read: async (file: { path: string }) => notes[file.path],
    },
    fileManager: {
      trashFile: async (file: { path: string }) => {
        trashed.push(file.path);
        delete notes[file.path];
      },
    },
  };
  return { p, trashed };
}

test('at startup, a plan note left as Claude wrote it goes; one with edits stays; a record without its note is dropped', async () => {
  const { p, trashed } = setup({ 'Plans/Same.md': 'Plan A\n', 'Plans/Edited.md': 'Plan B, edited' });
  p.planNotes = {
    a: { path: 'Plans/Same.md', plan: 'Plan A' },
    b: { path: 'Plans/Edited.md', plan: 'Plan B' },
    c: { path: 'Plans/Gone.md', plan: 'Plan C' },
  };
  await p.tidyPlanNotes();
  assert.deepEqual(trashed, ['Plans/Same.md']);
  assert.deepEqual(p.planNotes, { b: { path: 'Plans/Edited.md', plan: 'Plan B' } });
});

test("a chat's plan note goes with the chat", async () => {
  const { p, trashed } = setup({ 'Plans/Kept.md': 'edited' });
  p.chats = [{ id: 'a', title: 'A' }];
  p.planNotes = { a: { path: 'Plans/Kept.md', plan: 'Plan' } };
  (p as unknown as { forgetChatData(id: string): void }).forgetChatData('a');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(trashed, ['Plans/Kept.md']);
  assert.deepEqual(p.planNotes, {});
});

test('a plan note that moves is followed; one deleted is forgotten', () => {
  const { p } = setup({});
  p.planNotes = { a: { path: 'Plans/A.md', plan: 'x' }, b: { path: 'Plans/B.md', plan: 'y' } };
  p.noteMoved('Plans/A.md', 'Plans/Renamed.md');
  p.noteMoved('Plans/B.md', null);
  assert.deepEqual(p.planNotes, { a: { path: 'Plans/Renamed.md', plan: 'x' } });
});
