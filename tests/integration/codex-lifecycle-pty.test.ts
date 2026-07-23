/**
 * Group E deliverable 5 — the real-PTY lifecycle flow:
 *
 *   repair handoff (missing delivery record → typed refusal with the one
 *   recovery command) → record published (as update/install repair would) →
 *   `genie setup --codex` under a REAL pty (consent answered on /dev/tty) →
 *   explicit new-task instruction → `genie doctor --json` state `current`,
 *   plus the real PATH advisory, stale historical config, route collision /
 *   shadowing, context states, and a hard query failure — all through the
 *   actual setup/doctor command implementations, a stateful fake `codex`
 *   executable, and the production GENIE_HOME payload layout (no canonical-root
 *   override). An unshipped driver injects only deterministic bundle-signature
 *   verification because production deliberately exposes no CLI/env bypass.
 *
 * PTY allocation uses the platform `script(1)`; the suite skips cleanly where
 * a pty cannot be allocated (no `script`, or Windows). The fake codex lives
 * OUTSIDE the repo/CWD so trusted-executable validation applies unchanged.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDownloadedDeliveryEvidence } from '../../src/lib/codex-delivery-evidence.js';
import { buildTestDeliveryEvidencePack } from '../../src/lib/codex-delivery-evidence.test-support.js';
import { acquireLifecycleLease } from '../../src/lib/codex-lifecycle-lease.js';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const PRODUCTION_GENIE_CLI = join(REPO_ROOT, 'src', 'genie.ts');
const LIFECYCLE_TEST_RUNNER = join(REPO_ROOT, 'tests', 'support', 'codex-lifecycle-test-runner.ts');
const REAL_SESSION_CONTEXT = join(REPO_ROOT, 'plugins', 'genie', 'scripts', 'session-context.cjs');
const REAL_MCP_LAUNCHER = join(REPO_ROOT, 'plugins', 'genie', 'scripts', 'mcp-launcher.cjs');
const REAL_CODEX_AGENTS = join(REPO_ROOT, 'plugins', 'genie', 'codex-agents');
const REAL_SKILLS = join(REPO_ROOT, 'plugins', 'genie', 'skills');
const TARGET = '5.260722.1';
const OLD = '5.260711.9';
const PLATFORM_ID =
  process.platform === 'darwin' ? 'darwin-arm64' : process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64-glibc';
const PLATFORM_TRIPLE = `${process.platform}-${process.arch}`;

// PTY driver: GNU `script -qec` forwards piped stdin to the pty on Linux (the
// CI condition); macOS `script` refuses a non-tty stdin (tcgetattr), so darwin
// drives the pty through the preinstalled `expect` instead.
const SCRIPT_BIN = Bun.which('script');
const EXPECT_BIN = Bun.which('expect');
const CAN_PTY =
  process.platform === 'linux' ? SCRIPT_BIN !== null : process.platform === 'darwin' ? EXPECT_BIN !== null : false;

let root: string;
let genieHome: string;
let codexHome: string;
let repo: string;
let binDir: string;
let stateDir: string;
let fakeCodex: string;
let childEnv: Record<string, string>;

function deliveryRecordPath(): string {
  return join(genieHome, '.codex-plugin-delivery-record.json');
}

/** Stage the whole fixture once; individual tests advance the lifecycle in order. */
beforeAll(() => {
  if (!CAN_PTY) return;
  root = mkdtempSync(join(tmpdir(), 'genie-pty-lifecycle-'));
  genieHome = join(root, 'genie-home');
  codexHome = join(root, 'codex-home');
  repo = join(root, 'repo');
  binDir = join(root, 'bin');
  stateDir = join(root, 'codex-state');
  for (const dir of [genieHome, codexHome, repo, binDir, stateDir, join(root, 'home'), join(root, 'tmp')]) {
    mkdirSync(dir, { recursive: true });
  }

  // Canonical payload at the PRODUCTION location: $GENIE_HOME/plugins/genie
  // (+ VERSION beside it) — no canonicalRoot override anywhere in this suite.
  const payload = join(genieHome, 'plugins', 'genie');
  mkdirSync(join(payload, 'scripts'), { recursive: true });
  mkdirSync(join(payload, 'hooks'), { recursive: true });
  cpSync(REAL_SESSION_CONTEXT, join(payload, 'scripts', 'session-context.cjs'));
  cpSync(REAL_MCP_LAUNCHER, join(payload, 'scripts', 'mcp-launcher.cjs'));
  cpSync(REAL_CODEX_AGENTS, join(payload, 'codex-agents'), { recursive: true });
  cpSync(REAL_SKILLS, join(payload, 'skills'), { recursive: true });
  writeFileSync(join(payload, 'README.md'), 'genie codex payload\n');
  writeFileSync(join(payload, 'hooks', 'codex-hooks.json'), '{"hooks":{}}\n');
  writeFileSync(join(genieHome, 'VERSION'), `${TARGET}\n`);
  mkdirSync(join(genieHome, 'bin'), { recursive: true });
  const fixtureBinary = join(genieHome, 'bin', 'genie');
  writeFileSync(
    fixtureBinary,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(PRODUCTION_GENIE_CLI)} "$@"\n`,
  );
  chmodSync(fixtureBinary, 0o755);

  // Codex home: enabled plugin flag + an OLD physical cache generation so the
  // pre-activation state is genuinely activation-pending.
  writeFileSync(join(codexHome, 'config.toml'), `[plugins."genie@automagik"]\nenabled = true\n`);
  const familyDir = join(codexHome, 'plugins', 'cache', 'automagik', 'genie');
  mkdirSync(join(familyDir, OLD), { recursive: true });
  writeFileSync(join(familyDir, OLD, 'README.md'), 'old generation\n');
  writeFileSync(join(stateDir, 'registered'), `${OLD}\n`);

  // The stateful fake codex CLI (outside the repo → passes trusted-executable).
  fakeCodex = join(binDir, 'codex');
  writeFileSync(
    fakeCodex,
    `#!/bin/bash
set -u
cmd="$*"
if [ "\${1:-}" = "--version" ]; then echo "codex 0.0.0-fake"; exit 0; fi
if [ "$cmd" = "plugin list --json" ]; then
  if [ -n "\${FAKE_CODEX_ADVISORY:-}" ]; then printf '\\033[33m%s\\033[0m\\n' "$FAKE_CODEX_ADVISORY" >&2; fi
  if [ -n "\${FAKE_CODEX_EXIT:-}" ]; then echo "hard failure" >&2; exit "$FAKE_CODEX_EXIT"; fi
  ver=$(cat "$FAKE_CODEX_STATE/registered" 2>/dev/null | tr -d '\\n')
  enabled=true
  grep -q 'enabled = false' "$CODEX_HOME/config.toml" 2>/dev/null && enabled=false
  if [ -z "$ver" ]; then echo '{"installed":[]}'; else
    printf '{"installed":[{"pluginId":"genie@automagik","enabled":%s,"version":"%s"}]}\\n' "$enabled" "$ver"
  fi
  exit 0
fi
if [ "$cmd" = "plugin add genie@automagik --json" ]; then
  target_dir="$CODEX_HOME/plugins/cache/automagik/genie/$FAKE_CODEX_TARGET"
  mkdir -p "$target_dir"
  cp -R "$GENIE_HOME/plugins/genie/." "$target_dir/"
  printf '%s\\n' "$FAKE_CODEX_TARGET" > "$FAKE_CODEX_STATE/registered"
  printf '[plugins."genie@automagik"]\\nenabled = true\\n' > "$CODEX_HOME/config.toml"
  echo '{}'
  exit 0
fi
echo '{}'
exit 0
`,
  );
  chmodSync(fakeCodex, 0o755);

  // A real project repo, initialized + trusted, whose route genie init owns.
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'pty@test.local'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'PTY Test'], { cwd: repo });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'seed'], { cwd: repo });

  childEnv = {
    ...process.env,
    HOME: join(root, 'home'),
    GENIE_HOME: genieHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: join(root, 'home', 'claude'),
    HERMES_HOME: join(root, 'home', 'hermes'),
    TMPDIR: join(root, 'tmp'),
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_CODEX_STATE: stateDir,
    FAKE_CODEX_TARGET: TARGET,
    TERM: 'xterm',
  } as Record<string, string>;
  for (const key of ['CI', 'CODEX_THREAD_ID', 'GENIE_BUNDLE_ROOT', 'GENIE_WORKER', 'FAKE_CODEX_ADVISORY']) {
    delete childEnv[key];
  }

  // Trust the repo in the global Codex config (Group E trust classifier).
  // Codex records whatever spelling it saw; cover the logical AND physical
  // spelling of the tmp path (macOS /var vs /private/var).
  const repoSpellings = [...new Set([repo, realpathSync(repo)])];
  writeFileSync(
    join(codexHome, 'config.toml'),
    `[plugins."genie@automagik"]\nenabled = true\n${repoSpellings
      .map((spelling) => `[projects."${spelling}"]\ntrust_level = "trusted"\n`)
      .join('')}`,
  );

  // `genie init` owns the marker-managed project route (the ONLY command that
  // may create it — authority matrix row 1). Route-only, delivery-independent.
  const init = Bun.spawnSync([process.execPath, PRODUCTION_GENIE_CLI, 'init'], {
    cwd: repo,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  if (init.exitCode !== 0) {
    throw new Error(`genie init failed (${init.exitCode}): ${init.stdout.toString()}${init.stderr.toString()}`);
  }
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function runCli(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, LIFECYCLE_TEST_RUNNER, ...args], {
    cwd: opts.cwd ?? repo,
    env: opts.env ?? childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Run the CLI under a REAL pty; `input` is delivered to the pty (read via /dev/tty). */
function runPty(
  args: string[],
  input: string,
  opts: { env?: Record<string, string> } = {},
): { exitCode: number; output: string } {
  const cli = [process.execPath, LIFECYCLE_TEST_RUNNER, ...args];
  if (process.platform === 'darwin') {
    // expect(1): spawn on a pty, queue the consent answer, exit with the
    // child's status. Braced words keep tmp paths literal (no spaces in them).
    const spawnWords = cli.map((part) => `{${part}}`).join(' ');
    const sendWords = input.replaceAll('\n', '\\r');
    const expectScript = [
      'set timeout 120',
      `spawn -noecho ${spawnWords}`,
      `send -- "${sendWords}"`,
      'expect eof',
      'catch wait result',
      'exit [lindex $result 3]',
    ].join('\n');
    const proc = Bun.spawnSync([EXPECT_BIN as string, '-c', expectScript], {
      cwd: repo,
      env: opts.env ?? childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 150_000,
    });
    return { exitCode: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
  }
  const argv = [
    SCRIPT_BIN as string,
    '-qec',
    cli.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(' '),
    '/dev/null',
  ];
  const proc = Bun.spawnSync(argv, {
    cwd: repo,
    env: opts.env ?? childEnv,
    stdin: Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  });
  return { exitCode: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

interface DoctorJson {
  ok: boolean;
  checks: Array<{ name: string; status: string; detail?: string; advisory?: string; routeLayers?: unknown[] }>;
  integrationSummary?: { codexPlugin: { state: string; deliveryComplete: boolean; recovery: string } };
}

function doctorJson(opts: { env?: Record<string, string>; cwd?: string } = {}): {
  json: DoctorJson;
  exitCode: number;
  raw: string;
} {
  const { exitCode, stdout } = runCli(['doctor', '--json'], opts);
  return { json: JSON.parse(stdout) as DoctorJson, exitCode, raw: stdout };
}

describe.skipIf(!CAN_PTY)('codex lifecycle over a real PTY (Group E deliverable 5)', () => {
  test('stage 1 — missing delivery record: setup refuses BEFORE consent with the one recovery command', () => {
    expect(existsSync(deliveryRecordPath())).toBe(false);
    const { exitCode, stdout, stderr } = runCli(['setup', '--codex']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('delivery record is absent');
    expect(stderr).toContain('genie update');
    expect(stdout).not.toContain('Codex configuration saved');
    // Doctor agrees, from the same facts: delivery-incomplete, never current.
    const { json, exitCode: doctorExit } = doctorJson();
    expect(json.integrationSummary?.codexPlugin.state).toBe('delivery-incomplete');
    expect(json.integrationSummary?.codexPlugin.deliveryComplete).toBe(false);
    expect(doctorExit).toBe(1);
  }, 120_000);

  test('stage 2 — record published (as update/install repair would): pending, not incomplete', async () => {
    // Publish through the REAL deep store under the real lifecycle lease —
    // the same API the repair path drives; setup/doctor never mint records.
    const { openCodexActivationStore, observeCodexActivation } = await import(
      '../../src/lib/codex-activation-executor.js'
    );
    const snapshot = observeCodexActivation({ genieHome, codexHome, command: fakeCodex });
    if (snapshot.canonical.status !== 'ok') throw new Error(`canonical not ok: ${JSON.stringify(snapshot.canonical)}`);
    const pack = buildTestDeliveryEvidencePack({
      descriptor: {
        version: TARGET,
        channel: 'stable',
        platformId: PLATFORM_ID,
        platformTriple: PLATFORM_TRIPLE,
        releaseTag: `v${TARGET}`,
        releaseName: `genie-${TARGET}-${PLATFORM_ID}.tar.gz`,
        artifactSha256: 'b'.repeat(64),
        installedBinarySha256: createHash('sha256')
          .update(readFileSync(join(genieHome, 'bin', 'genie')))
          .digest('hex'),
        canonicalPayloadSha256: snapshot.canonical.digest,
      },
    });
    const evidence = verifyDownloadedDeliveryEvidence(pack.input, pack.dependencies);
    const lease = acquireLifecycleLease('update-delivery', { genieHome });
    if (!lease.ok) throw new Error(`lease: ${lease.detail}`);
    try {
      const store = openCodexActivationStore({
        genieHome,
        codexHome,
        command: fakeCodex,
        deliveryEvidenceVerification: pack.dependencies,
      });
      store.publishDelivery(lease, {
        evidence,
        deliveryRoot: realpathSync(genieHome),
      });
    } finally {
      lease.release();
    }
    expect(existsSync(deliveryRecordPath())).toBe(true);
    const { json } = doctorJson();
    expect(json.integrationSummary?.codexPlugin.state).toBe('activation-pending');
    expect(json.integrationSummary?.codexPlugin.deliveryComplete).toBe(true);
  }, 120_000);

  test('stage 3 — PTY consent activates: add once, enabled restored, journal cleared, new-task instruction printed', () => {
    const { exitCode, output } = runPty(['setup', '--codex'], 'yes\n');
    expect(output).toContain('Activated Codex plugin v');
    expect(output).toContain('new Codex task');
    expect(output).toContain('Codex configuration saved');
    expect(exitCode).toBe(0);
    // Normal journal clearing: no refresh-intent journal left behind.
    expect(existsSync(join(genieHome, '.codex-plugin-refresh-intent.json'))).toBe(false);
    // The cache now physically carries the target generation.
    expect(existsSync(join(codexHome, 'plugins', 'cache', 'automagik', 'genie', TARGET, 'README.md'))).toBe(true);
    expect(readFileSync(join(stateDir, 'registered'), 'utf8').trim()).toBe(TARGET);
  }, 180_000);

  test('stage 4 — doctor ends current: consistent human/JSON/exit, project context surfaced', () => {
    const { json, exitCode } = doctorJson();
    expect(json.integrationSummary?.codexPlugin).toMatchObject({ state: 'current', deliveryComplete: true });
    // The host bun version is environmental; every OTHER check must be clean.
    const failing = json.checks.filter((check) => check.status === 'fail' && !check.name.startsWith('bun'));
    expect(JSON.stringify(failing, null, 2)).toBe('[]');
    const bunFails = json.checks.some((check) => check.status === 'fail' && check.name.startsWith('bun'));
    expect(exitCode).toBe(bunFails ? 1 : 0);
    // The typed context state, end-to-end: init scaffolds no genie.db, so a
    // Codex task would see the typed database-unavailable error (warn) —
    // never a healthy empty board and never a hard context failure.
    const context = json.checks.find((check) => check.name === 'Codex project context');
    expect(context?.status).toBe('warn');
    expect(context?.detail).toContain('project-database-unavailable');
    // Route: the marker-owned project route from `genie init` + trusted repo.
    const human = runCli(['doctor']);
    expect(human.stdout).toContain('Codex integration:');
    expect(human.exitCode).toBe(bunFails ? 1 : 0);
  }, 120_000);

  test('stage 5 — real PATH advisory: one ANSI-free JSON, advisory rider, still current (Decision 11)', () => {
    const env = { ...childEnv, FAKE_CODEX_ADVISORY: 'WARN: PATH does not include codex shims' };
    const { json, exitCode, raw } = doctorJson({ env });
    expect(json.integrationSummary?.codexPlugin.state).toBe('current');
    const bunFails = json.checks.some((check) => check.status === 'fail' && check.name.startsWith('bun'));
    expect(exitCode).toBe(bunFails ? 1 : 0);
    const cli = json.checks.find((check) => check.name === 'Codex CLI');
    expect(cli?.advisory).toBe('WARN: PATH does not include codex shims');
    expect(raw).not.toContain('\x1b[33m');
  }, 120_000);

  test('stage 6 — stale historical config: record removed → no green banner despite configured history', () => {
    const recordBytes = readFileSync(deliveryRecordPath());
    rmSync(deliveryRecordPath());
    try {
      const { exitCode, stdout, stderr } = runCli(['setup', '--codex']);
      expect(exitCode).toBe(1);
      expect(stdout).not.toContain('Codex configuration saved');
      expect(stderr).toContain('delivery record is absent');
    } finally {
      writeFileSync(deliveryRecordPath(), recordBytes);
    }
  }, 120_000);

  test('stage 6b — a stale activation journal is quarantined under one consent, then re-observed (live-QA regression)', () => {
    // The 2026-07-23 live-QA failure: a leftover journal from a prior
    // generation made consent mint a quarantine permit that setup fed to the
    // activation executor ("permit lacks activation capability"), leaving the
    // prescribed recovery unreachable. One consented run must now quarantine
    // the journal, re-observe, and land on the truthful current state.
    const journalPath = join(genieHome, '.codex-plugin-refresh-intent.json');
    writeFileSync(journalPath, 'not json at all\n');
    const { exitCode, output } = runPty(['setup', '--codex'], 'yes\n');
    expect(output).toContain('Quarantined stale activation journal');
    expect(output).toContain('already current');
    expect(output).not.toContain('permit lacks activation capability');
    expect(exitCode).toBe(0);
    expect(existsSync(journalPath)).toBe(false);
    // The journal was moved aside (content-addressed), not destroyed.
    const quarantinedSiblings = readdirSync(genieHome).filter((name) =>
      name.startsWith('.codex-plugin-refresh-intent.json.invalid-'),
    );
    expect(quarantinedSiblings.length).toBe(1);
  }, 180_000);

  test('stage 7 — route collision and nested shadowing are typed doctor failures, never green', () => {
    // Unmanaged same-key route: replace the project config with a user-owned one.
    const projectConfig = join(repo, '.codex', 'config.toml');
    mkdirSync(join(repo, '.codex'), { recursive: true });
    const prior = existsSync(projectConfig) ? readFileSync(projectConfig) : null;
    writeFileSync(projectConfig, '[mcp_servers.genie]\ncommand = "/usr/local/bin/other"\nargs = []\n');
    try {
      const collision = doctorJson();
      const route = collision.json.checks.find((check) => check.name === 'Codex Genie MCP registration');
      expect(route?.status).toBe('fail');
      expect(JSON.stringify(route?.routeLayers ?? [])).toContain('route-collision');
    } finally {
      if (prior === null) rmSync(projectConfig);
      else writeFileSync(projectConfig, prior);
    }

    // Nested shadowing: a nearer .codex/config.toml between root and CWD.
    const nested = join(repo, 'packages', 'web');
    mkdirSync(join(nested, '.codex'), { recursive: true });
    writeFileSync(join(nested, '.codex', 'config.toml'), '[mcp_servers.genie]\ncommand = "/elsewhere"\n');
    try {
      const shadowed = doctorJson({ cwd: nested });
      const route = shadowed.json.checks.find((check) => check.name === 'Codex Genie MCP registration');
      expect(route?.status).toBe('fail');
      expect(JSON.stringify(route?.routeLayers ?? [])).toContain('route-shadowed');
    } finally {
      rmSync(join(repo, 'packages'), { recursive: true, force: true });
    }
  }, 120_000);

  test('stage 8 — a hard query failure fails BOTH surfaces consistently (no PASS + query-failed split)', () => {
    const env = { ...childEnv, FAKE_CODEX_EXIT: '7' };
    const { json, exitCode } = doctorJson({ env });
    expect(json.integrationSummary?.codexPlugin.state).toBe('query-failed');
    const plugin = json.checks.find((check) => check.name === 'Codex Genie plugin');
    expect(plugin?.status).toBe('fail');
    expect(exitCode).toBe(1);
  }, 120_000);
});
