import esbuild from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const prod = process.argv[2] === 'production';
const entry = process.argv[3] ?? 'src/main.ts';
const outfile = process.argv[4] ?? 'main.js';

// The Agent SDK ships as an ES module for Node. Two patches let it run inside
// Obsidian's renderer once bundled to CommonJS:
// - `import.meta.url` does not exist in CommonJS; it becomes a file URL set in the banner.
// - Electron renderer timers are browser timers with no `.unref()`; the calls become optional.
const patchAgentSdk = {
  name: 'patch-agent-sdk',
  setup(build) {
    build.onLoad({ filter: /claude-agent-sdk[\\/]sdk\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const contents = source
        .replaceAll('import.meta.url', '__vcImportMetaUrl')
        .replaceAll('.unref()', '.unref?.()');
      return { contents, loader: 'js' };
    });
  },
};

// The Claude Code version the SDK was released with, for the plugin's version-drift notice.
const sdkPackage = JSON.parse(await readFile('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'));
const define = { __CLAUDE_CODE_TARGET__: JSON.stringify(sdkPackage.claudeCodeVersion ?? '') };

const banner = [
  'var __vcImportMetaUrl = require("url").pathToFileURL(',
  '  typeof __filename === "string" && __filename ? __filename : require("path").join(process.cwd(), "vault-claude.js")',
  ').href;',
  // A script built from the same sources (the smoke test) logs to a file of its own, not to the plugin's log.
  ...(outfile === 'main.js' ? [] : ['process.env.VAULT_CLAUDE_LOG ||= require("path").join(require("os").tmpdir(), "vault-claude-tests.log");']),
].join('\n');

// Set OBSIDIAN_PLUGIN_DIR to a vault's `.obsidian/plugins/vault-claude` to copy each build there.
const pluginDir = process.env.OBSIDIAN_PLUGIN_DIR;
const copyToVault = {
  name: 'copy-to-vault',
  setup(build) {
    build.onEnd(async (result) => {
      if (!pluginDir || result.errors.length > 0 || outfile !== 'main.js') return;
      await mkdir(pluginDir, { recursive: true });
      for (const file of ['main.js', 'manifest.json', 'styles.css']) {
        await copyFile(file, path.join(pluginDir, file));
      }
      console.log(`Copied build to ${pluginDir}`);
    });
  },
};

const context = await esbuild.context({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  banner: { js: banner },
  define,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  plugins: [patchAgentSdk, copyToVault],
  minify: prod,
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  logLevel: 'info',
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
