/**
 * Tests for the `genie install` post-install finisher.
 *
 * The v4 cleanup engine is covered by legacy-v4.test.ts and the agent-sync
 * engine by agent-sync.test.ts; here we only prove the command wiring: v4
 * cleanup is gated by --skip-v4-cleanup, while the layout-normalize and
 * agent-sync steps always run. Every seam is injected — calling the real
 * cleanup/normalize/sync from a test would target the actual home directory.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireLifecycleLease, lifecycleLockPath } from '../lib/agent-sync.js';
import { VERSION } from '../lib/version.js';
import { convergeAuxiliaryTree } from './auxiliary-trees.js';
import {
  type InstallOptions,
  normalizeAuxLayout,
  runInstallAgentSync,
  installCommand as runInstallCommand,
} from './install.js';
import type { cleanupV4 } from './legacy-v4.js';

function makeCleanupSpy(): { runner: typeof cleanupV4; calls: () => number } {
  let count = 0;
  const runner: typeof cleanupV4 = () => {
    count += 1;
    return {
      report: { rulesFile: { path: '/fixture', status: 'absent' }, cacheDirs: [], hasRelics: false },
      homeResidue: [],
      actions: [],
      backupDir: null,
      logFile: null,
      noOp: true,
    };
  };
  return { runner, calls: () => count };
}

const noopLease = () => ({ path: '/tmp/test-lifecycle.lock', release: () => undefined });
const noopCodexLease = () =>
  ({
    ok: true,
    operationId: '0'.repeat(32),
    kind: 'install-converge',
    assertOperation: () => undefined,
    release: () => undefined,
  }) as const;
const noopConsent = () => undefined;
const noopDeliveryRepair = async () => ({ action: 'proceed-current' as const });
const currentCodexTarget = () => ({ installedVersion: VERSION });

/** Keep every command-wiring test isolated from the operator's real install marker. */
function installCommand(...args: Parameters<typeof runInstallCommand>): ReturnType<typeof runInstallCommand> {
  args[10] ??= () => undefined;
  return runInstallCommand(...args);
}

