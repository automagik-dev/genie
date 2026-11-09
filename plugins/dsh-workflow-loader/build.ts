import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
// Read, not imported: a git install runs this file under plain node, which wants an
// import attribute for JSON, and the build must not depend on how it is started.
const sourcePackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const [version = sourcePackage.version, output = 'dist', ...extra] = process.argv.slice(2);
if (extra.length || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(version)) throw new Error('invalid build version');
const outdir = resolve(output);

/**
 * One host bundle, one cordis row. There is no client half: the catalog panel
 * belongs to `plugins/dsh-genie-board`, and this row only adds the run path.
 */
export const HOST_ROWS = ['index'] as const;

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
