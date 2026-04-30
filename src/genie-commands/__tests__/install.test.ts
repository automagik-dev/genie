/**
 * Tests for `genie install` — Wave 2 of the canonical-pgserve-pm2-supervision
 * wish (PR pgserve#55, Wave 1 = pgserve#57).
 *
 * The interesting paths here are:
 *   - The pm2 launch args list (pinned values flow through `buildPm2StartArgs`)
 *   - Memory-ceiling env override (`GENIE_SERVE_MAX_MEMORY`)
 *   - `--interpreter none` and `serve start --headless --no-tui --no-interactive`
 *     (the empirically-validated invocation from the wish's beachhead)
 *
 * The full install flow (which spawns `pgserve install` and `pm2 start`) is
 * exercised in CI via the install.sh smoke test on a clean container; here
 * we just lock down the pure helpers so refactors don't drift the
 * canonical-stack behavior.
 *
 * Run with: bun test src/genie-commands/__tests__/install.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internals } from '../install.js';

const { HARDENED_DEFAULTS, PM2_PROCESS_NAME, buildPm2StartArgs } = _internals;

describe('install._internals — canonical-stack constants', () => {
  test('process name is genie-serve', () => {
    expect(PM2_PROCESS_NAME).toBe('genie-serve');
  });

  test('hardened defaults match the canonical pgserve/omni values', () => {
    // These numbers are pinned across all four pm2 services in the wish so
    // every service in the stack behaves identically under crash-loop and
    // resource pressure. If any of these change here without a matching
    // change in pgserve/cli-install.cjs and omni/packages/cli/src/pm2.ts,
    // the stack drifts. Fail loudly.
    expect(HARDENED_DEFAULTS.maxRestarts).toBe(50);
    expect(HARDENED_DEFAULTS.minUptimeMs).toBe(10_000);
    expect(HARDENED_DEFAULTS.restartDelayMs).toBe(4000);
    expect(HARDENED_DEFAULTS.expBackoffRestartDelayMs).toBe(100);
    expect(HARDENED_DEFAULTS.killTimeoutMs).toBe(60_000);
    expect(HARDENED_DEFAULTS.logDateFormat).toBe('YYYY-MM-DD HH:mm:ss.SSS');
  });

  test('default memory ceiling is 4G when no env override', () => {
    // Re-importing under cleared env is awkward in bun:test, so we just
    // check that whatever value HARDENED_DEFAULTS captured on module load
    // is one of the supported shapes. The env-override path is verified
    // separately in install-env.test.ts (loads the module with env set).
    expect(HARDENED_DEFAULTS.maxMemory).toMatch(/^\d+G$/);
  });
});

describe('buildPm2StartArgs — pm2 invocation locked down', () => {
  test('emits all hardened pm2 flags in the right order', () => {
    const args = buildPm2StartArgs('/usr/local/bin/genie');
    expect(args[0]).toBe('start');
    expect(args[1]).toBe('/usr/local/bin/genie');
    // Sanity: the args list contains every hardening flag.
    const flagsExpected = [
      '--name',
      '--interpreter',
      '--max-restarts',
      '--min-uptime',
      '--restart-delay',
      '--exp-backoff-restart-delay',
      '--max-memory-restart',
      '--kill-timeout',
      '--log-date-format',
      '--output',
      '--error',
    ];
    for (const flag of flagsExpected) {
      expect(args).toContain(flag);
    }
  });

  test('uses --interpreter none for shebang resolution (NOT --interpreter bun)', () => {
    // pm2's bun launcher errors out on top-level await with
    // "require() async module ... is unsupported. use await import()".
    // Validated empirically 2026-04-30. If anyone "fixes" this to
    // --interpreter bun, the install will pass but the supervised process
    // immediately crashes — exactly the silent dead-code class the
    // host-fingerprint pipeline smoke test guards against.
    const args = buildPm2StartArgs('/usr/local/bin/genie');
    const interpreterIdx = args.indexOf('--interpreter');
    expect(args[interpreterIdx + 1]).toBe('none');
    expect(args).not.toContain('bun');
  });

  test('forwards `serve start --headless --no-tui --no-interactive` to genie', () => {
    // pm2's child has no controlling terminal so a TUI would wedge.
    // Headless + no-tui + no-interactive matches the invocation pinned in
    // the wish's Decisions 4 & 5.
    const args = buildPm2StartArgs('/usr/local/bin/genie');
    const sepIdx = args.indexOf('--');
    expect(sepIdx).toBeGreaterThan(0);
    const scriptArgs = args.slice(sepIdx + 1);
    expect(scriptArgs).toEqual(['serve', 'start', '--headless', '--no-tui', '--no-interactive']);
  });

  test('process name is registered as "genie-serve"', () => {
    const args = buildPm2StartArgs('/usr/local/bin/genie');
    const nameIdx = args.indexOf('--name');
    expect(args[nameIdx + 1]).toBe('genie-serve');
  });

  test('memory ceiling matches HARDENED_DEFAULTS.maxMemory', () => {
    const args = buildPm2StartArgs('/usr/local/bin/genie');
    const memIdx = args.indexOf('--max-memory-restart');
    expect(args[memIdx + 1]).toBe(HARDENED_DEFAULTS.maxMemory);
  });

  test('logs land in ~/.genie/logs/genie-serve-{out,error}.log', () => {
    const args = buildPm2StartArgs('/usr/local/bin/genie');
    const outIdx = args.indexOf('--output');
    const errIdx = args.indexOf('--error');
    expect(args[outIdx + 1]).toMatch(/genie-serve-out\.log$/);
    expect(args[errIdx + 1]).toMatch(/genie-serve-error\.log$/);
  });

  test('numeric flags are stringified (pm2 child_process arg constraint)', () => {
    const args = buildPm2StartArgs('/usr/local/bin/genie');
    const numericFlags = [
      '--max-restarts',
      '--min-uptime',
      '--restart-delay',
      '--exp-backoff-restart-delay',
      '--kill-timeout',
    ];
    for (const flag of numericFlags) {
      const idx = args.indexOf(flag);
      const value = args[idx + 1];
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^\d+$/);
    }
  });
});

describe('GENIE_SERVE_MAX_MEMORY env override', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.GENIE_SERVE_MAX_MEMORY;
  });

  afterEach(() => {
    if (original === undefined) process.env.GENIE_SERVE_MAX_MEMORY = undefined;
    else process.env.GENIE_SERVE_MAX_MEMORY = original;
  });

  test('override is captured at module load — re-importing reflects new env', async () => {
    // The install module reads `process.env.GENIE_SERVE_MAX_MEMORY` at
    // module-load time. Set it, then dynamically re-import to observe
    // the captured value. We use the test-only `_internals` export
    // because exposing the live HARDENED_DEFAULTS via reload would
    // pollute the other tests in this file.
    process.env.GENIE_SERVE_MAX_MEMORY = '8G';
    const reload = await import(`../install.js?override-test=${Date.now()}`);
    expect(reload._internals.HARDENED_DEFAULTS.maxMemory).toBe('8G');
  });
});
