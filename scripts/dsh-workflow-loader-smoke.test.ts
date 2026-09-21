import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVATION_FAILURES,
  BOOT_SETTLE_MS,
  PACKAGE_NAME,
  PLUGIN_BUNDLES,
  ROW_ID,
  activationFailure,
  buildLoaderDist,
  sandboxDirectories,
  sandboxEnvironment,
} from './dsh-workflow-loader-smoke';

const roots: string[] = [];

/**
 * A writable scratch root. `os.tmpdir()` is the convention and works in CI; a
 * sandbox that mounts its temp area read-only falls back to one beside the
 * script, which `afterEach` removes.
 */
function temporary(): string {
  let root: string;
  try {
    root = mkdtempSync(join(tmpdir(), 'loader-smoke-test-'));
  } catch {
    const base = join(import.meta.dir, '.loader-smoke-tmp');
    mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, 'run-'));
  }
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the loader smoke', () => {
  test('isolates every writable location a child may touch', () => {
    const root = temporary();
    const env = sandboxEnvironment(root, { PATH: '/usr/bin', HOME: '/home/someone' } as NodeJS.ProcessEnv);
    expect(env.DSH_HOME).toBe(join(root, 'dsh'));
    expect(env.GENIE_HOME).toBe(join(root, 'genie-home'));
    expect(env.HOME).toBe(join(root, 'home'));
    expect(env.TMPDIR).toBe(join(root, 'tmp'));
    expect(env.TMP).toBe(join(root, 'tmp'));
    expect(env.TEMP).toBe(join(root, 'tmp'));
    // A child must not resolve anything out of the operator's home, and the
    // sandbox's own bin has to come first so a stub can stand in for `dsh`.
    expect(env.HOME).not.toBe('/home/someone');
    expect(env.PATH.startsWith(join(root, 'bin'))).toBe(true);
  });

  test('promises the directories it hands to a child', () => {
    const root = temporary();
    expect(sandboxDirectories(root)).toEqual([
      join(root, 'repo'),
      join(root, 'bin'),
      join(root, 'home'),
      join(root, 'tmp'),
    ]);
  });

  test('refuses to smoke a stale dist when the build produces nothing', async () => {
    const root = temporary();
    const dist = join(root, 'plugins/dsh-workflow-loader/dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), '// a bundle from some earlier build\n');
    await expect(buildLoaderDist(root, async () => '')).rejects.toThrow(/produced no index\.js/);
    // The stale bundle is gone before the failing build, so the next run cannot
    // pass against it either.
    expect(await Bun.file(join(dist, 'index.js')).exists()).toBe(false);
  });

  test('reports a failed build as a refusal, not as a stale success', async () => {
    const root = temporary();
    await expect(
      buildLoaderDist(root, async () => {
        throw new Error('esbuild: boom');
      }),
    ).rejects.toThrow(/refusing to smoke a stale dist: esbuild: boom/);
  });

  test('accepts the bundle the build actually produces', async () => {
    const root = temporary();
    const built = await buildLoaderDist(root, async (_binary, _args, cwd) => {
      mkdirSync(join(cwd!, 'dist'), { recursive: true });
      writeFileSync(join(cwd!, 'dist/index.js'), 'export const name = "genie-dsh-workflow-loader";\n');
      return '';
    });
    expect(built).toEqual([join(root, 'plugins/dsh-workflow-loader/dist/index.js')]);
    expect(PLUGIN_BUNDLES).toEqual(['index.js']);
  });

  test('names the boot-audit failures the wait exists for', () => {
    expect(ACTIVATION_FAILURES).toEqual(['did not activate', 'waiting for service']);
    expect(BOOT_SETTLE_MS).toBeGreaterThanOrEqual(10_000);
    expect(ROW_ID).toBe('genie-dsh-workflow-loader');
    expect(PACKAGE_NAME).toBe('@automagik/genie-dsh-workflow-loader');
  });

  test('finds an activation failure in a Host transcript', () => {
    const transcript = [
      'dsh: composing profile web',
      '3 entries did not activate',
      '  loader: pending (waiting for service: tools)',
    ].join('\n');
    expect(activationFailure(transcript)).toBe('3 entries did not activate');
    expect(activationFailure('dsh: listening on http://127.0.0.1:9/')).toBeUndefined();
  });
});
