import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';
import { projectFolder } from '../src/history';

test("a chat cut short no longer lists the notes only its removed part changed; other notes keep it", async () => {
  const { TFile } = await import('obsidian');
  const config = mkdtempSync(join(tmpdir(), 'vc-relink-config-'));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), 'vc-relink-vault-')));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const folder = join(config, 'projects', projectFolder(vault));
    mkdirSync(folder, { recursive: true });
    const id = '66666666-6666-4666-8666-666666666666';
    const at = new Date().toISOString();
    const rows = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, cwd: vault, timestamp: at, message: { role: 'user', content: 'which note?' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: id, cwd: vault, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'See [[Kept]].' }] } },
    ];
    writeFileSync(join(folder, `${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const plugin = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
    plugin.saveSettings = async () => undefined;
    plugin.vaultRoot = () => vault;
    const note = (path: string) => Object.assign(new TFile(), { path, extension: 'md' });
    (plugin as unknown as { app: unknown }).app = {
      metadataCache: { getFirstLinkpathDest: (link: string) => (link === 'Kept' ? note('Kept.md') : null) },
      vault: { getAbstractFileByPath: () => null },
      workspace: { getLeavesOfType: () => [] },
    };
    const indexes = plugin as unknown as { noteChats: Record<string, string[]>; noteMentions: Record<string, string[]> };
    indexes.noteChats = { 'Gone.md': ['other', id], 'Untouched.md': [id] };
    indexes.noteMentions = { 'Kept.md': [id] };
    const dropped = await plugin.unlinkRemovedEdits(id, ['Gone.md']);
    assert.deepEqual(dropped, ['Gone.md']);
    // Only the edit the removed part made goes; nothing else is touched.
    assert.deepEqual(indexes.noteChats, { 'Gone.md': ['other'], 'Untouched.md': [id] });
    assert.deepEqual(indexes.noteMentions, { 'Kept.md': [id] });
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(config, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});
