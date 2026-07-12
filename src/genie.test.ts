import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// CLI registration contract — spawn the real entrypoint, exactly as a user
// invokes it, and assert commander actually registered the surface. These
// `--sync-only` remains an explicit update/convergence compatibility surface.
// Lifecycle hooks never invoke it; keeping the option registered prevents old
// explicit automation from being reinterpreted as a full update.
// ============================================================================

describe('genie CLI registration', () => {
  let fxHome: string;

  beforeEach(() => {
    fxHome = mkdtempSync(join(tmpdir(), 'genie-cli-reg-'));
  });

  afterEach(() => {
    rmSync(fxHome, { recursive: true, force: true });
  });

  test('update --help registers the explicit --sync-only compatibility surface', () => {
    const repoRoot = import.meta.dir;
    const proc = Bun.spawnSync([process.execPath, join(repoRoot, 'genie.ts'), 'update', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: fxHome, GENIE_HOME: join(fxHome, '.genie') },
    });

    expect(proc.exitCode).toBe(0);
    const stdout = proc.stdout.toString();
    expect(stdout).toContain('--sync-only');
    expect(stdout).toContain('GENIE_UPDATE_SYNC_ONLY=1'); // help text names the env contract
    expect(stdout).not.toContain('--post-delivery-converge');
  });

  test('hidden post-delivery mode converges locally without entering channel/network delivery', () => {
    const repoRoot = import.meta.dir;
    const genieHome = join(fxHome, '.genie');
    const binary = join(genieHome, 'bin', 'genie');
    mkdirSync(join(genieHome, 'bin'), { recursive: true });
    writeFileSync(binary, '#!/bin/sh\nprintf "genie 5.260711.7\\n"\n');
    chmodSync(binary, 0o755);
    writeFileSync(
      join(genieHome, '.integration-consent.json'),
      `${JSON.stringify({ schemaVersion: 3, selection: 'none', state: 'committed', revision: 1 })}\n`,
    );

    const proc = Bun.spawnSync([process.execPath, join(repoRoot, 'genie.ts'), 'update', '--post-delivery-converge'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: fxHome, GENIE_HOME: genieHome, GENIE_UPDATE_SYNC_ONLY: '' },
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).not.toContain('Channel:');
    expect(proc.stdout.toString()).not.toContain('Downloading signed tarball');
  });

  test('init --help discloses every project MCP file it may reconcile', () => {
    const repoRoot = import.meta.dir;
    const proc = Bun.spawnSync([process.execPath, join(repoRoot, 'genie.ts'), 'init', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: fxHome, GENIE_HOME: join(fxHome, '.genie') },
    });

    expect(proc.exitCode).toBe(0);
    const stdout = proc.stdout.toString();
    for (const path of ['.mcp.json', '.warp/.mcp.json', '.codex/config.toml']) expect(stdout).toContain(path);
  });

  test('update rejects an unknown flag with a nonzero exit (pre-contract binaries error, not update)', () => {
    // The B1 guard relies on old commander builds erroring out on unknown
    // flags — verify the CURRENT binary keeps that behavior too.
    const repoRoot = import.meta.dir;
    const proc = Bun.spawnSync(
      [process.execPath, join(repoRoot, 'genie.ts'), 'update', '--definitely-not-a-real-flag'],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: fxHome, GENIE_HOME: join(fxHome, '.genie') },
      },
    );

    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain('--definitely-not-a-real-flag');
  });

  test('conflicting update modes return one user-facing parser error without a stack trace', () => {
    const repoRoot = import.meta.dir;
    const proc = Bun.spawnSync([process.execPath, join(repoRoot, 'genie.ts'), 'update', '--rollback', '--sync-only'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: fxHome, GENIE_HOME: join(fxHome, '.genie') },
    });

    expect(proc.exitCode).toBe(1);
    const stderr = proc.stderr.toString();
    expect(stderr).toContain("option '--rollback' cannot be used with option '--sync-only'");
    expect(stderr).not.toContain('src/genie-commands/update.ts');
    expect(stderr).not.toContain('Bun v');
    expect(stderr).not.toContain(' at ');
  });

  test('hidden post-delivery mode rejects delivery and compatibility flags before action', () => {
    const repoRoot = import.meta.dir;
    for (const conflicting of ['--sync-only', '--stable']) {
      const proc = Bun.spawnSync(
        [process.execPath, join(repoRoot, 'genie.ts'), 'update', '--post-delivery-converge', conflicting],
        {
          cwd: repoRoot,
          env: { ...process.env, HOME: fxHome, GENIE_HOME: join(fxHome, '.genie') },
        },
      );
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("option '--post-delivery-converge' cannot be used with option");
      expect(proc.stdout.toString()).not.toContain('Channel:');
    }
  });
});
