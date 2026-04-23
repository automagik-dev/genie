import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// CommonJS require — keep the cjs payload importable from a bun:test context
// without forcing a module rewrite.
const remediate = require('./sec-remediate.cjs') as any;

const SCRIPT_PATH = resolve(__dirname, 'sec-remediate.cjs');

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'genie-remediate-'));
}

function writeScanReport(home: string, scanId: string, body: Record<string, unknown>): string {
  mkdirSync(join(home, 'sec-scan'), { recursive: true });
  const path = join(home, 'sec-scan', `${scanId}.json`);
  const data = { scan_id: scanId, reportVersion: 1, ...body };
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  opts: { input?: string } = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input: opts.input,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

describe('sec-remediate plan generation', () => {
  let homeDir: string;
  let workDir: string;

  beforeEach(() => {
    homeDir = makeTempHome();
    workDir = mkdtempSync(join(tmpdir(), 'genie-remediate-work-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('builds quarantine action only when target exists', () => {
    const targetPath = join(workDir, 'malware.cjs');
    writeFileSync(targetPath, 'console.log("ioc")');
    const action = remediate.buildQuarantineActionFromFinding(
      { path: targetPath, kind: 'temp-artifact', iocMatches: ['env-compat'] },
      'temp-artifact',
    );
    expect(action).not.toBeNull();
    expect(action.action_type).toBe('quarantine');
    expect(action.target_path).toBe(targetPath);
    expect(action.sha256_before).toMatch(/^[a-f0-9]{64}$/);
  });

  test('skips findings without an absolute existing target', () => {
    expect(
      remediate.buildQuarantineActionFromFinding({ path: '/does/not/exist', kind: 'install' }, 'install'),
    ).toBeNull();
    expect(remediate.buildQuarantineActionFromFinding({ path: 'relative/path' }, 'install')).toBeNull();
  });

  test('credential emission action maps known finding kinds to providers', () => {
    const action = remediate.buildCredentialEmissionAction({
      kind: 'aws-credentials',
      path: '/home/u/.aws/credentials',
    });
    expect(action.provider).toBe('aws');
    expect(action.action_type).toBe('emit_credential_rotation');
  });

  test('generatePlan groups quarantine + credential + kill actions', () => {
    const target = join(workDir, 'tracked.cjs');
    writeFileSync(target, 'fake');
    const plan = remediate.generatePlan({
      scan_id: 'TESTSCAN1',
      installFindings: [{ path: target, kind: 'global-install', compromisedVersion: '4.260421.33' }],
      liveProcessFindings: [{ pid: 99999, command: '/usr/bin/node /tmp/env-compat.cjs' }],
      impactSurfaceFindings: [{ kind: 'npm-token', path: '/home/u/.npmrc', label: '.npmrc' }],
      coverage: { caps_hit: 0, skipped_roots: 0 },
    });
    expect(plan.scan_id).toBe('TESTSCAN1');
    expect(plan.actions).toHaveLength(3);
    const types = plan.actions.map((a: { action_type: string }) => a.action_type).sort();
    expect(types).toEqual(['emit_credential_rotation', 'kill_process', 'quarantine']);
    expect(plan.coverage).toEqual({ caps_hit: 0, skipped_roots: 0 });
  });
});

describe('sec-remediate consent + drift + cross-device', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'genie-remediate-consent-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test('expectedConsentToken uses last 6 of action_id, lowercased', () => {
    const token = remediate.expectedConsentToken({ action_id: 'TESTACTION1234ABCDEF' });
    expect(token).toBe('CONFIRM-QUARANTINE-abcdef');
  });

  test('promptConsent accepts only the exact typed string', async () => {
    const action = { action_id: 'AAAAAAAAAAA1B2C3D4' };
    const expected = remediate.expectedConsentToken(action);

    const accept = await remediate.promptConsent(action, { autoConfirm: { [action.action_id]: expected } });
    expect(accept).toBe(true);

    const partial = await remediate.promptConsent(action, {
      autoConfirm: { [action.action_id]: 'CONFIRM-QUARANTINE' },
    });
    expect(partial).toBe(false);

    const yes = await remediate.promptConsent(action, { autoConfirm: { [action.action_id]: 'yes' } });
    expect(yes).toBe(false);

    const empty = await remediate.promptConsent(action, { autoConfirm: { [action.action_id]: '' } });
    expect(empty).toBe(false);
  });

  test('detectPlanDrift catches sha256 mismatch + missing targets', () => {
    const file = join(workDir, 'a.cjs');
    writeFileSync(file, 'original');
    const action = remediate.buildQuarantineActionFromFinding({ path: file, kind: 'temp-artifact' }, 'temp-artifact');
    const plan = { plan_id: 'P1', scan_id: 'S1', actions: [action] };
    expect(remediate.detectPlanDrift(plan)).toEqual([]);

    writeFileSync(file, 'mutated');
    const drift = remediate.detectPlanDrift(plan);
    expect(drift).toHaveLength(1);
    expect(drift[0].reason).toMatch(/sha256 mismatch/);
    expect(drift[0].target_path).toBe(file);

    rmSync(file);
    const driftMissing = remediate.detectPlanDrift(plan);
    expect(driftMissing[0].reason).toBe('target-missing');
  });

  test('ensureRunRootOnSameDevice refuses cross-device', () => {
    const runRoot = join(workDir, 'quar');
    mkdirSync(runRoot, { recursive: true });
    const targetDevice = statSync(runRoot).dev;
    expect(remediate.ensureRunRootOnSameDevice(runRoot, targetDevice, '/tmp/x')).toBe(runRoot);
    expect(() => remediate.ensureRunRootOnSameDevice(runRoot, targetDevice + 1, '/tmp/x')).toThrow(/cross-device/);
  });

  test('emitCredentialRotation prints both primary commands and offline-fallback URL', () => {
    let captured = '';
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: string) => {
      captured += chunk;
      return true;
    };
    try {
      remediate.emitCredentialRotation({
        provider: 'npm',
        target_path: '/home/u/.npmrc',
        action_id: 'A1',
      });
    } finally {
      (process.stdout as any).write = original;
    }
    expect(captured).toContain('npm token revoke');
    expect(captured).toContain('https://www.npmjs.com/settings/~/tokens');
  });

  test('coverage gate refuses without typed ack on capped scan', () => {
    const plan = { coverage: { caps_hit: 3, skipped_roots: 1 } };
    expect(() => remediate.enforceCoverageGate(plan, 'SCANID', { remediatePartial: false })).toThrow(/incomplete/);
    expect(() =>
      remediate.enforceCoverageGate(plan, 'SCANID', {
        remediatePartial: true,
        confirmIncomplete: 'wrong',
      }),
    ).toThrow(/incomplete/);

    expect(() =>
      remediate.enforceCoverageGate(plan, 'cad1ed', {
        remediatePartial: true,
        confirmIncomplete: 'CONFIRM-INCOMPLETE-SCAN-cad1ed',
      }),
    ).not.toThrow();
  });
});

