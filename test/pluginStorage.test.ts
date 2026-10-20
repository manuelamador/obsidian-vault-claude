import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { FileSystemAdapter } from 'obsidian';
import VaultClaudePlugin from '../src/main';

/** A plugin whose data files are in a folder on disk, as in a vault. */
function pluginIn(root: string): VaultClaudePlugin {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  const adapter = Object.assign(Object.create(FileSystemAdapter.prototype), { getBasePath: () => root });
  Object.assign(p, { app: { vault: { adapter } }, manifest: { dir: 'plugin', version: '1.0.0' } });
  return p;
}

test("the chats' and notes' data moves from data.json to chats.json, and each is copied once a day", async () => {
  const root = mkdtempSync(`${tmpdir()}/vc-storage-`);
  const dir = `${root}/plugin`;
  mkdirSync(dir);
  try {
    // As 0.36.0 left them: the records in chats.json, the rest in data.json.
    writeFileSync(`${dir}/chats.json`, JSON.stringify({ chats: [{ id: 'a', title: 'A' }], deletedCodex: ['gone'] }));
    writeFileSync(`${dir}/data.json`, JSON.stringify({ settings: { panelMargin: 33 }, pinned: ['a'], chatSummaries: { a: { text: 'sum', at: 1 } }, models: [] }));
    const p = pluginIn(root);
    await p.loadSettings();
    assert.equal(p.settings.panelMargin, 33);
    assert.deepEqual(p.pinned, ['a']);
    assert.deepEqual(p.chats.map((chat) => chat.id), ['a']);
    await p.saveSettings();
    const records = JSON.parse(readFileSync(`${dir}/chats.json`, 'utf8'));
    const data = JSON.parse(readFileSync(`${dir}/data.json`, 'utf8'));
    assert.deepEqual(records.pinned, ['a']);
    assert.deepEqual(records.chatSummaries, { a: { text: 'sum', at: 1 } });
    assert.deepEqual(records.deletedCodex, ['gone']);
    assert.equal('pinned' in data, false);
    assert.equal('chats' in data, false);
    assert.equal(data.settings.panelMargin, 33);
    // Read back from the new layout.
    const again = pluginIn(root);
    await again.loadSettings();
    assert.deepEqual(again.pinned, ['a']);
    assert.equal(again.chatSummaries.a?.text, 'sum');
    const backups = readdirSync(`${dir}/backups`).sort();
    assert.equal(backups.length, 2);
    assert.match(backups[0], /^chats-\d{4}-\d{2}-\d{2}\.json$/);
    assert.match(backups[1], /^data-\d{4}-\d{2}-\d{2}\.json$/);
    // An old copy past the seven kept is removed at the next day's copy.
    for (let day = 1; day <= 8; day += 1) writeFileSync(`${dir}/backups/chats-2020-01-0${day}.json`, '{}');
    rmSync(`${dir}/backups/${backups[0]}`);
    await again.saveSettings();
    const chatsCopies = readdirSync(`${dir}/backups`).filter((name) => name.startsWith('chats-'));
    assert.equal(chatsCopies.length, 7);
    assert.equal(existsSync(`${dir}/backups/chats-2020-01-01.json`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
