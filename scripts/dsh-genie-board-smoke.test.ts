import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  BOOT_SETTLE_MS,
  GENIE_ROUTES,
  PLUGIN_BUNDLES,
  type Runner,
  buildPluginDist,
  dshVersion,
  resolveDshBinary,
  sandboxDirectories,
  sandboxEnvironment,
  withPinnedDsh,
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
  expect(source).toContain('const env = sandboxEnvironment(temporary, withPinnedDsh(dsh))');
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

/**
 * A compatibility claim is only as good as the Host it was proven on, so the
 * smoke boots the binary `DSH_BIN` names when one is set, and says which one.
 */
describe('the Host the smoke boots', () => {
  test('is dsh on PATH unless DSH_BIN names another', () => {
    expect(resolveDshBinary({})).toBe('dsh');
    expect(resolveDshBinary({ DSH_BIN: '   ' })).toBe('dsh');
    expect(resolveDshBinary({ DSH_BIN: '/opt/dsh-0.2/node_modules/.bin/dsh' })).toBe(
      '/opt/dsh-0.2/node_modules/.bin/dsh',
    );
    // A relative path is pinned to where the operator ran the smoke, not to a
    // child's cwd.
    expect(resolveDshBinary({ DSH_BIN: 'pinned/node_modules/.bin/dsh' })).toBe(
      join(process.cwd(), 'pinned/node_modules/.bin/dsh'),
    );
  });

  test('puts a pinned binary first on the children PATH, and leaves PATH alone otherwise', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/someone' };
    expect(withPinnedDsh('dsh', base)).toBe(base);
    const pinned = withPinnedDsh('/opt/dsh/node_modules/.bin/dsh', base);
    expect(pinned.PATH).toBe(`/opt/dsh/node_modules/.bin${delimiter}/usr/bin`);
    expect(pinned.HOME).toBe('/home/someone');
    // The sandbox bin still wins, so a stub can stand in for anything.
    const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-pin-'));
    roots.push(root);
    expect(sandboxEnvironment(root, pinned).PATH).toBe(
      `${join(root, 'bin')}${delimiter}/opt/dsh/node_modules/.bin${delimiter}/usr/bin`,
    );
  });

  test('reports the version it will boot, and refuses a binary that does not run', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-version-'));
    roots.push(root);
    const fake = join(root, 'dsh');
    writeFileSync(fake, '#!/bin/sh\necho 0.2.0-rc.1\n', { mode: 0o755 });
    expect(dshVersion(fake, 'README.md')).toBe('0.2.0-rc.1');
    expect(() => dshVersion(join(root, 'missing'), 'README.md')).toThrow(/DSH_BIN=.*missing does not run/);
    const broken = join(root, 'broken');
    writeFileSync(broken, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    expect(() => dshVersion(broken, 'README.md')).toThrow(/does not run.*README\.md/);
  });

  test('prints the resolved version before it builds anything', () => {
    const source = readFileSync(join(import.meta.dir, 'dsh-genie-board-smoke.ts'), 'utf8');
    const printed = source.indexOf('console.log(`dsh: ${dsh} (version ${version})`)');
    expect(printed).toBeGreaterThan(-1);
    expect(printed).toBeLessThan(source.indexOf('await buildPluginDist(root, command)'));
    // Every Host invocation goes through the resolved binary.
    expect(source).not.toMatch(/(?:spawn|command)\(\s*'dsh'/);
  });
});

/**
 * The range both DSH plugins declare, where DSH's manifest contract puts it —
 * top-level `engines.dsh` (`@deepseek-ai/dsh-package-manifest`
 * `DshEnginesManifest`; `package.json.dsh` has no `engines`) — and the READMEs
 * that say what proved it. No DSH installer or loader enforces the range yet,
 * so these files are the only place the claim lives.
 */
test('both DSH plugins declare the proven range as engines.dsh, and their READMEs say so', () => {
  const range = '>=0.1.2-rc.1 <0.3.0-0';
  // Default semver: the release versions of both proven lines match, the next
  // minor does not. The proven prereleases match only with prereleases included,
  // which is what the READMEs tell a reader.
  expect(Bun.semver.satisfies('0.1.7', range)).toBe(true);
  expect(Bun.semver.satisfies('0.2.0', range)).toBe(true);
  expect(Bun.semver.satisfies('0.3.0', range)).toBe(false);
  for (const plugin of ['dsh-genie-board', 'dsh-workflow-loader']) {
    const dir = join(import.meta.dir, '../plugins', plugin);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(manifest.engines.dsh).toBe(range);
    expect(manifest.dsh.engines).toBeUndefined();
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain(`\`${range}\``);
    expect(readme).toContain('top-level `engines.dsh`');
    expect(readme).toContain('`includePrerelease`');
    expect(readme).toContain('`0.1.7-rc.2` and\n`0.2.0-rc.1`');
    expect(readme).toContain('README.md:93');
    expect(readme).not.toContain('No DSH version reads');
    expect(readme).toContain('@deepseek-ai/dsh@0.2.0-rc.1');
    expect(readme).toContain('DSH_BIN=');
    expect(readme).toContain('npm install --prefix');
  }
});
