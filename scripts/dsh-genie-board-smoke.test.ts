import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOOT_SETTLE_MS,
  GENIE_ROUTES,
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

  // Every row bundle is checked, not just the first: a build that wrote the
  // manager and two sub-rows but truncated the client half is still a
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

/**
 * V1: disabling the manager row by id used to abort the whole DSH boot, because
 * the sub-rows declared a hard `inject` on the manager's service. Phase
 * three of the smoke is the end-to-end proof, so it must stay wired up — and it
 * must probe EVERY route the suite can own, or a new route could quietly
 * survive a disabled manager.
 */
test('the smoke has a manager-disabled phase that probes every route the plugin registers', () => {
  const source = readFileSync(join(import.meta.dir, 'dsh-genie-board-smoke.ts'), 'utf8');
  const patch = source.indexOf('`${workspaceRow}- id: genie-dsh-board\\n  disabled: true\\n`');
  expect(patch).toBeGreaterThan(-1);
  expect(source).toContain("await assertManagerDisabled(await start('fixture-manager-disabled.patch.yml')");
  // A printed URL is not a boot: `dsh web` prints one before the tree audit.
  expect(source).toContain('await Bun.sleep(BOOT_SETTLE_MS)');
  expect(BOOT_SETTLE_MS).toBeGreaterThanOrEqual(5000);

  const rows = ['index', 'board', 'workflows'];
  const registered = new Set<string>();
  for (const row of rows) {
    const row_source = readFileSync(join(import.meta.dir, `../plugins/dsh-genie-board/src/${row}.ts`), 'utf8');
    for (const [, path] of row_source.matchAll(/'\/api\/genie-board\/([^']*)'/g)) registered.add(path);
  }
  expect(registered.size).toBeGreaterThan(0);
  const probed = new Set(GENIE_ROUTES.map((route) => route.split('?')[0]));
  expect([...registered].filter((path) => !probed.has(path))).toEqual([]);
});

/**
 * Phase two disables a row by its id, so its target has to be a row the shipped
 * patch still inserts — a retirement that removed the target would leave the
 * phase asserting a 404 the patch never caused. The retirement itself is pinned
 * here too: the skills row is gone from the patch, the bundle list and the
 * probed routes, not moved behind a flag.
 */
test('the disable-by-id phase targets a shipped row, and the retired skills row is gone from every half', () => {
  const patch = readFileSync(join(import.meta.dir, '../plugins/dsh-genie-board/cordis.patch.yml'), 'utf8');
  expect(patch).toContain('- id: genie-dsh-board-workflows');
  // The patch may name the retired row in prose; it must not insert it.
  const inserted = patch.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  expect(inserted.some((line) => line.includes('genie-dsh-board-skills'))).toBe(false);
  expect(inserted.some((line) => line.includes('@automagik/genie-dsh-board/skills'))).toBe(false);
  const source = readFileSync(join(import.meta.dir, 'dsh-genie-board-smoke.ts'), 'utf8');
  expect(source).toContain('`${workspaceRow}- id: genie-dsh-board-workflows\\n  disabled: true\\n`');
  expect(PLUGIN_BUNDLES).not.toContain('skills.js');
  expect(GENIE_ROUTES.some((route) => route.startsWith('skills'))).toBe(false);
  // ... nor from the package's own halves: the subpath export, the client
  // panel registration and the row module itself.
  const board = join(import.meta.dir, '../plugins/dsh-genie-board');
  const exports = JSON.parse(readFileSync(join(board, 'package.json'), 'utf8')).exports as Record<string, string>;
  expect(exports['./skills']).toBeUndefined();
  const client = readFileSync(join(board, 'src/client/index.ts'), 'utf8');
  expect(client).not.toContain('genie-skills');
  expect(client).not.toContain('SkillsPanel');
  expect(existsSync(join(board, 'src/skills.ts'))).toBe(false);
});
