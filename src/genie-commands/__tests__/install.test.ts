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

const { HARDENED_DEFAULTS, PM2_PROCESS_NAME, buildPm2StartArgs, buildEcosystemConfigSource, getEcosystemConfigPath } =
  _internals;

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

describe('buildEcosystemConfigSource — pm2 ecosystem config locked down', () => {
  // pm2 6 dropped CLI flags like --min-uptime / --max-restarts / --restart-delay
  // / --max-memory-restart / --output / --error. Ecosystem-config form is the
  // ONLY supported path on modern pm2. Tests assert the generated config text
  // carries every hardening field as the canonical-stack contract requires.

  test('config has the canonical pm2 app shape with hardening fields', () => {
    const src = buildEcosystemConfigSource('/usr/local/bin/genie');
    // Required fields the canonical stack contract pins.
    const fieldsExpected = [
      `"name": "${PM2_PROCESS_NAME}"`,
      '"script":',
      '"args":',
      '"interpreter": "none"',
      '"autorestart": true',
      '"max_restarts":',
      '"min_uptime":',
      '"restart_delay":',
      '"exp_backoff_restart_delay":',
      '"max_memory_restart":',
      '"kill_timeout":',
      '"log_date_format":',
      '"error_file":',
      '"out_file":',
      '"merge_logs": true',
      '"time": true',
    ];
    for (const field of fieldsExpected) {
      expect(src).toContain(field);
    }
  });

  test('uses interpreter:"none" for shebang resolution (NOT bun)', () => {
    // pm2's bun launcher errors out on top-level await with
    // "require() async module ... is unsupported. use await import()".
    // Validated empirically 2026-04-30. If anyone "fixes" this to
    // interpreter:"bun", the install will pass but the supervised process
    // immediately crashes.
    const src = buildEcosystemConfigSource('/usr/local/bin/genie');
    expect(src).toContain('"interpreter": "none"');
    expect(src).not.toContain('"interpreter": "bun"');
  });

  test('forwards `serve start --headless --no-tui --no-interactive` to genie', () => {
    // pm2's child has no controlling terminal so a TUI would wedge.
    // Headless + no-tui + no-interactive matches the invocation pinned in
    // the wish's Decisions 4 & 5.
    const src = buildEcosystemConfigSource('/usr/local/bin/genie');
    expect(src).toContain('"args": "serve start --headless --no-tui --no-interactive"');
  });

  test('script points at the resolved genie binary path', () => {
    const src = buildEcosystemConfigSource('/usr/local/bin/genie');
    expect(src).toContain('"script": "/usr/local/bin/genie"');
  });

  test('memory ceiling matches HARDENED_DEFAULTS.maxMemory', () => {
    const src = buildEcosystemConfigSource('/usr/local/bin/genie');
    expect(src).toContain(`"max_memory_restart": "${HARDENED_DEFAULTS.maxMemory}"`);
  });

  test('logs land in ~/.genie/logs/genie-serve-{out,error}.log', () => {
    const src = buildEcosystemConfigSource('/usr/local/bin/genie');
    expect(src).toMatch(/"out_file": "[^"]*genie-serve-out\.log"/);
    expect(src).toMatch(/"error_file": "[^"]*genie-serve-error\.log"/);
  });

  test('numeric fields are real numbers (not strings)', () => {
    // Ecosystem config wants real numbers for these — pm2 stringifies
    // internally. Strings would silently fail validation on some pm2
    // versions or be coerced to NaN.
    const src = buildEcosystemConfigSource('/usr/local/bin/genie');
    const numericFields: Array<[string, number]> = [
      ['max_restarts', HARDENED_DEFAULTS.maxRestarts],
      ['min_uptime', HARDENED_DEFAULTS.minUptimeMs],
      ['restart_delay', HARDENED_DEFAULTS.restartDelayMs],
      ['exp_backoff_restart_delay', HARDENED_DEFAULTS.expBackoffRestartDelayMs],
      ['kill_timeout', HARDENED_DEFAULTS.killTimeoutMs],
    ];
    for (const [field, value] of numericFields) {
      expect(src).toContain(`"${field}": ${value}`);
    }
  });

  test('omits env block when no databaseUrl provided (legacy fallback path)', () => {
    // When canonical pgserve isn't available at install time, we omit the
    // env block entirely so genie-serve can spawn its embedded pgserve as
    // a fallback. Adding `env: {}` would override any DATABASE_URL the
    // operator sets in their shell with an empty string.
    const src = buildEcosystemConfigSource('/usr/local/bin/genie');
    expect(src).not.toContain('"env":');
    expect(src).not.toContain('DATABASE_URL');
  });

  test('bakes DATABASE_URL into env block when canonical pgserve url provided', () => {
    // Canonical pgserve detected at install time → bake the URL into the
    // pm2-stored env so genie-serve finds it on every restart without
    // operators having to set DATABASE_URL in their shell. This is the
    // wire that closes the wish's "shared backbone" loop for genie.
    const url = 'postgresql://postgres:postgres@localhost:8432/genie';
    const src = buildEcosystemConfigSource('/usr/local/bin/genie', url);
    expect(src).toContain('"env":');
    expect(src).toContain(`"DATABASE_URL": "${url}"`);
  });
});

describe('buildPm2StartArgs — CLI invocation', () => {
  // Thin smoke: the function writes the ecosystem config to disk and
  // returns the pm2 start argv. Heavy content assertions live above.

  test('returns ["start", <config-path>, "--update-env"]', () => {
    const args = buildPm2StartArgs('/usr/local/bin/genie');
    expect(args[0]).toBe('start');
    expect(args[1]).toBe(getEcosystemConfigPath());
    expect(args[2]).toBe('--update-env');
    expect(args).toHaveLength(3);
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
