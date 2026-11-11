import { afterAll, expect, test } from 'bun:test';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #3275: a git install builds each DSH plugin with its `prepare` script, under whatever
 * `node` the host has. The plugins claim a Node floor in `engines.node`, so this file runs
 * the REAL prepare — the `scripts.prepare` string, through `sh -c`, the way an installer
 * runs a lifecycle script — under exactly that floor, and never under the runner's own node.
 *
 * The floor binary is `GENIE_NODE_FLOOR_BIN` when set (it must report exactly the floor
 * version), otherwise the official tarball, fetched once into the temp dir and checked
 * against the checksum pinned below on every use. A floor that cannot be resolved FAILS
 * these tests: a skip would read as "the claim holds" on a host that never ran it.
 *
 * Because that fallback is a download, this file is excluded from the default `bun test`
 * (bunfig.toml), which stays network-free. Run it with `bun run test:node-floor`; CI runs
 * it in its own `node-floor` job, on a Node 22.12.0 that setup-node installed.
 */
const NODE_FLOOR = '22.12.0';

/** sha256 of `node-v22.12.0-<platform>-<arch>.tar.gz`, from nodejs.org/dist/v22.12.0/SHASUMS256.txt. */
const NODE_FLOOR_SHA256: Record<string, string> = {
  'darwin-arm64': '293dcc6c2408da21562d135b0412525e381bb6fe150d688edb58fe850d0f3e13',
  'darwin-x64': '52bc25dd026db7247c3c00439afdb83e95087248267f02d6c1a7250d1f896173',
  'linux-arm64': '9e7905fdee722f9650a03ae644b51c4c6effd3b98ac93c588700072ab35c9ddb',
  'linux-x64': 'e05a4d65232ae2b27b3d77da2e368522fb46b923335b8e0d5f77624c32484044',
};

const REPO = resolve(import.meta.dir, '..');

/** Each plugin and the complete `dist/` its prepare has to leave behind. */
const PLUGINS = [
  { dir: 'dsh-genie-board', bundles: ['board.js', 'client.js', 'index.js', 'workflows.js'] },
  { dir: 'dsh-workflow-loader', bundles: ['index.js'] },
] as const;

