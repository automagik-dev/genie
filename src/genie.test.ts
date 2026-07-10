import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// CLI registration contract — spawn the real entrypoint, exactly as a user
// invokes it, and assert commander actually registered the surface. These
// tests exist because the hook delegation re-entry contract
// (GENIE_UPDATE_SYNC_ONLY=1 → `genie update --sync-only`) depends on the
// .option() call in src/genie.ts: if someone removes it, every SessionStart
// delegation degrades into a full unattended update (the B1 failure mode).
// ============================================================================

describe('genie CLI registration', () => {
  let fxHome: string;

  beforeEach(() => {
    fxHome = mkdtempSync(join(tmpdir(), 'genie-cli-reg-'));
  });

  afterEach(() => {
    rmSync(fxHome, { recursive: true, force: true });
  });

  test('update --help registers --sync-only (hook delegation re-entry contract)', () => {
    const repoRoot = import.meta.dir;
    const proc = Bun.spawnSync([process.execPath, join(repoRoot, 'genie.ts'), 'update', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: fxHome, GENIE_HOME: join(fxHome, '.genie') },
    });

    expect(proc.exitCode).toBe(0);
    const stdout = proc.stdout.toString();
    expect(stdout).toContain('--sync-only');
    expect(stdout).toContain('GENIE_UPDATE_SYNC_ONLY=1'); // help text names the env contract
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
});