describe('sec-remediate apply + restore round-trip', () => {
  let homeDir: string;
  let workDir: string;
  const env = (h: string) => ({ GENIE_HOME: h, GENIE_SEC_SKIP_SIG_CHECK: '1' });

  beforeEach(() => {
    homeDir = makeTempHome();
    workDir = mkdtempSync(join(tmpdir(), 'genie-remediate-apply-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('dry-run → apply → restore: original sha256 unchanged', async () => {
    const originalContent = `console.log("ioc:env-compat");\n`;
    const target = join(workDir, 'env-compat.cjs');
    writeFileSync(target, originalContent);

    const scanId = 'SCANROUNDTRIP1';
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [{ path: target, kind: 'temp-artifact', iocMatches: ['env-compat'] }],
    });

    // Dry-run via CLI
    const dryResult = runCli(['--dry-run', '--scan-id', scanId, '--json'], env(homeDir));
    expect(dryResult.status).toBe(0);
    const dryOutput = JSON.parse(dryResult.stdout);
    const planPath: string = dryOutput.plan_path;
    expect(existsSync(planPath)).toBe(true);
    expect(statSync(planPath).mode & 0o777).toBe(0o600);

    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    const expectedToken = remediate.expectedConsentToken(action);
    const consentPath = join(workDir, 'consent.json');
    writeFileSync(consentPath, JSON.stringify({ [action.action_id]: expectedToken }));

    // Apply
    const applyResult = runCli(
      [
        '--apply',
        '--plan',
        planPath,
        '--auto-confirm-from',
        consentPath,
        '--unsafe-unverified',
        'TEST_HARNESS_2026_04_23',
      ],
      env(homeDir),
    );
    expect(applyResult.status).toBe(0);
    expect(existsSync(target)).toBe(false);

    // Locate quarantine id
    const quarRoot = join(homeDir, 'sec-scan', 'quarantine');
    const quarantineIds = readdirSync(quarRoot);
    expect(quarantineIds).toHaveLength(1);
    const quarantineId = quarantineIds[0];

    // Restore
    const restoreResult = runCli(['--restore', quarantineId], env(homeDir));
    expect(restoreResult.status).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(originalContent);
  });

  test('apply refuses when binary is unverified and no incident id is provided', async () => {
    const target = join(workDir, 'a.cjs');
    writeFileSync(target, 'a');
    const scanId = 'SCANUNVERIFIED1';
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [{ path: target, kind: 'temp-artifact' }],
    });

    const dryResult = runCli(['--dry-run', '--scan-id', scanId, '--json'], { GENIE_HOME: homeDir });
    const planPath = JSON.parse(dryResult.stdout).plan_path;

    const applyResult = runCli(['--apply', '--plan', planPath], { GENIE_HOME: homeDir });
    expect(applyResult.status).toBe(3);
    expect(applyResult.stderr).toMatch(/signature is not verified/);
    expect(existsSync(target)).toBe(true);
  });

  test('plan drift refusal: mutating file between dry-run and apply aborts with drift detail', async () => {
    const target = join(workDir, 'drift.cjs');
    writeFileSync(target, 'pristine');
    const scanId = 'SCANDRIFT1';
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [{ path: target, kind: 'temp-artifact' }],
    });

    const dry = runCli(['--dry-run', '--scan-id', scanId, '--json'], env(homeDir));
    const planPath = JSON.parse(dry.stdout).plan_path;

    writeFileSync(target, 'tampered between observation and mutation');

    const apply = runCli(
      ['--apply', '--plan', planPath, '--unsafe-unverified', 'TEST_HARNESS_2026_04_23'],
      env(homeDir),
    );
    expect(apply.status).toBe(3);
    expect(apply.stderr).toContain('drifted between dry-run and apply');
    expect(apply.stderr).toContain(target);
  });

  test('--apply without --plan refuses with exit 1', () => {
    const result = runCli(['--apply'], env(homeDir));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--apply requires --plan/);
  });

  test('--kill-pid: refuses when no matching plan entry exists', async () => {
    const target = join(workDir, 'safe.cjs');
    writeFileSync(target, 'safe');
    const scanId = 'SCANKILL1';
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [{ path: target, kind: 'temp-artifact' }],
    });

    const dry = runCli(['--dry-run', '--scan-id', scanId, '--json'], env(homeDir));
    const planPath = JSON.parse(dry.stdout).plan_path;
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const consentPath = join(workDir, 'consent.json');
    writeFileSync(
      consentPath,
      JSON.stringify(
        Object.fromEntries(
          plan.actions.map((a: { action_id: string }) => [a.action_id, remediate.expectedConsentToken(a)]),
        ),
      ),
    );

    // Pass a kill-pid that has NO matching plan entry. Apply must succeed (no
    // kill actions exist), and the bogus pid is silently discarded — the
    // safety property here is "no kill happens". An action would only run if
    // both (a) a kill_process action existed and (b) its target_pid was passed.
    const apply = runCli(
      [
        '--apply',
        '--plan',
        planPath,
        '--auto-confirm-from',
        consentPath,
        '--unsafe-unverified',
        'TEST_HARNESS_2026_04_23',
        '--kill-pid',
        '424242',
      ],
      env(homeDir),
    );
    expect(apply.status).toBe(0);
    // No live-process finding existed, so no kill action ran.
    const auditPath = join(homeDir, 'sec-scan', 'audit', `${scanId}.jsonl`);
    const audit = readFileSync(auditPath, 'utf8');
    expect(audit).not.toMatch(/"action_type":"kill_process"/);
  });
});

