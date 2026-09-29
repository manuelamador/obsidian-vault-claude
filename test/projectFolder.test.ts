import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { projectFolder } from '../src/history';

/**
 * A session with one prompt, written where projectFolder says `dir`'s sessions go. Its row carries
 * no `cwd`: the SDK finds a folder by any other name only from that field, so reading it back through
 * the SDK shows the name is the SDK's own.
 */
function sdkReadsBack(config: string, dir: string, folder = projectFolder(dir)): Promise<boolean> {
  const id = '33333333-3333-4333-8333-333333333333';
  mkdirSync(join(config, 'projects', folder), { recursive: true });
  const row = { type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } };
  writeFileSync(join(config, 'projects', folder, `${id}.jsonl`), `${JSON.stringify(row)}\n`);
  return getSessionMessages(id, { dir }).then(
    (messages) => messages.length === 1,
    () => false,
  );
}

function withConfig(run: (config: string, base: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const config = mkdtempSync(join(tmpdir(), 'vc-folder-config-'));
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'vc-folder-vault-')));
    const before = { config: process.env.CLAUDE_CONFIG_DIR, name: process.env.CLAUDE_CODE_PROJECT_DIR_NAME };
    process.env.CLAUDE_CONFIG_DIR = config;
    delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    try {
      await run(config, base);
    } finally {
      for (const [key, value] of [['CLAUDE_CONFIG_DIR', before.config], ['CLAUDE_CODE_PROJECT_DIR_NAME', before.name]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(config, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  };
}

test('a short path: every character but letters and digits as "-"', () => {
  assert.equal(projectFolder('/no/such/Vault name_2'), '-no-such-Vault-name-2');
});

test(
  'a vault reached through a symbolic link is named by its real path, as the SDK names it',
  withConfig(async (config, base) => {
    const vault = join(base, 'Vault');
    mkdirSync(vault);
    const link = join(base, 'Link');
    symlinkSync(vault, link);
    assert.equal(projectFolder(link), projectFolder(vault));
    assert.equal(await sdkReadsBack(config, link), true);
  }),
);

test(
  'a path over 200 characters: cut, and followed by the hash the SDK gives it',
  withConfig(async (config, base) => {
    const vault = join(base, 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'Résumé notes');
    mkdirSync(vault, { recursive: true });
    const folder = projectFolder(vault);
    assert.equal(folder.length > 200, true);
    assert.match(folder, /^.{200}-[0-9a-z]+$/);
    assert.equal(await sdkReadsBack(config, vault), true);
    // A folder with the same start and another hash is not the SDK's.
    const other = `${folder.slice(0, 201)}zzzz`;
    rmSync(join(config, 'projects'), { recursive: true, force: true });
    assert.equal(await sdkReadsBack(config, vault, other), false);
  }),
);

test(
  'CLAUDE_CODE_PROJECT_DIR_NAME names the folder when CLAUDE_CONFIG_DIR is set',
  withConfig(async (config, base) => {
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'my-vault';
    assert.equal(projectFolder(base), 'my-vault');
    assert.equal(await sdkReadsBack(config, base), true);
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'not/a name';
    assert.equal(projectFolder(base), base.replace(/[^a-zA-Z0-9]/g, '-'));
  }),
);
