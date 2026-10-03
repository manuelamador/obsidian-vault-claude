// Bundles each test/*.test.ts with esbuild (the modules import each other without extensions, which
// Node cannot resolve on its own) and runs them with Node's built-in test runner. `obsidian` is
// aliased to the same stub as the panel test, for modules that import it next to pure helpers, and
// the Agent SDK gets the plugin build's patch, for tests of modules that import it.
import esbuild from 'esbuild';
import { patchAgentSdk } from './patch-agent-sdk.mjs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const sdkPackage = JSON.parse(await readFile('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'));
const entries = (await readdir('test')).filter((name) => name.endsWith('.test.ts')).map((name) => `test/${name}`);

await rm('test/out', { recursive: true, force: true });
await esbuild.build({
  define: { __CLAUDE_CODE_TARGET__: JSON.stringify(sdkPackage.claudeCodeVersion ?? '') },
  entryPoints: entries,
  outdir: 'test/out',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  alias: { obsidian: './scripts/obsidian-stub.ts' },
  external: ['jsdom', 'electron'],
  banner: { js: 'var __vcImportMetaUrl = require("url").pathToFileURL(__filename).href;' },
  plugins: [patchAgentSdk],
  logLevel: 'warning',
});

const files = entries.map((entry) => entry.replace(/^test\//, 'test/out/').replace(/\.ts$/, '.cjs'));
// A hung test fails after ten seconds instead of stalling the run.
// The tests log to a file of their own, not to the plugin's log (see LOG_PATH).
const env = { ...process.env, VAULT_CLAUDE_LOG: join(tmpdir(), 'vault-claude-tests.log') };
const run = spawnSync(process.execPath, ['--test', '--test-timeout=10000', ...files], { stdio: 'inherit', env });
process.exit(run.status ?? 1);