describe('sec-remediate credential rotation: zero network', () => {
  test('emitCredentialRotation makes no fetch / http calls', () => {
    let netCalled = false;
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = () => {
      netCalled = true;
      throw new Error('network call attempted in credential emission');
    };
    try {
      remediate.emitCredentialRotation({
        provider: 'github',
        target_path: '/home/u/.config/gh/hosts.yml',
        action_id: 'A2',
      });
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
    expect(netCalled).toBe(false);
  });
});

describe('sec-remediate audit log + mode 0600', () => {
  let homeDir: string;
  let workDir: string;

  beforeEach(() => {
    homeDir = makeTempHome();
    workDir = mkdtempSync(join(tmpdir(), 'genie-remediate-audit-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('appendAuditEvent is append-only and survives multiple writes', () => {
    process.env.GENIE_HOME = homeDir;
    remediate.appendAuditEvent('SCAN-AUDIT-1', { ts: '2026-04-23T00:00:00Z', event: 'a.start' });
    remediate.appendAuditEvent('SCAN-AUDIT-1', { ts: '2026-04-23T00:00:01Z', event: 'a.end' });
    process.env.GENIE_HOME = undefined;
    const auditPath = join(homeDir, 'sec-scan', 'audit', 'SCAN-AUDIT-1.jsonl');
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('a.start');
    expect(JSON.parse(lines[1]).event).toBe('a.end');
    expect(statSync(auditPath).mode & 0o777).toBe(0o600);
  });

  test('plan + sidecar files are mode 0600 on POSIX filesystems', async () => {
    const target = join(workDir, 'mode.cjs');
    writeFileSync(target, 'mode-check');
    const scanId = 'SCANMODE1';
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [{ path: target, kind: 'temp-artifact' }],
    });

    const dry = runCli(['--dry-run', '--scan-id', scanId, '--json'], {
      GENIE_HOME: homeDir,
      GENIE_SEC_SKIP_SIG_CHECK: '1',
    });
    const planPath = JSON.parse(dry.stdout).plan_path;
    expect(statSync(planPath).mode & 0o777).toBe(0o600);

    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const action = plan.actions[0];
    const consent = join(workDir, 'consent.json');
    writeFileSync(consent, JSON.stringify({ [action.action_id]: remediate.expectedConsentToken(action) }));

    const apply = runCli(
      ['--apply', '--plan', planPath, '--auto-confirm-from', consent, '--unsafe-unverified', 'INC1'],
      { GENIE_HOME: homeDir, GENIE_SEC_SKIP_SIG_CHECK: '1' },
    );
    expect(apply.status).toBe(0);

    const quarRoot = join(homeDir, 'sec-scan', 'quarantine');
    const ids = readdirSync(quarRoot);
    const sidecarPath = join(quarRoot, ids[0], action.action_id, 'action.json');
    expect(existsSync(sidecarPath)).toBe(true);
    expect(statSync(sidecarPath).mode & 0o777).toBe(0o600);
  });
});

// ─── Group 2: rollback + quarantine list/gc + audit-log integrity ──────────

describe('sec-remediate parseDurationMs', () => {
  test('parses seconds, minutes, hours, days', () => {
    expect(remediate.parseDurationMs('30s')).toBe(30_000);
    expect(remediate.parseDurationMs('15m')).toBe(15 * 60_000);
    expect(remediate.parseDurationMs('24h')).toBe(24 * 3_600_000);
    expect(remediate.parseDurationMs('30d')).toBe(30 * 86_400_000);
  });

  test('refuses malformed durations', () => {
    expect(() => remediate.parseDurationMs('')).toThrow(/invalid duration/);
    expect(() => remediate.parseDurationMs('abc')).toThrow(/invalid duration/);
    expect(() => remediate.parseDurationMs('30')).toThrow(/invalid duration/);
    expect(() => remediate.parseDurationMs('30y')).toThrow(/invalid duration/);
  });
});

describe('sec-remediate rollback (audit-log reverse walk)', () => {
  let homeDir: string;
  let workDir: string;
  const env = (h: string) => ({ GENIE_HOME: h, GENIE_SEC_SKIP_SIG_CHECK: '1' });

  beforeEach(() => {
    homeDir = makeTempHome();
    workDir = mkdtempSync(join(tmpdir(), 'genie-rollback-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  async function applyTwoTargets(scanId: string): Promise<{ planPath: string; targets: string[] }> {
    const targets = [join(workDir, 'a.cjs'), join(workDir, 'b.cjs')];
    writeFileSync(targets[0], 'alpha');
    writeFileSync(targets[1], 'bravo');
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [
        { path: targets[0], kind: 'temp-artifact' },
        { path: targets[1], kind: 'temp-artifact' },
      ],
    });
    const dry = runCli(['--dry-run', '--scan-id', scanId, '--json'], env(homeDir));
    expect(dry.status).toBe(0);
    const planPath = JSON.parse(dry.stdout).plan_path;
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const consent = join(workDir, 'consent.json');
    writeFileSync(
      consent,
      JSON.stringify(
        Object.fromEntries(
          plan.actions.map((a: { action_id: string }) => [a.action_id, remediate.expectedConsentToken(a)]),
        ),
      ),
    );
    const apply = runCli(
      ['--apply', '--plan', planPath, '--auto-confirm-from', consent, '--unsafe-unverified', 'INC_ROLLBACK'],
      env(homeDir),
    );
    expect(apply.status).toBe(0);
    expect(existsSync(targets[0])).toBe(false);
    expect(existsSync(targets[1])).toBe(false);
    return { planPath, targets };
  }

  test('rollback after full apply restores every file with sha256 match', async () => {
    const scanId = 'ROLLBACKOK1';
    const { targets } = await applyTwoTargets(scanId);

    const result = runCli(['--rollback', scanId, '--json'], env(homeDir));
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.scan_id).toBe(scanId);
    expect(summary.actions_undone).toHaveLength(2);
    expect(summary.actions_failed).toEqual([]);
    expect(summary.rollback_id).toMatch(/^R/);
    expect(typeof summary.duration_ms).toBe('number');
    expect(summary.summary_path).toContain('rollback');

    for (const target of targets) {
      expect(existsSync(target)).toBe(true);
    }
    expect(readFileSync(targets[0], 'utf8')).toBe('alpha');
    expect(readFileSync(targets[1], 'utf8')).toBe('bravo');
    expect(existsSync(summary.summary_path)).toBe(true);
    expect(statSync(summary.summary_path).mode & 0o777).toBe(0o600);
  });

  test('partial rollback records actions_failed when original path is already occupied', async () => {
    const scanId = 'ROLLBACKPARTIAL1';
    const { targets } = await applyTwoTargets(scanId);

    // Put a file back at one of the original paths so rollback can't restore
    // that action — rollback should still succeed on the other.
    writeFileSync(targets[0], 'squatter');

    const result = runCli(['--rollback', scanId, '--json'], env(homeDir));
    expect(result.status).toBe(2);
    const summary = JSON.parse(result.stdout);
    expect(summary.actions_undone).toHaveLength(1);
    expect(summary.actions_failed).toHaveLength(1);
    expect(summary.actions_failed[0].reason).toMatch(/already occupied/);
    expect(existsSync(targets[1])).toBe(true);
    expect(readFileSync(targets[1], 'utf8')).toBe('bravo');
  });

  test('rollback refuses a scan with no audit log', () => {
    const result = runCli(['--rollback', 'NO-SUCH-SCAN', '--json'], env(homeDir));
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/audit log not found/);
  });

  test('rollback walks the audit log in reverse action-time order', async () => {
    const scanId = 'ROLLBACKORDER1';
    await applyTwoTargets(scanId);

    const result = runCli(['--rollback', scanId, '--json'], env(homeDir));
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);

    // Verify the rollback audit entries landed in strict reverse of the
    // original action.end sequence.
    const auditPath = join(homeDir, 'sec-scan', 'audit', `${scanId}.jsonl`);
    const events = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const appliedOrder = events
      .filter((e) => e.actor === 'remediate' && e.event === 'action.end' && e.action_type === 'quarantine')
      .map((e) => e.action_id);
    const rolledOrder = events
      .filter((e) => e.actor === 'rollback' && e.event === 'action.rollback')
      .map((e) => e.action_id);
    expect(rolledOrder).toEqual(appliedOrder.slice().reverse());
    expect(summary.actions_undone.map((a: { action_id: string }) => a.action_id)).toEqual(
      appliedOrder.slice().reverse(),
    );
  });
});

