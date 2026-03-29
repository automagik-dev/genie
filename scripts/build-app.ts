#!/usr/bin/env bun

/**
 * Build script for genie-app sidecar backend.
 *
 * Bundles packages/genie-app/src-backend/index.ts into a single
 * executable file at dist/app/genie-sidecar.js. This is the binary
 * that Tauri spawns as a sidecar process.
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const rootDir = join(import.meta.dir, '..');
const outDir = join(rootDir, 'dist', 'app');
const entryPoint = join(rootDir, 'packages', 'genie-app', 'src-backend', 'index.ts');

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

console.log('[build-app] Bundling sidecar backend...');

const result = await Bun.build({
  entrypoints: [entryPoint],
  outdir: outDir,
  target: 'bun',
  minify: {
    syntax: true,
    whitespace: true,
  },
  external: ['bun', 'bun:*', 'pgserve'],
  naming: 'genie-sidecar.js',
});

if (!result.success) {
  console.error('[build-app] Build failed:');
  for (const msg of result.logs) {
    console.error(`  ${msg}`);
  }
  process.exit(1);
}

// Make executable
const outFile = join(outDir, 'genie-sidecar.js');
chmodSync(outFile, 0o755);

const { size } = Bun.file(outFile);
console.log(`[build-app] dist/app/genie-sidecar.js (${(size / 1024).toFixed(1)} KB)`);
console.log('[build-app] Done');
