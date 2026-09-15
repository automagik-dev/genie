import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_BUNDLES, type Runner, buildPluginDist } from './dsh-genie-board-smoke';

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

  // Every row bundle is checked, not just the first: a build that wrote the
  // manager and three sub-rows but truncated the client half is still a
  // stale-dist smoke waiting to happen.
  const empty = runner((dist) => {
    mkdirSync(dist, { recursive: true });
    for (const name of PLUGIN_BUNDLES) writeFileSync(join(dist, name), name === 'client.js' ? '' : 'bundle');
  });
  await expect(buildPluginDist(r.root, empty.run)).rejects.toThrow('plugin build produced no client.js');

  const partial = runner((dist) => {
    mkdirSync(dist, { recursive: true });
    for (const name of PLUGIN_BUNDLES) if (name !== 'workflows.js') writeFileSync(join(dist, name), 'bundle');
  });
  await expect(buildPluginDist(r.root, partial.run)).rejects.toThrow('plugin build produced no workflows.js');
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
