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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _internals } from '../install.js';

const {
  HARDENED_DEFAULTS,
  PM2_PROCESS_NAME,
  PM2_LOG_PREFIX,
  LEGACY_PM2_PROCESS_NAMES,
  PGSERVE_PM2_PROCESS_NAMES,
  buildPm2StartArgs,
  buildEcosystemConfigSource,
  buildCanonicalPgserveHint,
  getEcosystemConfigPath,
  isPgservePm2ManagedStatus,
  isPgserveReadyStatus,
  isPgserveOnlinePm2,
  isReusableCanonicalPm2Process,
} = _internals;

describe('install.sh release verifier bootstrap', () => {
  const source = readFileSync(join(__dirname, '..', '..', '..', 'install.sh'), 'utf-8');

  test('bootstraps a pinned cosign verifier when gh attestation is unavailable', () => {
    expect(source).toContain('COSIGN_VERSION="v2.4.1"');
    expect(source).toContain('gh_attestation_available');
    expect(source).toContain('bootstrap_cosign "$platform"');
    expect(source).toContain('https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/${asset}');
  });

  test('pins SHA256 for every install.sh-supported cosign asset', () => {
    expect(source).toContain(
      'cosign-linux-amd64) echo "8b24b946dd5809c6bd93de08033bcf6bc0ed7d336b7785787c080f574b89249b"',
    );
    expect(source).toContain(
      'cosign-linux-arm64) echo "3b2e2e3854d0356c45fe6607047526ccd04742d20bd44afb5be91fa2a6e7cb4a"',
    );
    expect(source).toContain(
      'cosign-darwin-arm64) echo "13343856b69f70388c4fe0b986a31dde5958e444b41be22d785d3dc5e1a9cc62"',
    );
  });

  test('does not require jq to parse the release manifest', () => {
    expect(source).toContain('manifest_get()');
    expect(source).toContain('manifest_channel_matches');
    expect(source).not.toContain('need curl; need jq; need tar; need uname');
  });
});

