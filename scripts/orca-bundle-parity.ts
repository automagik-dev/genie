#!/usr/bin/env bun

/**
 * Source-parity gate for the shipped native Orca plugin bundle.
 *
 * `plugins/genie/orca-entrypoint.min.js` is the file the Orca host executes
 * (`plugins/genie/orca-plugin.json` → `main`). It ships inside every signed
 * tarball, yet it sits outside tsc, biome, knip and the hook-bundle gate, so a
 * commit that edits only the blob would pass `bun run check`, get attested,
 * and reach every operator. Provenance proves origin, not correspondence to
 * reviewed source. This script binds the committed bundle byte-for-byte to
 * `plugins/genie/orca-entrypoint.ts`, exactly like `hook-bundle-parity.ts`
 * does for the generated hook executables.
 *
 * esbuild (a pinned devDependency) renders the bundle so the bytes do not
 * depend on the Bun version of whoever last ran `--write`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

export interface OrcaBundleTarget {
  name: string;
  source: string;
  bundle: string;
}

export const ORCA_BUNDLE: OrcaBundleTarget = {
  name: 'orca-entrypoint',
  source: join(ROOT, 'plugins', 'genie', 'orca-entrypoint.ts'),
  bundle: join(ROOT, 'plugins', 'genie', 'orca-entrypoint.min.js'),
};

export async function renderOrcaBundle(source: string): Promise<string> {
  const result = await build({
    entryPoints: [source],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    minify: true,
    logLevel: 'silent',
    write: false,
    external: ['bun', 'bun:*'],
    define: {
      __GENIE_VERSION__: '"parity-check"',
    },
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`esbuild produced no Orca bundle for ${source}`);
  return output.text;
}

export async function assertOrcaBundleParity(target: OrcaBundleTarget = ORCA_BUNDLE): Promise<void> {
  const expected = await renderOrcaBundle(target.source);
  const actual = readFileSync(target.bundle, 'utf8');
  if (actual !== expected) {
    throw new Error(
      `Orca bundle drift: plugins/genie/${target.name}.min.js does not match its TypeScript source; run \`bun scripts/orca-bundle-parity.ts --write\``,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--check' && args[0] !== '--write')) {
    throw new Error('usage: bun scripts/orca-bundle-parity.ts [--check|--write]');
  }
  if (args[0] === '--write') {
    writeFileSync(ORCA_BUNDLE.bundle, await renderOrcaBundle(ORCA_BUNDLE.source));
    console.log(`orca-bundle-parity: wrote ${ORCA_BUNDLE.name}.min.js`);
    return;
  }
  await assertOrcaBundleParity();
  console.log('orca-bundle-parity: OK');
}

if (import.meta.main) await main();
