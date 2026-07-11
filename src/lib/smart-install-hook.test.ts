/**
 * Spawn-based tests for the SessionStart hook's agent-sync delegation path
 * (plugins/genie/scripts/smart-install.js): findGenieBinary,
 * agentSyncThrottleAllows, delegateAgentSync, stampCouncilFallback.
 *
 * The script runs its main flow on load (it IS the hook), so each test spawns
 * `node` on the real file inside a fully isolated fixture: HOME, GENIE_HOME and
 * CLAUDE_PLUGIN_ROOT all point into a tmpdir, and a fake `genie` shell script
 * records every invocation (argv + the sync-only env) to a log file so tests
 * can assert exactly what the hook executed. The parent PATH is filtered so no
 * real `genie` binary is ever reachable from the child.
 *
 * Run with: bun test src/lib/smart-install-hook.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireLifecycleLease, lifecycleLockPath } from './agent-sync';

const SCRIPT_PATH = join(import.meta.dir, '..', '..', 'plugins', 'genie', 'scripts', 'smart-install.js');
const THROTTLE_MS = 6 * 60 * 60 * 1000;

const NODE_BIN = Bun.which('node');
if (!NODE_BIN) throw new Error('node binary is required for smart-install hook tests');

// Parent PATH minus every segment that carries a real `genie` executable, so
// the only genie the child can ever resolve is the fixture fake. Bun/tmux/etc.
// stay resolvable, keeping the hook on its cheap quick-exit path.
const CLEAN_PATH = (process.env.PATH ?? '')
  .split(':')
  .filter((seg) => seg !== '' && !existsSync(join(seg, 'genie')))
  .join(':');

const COUNCIL_TEMPLATE = ["const LENS_ROOT = '__GENIE_LENS_ROOT__';", 'module.exports = { LENS_ROOT };', ''].join('\n');

function fakeGenieScript(label: string): string {
  return [
    '#!/bin/sh',
    `echo "${label} env=\${GENIE_UPDATE_SYNC_ONLY:-} $@" >> "$FAKE_GENIE_LOG"`,
    // Default fake version sits ABOVE the flag-aware threshold (versions are
    // 5.YYMMDD.N — the minor is a date, so "999" would sort BEFORE 260710).
    'if [ "$1" = "--version" ]; then',
    '  echo "${FAKE_GENIE_VERSION:-5.999999.0}"',
    '  exit 0',
    'fi',
    'if [ "${FAKE_FAIL_IF_LIFECYCLE_LOCKED:-}" = "1" ] && [ -e "$FAKE_LIFECYCLE_LOCK_PATH" ]; then',
    `  echo "${label} SELF_CONTENTION" >> "$FAKE_GENIE_LOG"`,
    '  exit 97',
    'fi',
    'if [ "${FAKE_GENIE_WRITE_MARKER:-}" = "1" ] && [ "$1" = "update" ]; then',
    '  mkdir -p "$GENIE_HOME"',
    '  "$FAKE_NODE_BIN" -e \'process.stdout.write(new Date().toISOString())\' > "$GENIE_HOME/.last-agent-sync"',
    '  printf "\\n" >> "$GENIE_HOME/.last-agent-sync"',
    'fi',
    'if [ "${FAKE_CONCURRENT_SUCCESS_AFTER_RELEASE:-}" = "1" ] && [ "$1" = "update" ]; then',
    '  "$FAKE_NODE_BIN" -e \'process.stdout.write(new Date().toISOString())\' > "$GENIE_HOME/.last-agent-sync"',
    '  printf "\\n" >> "$GENIE_HOME/.last-agent-sync"',
    `  echo "${label} CONCURRENT_SUCCESS_AFTER_RELEASE" >> "$FAKE_GENIE_LOG"`,
    'fi',
    'exit "${FAKE_GENIE_EXIT:-0}"',
    '',
  ].join('\n');
}

interface Fixture {
  dir: string;
  home: string;
  genieHome: string;
  pluginRoot: string;
  fakeBin: string;
  logPath: string;
  markerPath: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'smart-install-hook-'));
  const home = join(dir, 'home');
  const genieHome = join(dir, 'genie-home');
  const pluginRoot = join(dir, 'plugin');
  const fakeBin = join(dir, 'fakebin');
  mkdirSync(home, { recursive: true });
  mkdirSync(genieHome, { recursive: true });
  // node_modules present + no package.json → needsInstall() is false, keeping
  // the spawned hook on the fast path with zero install side effects.
  mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });
  mkdirSync(join(pluginRoot, 'workflows'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(pluginRoot, 'workflows', 'council.js'), COUNCIL_TEMPLATE, 'utf8');
  return {
    dir,
    home,
    genieHome,
    pluginRoot,
    fakeBin,
    logPath: join(dir, 'genie-invocations.log'),
    markerPath: join(genieHome, '.last-agent-sync'),
  };
}

function installFakeGenie(fx: Fixture, at: 'canonical' | 'path', label: string): void {
  const target = at === 'canonical' ? join(fx.genieHome, 'bin', 'genie') : join(fx.fakeBin, 'genie');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fakeGenieScript(label), 'utf8');
  chmodSync(target, 0o755);
}

function writeMarker(fx: Fixture, date: Date | string): void {
  const iso = typeof date === 'string' ? date : date.toISOString();
  writeFileSync(fx.markerPath, `${iso}\n`, 'utf8');
}

function readLog(fx: Fixture): string {
  try {
    return readFileSync(fx.logPath, 'utf8');
  } catch {
    return '';
  }
}

function runHook(
  fx: Fixture,
  opts: {
    fakeGenieExit?: number;
    fakeGenieVersion?: string;
    fakeGenieWritesFreshMarker?: boolean;
    failIfLifecycleLocked?: boolean;
    concurrentSuccessAfterRelease?: boolean;
  } = {},
) {
  const env: Record<string, string> = {
    HOME: fx.home,
    PATH: `${fx.fakeBin}:${CLEAN_PATH}`,
    GENIE_HOME: fx.genieHome,
    CLAUDE_PLUGIN_ROOT: fx.pluginRoot,
    FAKE_GENIE_LOG: fx.logPath,
  };
  if (opts.fakeGenieExit !== undefined) env.FAKE_GENIE_EXIT = String(opts.fakeGenieExit);
  if (opts.fakeGenieVersion !== undefined) env.FAKE_GENIE_VERSION = opts.fakeGenieVersion;
  if (opts.fakeGenieWritesFreshMarker) {
    env.FAKE_GENIE_WRITE_MARKER = '1';
    env.FAKE_NODE_BIN = NODE_BIN as string;
  }
  if (opts.failIfLifecycleLocked) {
    env.FAKE_FAIL_IF_LIFECYCLE_LOCKED = '1';
    env.FAKE_LIFECYCLE_LOCK_PATH = lifecycleLockPath(fx.genieHome);
  }
  if (opts.concurrentSuccessAfterRelease) {
    env.FAKE_CONCURRENT_SUCCESS_AFTER_RELEASE = '1';
    env.FAKE_NODE_BIN = NODE_BIN as string;
  }
  return spawnSync(NODE_BIN as string, [SCRIPT_PATH], { env, encoding: 'utf-8', timeout: 30_000 });
}

/** Log lines for `update` invocations only (the fake also logs --version probes). */
function updateInvocations(fx: Fixture): string[] {
  return readLog(fx)
    .split('\n')
    .filter((l) => / update( |$)/.test(l));
}

