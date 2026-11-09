import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * #3230: this row shipped no code when installed from the repository's git spec — pnpm
 * packs only `files` and `dist/` is not committed. pnpm runs the package's prepare script
 * with its devDependencies installed, so the loader builds itself there, under plain node.
 */
test('a git install builds the loader: prepare runs this build under plain node', async () => {
  const root = import.meta.dir;
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    version: string;
    files: string[];
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  expect(pkg.scripts.build).toBe('bun run build.ts');
  expect(pkg.scripts.prepare).toBe('node build.ts');
  expect(pkg.files).toContain('dist');
  // The one thing the bundle resolves at build time; a bare git checkout has nothing.
  expect(pkg.devDependencies.esbuild).toBeString();
  const output = await mkdtemp(join(tmpdir(), 'genie-prepare-loader-'));
  try {
    const proc = Bun.spawn(['node', 'build.ts', pkg.version, output], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(stderr).not.toContain('error');
    expect(code).toBe(0);
    expect(await readdir(output)).toEqual(['index.js']);
    expect((await stat(join(output, 'index.js'))).size).toBeGreaterThan(1000);
    const module = (await import(join(output, 'index.js'))) as { apply: unknown };
    expect(typeof module.apply).toBe('function');
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 20_000);
