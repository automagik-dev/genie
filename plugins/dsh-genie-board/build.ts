import { resolve } from 'node:path';
import { build } from 'esbuild';
import sourcePackage from '../../package.json';
const [version = sourcePackage.version, output = 'dist', ...extra] = process.argv.slice(2);
if (extra.length || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(version)) throw new Error('invalid build version');
const outdir = resolve(output);
/** One host bundle per cordis row: the manager plus its two sub-rows. */
export const HOST_ROWS = ['index', 'board', 'workflows'] as const;
for (const row of HOST_ROWS) {
  await build({
    entryPoints: [`src/${row}.ts`],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: resolve(outdir, `${row}.js`),
    define: { __GENIE_BUILD_VERSION__: JSON.stringify(version) },
  });
}
await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  // Resolved from DSH's frozen browser module table (PLATFORM_MODULES) via the injected require.
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
  ],
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "@automagik/genie-dsh-board", factory: (require) => { const module = { exports: {} }; const exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  target: 'es2022',
  outfile: resolve(outdir, 'client.js'),
});