describe('sec-remediate quarantine list', () => {
  let homeDir: string;
  let workDir: string;
  const env = (h: string) => ({ GENIE_HOME: h, GENIE_SEC_SKIP_SIG_CHECK: '1' });

  beforeEach(() => {
    homeDir = makeTempHome();
    workDir = mkdtempSync(join(tmpdir(), 'genie-qlist-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('returns empty on a clean home', () => {
    const result = runCli(['--quarantine-list', '--json'], env(homeDir));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ quarantines: [] });
  });

  test('reports size, status, and scan_id after an apply', async () => {
    const target = join(workDir, 'q.cjs');
    writeFileSync(target, 'payload');
    const scanId = 'QLISTSCAN1';
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [{ path: target, kind: 'temp-artifact' }],
    });
    const dry = runCli(['--dry-run', '--scan-id', scanId, '--json'], env(homeDir));
    const planPath = JSON.parse(dry.stdout).plan_path;
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const consent = join(workDir, 'consent.json');
    writeFileSync(
      consent,
      JSON.stringify({ [plan.actions[0].action_id]: remediate.expectedConsentToken(plan.actions[0]) }),
    );
    const apply = runCli(
      ['--apply', '--plan', planPath, '--auto-confirm-from', consent, '--unsafe-unverified', 'INC_LIST'],
      env(homeDir),
    );
    expect(apply.status).toBe(0);

    const list = runCli(['--quarantine-list', '--json'], env(homeDir));
    expect(list.status).toBe(0);
    const parsed = JSON.parse(list.stdout);
    expect(parsed.quarantines).toHaveLength(1);
    const row = parsed.quarantines[0];
    expect(row.status).toBe('active');
    expect(row.scan_id).toBe(scanId);
    expect(row.size_bytes).toBeGreaterThan(0);
    expect(typeof row.timestamp).toBe('string');
    expect(row.action_counts).toEqual({ active: 1, restored: 0, abandoned: 0 });
  });

  test('human-readable output contains headers and status', async () => {
    const target = join(workDir, 'human.cjs');
    writeFileSync(target, 'h');
    const scanId = 'QLISTHUMAN1';
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [{ path: target, kind: 'temp-artifact' }],
    });
    const dry = runCli(['--dry-run', '--scan-id', scanId, '--json'], env(homeDir));
    const planPath = JSON.parse(dry.stdout).plan_path;
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const consent = join(workDir, 'consent.json');
    writeFileSync(
      consent,
      JSON.stringify({ [plan.actions[0].action_id]: remediate.expectedConsentToken(plan.actions[0]) }),
    );
    runCli(
      ['--apply', '--plan', planPath, '--auto-confirm-from', consent, '--unsafe-unverified', 'INC_LH'],
      env(homeDir),
    );

    const list = runCli(['--quarantine-list'], env(homeDir));
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('ID');
    expect(list.stdout).toContain('TIMESTAMP');
    expect(list.stdout).toContain('STATUS');
    expect(list.stdout).toContain('SCAN_ID');
    expect(list.stdout).toContain('active');
  });
});

