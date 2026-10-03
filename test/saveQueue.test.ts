import assert from 'node:assert/strict';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';

test('saves never overlap, and those asked for while one waits share it, taking the latest data', async () => {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  let writing = 0;
  let overlapped = false;
  const written: string[] = [];
  p.saveData = async (data: unknown) => {
    writing += 1;
    if (writing > 1) overlapped = true;
    const titles = (data as { chats: { title: string }[] }).chats.map((chat) => chat.title).join(',');
    await new Promise((resolve) => setTimeout(resolve, 5));
    written.push(titles);
    writing -= 1;
  };
  p.chats = [{ id: 'a', title: 'A' }];
  const first = p.saveSettings();
  // Started: asked for in the same moment, saves are one write.
  await new Promise((resolve) => setTimeout(resolve, 1));
  p.chats = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  const second = p.saveSettings();
  p.chats = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }];
  const third = p.saveSettings();
  await Promise.all([first, second, third]);
  assert.equal(overlapped, false);
  // The first as it was; the second, still waiting when the third was asked for, with the third's change.
  assert.deepEqual(written, ['A', 'A,B,C']);
  assert.equal(second, third);
});

test('saves asked for in the same moment are one write of the latest data', async () => {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  const written: number[] = [];
  p.saveData = async (data: unknown) => void written.push((data as { chats: unknown[] }).chats.length);
  p.chats = [{ id: 'a', title: 'A' }];
  const saves = [p.saveSettings()];
  p.chats = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  saves.push(p.saveSettings());
  await Promise.all(saves);
  assert.deepEqual(written, [2]);
});

test('a failed save does not stop the next', async () => {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  let calls = 0;
  p.saveData = async () => {
    calls += 1;
    if (calls === 1) throw new Error('disk full');
  };
  await assert.rejects(p.saveSettings());
  await p.saveSettings();
  assert.equal(calls, 2);
});