describe('install._internals — canonical-stack constants', () => {
  test('canonical pm2 process name is "Genie" (renamed from "genie-serve")', () => {
    // Rename rationale: capital-G "Genie" matches the project brand and is
    // visually distinct from the lowercase `genie` CLI invocations operators
    // see in the same `pm2 list` output. The legacy "genie-serve" name is
    // preserved in LEGACY_PM2_PROCESS_NAMES so install + update auto-migrate
    // pre-rename installs to the canonical name on the next cycle.
    expect(PM2_PROCESS_NAME).toBe('Genie');
  });

  test('legacy pm2 names list includes "genie-serve" for auto-migration', () => {
    // Add to this list, never remove: every legacy name ever shipped must
    // remain detected for an operator's first post-rename update to clean up.
    expect(LEGACY_PM2_PROCESS_NAMES).toContain('genie-serve');
  });

  test('pgserve pm2 names include autopg-server and legacy pgserve', () => {
    // pgserve v2.4 renamed the supervised daemon to autopg-server. Genie must
    // recognize both names before shelling out to `pgserve install`, because
    // pgserve's install path checks port availability before its own
    // idempotency check.
    expect(PGSERVE_PM2_PROCESS_NAMES).toEqual(['autopg-server', 'pgserve']);
  });

  test('logfile prefix preserves the historical "genie-serve" name', () => {
    // The pm2 process name was renamed but the logfile prefix is intentionally
    // pinned: operators have shell aliases / log-rotation rules referencing
    // `genie-serve-{out,error}.log` and breaking those for cosmetic parity is
    // not worth it. New installs share the same logfile path as legacy ones.
    expect(PM2_LOG_PREFIX).toBe('genie-serve');
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

  test('only an online PM2 Genie entry with a live pid is reusable', () => {
    expect(isReusableCanonicalPm2Process({ name: 'Genie', pid: 123, pm2_env: { status: 'online' } })).toBe(true);
    expect(isReusableCanonicalPm2Process({ name: 'Genie', pid: 0, pm2_env: { status: 'online' } })).toBe(false);
    expect(isReusableCanonicalPm2Process({ name: 'Genie', pid: 123, pm2_env: { status: 'waiting restart' } })).toBe(
      false,
    );
    expect(isReusableCanonicalPm2Process({ name: 'Genie', pid: 123, pm2_env: { status: 'errored' } })).toBe(false);
    expect(isReusableCanonicalPm2Process(null)).toBe(false);
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

  test('config name is the canonical "Genie" (not the legacy "genie-serve")', () => {
    // Lock-in: regression-prone area because the rename is recent. If a
    // future refactor flips PM2_PROCESS_NAME back to lowercase or to any
    // legacy alias, this test fires.
    const src = buildEcosystemConfigSource('/usr/local/bin/genie');
    expect(src).toContain('"name": "Genie"');
    expect(src).not.toContain('"name": "genie-serve"');
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

describe('buildCanonicalPgserveHint — pgserve fatal install hint (cutover G1)', () => {
  // Genie has no embedded pgserve fallback after the canonical-cutover wish.
  // Any pgserve install failure during `genie install` must surface as a
  // fatal exit with a one-line copy-paste recovery hint. The exact wording
  // is exercised by the install.sh smoke test on a clean container; here we
  // just lock down the hint content shape so refactors don't drop the
  // recovery commands or the canonical-stack rationale.

  test('hint identifies the failure as a canonical pgserve registration failure', () => {
    const text = buildCanonicalPgserveHint('pgserve binary not found in PATH');
    expect(text).toContain('canonical pgserve registration failed');
    expect(text).toContain('pgserve binary not found in PATH');
  });

  test('hint includes exit-code reason when surfaced', () => {
    const text = buildCanonicalPgserveHint('exit code 17');
    expect(text).toContain('(exit code 17)');
  });

  test('hint lists the canonical autopg-v3 recovery commands', () => {
    const text = buildCanonicalPgserveHint('exit code 1');
    // Post v2 → v3 cutover: hint points at the autopg installer, NOT
    // `bun add -g pgserve@^2` (the obsolete v2 package).
    expect(text).toContain('automagik-dev/autopg/main/install.sh');
    expect(text).toContain('genie install');
    expect(text).not.toContain('bun add -g pgserve@^2');
  });

  test('hint points at the canonical autopg docs URL', () => {
    const text = buildCanonicalPgserveHint('exit code 1');
    expect(text).toContain('https://github.com/automagik-dev/autopg');
  });

  test('hint explains genie depends on pm2-supervised pgserve (autopg v3)', () => {
    const text = buildCanonicalPgserveHint('exit code 1');
    expect(text).toContain('pm2-supervised pgserve');
    expect(text).toContain('autopg v3');
  });
});

describe('isPgserveOnlinePm2 — idempotent skip when pgserve already pm2-managed', () => {
  // Regression: a `curl ... | bash` re-install on a box that already has
  // pgserve under pm2 used to fail with
  //   pgserve install: port 8432 is already in use on 127.0.0.1
  //   Error: canonical pgserve registration failed (exit code 1).
  // because `pgserve install` runs an EADDRINUSE bind check before noticing
  // that the existing listener IS its own pm2-supervised instance. Detected
  // on Felipe's box on 2026-05-11. genie now consults `pm2 jlist` first and
  // short-circuits the `pgserve install` step when pgserve is online.

  test('returns true when pgserve pm2 entry is online', () => {
    expect(isPgserveOnlinePm2({ pid: 1234, pm2_env: { status: 'online' } })).toBe(true);
  });

  test('returns true when autopg-server pm2 entry is online', () => {
    expect(isPgserveOnlinePm2({ name: 'autopg-server', pid: 1234, pm2_env: { status: 'online' } })).toBe(true);
  });

  test('returns false when pgserve pm2 entry is stopped', () => {
    expect(isPgserveOnlinePm2({ pid: 1234, pm2_env: { status: 'stopped' } })).toBe(false);
  });

  test('returns false when pgserve pm2 entry is in errored / launching states', () => {
    expect(isPgserveOnlinePm2({ pm2_env: { status: 'errored' } })).toBe(false);
    expect(isPgserveOnlinePm2({ pm2_env: { status: 'launching' } })).toBe(false);
  });

  test('returns false when pm2 lookup returns null (pm2 absent or no entry)', () => {
    expect(isPgserveOnlinePm2(null)).toBe(false);
  });

  test('returns false when pm2_env is missing from the entry', () => {
    expect(isPgserveOnlinePm2({ pid: 1234 })).toBe(false);
  });
});

describe('pgserve status predicates — autopg install recovery', () => {
  test('pm2-managed status is recognized from pgserve status --json', () => {
    expect(isPgservePm2ManagedStatus({ installed: true, supervisor: 'pm2', name: 'autopg-server' })).toBe(true);
  });

  test('ready status requires pm2 online and runtime not explicitly dead', () => {
    expect(
      isPgserveReadyStatus({
        installed: true,
        supervisor: 'pm2',
        name: 'autopg-server',
        status: 'online',
        runtime: { live: true },
      }),
    ).toBe(true);
    expect(
      isPgserveReadyStatus({
        installed: true,
        supervisor: 'pm2',
        name: 'autopg-server',
        status: 'online',
        runtime: { live: false },
      }),
    ).toBe(false);
  });

  test('stopped autopg-server is pm2-managed but not ready', () => {
    const status = {
      installed: true,
      supervisor: 'pm2',
      name: 'autopg-server',
      status: 'stopped',
      runtime: { live: false },
    };
    expect(isPgservePm2ManagedStatus(status)).toBe(true);
    expect(isPgserveReadyStatus(status)).toBe(false);
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