let fx: Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  rmSync(fx.dir, { recursive: true, force: true });
});

describe('agentSyncThrottleAllows (observed through delegation)', () => {
  test('no marker → delegation runs', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const res = runHook(fx);
    expect(res.status).toBe(0);
    expect(readLog(fx)).toContain('CANONICAL env=1 update --sync-only');
  });

  test('marker older than 6h → delegation runs', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    writeMarker(fx, new Date(Date.now() - THROTTLE_MS - 60 * 60 * 1000));
    const res = runHook(fx);
    expect(res.status).toBe(0);
    expect(readLog(fx)).toContain('CANONICAL env=1 update --sync-only');
  });

  test('fresh marker (1h old) → delegation is throttled', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    writeMarker(fx, new Date(Date.now() - 60 * 60 * 1000));
    const res = runHook(fx);
    expect(res.status).toBe(0);
    expect(readLog(fx)).not.toContain('update --sync-only');
  });

  test('future-dated marker is stale, not fresh-forever (negative-delta regression)', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    writeMarker(fx, new Date(Date.now() + 2 * 60 * 60 * 1000));
    const res = runHook(fx);
    expect(res.status).toBe(0);
    expect(readLog(fx)).toContain('CANONICAL env=1 update --sync-only');
  });

  test('unparseable marker → delegation runs', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    writeMarker(fx, 'not-a-timestamp');
    const res = runHook(fx);
    expect(res.status).toBe(0);
    expect(readLog(fx)).toContain('CANONICAL env=1 update --sync-only');
  });
});

