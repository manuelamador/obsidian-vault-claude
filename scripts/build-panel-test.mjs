// Bundles scripts/panel-test.ts with `obsidian` replaced by scripts/obsidian-stub.ts and the
// same Agent SDK patches as the plugin build, then runs it.
import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const patchAgentSdk = {
  name: 'patch-agent-sdk',
  setup(build) {
    build.onLoad({ filter: /claude-agent-sdk[\\/]sdk\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      return { contents: source.replaceAll('import.meta.url', '__vcImportMetaUrl').replaceAll('.unref()', '.unref?.()'), loader: 'js' };
    });
  },
};

const sdkPackage = JSON.parse(await readFile('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'));

await esbuild.build({
  define: { __CLAUDE_CODE_TARGET__: JSON.stringify(sdkPackage.claudeCodeVersion ?? '') },
  entryPoints: ['scripts/panel-test.ts'],
  outfile: 'scripts/panel-test.cjs',
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
// The test logs to a file of its own, not to the plugin's log (see LOG_PATH).
const env = { ...process.env, VAULT_CLAUDE_LOG: join(tmpdir(), 'vault-claude-tests.log') };
execFileSync(process.execPath, ['scripts/panel-test.cjs'], { stdio: 'inherit', env });
