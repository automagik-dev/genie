#!/usr/bin/env bun

import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

export interface HookBundleTarget {
  name: string;
  source: string;
  bundle: string;
}

export const HOOK_BUNDLES: readonly HookBundleTarget[] = [
  'validate-wish',
  'validate-completion',
  'session-context',
].map((name) => ({
  name,
  source: join(ROOT, 'plugins', 'genie', 'scripts', 'src', `${name}.ts`),
  bundle: join(ROOT, 'plugins', 'genie', 'scripts', `${name}.cjs`),
}));

export async function renderHookBundle(source: string): Promise<string> {
  const result = await build({
    entryPoints: [source],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    minify: true,
    logLevel: 'silent',
    write: false,
    external: ['bun', 'bun:*'],
    define: {
      __GENIE_VERSION__: '"parity-check"',
    },
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`esbuild produced no hook bundle for ${source}`);
  return `#!/usr/bin/env node\n${output.text.replace(/^#!.*\n/gm, '')}`;
}

export async function assertHookBundleParity(target: HookBundleTarget): Promise<void> {
  const expected = await renderHookBundle(target.source);
  const actual = readFileSync(target.bundle, 'utf8');
  if (actual !== expected) {
    throw new Error(
      `Hook bundle drift: plugins/genie/scripts/${target.name}.cjs does not match its TypeScript source; run \`bun scripts/hook-bundle-parity.ts --write\``,
    );
  }
  const mode = statSync(target.bundle).mode & 0o777;
  if (mode !== 0o755) {
    throw new Error(
      `Hook bundle drift: plugins/genie/scripts/${target.name}.cjs must have mode 755 (found ${mode.toString(8)})`,
    );
  }
}

export async function assertHookBundlesParity(targets = HOOK_BUNDLES): Promise<void> {
  for (const target of targets) await assertHookBundleParity(target);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--check' && args[0] !== '--write')) {
    throw new Error('usage: bun scripts/hook-bundle-parity.ts [--check|--write]');
  }
  if (args[0] === '--write') {
    for (const target of HOOK_BUNDLES) {
      writeFileSync(target.bundle, await renderHookBundle(target.source));
      chmodSync(target.bundle, 0o755);
    }
    console.log(`hook-bundle-parity: wrote ${HOOK_BUNDLES.map((target) => `${target.name}.cjs`).join(', ')}`);
    return;
  }
  await assertHookBundlesParity();
  console.log('hook-bundle-parity: OK');
}

if (import.meta.main) await main();