describe('delegateAgentSync', () => {
  test('invokes `update --sync-only` with GENIE_UPDATE_SYNC_ONLY=1 (both contract forms)', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    runHook(fx);
    const updateLines = readLog(fx)
      .split('\n')
      .filter((l) => l.includes('update --sync-only'));
    expect(updateLines).toHaveLength(1);
    expect(updateLines[0]).toBe('CANONICAL env=1 update --sync-only');
  });

  test('the hook never marks a delegated process successful on exit status alone', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const res = runHook(fx);
    expect(res.status).toBe(0);
    expect(existsSync(fx.markerPath)).toBe(false);
  });

  test('failure warns, leaves the success marker absent, and falls back to the in-hook /council stamp', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const res = runHook(fx, { fakeGenieExit: 1 });
    expect(res.status).toBe(0); // a failed delegation never breaks session start
    expect(res.stderr).toContain('agent sync via genie update failed');

    expect(existsSync(fx.markerPath)).toBe(false);

    // /council still gets stamped on the machines where delegation fails.
    const stamped = join(fx.home, '.claude', 'workflows', 'council.js');
    expect(existsSync(stamped)).toBe(true);
    expect(readFileSync(stamped, 'utf8')).toContain(fx.pluginRoot);
    expect(readFileSync(stamped, 'utf8')).not.toContain('__GENIE_LENS_ROOT__');
  });

  test('a failed delegation remains immediately retryable', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const first = runHook(fx, { fakeGenieExit: 1 });
    expect(first.status).toBe(0);
    const second = runHook(fx, { fakeGenieExit: 1 });
    expect(second.status).toBe(0);
    const attempts = readLog(fx)
      .split('\n')
      .filter((l) => l.includes('update --sync-only'));
    expect(attempts).toHaveLength(2);
    expect(second.stderr).toContain('agent sync via genie update failed');
  });
});

describe('delegateAgentSync version tiers (old-binary-safe invocation)', () => {
  test('flag-aware binary (future default 5.999999.0) → `update --sync-only` + env', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const res = runHook(fx);
    expect(res.status).toBe(0);
    expect(updateInvocations(fx)).toEqual(['CANONICAL env=1 update --sync-only']);
  });

  test('env-aware, flag-unaware binary (5.260710.5) → env-only `update`, NO --sync-only', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const res = runHook(fx, { fakeGenieVersion: '5.260710.5' });
    expect(res.status).toBe(0);
    // commander in .5–.9 rejects the unknown flag before the env is honored —
    // the invocation must be `genie update` with GENIE_UPDATE_SYNC_ONLY=1 only.
    expect(updateInvocations(fx)).toEqual(['CANONICAL env=1 update']);
  });

  test('env-aware, flag-unaware binary (5.260710.9, last flag-unaware release) → env-only `update`', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const res = runHook(fx, { fakeGenieVersion: '5.260710.9' });
    expect(res.status).toBe(0);
    expect(updateInvocations(fx)).toEqual(['CANONICAL env=1 update']);
  });

  test('failed 5.260710.9 child marker is removed so the next SessionStart retries', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const legacyFailure = {
      fakeGenieVersion: '5.260710.9',
      fakeGenieExit: 1,
      fakeGenieWritesFreshMarker: true,
    };

    const first = runHook(fx, legacyFailure);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('agent sync via genie update failed');
    expect(existsSync(fx.markerPath)).toBe(false);

    const second = runHook(fx, legacyFailure);
    expect(second.status).toBe(0);
    expect(second.stderr).toContain('agent sync via genie update failed');
    expect(updateInvocations(fx)).toEqual(['CANONICAL env=1 update', 'CANONICAL env=1 update']);
    expect(existsSync(fx.markerPath)).toBe(false);
  });

  test('failed 5.260710.10 flag-aware child marker is removed so the next SessionStart retries', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const flagAwareFailure = {
      fakeGenieVersion: '5.260710.10',
      fakeGenieExit: 1,
      fakeGenieWritesFreshMarker: true,
    };

    const first = runHook(fx, flagAwareFailure);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('agent sync via genie update failed');
    expect(existsSync(fx.markerPath)).toBe(false);

    const second = runHook(fx, flagAwareFailure);
    expect(second.status).toBe(0);
    expect(second.stderr).toContain('agent sync via genie update failed');
    expect(updateInvocations(fx)).toEqual(['CANONICAL env=1 update --sync-only', 'CANONICAL env=1 update --sync-only']);
    expect(existsSync(fx.markerPath)).toBe(false);
  });

  test('current/new child self-serializes without parent-lease contention and failed marker remains retryable', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const currentFailure = {
      fakeGenieVersion: '5.260711.6',
      fakeGenieExit: 1,
      failIfLifecycleLocked: true,
    };

    const first = runHook(fx, currentFailure);
    expect(first.status).toBe(0);
    expect(readLog(fx)).not.toContain('SELF_CONTENTION');
    expect(existsSync(fx.markerPath)).toBe(false);

    const second = runHook(fx, currentFailure);
    expect(second.status).toBe(0);
    expect(readLog(fx)).not.toContain('SELF_CONTENTION');
    expect(updateInvocations(fx)).toEqual(['CANONICAL env=1 update --sync-only', 'CANONICAL env=1 update --sync-only']);
    expect(existsSync(fx.markerPath)).toBe(false);
  });

  test('5.260711.6+ failure preserves a concurrent success marker written after child lease release', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const concurrentFailure = {
      fakeGenieVersion: '5.260711.6',
      fakeGenieExit: 1,
      failIfLifecycleLocked: true,
      concurrentSuccessAfterRelease: true,
    };

    const first = runHook(fx, concurrentFailure);
    expect(first.status).toBe(0);
    expect(readLog(fx)).not.toContain('SELF_CONTENTION');
    expect(readLog(fx)).toContain('CONCURRENT_SUCCESS_AFTER_RELEASE');
    expect(existsSync(fx.markerPath)).toBe(true);
    const concurrentMarker = readFileSync(fx.markerPath, 'utf8');

    const second = runHook(fx, concurrentFailure);
    expect(second.status).toBe(0);
    expect(updateInvocations(fx)).toEqual(['CANONICAL env=1 update --sync-only']);
    expect(readFileSync(fx.markerPath, 'utf8')).toBe(concurrentMarker);
  });

  test('failed-child cleanup restores a pre-existing stale marker', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const stale = new Date(Date.now() - THROTTLE_MS - 60_000).toISOString();
    writeMarker(fx, stale);

    const res = runHook(fx, {
      fakeGenieVersion: '5.260710.9',
      fakeGenieExit: 1,
      fakeGenieWritesFreshMarker: true,
    });

    expect(res.status).toBe(0);
    expect(readFileSync(fx.markerPath, 'utf8')).toBe(`${stale}\n`);
  });

  test('pre-contract binary (5.260710.4) → delegation skipped entirely, no success marker + /council fallback', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const res = runHook(fx, { fakeGenieVersion: '5.260710.4' });
    expect(res.status).toBe(0);
    // A pre-contract binary ignores GENIE_UPDATE_SYNC_ONLY — invoking `update`
    // would run a full unattended download + binary swap mid-session. Never call it.
    expect(updateInvocations(fx)).toEqual([]);
    expect(res.stderr).toContain('predates the agent-sync contract');

    expect(existsSync(fx.markerPath)).toBe(false);

    // /council still stamped in-hook on exactly these machines.
    const stamped = join(fx.home, '.claude', 'workflows', 'council.js');
    expect(existsSync(stamped)).toBe(true);
    expect(readFileSync(stamped, 'utf8')).toContain(fx.pluginRoot);
  });

  test('unprobeable version output → treated as pre-contract (skip, no update invocation)', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const res = runHook(fx, { fakeGenieVersion: 'not-a-version' });
    expect(res.status).toBe(0);
    expect(updateInvocations(fx)).toEqual([]);
    expect(existsSync(join(fx.home, '.claude', 'workflows', 'council.js'))).toBe(true);
  });
});