describe('sec-remediate quarantine gc', () => {
  let homeDir: string;
  let workDir: string;
  const env = (h: string) => ({ GENIE_HOME: h, GENIE_SEC_SKIP_SIG_CHECK: '1' });

  beforeEach(() => {
    homeDir = makeTempHome();
    workDir = mkdtempSync(join(tmpdir(), 'genie-qgc-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('refuses without --older-than', () => {
    const result = runCli(['--quarantine-gc'], env(homeDir));
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/requires --older-than/);
  });

  test('refuses malformed --older-than', () => {
    const result = runCli(['--quarantine-gc', '--older-than', '30y'], env(homeDir));
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/invalid duration/);
  });

  async function applyOne(scanId: string, name = 'gc-target.cjs'): Promise<string> {
    const target = join(workDir, name);
    writeFileSync(target, 'data');
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [{ path: target, kind: 'temp-artifact' }],
    });
    const dry = runCli(['--dry-run', '--scan-id', scanId, '--json'], env(homeDir));
    const planPath = JSON.parse(dry.stdout).plan_path;
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const consent = join(workDir, `${scanId}-consent.json`);
    writeFileSync(
      consent,
      JSON.stringify({ [plan.actions[0].action_id]: remediate.expectedConsentToken(plan.actions[0]) }),
    );
    runCli(
      ['--apply', '--plan', planPath, '--auto-confirm-from', consent, '--unsafe-unverified', 'INC_GC'],
      env(homeDir),
    );
    return target;
  }

  test('refuses active quarantines even when old enough', async () => {
    await applyOne('QGCACTIVE1');

    const result = runCli(['--quarantine-gc', '--older-than', '0s', '--json'], env(homeDir));
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.eligible_ids).toEqual([]);
    expect(summary.active_refused).toBe(1);
    expect(summary.status).toBe('nothing-to-gc');
  });

  test('requires typed CONFIRM-GC token before deleting', async () => {
    const target = await applyOne('QGCCONFIRM1');
    // Restore so the quarantine is eligible (status = restored)
    const quarIds = readdirSync(join(homeDir, 'sec-scan', 'quarantine'));
    expect(quarIds).toHaveLength(1);
    const restored = runCli(['--restore', quarIds[0]], env(homeDir));
    expect(restored.status).toBe(0);
    expect(existsSync(target)).toBe(true);

    // Preview step (no --confirm-gc): should refuse and print expected token
    const preview = runCli(['--quarantine-gc', '--older-than', '0s', '--json'], env(homeDir));
    expect(preview.status).toBe(2);
    const previewSummary = JSON.parse(preview.stdout);
    expect(previewSummary.status).toBe('needs-typed-confirmation');
    expect(previewSummary.expected_token).toMatch(/^CONFIRM-GC-[a-f0-9]{6}$/);
    expect(previewSummary.eligible_ids).toHaveLength(1);

    // Wrong token still refused
    const wrong = runCli(
      ['--quarantine-gc', '--older-than', '0s', '--confirm-gc', 'CONFIRM-GC-xxxxxx', '--json'],
      env(homeDir),
    );
    expect(wrong.status).toBe(2);
    expect(JSON.parse(wrong.stdout).status).toBe('needs-typed-confirmation');
    // Quarantine dir still present
    expect(existsSync(join(homeDir, 'sec-scan', 'quarantine', quarIds[0]))).toBe(true);

    // Correct token deletes
    const final = runCli(
      ['--quarantine-gc', '--older-than', '0s', '--confirm-gc', previewSummary.expected_token, '--json'],
      env(homeDir),
    );
    expect(final.status).toBe(0);
    const finalSummary = JSON.parse(final.stdout);
    expect(finalSummary.status).toBe('ok');
    expect(finalSummary.deleted_ids).toEqual(previewSummary.eligible_ids);
    expect(existsSync(join(homeDir, 'sec-scan', 'quarantine', quarIds[0]))).toBe(false);
  });
});

