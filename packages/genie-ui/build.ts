// build.ts — the BUILD step. Run under **bun** (`bun run build.ts`): bun is a fine
// bundler. The RUNTIME is **node** (`node dist/index.js`): bun's `node-pty` never
// delivers `onData` (verified 38k-vs-0-byte btop isolation — see README "Runtime
// split"), so the PTY-host server must run under node. This is the "bun builds,
// node runs" seam in one file.
//
// Two bundles, both into `packages/genie-ui/dist/`:
//   - client/main.ts -> dist/main.js  (target browser; @xterm inlined from node_modules)
//   - server/index.ts -> dist/index.js (target node; node-pty/ws/@xterm kept external
//     so node resolves the native addon + CJS packages from node_modules at runtime)

import { resolve } from 'node:path';

const ROOT = import.meta.dirname;
const OUT = resolve(ROOT, 'dist');

// node-pty is a native addon and @xterm/headless + @xterm/addon-serialize are loaded
// via createRequire at runtime; keep them (and ws) external so node loads them itself.
const SERVER_EXTERNAL = ['node-pty', 'ws', '@xterm/headless', '@xterm/addon-serialize', '@xterm/xterm'];

async function build(name: string, entry: string, target: 'browser' | 'node', external: string[] = []): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(ROOT, entry)],
    target,
    outdir: OUT,
    minify: false,
    external,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `${name} build failed`);
  }
  const bytes = (await result.outputs[0].arrayBuffer()).byteLength;
  console.log(
    `[genie-ui build] ${name.padEnd(6)} ${entry} -> dist/${result.outputs[0].path.split('/').pop()} (${bytes} bytes)`,
  );
}

await build('client', 'client/main.ts', 'browser');
await build('server', 'server/index.ts', 'node', SERVER_EXTERNAL);
console.log('[genie-ui build] done — run: node packages/genie-ui/dist/index.js');
