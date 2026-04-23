import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
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