describe('sec-remediate completion banner + disk warning', () => {
  let homeDir: string;
  let workDir: string;
  const env = (h: string) => ({ GENIE_HOME: h, GENIE_SEC_SKIP_SIG_CHECK: '1' });

  beforeEach(() => {
    homeDir = makeTempHome();
    workDir = mkdtempSync(join(tmpdir(), 'genie-banner-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('apply banner prints both restore and rollback commands verbatim', async () => {
    const target = join(workDir, 'banner.cjs');
    writeFileSync(target, 'b');
    const scanId = 'BANNERSCAN1';
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [{ path: target, kind: 'temp-artifact' }],
    });
    const dry = runCli(['--dry-run', '--scan-id', scanId, '--json'], env(homeDir));
    const planPath = JSON.parse(dry.stdout).plan_path;
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const consent = join(workDir, 'consent.json');
    writeFileSync(
      consent,
      JSON.stringify({ [plan.actions[0].action_id]: remediate.expectedConsentToken(plan.actions[0]) }),
    );

    const apply = runCli(
      ['--apply', '--plan', planPath, '--auto-confirm-from', consent, '--unsafe-unverified', 'INC_BANNER'],
      env(homeDir),
    );
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain('genie sec restore');
    expect(apply.stdout).toMatch(new RegExp(`genie sec rollback ${scanId}`));
  });

  test('apply emits stderr warning when quarantine exceeds 100MB', async () => {
    const target = join(workDir, 'big.bin');
    const chunk = Buffer.alloc(1024 * 1024, 0x41); // 1MB of 'A'
    const fd = openSync(target, 'w');
    for (let i = 0; i < 105; i += 1) writeSync(fd, chunk); // 105MB
    closeSync(fd);
    const scanId = 'BIGSCAN1';
    writeScanReport(homeDir, scanId, {
      tempArtifactFindings: [{ path: target, kind: 'temp-artifact' }],
    });
    const dry = runCli(['--dry-run', '--scan-id', scanId, '--json'], env(homeDir));
    const planPath = JSON.parse(dry.stdout).plan_path;
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const consent = join(workDir, 'consent.json');
    writeFileSync(
      consent,
      JSON.stringify({ [plan.actions[0].action_id]: remediate.expectedConsentToken(plan.actions[0]) }),
    );

    const apply = runCli(
      ['--apply', '--plan', planPath, '--auto-confirm-from', consent, '--unsafe-unverified', 'INC_BIG'],
      env(homeDir),
    );
    expect(apply.status).toBe(0);
    expect(apply.stderr).toMatch(/WARNING: quarantine size \d+(\.\d+)?MB exceeds 100MB threshold/);
    expect(apply.stderr).toContain('genie sec quarantine gc');
  }, 15_000);
});

