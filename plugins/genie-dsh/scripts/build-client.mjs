// Builds client.js, the browser half, from src/client.
//
//   node scripts/build-client.mjs           writes it
//   node scripts/build-client.mjs --check   exits 1 when it differs from a fresh build
//
// client.js is committed, so git installs need no build step. DSH loads it as a classic
// script that hands a factory to its module loader; `require` resolves the shell-seeded
// platform modules (react, react-dom) and the Bot team's client bundle, which this package
// names in dsh.client.external, so they stay external.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
const OUTPUT = join(PLUGIN, 'client.js');
export const PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom'];
export const EXTERNAL_BUNDLES = MANIFEST.dsh.client.external;

export async function bundleClient() {
  const result = await build({
    absWorkingDir: PLUGIN,
    entryPoints: ['src/client/index.js'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: [...PLATFORM_MODULES, ...EXTERNAL_BUNDLES],
    treeShaking: false,
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  });
  if (result.warnings.length > 0)
    throw new Error(`esbuild warnings:\n${result.warnings.map((w) => w.text).join('\n')}`);
  return [
    '// Generated from src/client by `npm run build` (scripts/build-client.mjs). Do not edit by hand.',
    'window.__ModuleLoader__.load({',
    `  id: '${MANIFEST.name}',`,
    '  factory: (require) => {',
    'const module = { exports: {} }',
    result.outputFiles[0].text.trimEnd(),
    "return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })",
    '  },',
    '})',
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = await bundleClient();
  if (process.argv.includes('--check')) {
    let current = null;
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {
      /* missing counts as stale */
    }
    if (current !== next) {
      process.stderr.write('client.js is stale: run `npm run build` in plugins/genie-dsh and commit the result\n');
      process.exit(1);
    }
  } else {
    writeFileSync(OUTPUT, next);
  }
}
