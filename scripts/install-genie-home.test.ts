/**
 * install.sh — GENIE_HOME bootstrap (dogfood r2 §3.3 #1, m14 residue).
 *
 * `GENIE_HOME="$H/nested/.genie" bash install.sh` died at the lifecycle-lease
 * guard with `GENIE_HOME parent does not exist; refusing to mutate before
 * lifecycle lease acquisition` — a refusal that named no remedy and appeared
 * nowhere else in the repo. install.sh now creates the whole chain itself, at
 * 0700, before the lease; the guard survives only as a fail-closed backstop for
 * callers that source the script and skip that step.
 *
 * Shell-level, bats-free: install.sh is sourced with GENIE_INSTALL_SOURCE_ONLY=1
 * (main suppressed) and its functions are called directly, so nothing here
 * touches the network.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INSTALL_SH = join(import.meta.dir, '..', 'install.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mkroot(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-install-home-'));
  roots.push(root);
  return root;
}

/** Source install.sh (main suppressed) and run `script` against it. */
function sourced(genieHome: string, home: string, script: string) {
  const res = Bun.spawnSync(['bash', '-c', `source "$1"; ${script}`, 'bash', INSTALL_SH], {
    env: {
      PATH: process.env.PATH ?? '',
      GENIE_INSTALL_SOURCE_ONLY: '1',
      GENIE_HOME: genieHome,
      HOME: home,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

describe('install.sh creates a relocated GENIE_HOME itself', () => {
  test('a home whose parents do not exist is created at 0700 and the lease is taken', () => {
    const root = mkroot();
    const genieHome = join(root, 'nested', 'deep', '.genie');

    const run = sourced(genieHome, root, 'ensure_genie_home_root; acquire_lifecycle_lock; release_lifecycle_lock');

    expect(run.stderr).not.toContain('parent does not exist');
    expect(run.code).toBe(0);
    expect(statSync(genieHome).isDirectory()).toBe(true);
    expect(statSync(genieHome).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'nested')).mode & 0o777).toBe(0o700);
  });

  test('it is idempotent and never re-modes a home that already exists', () => {
    const root = mkroot();
    const genieHome = join(root, '.genie');
    const first = sourced(genieHome, root, 'ensure_genie_home_root');
    expect(first.code).toBe(0);
    Bun.spawnSync(['chmod', '755', genieHome]);

    const second = sourced(genieHome, root, 'ensure_genie_home_root');

    expect(second.code).toBe(0);
    expect(statSync(genieHome).mode & 0o777).toBe(0o755);
  });

  test('a GENIE_HOME that exists as a file is refused with a remedy, not created over', () => {
    const root = mkroot();
    const genieHome = join(root, '.genie');
    writeFileSync(genieHome, 'not a directory\n');

    const run = sourced(genieHome, root, 'ensure_genie_home_root');

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('exists and is not a directory');
    expect(run.stderr).toContain('move it aside');
    expect(existsSync(genieHome)).toBe(true);
    expect(statSync(genieHome).isFile()).toBe(true);
  });

  test('main materializes the home before it acquires the lifecycle lease', () => {
    const source = readFileSync(INSTALL_SH, 'utf-8');
    const body = /^main\(\) \{$([\s\S]*?)^\}$/m.exec(source)?.[1] ?? '';
    expect(body).toContain('ensure_genie_home_root');
    expect(body.indexOf('ensure_genie_home_root')).toBeLessThan(body.indexOf('acquire_lifecycle_lock'));
  });
});