describe('sec-remediate audit-log append-only integrity', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = makeTempHome();
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  test('multiple appendAuditEvent calls preserve earlier lines (append-only)', () => {
    process.env.GENIE_HOME = homeDir;
    try {
      remediate.appendAuditEvent('INTEGRITY1', { ts: '2026-04-23T00:00:00Z', event: 'first' });
      remediate.appendAuditEvent('INTEGRITY1', { ts: '2026-04-23T00:00:01Z', event: 'second' });
      remediate.appendAuditEvent('INTEGRITY1', { ts: '2026-04-23T00:00:02Z', event: 'third' });
    } finally {
      process.env.GENIE_HOME = undefined;
    }
    const auditPath = join(homeDir, 'sec-scan', 'audit', 'INTEGRITY1.jsonl');
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event).toBe('first');
    expect(JSON.parse(lines[1]).event).toBe('second');
    expect(JSON.parse(lines[2]).event).toBe('third');
  });

  test('O_APPEND fd writes are forced to end-of-file even after external appends', () => {
    process.env.GENIE_HOME = homeDir;
    try {
      remediate.appendAuditEvent('INTEGRITY2', { event: 'a' });
      const auditPath = join(homeDir, 'sec-scan', 'audit', 'INTEGRITY2.jsonl');
      // Open a second fd with O_APPEND and interleave a write — it must not
      // overwrite the existing first line.
      const fd = openSync(auditPath, 'a');
      try {
        writeSync(fd, `${JSON.stringify({ event: 'external-b' })}\n`);
      } finally {
        closeSync(fd);
      }
      remediate.appendAuditEvent('INTEGRITY2', { event: 'c' });
      const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).event).toBe('a');
      expect(JSON.parse(lines[1]).event).toBe('external-b');
      expect(JSON.parse(lines[2]).event).toBe('c');
    } finally {
      process.env.GENIE_HOME = undefined;
    }
  });

  test('readAuditEvents skips corrupt lines but still returns the rest', () => {
    process.env.GENIE_HOME = homeDir;
    try {
      remediate.appendAuditEvent('CORRUPT1', { event: 'a' });
      const auditPath = join(homeDir, 'sec-scan', 'audit', 'CORRUPT1.jsonl');
      const fd = openSync(auditPath, 'a');
      try {
        writeSync(fd, '{this is not valid json}\n');
      } finally {
        closeSync(fd);
      }
      remediate.appendAuditEvent('CORRUPT1', { event: 'c' });
      const events = remediate.readAuditEvents('CORRUPT1');
      expect(events.map((e: { event: string }) => e.event)).toEqual(['a', 'c']);
    } finally {
      process.env.GENIE_HOME = undefined;
    }
  });
});

