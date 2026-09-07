import { resolve } from 'node:path';
import { build } from 'esbuild';
import sourcePackage from '../../package.json';
const [version = sourcePackage.version, output = 'dist', ...extra] = process.argv.slice(2);
if (extra.length || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(version)) throw new Error('invalid build version');
const outdir = resolve(output);
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: resolve(outdir, 'index.js'),
  define: { __GENIE_BUILD_VERSION__: JSON.stringify(version) },
});
await build({
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "@automagik/genie-dsh-board", factory: (require) => { const module = { exports: {} }; const exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  target: 'es2022',
  outfile: resolve(outdir, 'client.js'),
});
