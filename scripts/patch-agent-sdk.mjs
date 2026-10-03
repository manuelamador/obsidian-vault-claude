// The Agent SDK ships as an ES module for Node. Two patches let it run inside Obsidian's renderer
// once bundled to CommonJS, for the plugin and for the tests alike:
// - `import.meta.url` does not exist in CommonJS; it becomes a file URL the bundle's banner sets.
// - Electron renderer timers are browser timers with no `.unref()`; the calls become optional.
import { readFile } from 'node:fs/promises';

export const patchAgentSdk = {
  name: 'patch-agent-sdk',
  setup(build) {
    build.onLoad({ filter: /claude-agent-sdk[\\/]sdk\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const contents = source.replaceAll('import.meta.url', '__vcImportMetaUrl').replaceAll('.unref()', '.unref?.()');
      return { contents, loader: 'js' };
    });
  },
};
