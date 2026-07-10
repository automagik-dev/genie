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

const SCRIPT_PATH = join(import.meta.dir, '..', '..', 'plugins', 'genie', 'scripts', 'smart-install.js');
const THROTTLE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;

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
    'if [ "$1" = "--version" ]; then',
    '  echo "5.999.0"',
    '  exit 0',
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

function runHook(fx: Fixture, opts: { fakeGenieExit?: number } = {}) {
  const env: Record<string, string> = {
    HOME: fx.home,
    PATH: `${fx.fakeBin}:${CLEAN_PATH}`,
    GENIE_HOME: fx.genieHome,
    CLAUDE_PLUGIN_ROOT: fx.pluginRoot,
    FAKE_GENIE_LOG: fx.logPath,
  };
  if (opts.fakeGenieExit !== undefined) env.FAKE_GENIE_EXIT = String(opts.fakeGenieExit);
  return spawnSync(NODE_BIN as string, [SCRIPT_PATH], { env, encoding: 'utf-8', timeout: 30_000 });
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

  test('success writes the throttle marker hook-side (~now)', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const before = Date.now();
    const res = runHook(fx);
    expect(res.status).toBe(0);
    expect(existsSync(fx.markerPath)).toBe(true);
    const ts = Date.parse(readFileSync(fx.markerPath, 'utf8').trim());
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('failure warns, writes a retry-window marker, and falls back to the in-hook /council stamp', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const res = runHook(fx, { fakeGenieExit: 1 });
    expect(res.status).toBe(0); // a failed delegation never breaks session start
    expect(res.stderr).toContain('agent sync via genie update failed');

    // Backdated marker: throttled right now, but stale again after ~RETRY_MS
    // instead of the full 6h window (and instead of retrying every session).
    const ts = Date.parse(readFileSync(fx.markerPath, 'utf8').trim());
    const delta = Date.now() - ts;
    expect(delta).toBeLessThan(THROTTLE_MS);
    expect(delta).toBeGreaterThan(THROTTLE_MS - RETRY_MS - 60_000);

    // /council still gets stamped on the machines where delegation fails.
    const stamped = join(fx.home, '.claude', 'workflows', 'council.js');
    expect(existsSync(stamped)).toBe(true);
    expect(readFileSync(stamped, 'utf8')).toContain(fx.pluginRoot);
    expect(readFileSync(stamped, 'utf8')).not.toContain('__GENIE_LENS_ROOT__');
  });

  test('a failed delegation does not retry on the very next session start', () => {
    installFakeGenie(fx, 'canonical', 'CANONICAL');
    const first = runHook(fx, { fakeGenieExit: 1 });
    expect(first.status).toBe(0);
    const second = runHook(fx, { fakeGenieExit: 1 });
    expect(second.status).toBe(0);
    const attempts = readLog(fx)
      .split('\n')
      .filter((l) => l.includes('update --sync-only'));
    expect(attempts).toHaveLength(1); // second run throttled by the retry-window marker
    expect(second.stderr).not.toContain('agent sync via genie update failed');
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
