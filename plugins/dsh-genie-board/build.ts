import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
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
  outfile: 'dist/client.js',
});