async function run(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(argv, { ...options, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function sha256Of(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex');
}

/**
 * The verified floor tarball, always a file inside this run's private scratch directory:
 * a copy of the temp-dir cache when that copy's checksum holds, else a fresh download.
 */
async function floorTarball(scratch: string): Promise<string> {
  const target = `${process.platform}-${process.arch}`;
  const pinned = NODE_FLOOR_SHA256[target];
  if (!pinned) throw new Error(`no pinned Node v${NODE_FLOOR} build for ${target}`);
  const name = `node-v${NODE_FLOOR}-${target}.tar.gz`;
  const cache = join(tmpdir(), 'genie-node-floor');
  const cached = join(cache, name);
  const fresh = join(scratch, name);
  // The cache sits in a temp dir other users can write to, so it is never hashed or
  // extracted in place: another user could swap the file between the check and the use.
  // It is copied into the private scratch first, and only that copy is hashed and used.
  const copied = await copyFile(cached, fresh).then(
    () => true,
    () => false,
  );
  if (copied && (await sha256Of(fresh)) === pinned) return fresh;
  const response = await fetch(`https://nodejs.org/dist/v${NODE_FLOOR}/${name}`, {
    signal: AbortSignal.timeout(150_000),
  });
  if (!response.ok) throw new Error(`nodejs.org answered ${response.status} for ${name}`);
  await Bun.write(fresh, response);
  const actual = await sha256Of(fresh);
  if (actual !== pinned) throw new Error(`${name} has sha256 ${actual}, pinned ${pinned}`);
  const staged = join(cache, `${name}.${process.pid}`);
  try {
    await mkdir(cache, { recursive: true });
    await cp(fresh, staged);
    await rename(staged, cached);
  } catch {
    // A cache that cannot be written costs the next run a download, nothing else.
    await rm(staged, { force: true });
  }
  return fresh;
}

/** A directory holding exactly one `node`: the floor version, proven by running it. */
async function provisionFloorNode(scratch: string): Promise<string> {
  const bin = join(scratch, 'bin');
  await mkdir(bin);
  const override = process.env.GENIE_NODE_FLOOR_BIN;
  if (override) {
    await symlink(resolve(override), join(bin, 'node'));
  } else {
    const tarball = await floorTarball(scratch);
    const member = `${tarball.slice(tarball.lastIndexOf('/') + 1, -'.tar.gz'.length)}/bin/node`;
    const untar = await run(['tar', '-xzf', tarball, '-C', scratch, '--strip-components=1', member]);
    if (untar.code !== 0) throw new Error(`tar could not extract ${member}: ${untar.stderr}`);
  }
  const { stdout } = await run([join(bin, 'node'), '--version']).catch(() => ({ stdout: '' }));
  if (stdout.trim() !== `v${NODE_FLOOR}`) {
    throw new Error(`${override ?? 'the downloaded node'} reports "${stdout.trim()}", not v${NODE_FLOOR}`);
  }
  return bin;
}

let scratch: Promise<string> | undefined;
let floor: Promise<string> | undefined;

/** Resolved once for the file. A failure rejects every test that asks: never a skip. */
function floorNodeBin(): Promise<string> {
  scratch ??= mkdtemp(join(tmpdir(), 'genie-prepare-floor-'));
  floor ??= scratch.then(provisionFloorNode).catch((cause) => {
    throw new Error(
      `Node v${NODE_FLOOR} could not be resolved, so the plugins' engines.node claim was NOT tested. Point GENIE_NODE_FLOOR_BIN at a v${NODE_FLOOR} node binary, or allow the download from nodejs.org. Cause: ${cause instanceof Error ? cause.message : cause}`,
    );
  });
  return floor;
}

afterAll(async () => {
  if (scratch) await rm(await scratch, { recursive: true, force: true });
});

for (const plugin of PLUGINS) {
  test(`${plugin.dir}: the git-install prepare builds dist/ under Node ${NODE_FLOOR}`, async () => {
    const bin = await floorNodeBin();
    // A stand-in for the installer's clone: the plugin's own files at their place in the
    // repository, the two root files its build reads (package.json for the version, the
    // tsconfig.json its own one extends), and the checkout's installed dependencies where
    // a git install puts the package's devDependencies.
    const clone = await mkdtemp(join(await (scratch as Promise<string>), 'clone-'));
    const root = join(clone, 'plugins', plugin.dir);
    for (const file of ['package.json', 'tsconfig.json']) await cp(join(REPO, file), join(clone, file));
    await symlink(join(REPO, 'node_modules'), join(clone, 'node_modules'), 'dir');
    await cp(join(REPO, 'plugins', plugin.dir), root, {
      recursive: true,
      filter: (source) => !/[\\/](dist|node_modules|\.test-tmp)$/.test(source),
    });
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts: { prepare: string };
    };
    // The floor node first, then only the system directories `sh` needs: the prepare may
    // lean on nothing a host with just Node lacks.
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    expect((await run(['/bin/sh', '-c', 'node --version'], { cwd: root, env })).stdout.trim()).toBe(`v${NODE_FLOOR}`);

    const prepare = await run(['/bin/sh', '-c', pkg.scripts.prepare], { cwd: root, env });

    expect({ script: pkg.scripts.prepare, code: prepare.code, stderr: prepare.stderr }).toEqual({
      script: pkg.scripts.prepare,
      code: 0,
      stderr: '',
    });
    const dist = join(root, 'dist');
    expect((await readdir(dist)).sort()).toEqual([...plugin.bundles]);
    for (const bundle of plugin.bundles) expect((await stat(join(dist, bundle))).size).toBeGreaterThan(1000);
    const host = (await import(join(dist, 'index.js'))) as { apply: unknown };
    expect(typeof host.apply).toBe('function');
  }, 240_000);
}

test('both plugins claim exactly the Node floor their prepare is run under, and their READMEs say so', async () => {
  for (const plugin of PLUGINS) {
    const dir = join(REPO, 'plugins', plugin.dir);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      engines: Record<string, string>;
    };
    expect(pkg.engines.node).toBe(`>=${NODE_FLOOR}`);
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('`engines.node`');
    expect(readme).toContain(`\`>=${NODE_FLOOR}\``);
  }
});