describe('sec-remediate classifyQuarantineDir', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'genie-classify-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test('abandoned when no action dirs or no sidecars', () => {
    const dir = join(workDir, 'empty');
    mkdirSync(dir, { recursive: true });
    expect(remediate.classifyQuarantineDir(dir).status).toBe('abandoned');

    const dir2 = join(workDir, 'orphan');
    mkdirSync(join(dir2, 'ACTION1'), { recursive: true });
    expect(remediate.classifyQuarantineDir(dir2).status).toBe('abandoned');
  });

  test('active while quarantined file present; restored once it is gone', () => {
    const dir = join(workDir, 'q1');
    const actionDir = join(dir, 'ACTION_ABC');
    mkdirSync(actionDir, { recursive: true });
    const quarFile = join(actionDir, 'original.cjs');
    writeFileSync(quarFile, 'data');
    const sidecar = {
      action_id: 'ACTION_ABC',
      scan_id: 'CLASSIFY1',
      original_path: join(workDir, 'original.cjs'),
      quarantine_path: quarFile,
    };
    writeFileSync(join(actionDir, 'action.json'), JSON.stringify(sidecar));

    expect(remediate.classifyQuarantineDir(dir).status).toBe('active');

    rmSync(quarFile); // simulate restore
    expect(remediate.classifyQuarantineDir(dir).status).toBe('restored');
  });
});
