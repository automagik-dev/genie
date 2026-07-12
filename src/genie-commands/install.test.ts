/**
 * Tests for the `genie install` post-install finisher.
 *
 * The v4 cleanup engine is covered by legacy-v4.test.ts and the agent-sync
 * engine by agent-sync.test.ts; here we only prove the command wiring: v4
 * cleanup is gated by --skip-v4-cleanup, while the layout-normalize and
 * agent-sync steps always run. Every seam is injected — calling the real
 * cleanup/normalize/sync from a test would target the actual home directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
import { convergeAuxiliaryTree } from './auxiliary-trees.js';
import { type InstallOptions, installCommand, normalizeAuxLayout } from './install.js';
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
const noopConsent = () => undefined;

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
    return spawnSync('bash', ['-c', script, 'bash', installer], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        GENIE_HOME: genieHome,
        GENIE_INSTALL_SOURCE_ONLY: '1',
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
      handoff_to_subcommand() { assert_lease; }
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

    const result = shell('source "$1"; acquire_lifecycle_lock');

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
      `#!/usr/bin/env bash\nset -euo pipefail\n[[ "\${1:-}" == install ]]\n[[ "$(sed -n '1p' "$GENIE_LIFECYCLE_LEASE_PATH")" == "$GENIE_LIFECYCLE_LEASE_OWNER" ]]\nprintf '%s' "$GENIE_LIFECYCLE_LEASE_OWNER" > ${JSON.stringify(observed)}\n`,
      { mode: 0o755 },
    );

    const success = shell(
      'source "$1"; acquire_lifecycle_lock; handoff_to_subcommand; test -f "$LIFECYCLE_LOCK"; release_lifecycle_lock',
    );
    expect(success.status).toBe(0);
    expect(readFileSync(observed, 'utf8')).toMatch(/^[0-9]+:[a-f0-9]{32}:unknown$/);

    writeFileSync(join(localBin, 'genie'), '#!/usr/bin/env bash\nexit 19\n', { mode: 0o755 });
    const failure = shell('source "$1"; acquire_lifecycle_lock; handoff_to_subcommand');
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain('installation remains incomplete and retryable');
    expect(existsSync(lifecycleLockPath(genieHome))).toBe(false);
  });
});

describe('installCommand', () => {
  test('runs v4 cleanup + layout normalize + agent sync by default', () => {
    const spy = makeCleanupSpy();
    let normalizeCalls = 0;
    let syncCalls = 0;
    installCommand(
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
      noopConsent,
    );
    expect(spy.calls()).toBe(1);
    expect(normalizeCalls).toBe(1);
    expect(syncCalls).toBe(1);
  });

  test('--skip-v4-cleanup skips ONLY the cleanup; normalize + sync still run', () => {
    const spy = makeCleanupSpy();
    let normalizeCalls = 0;
    let syncCalls = 0;
    installCommand(
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
      noopConsent,
    );
    expect(spy.calls()).toBe(0);
    expect(normalizeCalls).toBe(1);
    expect(syncCalls).toBe(1);
  });

  test('--skip-integrations maps to none', () => {
    let selection = '';
    installCommand(
      {},
      makeCleanupSpy().runner,
      () => undefined,
      () => undefined,
      (options) => {
        selection = options?.selection ?? '';
        return [];
      },
      noopLease,
      noopConsent,
    );
    installCommand(
      { skipIntegrations: true },
      makeCleanupSpy().runner,
      () => undefined,
      () => undefined,
      (options) => {
        selection = options?.selection ?? '';
        return [];
      },
      noopLease,
      noopConsent,
    );
    expect(selection).toBe('none');
  });

  test('selection bounds agent-sync homes and none performs no client sync', () => {
    const observed: string[] = [];
    installCommand(
      { integrations: 'codex' },
      makeCleanupSpy().runner,
      () => undefined,
      (selection) => observed.push(selection),
      () => [],
      noopLease,
      noopConsent,
    );
    installCommand(
      { integrations: 'none' },
      makeCleanupSpy().runner,
      () => undefined,
      (selection) => observed.push(selection),
      () => [],
      noopLease,
      noopConsent,
    );
    expect(observed).toEqual(['codex']);
  });

  test('explicit integration failures are fatal while auto failures warn', () => {
    const failing = () => [{ runtime: 'codex' as const, ok: false, detail: 'missing' }];
    expect(() =>
      installCommand(
        {},
        makeCleanupSpy().runner,
        () => undefined,
        () => undefined,
        failing,
        noopLease,
        noopConsent,
      ),
    ).not.toThrow();
    expect(() =>
      installCommand(
        { integrations: 'codex' },
        makeCleanupSpy().runner,
        () => undefined,
        () => {},
        failing,
        noopLease,
        noopConsent,
      ),
    ).toThrow('Requested integration failed');
  });

  test('install prints hook review guidance only when hook definition bytes changed', () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    const run = (hookReviewRequired: boolean) =>
      installCommand(
        { integrations: 'codex' },
        makeCleanupSpy().runner,
        () => undefined,
        () => undefined,
        () => [
          {
            runtime: 'codex',
            ok: true,
            detail: 'fixture integration current',
            hookReviewRequired,
          },
        ],
        noopLease,
        noopConsent,
      );
    try {
      run(false);
      expect(lines.join('\n')).not.toContain('Review Genie hooks with /hooks');
      lines.length = 0;
      run(true);
      expect(lines.join('\n')).toContain('Review Genie hooks with /hooks, then start a new Codex task.');
    } finally {
      console.log = originalLog;
    }
  });

  test('rejects an invalid integration option before every finisher side effect', () => {
    const calls: string[] = [];
    const invalid = { integrations: 'codxe' } as unknown as InstallOptions;
    expect(() =>
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
        noopConsent,
      ),
    ).toThrow('Invalid --integrations value: codxe');
    expect(calls).toEqual([]);
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