describe('standalone install.sh lifecycle lease', () => {
  let root: string;
  let home: string;
  let genieHome: string;
  const installer = join(import.meta.dir, '..', '..', 'install.sh');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genie-install-shell-'));
    home = join(root, 'home');
    genieHome = join(home, '.genie');
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function shell(script: string) {
    const deterministicProcessProbe = `ps() { [[ "$1" == "-p" && "$2" == "$GENIE_TEST_LIVE_PID" ]]; }; ${script}`;
    return spawnSync('bash', ['-c', deterministicProcessProbe, 'bash', installer], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        GENIE_HOME: genieHome,
        GENIE_INSTALL_SOURCE_ONLY: '1',
        GENIE_TEST_LIVE_PID: String(process.pid),
      },
    });
  }

  test('logical path normalization is nounset-safe before the first array element', () => {
    const result = shell(`
      source "$1"
      logical_absolute_path '/tmp/genie'
      logical_absolute_path '/../tmp/..'
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('/tmp/genie\n/\n');
    expect(result.stderr).not.toContain('unbound variable');
    expect(readFileSync(installer, 'utf8')).not.toContain('${#normalized_parts[@]}');
  });

  test('acquires before an absent GENIE_HOME and owns continuously through final verification', () => {
    const result = shell(`
      source "$1"
      need() { :; }
      detect_platform() { printf 'darwin-arm64\\n'; }
      resolve_channel() { printf 'stable\\n'; }
      fetch_latest() { printf '{}\\n'; }
      manifest_get() {
        if [[ "$2" == 'version' ]]; then printf '5.9.0\\n'; else printf '/fixture\\n'; fi
      }
      assert_lease() {
        test -f "$LIFECYCLE_LOCK"
        test "$(sed -n '1p' "$LIFECYCLE_LOCK")" = "$LIFECYCLE_OWNER_RECORD"
      }
      download_and_verify() {
        assert_lease
        test ! -e "$GENIE_HOME"
        printf '%s/payload.tar.gz\\n' "$TMP_DIR"
      }
      extract_and_link() {
        assert_lease
        mkdir -p "$GENIE_HOME/bin" "$LOCAL_BIN"
        printf '#!/usr/bin/env bash\\n' > "$GENIE_HOME/bin/genie"
        chmod +x "$GENIE_HOME/bin/genie"
        ln -s "$GENIE_HOME/bin/genie" "$LOCAL_BIN/genie"
      }
      detect_legacy_install() { assert_lease; }
      ensure_path_wired() { assert_lease; }
      handoff_to_subcommand() { assert_lease; test "$1" = 'stable'; }
      verify_installation() { assert_lease; test "$1" = '5.9.0'; }
      main
      test -z "$LIFECYCLE_LOCK"
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('another Genie lifecycle command');
    expect(existsSync(genieHome)).toBe(true);
    expect(existsSync(lifecycleLockPath(genieHome))).toBe(false);
  });

  test('a losing installer does not create an absent GENIE_HOME', () => {
    const lease = acquireLifecycleLease(genieHome);
    expect('skipped' in lease).toBe(false);
    if ('skipped' in lease) throw new Error(lease.skipped);
    try {
      const result = shell('source "$1"; acquire_lifecycle_lock');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('another Genie lifecycle command is active');
      expect(existsSync(genieHome)).toBe(false);
    } finally {
      lease.release();
    }
  });

  test('recovers a stale dead shell owner using the shared steal guard', () => {
    const lock = lifecycleLockPath(genieHome);
    writeFileSync(lock, '999999:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    const stale = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, stale, stale);

    const result = shell('source "$1"; acquire_lifecycle_lock; test -f "$LIFECYCLE_LOCK"; release_lifecycle_lock');

    expect(result.status).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.steal`)).toBe(false);
  });

  test('an abandoned steal guard (dead owner, aged) no longer permanently blocks acquisition', () => {
    const lock = lifecycleLockPath(genieHome);
    const guard = `${lock}.steal`;
    writeFileSync(lock, '999999:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    writeFileSync(guard, '999999:abcdefabcdefabcdefabcdefabcdefab:unknown\n', { mode: 0o600 });
    const aged = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, aged, aged);
    utimesSync(guard, aged, aged);

    const result = shell('source "$1"; acquire_lifecycle_lock; test -f "$LIFECYCLE_LOCK"; release_lifecycle_lock');

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('another Genie lifecycle command');
    expect(existsSync(lock)).toBe(false); // stale lock cleared once the guard was reaped
    expect(existsSync(guard)).toBe(false); // abandoned guard reaped, installer's own guard released
  });

  test('a zero-length aged steal guard is reaped like an abandoned owner record', () => {
    const lock = lifecycleLockPath(genieHome);
    const guard = `${lock}.steal`;
    writeFileSync(lock, '999999:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    writeFileSync(guard, '', { mode: 0o600 }); // crash between guard create and record write
    const aged = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, aged, aged);
    utimesSync(guard, aged, aged);

    const result = shell('source "$1"; acquire_lifecycle_lock; release_lifecycle_lock');

    expect(result.status).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(guard)).toBe(false);
  });

  test('a fresh steal guard still fails closed (never reaped)', () => {
    const lock = lifecycleLockPath(genieHome);
    const guard = `${lock}.steal`;
    writeFileSync(lock, '999999:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    const aged = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, aged, aged);
    writeFileSync(guard, '999999:abcdefabcdefabcdefabcdefabcdefab:unknown\n', { mode: 0o600 }); // fresh mtime

    const result = shell(`source "$1"; ps() { [[ "$2" == "${process.pid}" ]]; }; acquire_lifecycle_lock`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('another Genie lifecycle command is active');
    expect(existsSync(guard)).toBe(true); // an in-window guard is a live stealer — untouched
    expect(existsSync(lock)).toBe(true); // the stale lock is never stolen behind a live guard
  });

  test('a live-owner steal guard (aged mtime) still blocks — ps liveness, EPERM-safe', () => {
    const lock = lifecycleLockPath(genieHome);
    const guard = `${lock}.steal`;
    writeFileSync(lock, '999999:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    // This test process is a controlled live owner: `ps -p` sees it alive even
    // though age says the guard is old, so it must never be reaped.
    writeFileSync(guard, `${process.pid}:abcdefabcdefabcdefabcdefabcdefab:unknown\n`, { mode: 0o600 });
    const aged = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, aged, aged);
    utimesSync(guard, aged, aged);

    const result = shell('source "$1"; acquire_lifecycle_lock');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('another Genie lifecycle command is active');
    expect(existsSync(guard)).toBe(true); // live owner is never reaped regardless of age
  });

  test('an unavailable ps probe fails closed instead of reaping an aged lock', () => {
    const lock = lifecycleLockPath(genieHome);
    writeFileSync(lock, '999999:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    const aged = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, aged, aged);

    const result = shell('source "$1"; ps() { return 126; }; acquire_lifecycle_lock');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('another Genie lifecycle command is active');
    expect(existsSync(lock)).toBe(true); // unknown liveness never authorizes removal
  });

  test('an unavailable guard-owner probe preserves both the aged guard and stale lock', () => {
    const lock = lifecycleLockPath(genieHome);
    const guard = `${lock}.steal`;
    writeFileSync(lock, '999999:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    writeFileSync(guard, '888888:abcdefabcdefabcdefabcdefabcdefab:unknown\n', { mode: 0o600 });
    const aged = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, aged, aged);
    utimesSync(guard, aged, aged);

    const result = shell(
      'source "$1"; ps() { [[ "$2" == "999999" ]] && return 1; return 126; }; acquire_lifecycle_lock',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('another Genie lifecycle command is active');
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(guard)).toBe(true);
  });

  test('a single-digit pid lock record parses (regression for the two-digit-minimum glob)', () => {
    const lock = lifecycleLockPath(genieHome);
    writeFileSync(lock, '5:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    const aged = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, aged, aged);

    // Stub `ps` to report every pid dead so the outcome turns solely on whether
    // the single-digit record is PARSED. The old `[1-9][0-9]*:*` glob required
    // two leading digits and left a single-digit-pid lock unrecoverable forever.
    const result = shell('source "$1"; ps() { return 1; }; acquire_lifecycle_lock; release_lifecycle_lock');

    expect(result.status).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  test('a future-mtime abandoned guard (dead owner) is reaped per the ± window', () => {
    const lock = lifecycleLockPath(genieHome);
    const guard = `${lock}.steal`;
    writeFileSync(lock, '999999:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    writeFileSync(guard, '999999:abcdefabcdefabcdefabcdefabcdefab:unknown\n', { mode: 0o600 });
    const agedPast = new Date(Date.now() - 11 * 60 * 1_000);
    const agedFuture = new Date(Date.now() + 11 * 60 * 1_000); // implausibly far future = debris too
    utimesSync(lock, agedPast, agedPast);
    utimesSync(guard, agedFuture, agedFuture);

    const result = shell('source "$1"; acquire_lifecycle_lock; test -f "$LIFECYCLE_LOCK"; release_lifecycle_lock');

    expect(result.status).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(guard)).toBe(false);
  });

  test('a symlinked steal guard is never reaped and still blocks (fail-closed on ! -L)', () => {
    const lock = lifecycleLockPath(genieHome);
    const guard = `${lock}.steal`;
    const target = join(root, 'guard-symlink-target');
    writeFileSync(lock, '999999:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    const aged = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, aged, aged);
    writeFileSync(target, '999999:abcdefabcdefabcdefabcdefabcdefab:unknown\n', { mode: 0o600 });
    symlinkSync(target, guard); // a guard we must refuse to follow/unlink

    const result = shell(`source "$1"; ps() { [[ "$2" == "${process.pid}" ]]; }; acquire_lifecycle_lock`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('another Genie lifecycle command is active');
    expect(lstatSync(guard).isSymbolicLink()).toBe(true); // symlink node untouched
    expect(existsSync(lock)).toBe(true); // stale lock never stolen behind a symlink guard
  });

  test('a no-trailing-newline live-owner guard is preserved and not mis-reaped', () => {
    const lock = lifecycleLockPath(genieHome);
    const guard = `${lock}.steal`;
    writeFileSync(lock, '999999:0123456789abcdef0123456789abcdef:unknown\n', { mode: 0o600 });
    // A live owner (this test process) with NO trailing newline: the read idiom
    // must keep the record instead of clobbering it to "" and reaping a live guard.
    writeFileSync(guard, `${process.pid}:abcdefabcdefabcdefabcdefabcdefab:unknown`, { mode: 0o600 });
    const aged = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, aged, aged);
    utimesSync(guard, aged, aged);

    const result = shell('source "$1"; acquire_lifecycle_lock');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('another Genie lifecycle command is active');
    expect(existsSync(guard)).toBe(true); // live owner preserved despite the missing newline
  });

  test('an empty aged lock (crash between create and record write) is recovered', () => {
    const lock = lifecycleLockPath(genieHome);
    writeFileSync(lock, '', { mode: 0o600 }); // zero-byte lock, as TS leaves on a mid-write crash
    const aged = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, aged, aged);

    const result = shell('source "$1"; acquire_lifecycle_lock; test -f "$LIFECYCLE_LOCK"; release_lifecycle_lock');

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('another Genie lifecycle command');
    expect(existsSync(lock)).toBe(false);
  });

  test('final verification compares one exact normalized version token, never a substring', () => {
    const localBin = join(home, '.local', 'bin');
    const binary = join(genieHome, 'bin', 'genie');
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(localBin, { recursive: true });
    writeFileSync(binary, "#!/usr/bin/env bash\nprintf 'genie v5.9.0\\n'\n", { mode: 0o755 });
    symlinkSync(binary, join(localBin, 'genie'));

    const exact = shell('source "$1"; acquire_lifecycle_lock; verify_installation 5.9.0; release_lifecycle_lock');
    expect(exact.status).toBe(0);

    writeFileSync(binary, "#!/usr/bin/env bash\nprintf 'genie v15.9.0\\n'\n", { mode: 0o755 });
    const collision = shell('source "$1"; acquire_lifecycle_lock; verify_installation 5.9.0');
    expect(collision.status).toBe(1);
    expect(collision.stderr).toContain('version mismatch (expected 5.9.0, got 15.9.0)');
  });

  test('passes the exact owner record to the child finisher and treats failure as fatal', () => {
    const localBin = join(home, '.local', 'bin');
    const observed = join(root, 'observed-owner');
    mkdirSync(localBin, { recursive: true });
    writeFileSync(
      join(localBin, 'genie'),
      `#!/usr/bin/env bash\nset -euo pipefail\n[[ "\${1:-}" == install ]]\n[[ "$(sed -n '1p' "$GENIE_LIFECYCLE_LEASE_PATH")" == "$GENIE_LIFECYCLE_LEASE_OWNER" ]]\nprintf '%s\\n%s\\n' "$GENIE_LIFECYCLE_LEASE_OWNER" "$GENIE_INSTALL_DELIVERY_CHANNEL" > ${JSON.stringify(observed)}\n`,
      { mode: 0o755 },
    );

    const success = shell(
      'source "$1"; acquire_lifecycle_lock; handoff_to_subcommand dev; test -f "$LIFECYCLE_LOCK"; release_lifecycle_lock',
    );
    expect(success.status).toBe(0);
    expect(readFileSync(observed, 'utf8')).toMatch(/^[0-9]+:[a-f0-9]{32}:unknown\ndev\n$/);

    writeFileSync(join(localBin, 'genie'), '#!/usr/bin/env bash\nexit 19\n', { mode: 0o755 });
    const failure = shell('source "$1"; acquire_lifecycle_lock; handoff_to_subcommand stable');
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain('installation remains incomplete and retryable');
    expect(existsSync(lifecycleLockPath(genieHome))).toBe(false);
  });

  test('hands the exact bootstrapped gh to a child on a host with no system gh', () => {
    const localBin = join(home, '.local', 'bin');
    const bootstrapBin = join(root, 'bootstrap', 'bin');
    const bootstrappedGh = join(bootstrapBin, 'gh');
    mkdirSync(localBin, { recursive: true });
    mkdirSync(bootstrapBin, { recursive: true });
    writeFileSync(bootstrappedGh, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(localBin, 'genie'),
      `#!/bin/bash
set -euo pipefail
[[ "\${1:-}" == install ]]
[[ "$GH_BIN" == ${JSON.stringify(bootstrappedGh)} ]]
[[ "$(command -v gh)" == "$GH_BIN" ]]
`,
      { mode: 0o755 },
    );

    const result = shell(`
      source "$1"
      acquire_lifecycle_lock
      GH_BIN=${JSON.stringify(bootstrappedGh)}
      inherited_path="$PATH"
      PATH="${join(root, 'no-system-gh')}"
      handoff_to_subcommand stable
      PATH="$inherited_path"
      release_lifecycle_lock
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('installation remains incomplete and retryable');
  });
});

describe('installCommand', () => {
  test('runs v4 cleanup + layout normalize + agent sync by default', async () => {
    const spy = makeCleanupSpy();
    let normalizeCalls = 0;
    let syncCalls = 0;
    await installCommand(
      {},
      spy.runner,
      () => {
        normalizeCalls += 1;
        return undefined;
      },
      () => {
        syncCalls += 1;
      },
      () => [],
      noopLease,
      noopCodexLease,
      noopConsent,
      () => null,
      noopDeliveryRepair,
    );
    expect(spy.calls()).toBe(1);
    expect(normalizeCalls).toBe(1);
    expect(syncCalls).toBe(1);
  });

  test('--skip-v4-cleanup skips ONLY the cleanup; normalize + sync still run', async () => {
    const spy = makeCleanupSpy();
    let normalizeCalls = 0;
    let syncCalls = 0;
    await installCommand(
      { skipV4Cleanup: true },
      spy.runner,
      () => {
        normalizeCalls += 1;
        return undefined;
      },
      () => {
        syncCalls += 1;
      },
      () => [],
      noopLease,
      noopCodexLease,
      noopConsent,
      () => null,
      noopDeliveryRepair,
    );
    expect(spy.calls()).toBe(0);
    expect(normalizeCalls).toBe(1);
    expect(syncCalls).toBe(1);
  });

  test('--skip-integrations maps to none', async () => {
    let selection = '';
    await installCommand(
      {},
      makeCleanupSpy().runner,
      () => undefined,
      () => undefined,
      (options) => {
        selection = options?.selection ?? '';
        return [];
      },
      noopLease,
      noopCodexLease,
      noopConsent,
      () => null,
      noopDeliveryRepair,
    );
    await installCommand(
      { skipIntegrations: true },
      makeCleanupSpy().runner,
      () => undefined,
      () => undefined,
      (options) => {
        selection = options?.selection ?? '';
        return [];
      },
      noopLease,
      noopCodexLease,
      noopConsent,
      () => null,
      noopDeliveryRepair,
    );
    expect(selection).toBe('none');
  });

  test('agent-sync selection passes through unchanged (restore-hermes-sync-leg): codex/none skip it, auto/all/claude reach it as-is', async () => {
    const observed: string[] = [];
    const runFor = (integrations: 'codex' | 'none' | 'auto' | 'all' | 'claude') =>
      installCommand(
        { integrations },
        makeCleanupSpy().runner,
        () => undefined,
        (selection) => observed.push(selection),
        () => [],
        noopLease,
        noopCodexLease,
        noopConsent,
        integrations === 'codex' || integrations === 'all' ? currentCodexTarget : () => null,
        noopDeliveryRepair,
      );
    // Codex never reaches runIntegrations or agent-sync. `none` likewise has no
    // sync target.
    await runFor('codex');
    await runFor('none');
    expect(observed).toEqual([]);
    // auto/all/claude pass through UNCHANGED — narrowAgentSyncSelection no
    // longer collapses them to 'claude', which is what silently killed the
    // hermes leg (runAgentSync's hermes gate needs 'auto'/'all' verbatim).
    await runFor('auto');
    await runFor('all');
    await runFor('claude');
    expect(observed).toEqual(['auto', 'all', 'claude']);
  });

  test('Codex is structurally excluded from the integration runner after delivery authentication', async () => {
    const scopes: Array<{ selection?: string; codex?: boolean }> = [];
    const observedSync: string[] = [];
    await installCommand(
      { integrations: 'auto' },
      makeCleanupSpy().runner,
      () => undefined,
      (selection) => observedSync.push(selection),
      (options) => {
        scopes.push({ selection: options?.selection, codex: options?.detected?.codex });
        return [{ runtime: 'claude' as const, ok: true, detail: 'claude current' }];
      },
      noopLease,
      noopCodexLease,
      noopConsent,
      currentCodexTarget,
      noopDeliveryRepair,
    );
    expect(scopes).toEqual([{ selection: 'auto', codex: false }]);
    expect(observedSync).toEqual(['auto']);
  });

  test('explicit integration failures are fatal while auto failures warn', async () => {
    const failing = () => [{ runtime: 'claude' as const, ok: false, detail: 'missing' }];
    await expect(
      installCommand(
        {},
        makeCleanupSpy().runner,
        () => undefined,
        () => undefined,
        failing,
        noopLease,
        noopCodexLease,
        noopConsent,
        () => null,
        noopDeliveryRepair,
      ),
    ).resolves.toBeUndefined();
    await expect(
      installCommand(
        { integrations: 'claude' },
        makeCleanupSpy().runner,
        () => undefined,
        () => {},
        failing,
        noopLease,
        noopCodexLease,
        noopConsent,
        () => null,
        noopDeliveryRepair,
      ),
    ).rejects.toThrow('Requested integration failed');
  });

  test('non-Codex integration results cannot claim that Codex hook review is required', async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    const run = (hookReviewRequired: boolean) =>
      installCommand(
        { integrations: 'claude' },
        makeCleanupSpy().runner,
        () => undefined,
        () => undefined,
        () => [
          {
            runtime: 'claude',
            ok: true,
            detail: 'fixture integration current',
            hookReviewRequired,
          },
        ],
        noopLease,
        noopCodexLease,
        noopConsent,
      );
    try {
      await run(false);
      expect(lines.join('\n')).not.toContain('Review Genie hooks with /hooks');
      lines.length = 0;
      await run(true);
      expect(lines.join('\n')).not.toContain('Review Genie hooks with /hooks');
    } finally {
      console.log = originalLog;
    }
  });

  test('rejects an invalid integration option before every finisher side effect', async () => {
    const calls: string[] = [];
    const invalid = { integrations: 'codxe' } as unknown as InstallOptions;
    await expect(
      installCommand(
        invalid,
        (() => calls.push('cleanup')) as unknown as typeof cleanupV4,
        () => {
          calls.push('normalize');
          return undefined;
        },
        () => {
          calls.push('sync');
        },
        () => {
          calls.push('integrations');
          return [];
        },
        noopLease,
        noopCodexLease,
        noopConsent,
      ),
    ).rejects.toThrow('Invalid --integrations value: codxe');
    expect(calls).toEqual([]);
  });

  test('rejects a malformed standalone-installer channel before acquiring a lifecycle lease', async () => {
    const priorChannel = process.env.GENIE_INSTALL_DELIVERY_CHANNEL;
    let acquired = false;
    process.env.GENIE_INSTALL_DELIVERY_CHANNEL = 'main-evil';
    try {
      await expect(
        installCommand(
          {},
          makeCleanupSpy().runner,
          () => undefined,
          () => undefined,
          () => [],
          () => {
            acquired = true;
            return noopLease();
          },
        ),
      ).rejects.toThrow('Invalid installer delivery channel');
      expect(acquired).toBe(false);
    } finally {
      if (priorChannel === undefined) Reflect.deleteProperty(process.env, 'GENIE_INSTALL_DELIVERY_CHANNEL');
      else process.env.GENIE_INSTALL_DELIVERY_CHANNEL = priorChannel;
    }
  });
});

describe('normalizeAuxLayout', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'genie-normalize-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  test('moves bin/<dir> to the canonical <dir> when the target is absent', () => {
    mkdirSync(join(home, 'bin', 'plugins', 'genie'), { recursive: true });
    normalizeAuxLayout(home);
    expect(existsSync(join(home, 'plugins', 'genie'))).toBe(true);
    expect(existsSync(join(home, 'bin', 'plugins'))).toBe(false);
  });

  test('reinstall over an existing install swaps the fresh trees in — no bin/ residue, no swap debris', () => {
    write(join(home, 'bin', 'VERSION'), '5.2.0\n');
    write(join(home, 'VERSION'), '5.1.0\n');
    write(join(home, 'bin', 'plugins', 'genie', 'SKILL.md'), 'fresh plugin');
    write(join(home, 'plugins', 'genie', 'SKILL.md'), 'stale plugin');
    write(join(home, 'bin', 'skills', 'wish', 'SKILL.md'), 'fresh skill');
    write(join(home, 'skills', 'wish', 'SKILL.md'), 'stale skill');

    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'plugins', 'genie', 'SKILL.md'), 'utf8')).toBe('fresh plugin');
    expect(readFileSync(join(home, 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('fresh skill');
    expect(existsSync(join(home, 'bin', 'plugins'))).toBe(false);
    expect(existsSync(join(home, 'bin', 'skills'))).toBe(false);
    for (const name of ['plugins', 'skills']) {
      expect(existsSync(join(home, `${name}.new`))).toBe(false);
      expect(existsSync(join(home, `${name}.old`))).toBe(false);
    }
    // canonical VERSION stamp refreshed so the next run short-circuits
    expect(readFileSync(join(home, 'VERSION'), 'utf8').trim()).toBe('5.2.0');
  });

  test('same-version reinstall repairs divergent content instead of trusting VERSION stamps', () => {
    write(join(home, 'bin', 'VERSION'), '5.2.0\n');
    write(join(home, 'VERSION'), '5.2.0\n');
    // bin content deliberately differs so a wrongful swap would be visible
    write(join(home, 'bin', 'plugins', 'genie', 'SKILL.md'), 'reextracted');
    write(join(home, 'plugins', 'genie', 'SKILL.md'), 'canonical');

    normalizeAuxLayout(home);
    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'plugins', 'genie', 'SKILL.md'), 'utf8')).toBe('reextracted');
    expect(existsSync(join(home, 'bin', 'plugins'))).toBe(false);
    expect(readFileSync(join(home, 'VERSION'), 'utf8').trim()).toBe('5.2.0');
  });

  test('without VERSION stamps a differing tree is swapped in via the digest fallback', () => {
    write(join(home, 'bin', 'skills', 'wish', 'SKILL.md'), 'fresh skill');
    write(join(home, 'skills', 'wish', 'SKILL.md'), 'stale skill');

    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('fresh skill');
    expect(existsSync(join(home, 'bin', 'skills'))).toBe(false);
  });

  test('a digest-identical extracted tree is removed instead of becoming persistent residue', () => {
    write(join(home, 'bin', 'skills', 'wish', 'SKILL.md'), 'same content');
    write(join(home, 'skills', 'wish', 'SKILL.md'), 'same content');

    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('same content');
    expect(existsSync(join(home, 'bin', 'skills'))).toBe(false);
  });

  test('is a non-throwing no-op when neither layout is present', () => {
    expect(() => normalizeAuxLayout(home)).not.toThrow();
    expect(existsSync(join(home, 'plugins'))).toBe(false);
  });

  test('marketplace manifest dirs (.agents, .claude-plugin) move next to plugins/ under GENIE_HOME', () => {
    write(join(home, 'bin', 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml'), '# Managed by Genie.\n');
    write(join(home, 'bin', '.agents', 'plugins', 'marketplace.json'), '{"name":"automagik"}');
    write(join(home, 'bin', '.claude-plugin', 'marketplace.json'), '{"name":"automagik"}');

    normalizeAuxLayout(home);

    // GENIE_HOME is now a self-consistent `plugin marketplace add` root: the
    // manifests' relative `./plugins/genie` reference resolves under it.
    expect(existsSync(join(home, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
    expect(existsSync(join(home, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(existsSync(join(home, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml'))).toBe(true);
    expect(existsSync(join(home, 'bin', '.agents'))).toBe(false);
    expect(existsSync(join(home, 'bin', '.claude-plugin'))).toBe(false);
  });

  test('a failed tree suppresses the VERSION stamp so a same-version reinstall retries it', () => {
    write(join(home, 'bin', 'VERSION'), '5.2.0\n');
    // No home VERSION → per-tree digest compare. plugins adopts fine…
    write(join(home, 'bin', 'plugins', 'genie', 'SKILL.md'), 'fresh plugin');
    write(join(home, 'plugins', 'genie', 'SKILL.md'), 'stale plugin');
    // …but skills fails: a FILE squats where the tree should be, so the digest
    // compare throws and this tree cannot converge.
    write(join(home, 'bin', 'skills', 'wish', 'SKILL.md'), 'fresh skill');
    writeFileSync(join(home, 'skills'), 'not a directory');

    normalizeAuxLayout(home);

    // The healthy tree was adopted…
    expect(readFileSync(join(home, 'plugins', 'genie', 'SKILL.md'), 'utf8')).toBe('fresh plugin');
    // …but the stamp MUST stay absent: stamping a partial adoption would make
    // same-version reinstalls no-op forever while skills/ stays stale.
    expect(existsSync(join(home, 'VERSION'))).toBe(false);
  });

  test('source-removal failure preserves the prior VERSION stamp and extracted recovery tree', () => {
    const source = join(home, 'bin', 'plugins');
    write(join(home, 'bin', 'VERSION'), '5.2.0\n');
    write(join(home, 'VERSION'), '5.1.0\n');
    write(join(source, 'payload.txt'), 'fresh');
    write(join(home, 'plugins', 'payload.txt'), 'old');

    const outcomes = normalizeAuxLayout(home, {
      remove: (path) => {
        if (path === source) throw new Error('source removal failure');
        rmSync(path, { recursive: true, force: true });
      },
    });

    expect(outcomes.find((outcome) => outcome.label === 'plugins')?.status).toBe('failed');
    expect(readFileSync(join(home, 'VERSION'), 'utf8').trim()).toBe('5.1.0');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
    expect(readFileSync(join(home, 'plugins', 'payload.txt'), 'utf8')).toBe('fresh');
  });
});

describe('transactional auxiliary-tree convergence', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genie-aux-transaction-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { source: string; destination: string } {
    const source = join(root, 'extract', 'plugins');
    const destination = join(root, 'home', 'plugins');
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(source, 'payload.txt'), 'fresh');
    writeFileSync(join(destination, 'payload.txt'), 'old');
    return { source, destination };
  }

  function copyPayload(source: string, destination: string): void {
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'payload.txt'), readFileSync(join(source, 'payload.txt')));
  }

  test('copy failure leaves the prior live tree and complete fresh source untouched', () => {
    const { source, destination } = fixture();
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'copy-failure',
      operations: {
        copyTree: () => {
          throw new Error('copy injected');
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.stage).toBe('copy-fresh');
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('partial copy/disk-full never reports the incomplete staging tree as verified fresh', () => {
    const { source, destination } = fixture();
    const staging = `${destination}.new-partial-copy`;
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'partial-copy',
      operations: {
        copyTree: (_from, to) => {
          mkdirSync(to, { recursive: true });
          writeFileSync(join(to, 'payload.txt'), 'partial');
          throw new Error('ENOSPC: disk full');
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('copy-fresh');
      expect(outcome.freshArtifact).toBe(source);
      expect(outcome.freshArtifact).not.toBe(staging);
      expect(outcome.freshArtifactDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(readFileSync(join(staging, 'payload.txt'), 'utf8')).toBe('partial');
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
  });

  test('verify-copy mismatch reports only the verified source, never corrupt staging', () => {
    const { source, destination } = fixture();
    const staging = `${destination}.new-verify-mismatch`;
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'verify-mismatch',
      operations: {
        copyTree: (_from, to) => {
          mkdirSync(to, { recursive: true });
          writeFileSync(join(to, 'payload.txt'), 'corrupt');
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('verify-copy');
      expect(outcome.freshArtifact).toBe(source);
      expect(outcome.freshArtifact).not.toBe(staging);
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
  });

  test('live-tree parking failure is non-destructive and retains staged fresh content', () => {
    const { source, destination } = fixture();
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'park-failure',
      operations: {
        rename: () => {
          throw new Error('park injected');
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('park-live');
      expect(outcome.freshArtifact).toBeDefined();
      if (outcome.freshArtifact) expect(existsSync(outcome.freshArtifact)).toBe(true);
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('fresh promotion failure restores the prior live tree and retains retry artifacts', () => {
    const { source, destination } = fixture();
    let renames = 0;
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'promote-failure',
      operations: {
        rename: (from, to) => {
          renames += 1;
          if (renames === 2) throw new Error('promote injected');
          renameSync(from, to);
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('promote-fresh');
      expect(outcome.freshArtifact).toBeDefined();
      if (outcome.freshArtifact) expect(existsSync(outcome.freshArtifact)).toBe(true);
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('rollback rename failure falls back to a verified copy of the prior tree', () => {
    const { source, destination } = fixture();
    let renames = 0;
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'rollback-copy',
      operations: {
        rename: (from, to) => {
          renames += 1;
          if (renames >= 2) throw new Error(`rename injected ${renames}`);
          renameSync(from, to);
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('promote-fresh');
      expect(outcome.rollbackError).toBeUndefined();
      expect(outcome.previousArtifact).toBeDefined();
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('total rollback failure retains verified fresh and previous artifacts with an actionable error', () => {
    const { source, destination } = fixture();
    let renames = 0;
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'total-rollback',
      operations: {
        rename: (from, to) => {
          renames += 1;
          if (renames >= 2) throw new Error(`rename failure ${renames}`);
          renameSync(from, to);
        },
        copyTree: (from, to) => {
          if (from.includes('.old-total-rollback')) throw new Error('rollback copy failure');
          copyPayload(from, to);
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('promote-fresh');
      expect(outcome.rollbackError).toContain('rename rollback failed');
      expect(outcome.rollbackError).toContain('copy rollback failed');
      expect(outcome.freshArtifact).toBeDefined();
      expect(outcome.previousArtifact).toBeDefined();
      if (outcome.freshArtifact) expect(readFileSync(join(outcome.freshArtifact, 'payload.txt'), 'utf8')).toBe('fresh');
      if (outcome.previousArtifact)
        expect(readFileSync(join(outcome.previousArtifact, 'payload.txt'), 'utf8')).toBe('old');
    }
    expect(existsSync(destination)).toBe(false);
  });

  test('identical-source removal failure keeps live and verified source and blocks convergence', () => {
    const { source, destination } = fixture();
    writeFileSync(join(destination, 'payload.txt'), 'fresh');
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      removeSourceOnSuccess: true,
      transactionId: 'identical-remove',
      operations: {
        remove: (path) => {
          if (path === source) throw new Error('source removal failure');
          rmSync(path, { recursive: true, force: true });
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('remove-identical-source');
      expect(outcome.freshArtifact).toBe(source);
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('fresh');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('post-promotion source-removal failure keeps new live plus old and verified fresh recovery artifacts', () => {
    const { source, destination } = fixture();
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      removeSourceOnSuccess: true,
      transactionId: 'source-remove',
      operations: {
        remove: (path) => {
          if (path === source) throw new Error('source removal failure');
          rmSync(path, { recursive: true, force: true });
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('remove-source');
      expect(outcome.freshArtifact).toBeDefined();
      expect(outcome.previousArtifact).toBeDefined();
      if (outcome.previousArtifact)
        expect(readFileSync(join(outcome.previousArtifact, 'payload.txt'), 'utf8')).toBe('old');
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('fresh');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('cross-filesystem source is copied and only destination siblings are renamed', () => {
    const { source, destination } = fixture();
    const renameSources: string[] = [];
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      removeSourceOnSuccess: true,
      transactionId: 'cross-filesystem',
      operations: {
        rename: (from, to) => {
          renameSources.push(from);
          if (from === source || from.startsWith(`${source}/`)) {
            const error = new Error('cross-device link') as NodeJS.ErrnoException;
            error.code = 'EXDEV';
            throw error;
          }
          renameSync(from, to);
        },
      },
    });
    expect(outcome.status).toBe('refreshed');
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('fresh');
    expect(existsSync(source)).toBe(false);
    expect(renameSources.some((path) => path === source || path.startsWith(`${source}/`))).toBe(false);
  });

  test('symlinks are rejected even when they resolve to byte-identical content', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-aux-symlink-'));
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    writeFileSync(join(root, 'outside.txt'), 'same');
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'payload.txt'), 'same');
    symlinkSync(join(root, 'outside.txt'), join(source, 'payload.txt'));
    try {
      const outcome = convergeAuxiliaryTree({ label: 'plugins', source, destination });
      expect(outcome).toMatchObject({ status: 'failed', stage: 'inspect' });
      expect(outcome.status === 'failed' ? outcome.error : '').toContain('contains a symlink');
      expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('same');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mode-only drift converges and preserves the executable bit', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-aux-mode-'));
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(source, 'launcher'), '#!/bin/sh\n');
    writeFileSync(join(destination, 'launcher'), '#!/bin/sh\n');
    chmodSync(join(source, 'launcher'), 0o755);
    chmodSync(join(destination, 'launcher'), 0o644);
    try {
      const outcome = convergeAuxiliaryTree({ label: 'plugins', source, destination });
      expect(outcome.status).toBe('refreshed');
      expect(statSync(join(destination, 'launcher')).mode & 0o111).toBe(0o111);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('installCommand — Group C install gate (item 2)', () => {
  let logs: string[];
  let logSpy: ReturnType<typeof spyOn>;
  const savedExit = process.exitCode;

  beforeEach(() => {
    process.exitCode = 0;
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = savedExit;
  });

  test('publishes before permitted non-Codex work and defers a pending generation with zero Codex mutation', async () => {
    const events: string[] = [];
    const cleanup = makeCleanupSpy();
    await installCommand(
      { integrations: 'all' },
      ((...args: Parameters<typeof cleanupV4>) => {
        events.push('cleanup');
        return cleanup.runner(...args);
      }) as typeof cleanupV4,
      () => {
        events.push('normalize');
        return undefined;
      },
      (selection) => events.push(`sync:${selection}`),
      (options) => {
        events.push(`integrations:${options?.selection}`);
        return [{ runtime: 'claude', ok: true, detail: 'plugin refreshed' }];
      },
      noopLease,
      noopCodexLease,
      () => events.push('consent'),
      () => ({ installedVersion: '5.260710.2' }),
      async () => {
        events.push('repair');
        return { action: 'exit-handoff' };
      },
      () => events.push('retire-marker'),
    );
    expect(events).toEqual(['normalize', 'repair', 'cleanup', 'integrations:claude', 'sync:all', 'retire-marker']);
    expect(process.exitCode).toBe(2);
    expect(logs.filter((l) => l.includes('"deliveryComplete":true'))).toHaveLength(1);
    const codexLine = logs.find((l) => l.includes('codex:'));
    expect(codexLine).toContain('Codex plugin left at v5.260710.2 (no activation-owned mutation)');
    expect(codexLine).toContain('retire tasks → genie setup --codex → /hooks → new task');
  });

  test('failed or advanced publication is terminal before consent, cleanup, integration, sync, marker retirement, or success', async () => {
    const advancedManifest = {
      schema_version: 1,
      channel: 'stable' as const,
      version: '5.260723.8',
      released_at: '2026-07-23T00:00:00Z',
      tarball_base: 'https://github.com/automagik-dev/genie/releases/download/v5.260723.8',
      platforms: ['darwin-arm64'],
      manifestBytes: '{"version":"5.260723.8"}\n',
      manifestSha256: 'a'.repeat(64),
    };
    for (const directive of [
      { action: 'failed' as const, detail: 'delivery store is unwritable' },
      { action: 'route-upgrade' as const, manifest: advancedManifest },
    ]) {
      const events: string[] = [];
      logs.length = 0;
      process.exitCode = 0;
      await installCommand(
        { integrations: 'codex' },
        (() => {
          events.push('cleanup');
          return makeCleanupSpy().runner();
        }) as typeof cleanupV4,
        () => {
          events.push('normalize');
          return undefined;
        },
        () => events.push('sync'),
        () => {
          events.push('integrations');
          return [];
        },
        noopLease,
        noopCodexLease,
        () => events.push('consent'),
        () => ({ installedVersion: null }),
        async () => {
          events.push('repair');
          return directive;
        },
        () => events.push('retire-marker'),
      );
      expect(events).toEqual(['normalize', 'repair']);
      expect(process.exitCode).toBe(1);
      expect(logs.filter((line) => line.includes('"deliveryComplete":true'))).toHaveLength(0);
      expect(logs.join('\n')).not.toContain('authenticated delivery v');
      const trailer = logs.find((line) => line.includes('"code":"delivery-incomplete"'));
      expect(trailer).toBeDefined();
      expect(JSON.parse(trailer as string)).toMatchObject({ deliveryComplete: false, retry: true });
      if (directive.action === 'route-upgrade') expect(logs.join('\n')).toContain(advancedManifest.version);
    }
  });

  test('a target-current authenticated install leaves Codex untouched and permits only Claude integration', async () => {
    const events: string[] = [];
    await installCommand(
      { integrations: 'all' },
      makeCleanupSpy().runner,
      () => undefined,
      () => events.push('sync'),
      (options) => {
        events.push(`integrations:${options?.selection}`);
        return [{ runtime: 'claude', ok: true, detail: 'plugin refreshed' }];
      },
      noopLease,
      noopCodexLease,
      noopConsent,
      currentCodexTarget,
      async () => {
        events.push('repair');
        return { action: 'repaired-current' };
      },
      () => events.push('retire-marker'),
    );
    expect(events).toEqual(['repair', 'integrations:claude', 'sync', 'retire-marker']);
    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).not.toContain('"deliveryComplete":true');
    expect(logs.join('\n')).toContain('no activation-owned mutation');
  });

  test('only an explicitly Claude-only install persists maintenance consent', async () => {
    const persisted: string[] = [];
    for (const integrations of ['codex', 'auto', 'all', 'none', 'claude'] as const) {
      await installCommand(
        { integrations },
        makeCleanupSpy().runner,
        () => undefined,
        () => undefined,
        () => [],
        noopLease,
        noopCodexLease,
        (selection) => persisted.push(`${integrations}:${selection}`),
        integrations === 'codex' || integrations === 'auto' || integrations === 'all' ? currentCodexTarget : () => null,
        noopDeliveryRepair,
      );
    }
    expect(persisted).toEqual(['claude:claude']);
  });

  test('install-owned agent sync disables setup-owned Codex role convergence', () => {
    let captured: Parameters<typeof import('./update.js').runAgentSyncSafe>[0] | undefined;
    runInstallAgentSync('all', (options) => {
      captured = options;
      return null;
    });
    expect(captured?.selection).toBe('all');
    expect(captured?.strict).toBe(true);
    expect(captured?.codexRefresh).toBeUndefined();
  });

  test('fresh dev and homolog installer handoffs authenticate the exact selected channel', async () => {
    const priorChannel = process.env.GENIE_INSTALL_DELIVERY_CHANNEL;
    try {
      for (const selectedChannel of ['dev', 'homolog'] as const) {
        process.env.GENIE_INSTALL_DELIVERY_CHANNEL = selectedChannel;
        let repairedChannel = '';
        await installCommand(
          { integrations: 'codex' },
          makeCleanupSpy().runner,
          () => undefined,
          () => undefined,
          (options) => {
            expect(options?.selection).toBe('none');
            return [];
          },
          noopLease,
          noopCodexLease,
          noopConsent,
          () => ({ installedVersion: null }),
          async (channel) => {
            repairedChannel = channel;
            return { action: 'exit-handoff' };
          },
          () => undefined,
        );
        expect(repairedChannel).toBe(selectedChannel);
      }
    } finally {
      if (priorChannel === undefined) Reflect.deleteProperty(process.env, 'GENIE_INSTALL_DELIVERY_CHANNEL');
      else process.env.GENIE_INSTALL_DELIVERY_CHANNEL = priorChannel;
    }
  });

  test('a later permitted integration failure preserves the install marker after successful publication', async () => {
    let retired = false;
    await expect(
      installCommand(
        { integrations: 'all' },
        makeCleanupSpy().runner,
        () => undefined,
        () => undefined,
        () => [{ runtime: 'claude', ok: false, detail: 'claude integration failed' }],
        noopLease,
        noopCodexLease,
        noopConsent,
        currentCodexTarget,
        async () => ({ action: 'repaired-current' }),
        () => {
          retired = true;
        },
      ),
    ).rejects.toThrow('Requested integration failed: claude');
    expect(retired).toBe(false);
  });

  test('a later permitted agent-sync failure preserves the install marker after successful publication', async () => {
    let retired = false;
    await expect(
      installCommand(
        { integrations: 'all' },
        makeCleanupSpy().runner,
        () => undefined,
        () => {
          throw new Error('agent sync failed');
        },
        () => [{ runtime: 'claude', ok: true, detail: 'claude integration current' }],
        noopLease,
        noopCodexLease,
        noopConsent,
        currentCodexTarget,
        async () => ({ action: 'repaired-current' }),
        () => {
          retired = true;
        },
      ),
    ).rejects.toThrow('agent sync failed');
    expect(retired).toBe(false);
  });

  test('a busy Codex lifecycle lease projects exit 2 codex-lifecycle-busy / deliveryComplete:false with ZERO plugin convergence (AC8 loser)', async () => {
    let integrationsRan = false;
    let syncRan = false;
    let leaseAcquired = false;
    await installCommand(
      { integrations: 'auto' },
      makeCleanupSpy().runner,
      () => undefined,
      () => {
        syncRan = true;
      },
      () => {
        integrationsRan = true;
        return [];
      },
      noopLease,
      // Busy codex lifecycle lease: another lifecycle command (update-delivery) holds it.
      () => {
        leaseAcquired = true;
        return {
          ok: false,
          reason: 'codex-lifecycle-busy',
          holderKind: 'update-delivery',
          detail: 'held by update-delivery (pid 4242)',
        };
      },
      noopConsent,
      // Classifier must not even be consulted for a mutation decision after a busy refusal.
      () => null,
    );
    expect(leaseAcquired).toBe(true);
    // Zero mutation: neither plugin convergence nor agent-sync ran after the refusal.
    expect(integrationsRan).toBe(false);
    expect(syncRan).toBe(false);
    // Exit 2 with the codex-lifecycle-busy trailer (deliveryComplete:false, retry:true), naming the holder.
    expect(process.exitCode).toBe(2);
    const output = logs.join('\n');
    expect(output).toContain('codex-lifecycle-busy');
    expect(output).toContain('update-delivery');
    const trailer = logs.find((l) => l.includes('"code":"codex-lifecycle-busy"'));
    expect(trailer).toBeDefined();
    expect(JSON.parse(trailer as string)).toMatchObject({ deliveryComplete: false, retry: true });
  });

  test('a claude/none install never acquires the Codex lifecycle lease (no spurious cross-command contention)', async () => {
    let leaseTouched = false;
    const acquire = () => {
      leaseTouched = true;
      return noopCodexLease();
    };
    for (const integrations of ['claude', 'none'] as const) {
      leaseTouched = false;
      await installCommand(
        { integrations },
        makeCleanupSpy().runner,
        () => undefined,
        () => undefined,
        () => [],
        noopLease,
        acquire,
        noopConsent,
        () => null,
      );
      expect(leaseTouched).toBe(false);
    }
  });

  test('a held Codex lifecycle lease is acquired for an in-scope install and released on the terminal path', async () => {
    let released = false;
    const acquire = () => ({
      ok: true as const,
      operationId: 'a'.repeat(32),
      kind: 'install-converge' as const,
      assertOperation: () => undefined,
      release: () => {
        released = true;
      },
    });
    await installCommand(
      { integrations: 'codex' },
      makeCleanupSpy().runner,
      () => undefined,
      () => undefined,
      () => [{ runtime: 'codex' as const, ok: true, detail: 'plugin/hooks refreshed' }],
      noopLease,
      acquire,
      noopConsent,
      currentCodexTarget,
      noopDeliveryRepair,
    );
    expect(process.exitCode).toBe(0);
    expect(released).toBe(true);
  });
});
