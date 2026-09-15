import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLUGIN_BUNDLES,
  type Runner,
  buildPluginDist,
  sandboxDirectories,
  sandboxEnvironment,
} from './dsh-genie-board-smoke';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-build-'));
  roots.push(root);
  const dist = join(root, 'plugins/dsh-genie-board/dist');
  mkdirSync(dist, { recursive: true });
  // A bundle from an earlier build, exactly what the smoke used to run against.
  for (const name of PLUGIN_BUNDLES) writeFileSync(join(dist, name), 'stale bundle');
  return { root, dist };
}

function runner(behaviour: (dist: string) => void): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (binary, args, cwd) => {
    calls.push([binary, ...args, cwd ?? '']);
    behaviour(join(cwd ?? '', 'plugins/dsh-genie-board/dist'));
    return '';
  };
  return { run, calls };
}

test('the smoke builds the plugin bundles it is about to install', async () => {
  const r = repo();
  const { run, calls } = runner((dist) => {
    mkdirSync(dist, { recursive: true });
    for (const name of PLUGIN_BUNDLES) writeFileSync(join(dist, name), 'fresh bundle');
  });
  const built = await buildPluginDist(r.root, run);
  expect(calls).toEqual([['bun', 'run', 'build:plugin', r.root]]);
  expect(built).toEqual(PLUGIN_BUNDLES.map((name) => join(r.dist, name)));
  for (const path of built) expect(readFileSync(path, 'utf8')).toBe('fresh bundle');
});

test('a failing plugin build fails the smoke loudly and leaves no stale bundle behind', async () => {
  const r = repo();
  const { run, calls } = runner(() => {
    throw new Error('esbuild: Transform failed');
  });
  await expect(buildPluginDist(r.root, run)).rejects.toThrow('plugin build failed');
  await expect(buildPluginDist(r.root, run)).rejects.toThrow('esbuild: Transform failed');
  expect(calls).toHaveLength(2);
  // The previous build's output must not survive to be smoked by a later run.
  for (const name of PLUGIN_BUNDLES) expect(existsSync(join(r.dist, name))).toBe(false);
});

test('a build that exits zero without producing a bundle still fails', async () => {
  const r = repo();
  const missing = runner(() => {});
  await expect(buildPluginDist(r.root, missing.run)).rejects.toThrow('plugin build produced no index.js');

  const empty = runner((dist) => {
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), 'bundle');
    writeFileSync(join(dist, 'client.js'), '');
  });
  await expect(buildPluginDist(r.root, empty.run)).rejects.toThrow('plugin build produced no client.js');
});

test('the smoke builds before it installs the plugin, and build:plugin builds that plugin', () => {
  const source = readFileSync(join(import.meta.dir, 'dsh-genie-board-smoke.ts'), 'utf8');
  const build = source.indexOf('await buildPluginDist(root, command)');
  const install = source.indexOf("'add', `link:");
  expect(build).toBeGreaterThan(-1);
  expect(install).toBeGreaterThan(-1);
  expect(build).toBeLessThan(install);

  const scripts = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')).scripts;
  expect(scripts['build:plugin']).toContain('plugins/dsh-genie-board');
});

/**
 * r2 c5: the smoke removed its own tree and its plugin registration, but `dsh`
 * spilled a `dsh-spill-*` directory into the host's TMPDIR, outside everything
 * the smoke owned. Children now get a TMPDIR inside the run's own tree.
 */
test('every child of the smoke writes inside the run tree, temp files included', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-smoke-sandbox-'));
  roots.push(temporary);
  const env = sandboxEnvironment(temporary, { PATH: '/usr/bin', TMPDIR: tmpdir() });
  for (const key of ['DSH_HOME', 'GENIE_HOME', 'HOME', 'TMPDIR', 'TMP', 'TEMP']) {
    expect(env[key].startsWith(`${temporary}/`)).toBe(true);
  }
  expect(env.TMPDIR).not.toBe(tmpdir());
  expect(env.PATH).toBe(`${join(temporary, 'bin')}:/usr/bin`);
  // The sandbox TMPDIR must exist before a child spills into it.
  expect(sandboxDirectories(temporary)).toContain(env.TMPDIR);
});

test('a spilling child leaves nothing behind once the run tree is removed', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-smoke-sandbox-'));
  roots.push(temporary);
  const env = sandboxEnvironment(temporary, process.env);
  for (const directory of sandboxDirectories(temporary)) mkdirSync(directory, { recursive: true });
  // Exactly what the dsh CLI does with TMPDIR while the smoke drives it.
  const spill = Bun.spawnSync(['sh', '-c', 'mkdir "$TMPDIR/dsh-spill-smoketest"'], { env, stdout: 'pipe' });
  expect(spill.exitCode).toBe(0);
  expect(existsSync(join(env.TMPDIR, 'dsh-spill-smoketest'))).toBe(true);
  rmSync(temporary, { recursive: true, force: true });
  expect(readdirSync(tmpdir()).filter((name) => name === 'dsh-spill-smoketest')).toEqual([]);
});

test('the smoke sandboxes its children rather than building an env inline', () => {
  const source = readFileSync(join(import.meta.dir, 'dsh-genie-board-smoke.ts'), 'utf8');
  expect(source).toContain('const env = sandboxEnvironment(temporary)');
  expect(source).toContain('for (const directory of sandboxDirectories(temporary))');
});