describe('findGenieBinary', () => {
  test('prefers the canonical $GENIE_HOME/bin/genie over a genie on PATH', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    installFakeGenie(fx, 'path', 'PATH');
    runHook(fx);
    const log = readLog(fx);
    expect(log).toContain('CANONICAL env=1 update --sync-only');
    expect(log).not.toContain('PATH env=1 update --sync-only');
  });

  test('falls back to a genie on PATH when the canonical binary is absent', () => {
    installFakeGenie(fx, 'path', 'PATH');
    const res = runHook(fx);
    expect(res.status).toBe(0);
    expect(readLog(fx)).toContain('PATH env=1 update --sync-only');
  });

  test('no genie anywhere → in-hook /council stamp still runs (plugin-only machine)', () => {
    const res = runHook(fx);
    expect(res.status).toBe(0);
    expect(readLog(fx)).not.toContain('update --sync-only');
    const stamped = join(fx.home, '.claude', 'workflows', 'council.js');
    expect(existsSync(stamped)).toBe(true);
    expect(readFileSync(stamped, 'utf8')).toContain(fx.pluginRoot);
  });
});

describe('CJS council fallback lifecycle lease', () => {
  test('defers without recovery or writes while a TS lifecycle writer owns GENIE_HOME', () => {
    const lease = acquireLifecycleLease(fx.genieHome);
    expect('skipped' in lease).toBe(false);
    if ('skipped' in lease) throw new Error(lease.skipped);
    const lockPath = lifecycleLockPath(fx.genieHome);
    const ownerRecord = readFileSync(lockPath, 'utf8');
    try {
      const blocked = runHook(fx);
      expect(blocked.status).toBe(0);
      expect(blocked.stderr).toContain('another Genie lifecycle writer holds the lease');
      expect(existsSync(join(fx.home, '.claude', 'workflows', 'council.js'))).toBe(false);
      expect(readFileSync(lockPath, 'utf8')).toBe(ownerRecord);
    } finally {
      lease.release();
    }

    const retry = runHook(fx);
    expect(retry.status).toBe(0);
    expect(existsSync(join(fx.home, '.claude', 'workflows', 'council.js'))).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});
