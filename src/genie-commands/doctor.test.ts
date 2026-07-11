import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDirDigest } from '../lib/agent-sync.js';
import { reconcileCodexProjectMcp, resolveGitProjectRoots } from '../lib/codex-project-mcp.js';
import {
  checkAgentSync,
  checkCodexIntegration,
  checkSubagentModelOverride,
  checkV4Residue,
  doctorCommand,
  evaluateOmniHookTimeout,
  findDispatchHookTimeoutSec,
} from './doctor.js';
import { cleanupV4 } from './legacy-v4.js';

/**
 * Capture everything written to stdout during `fn`, restoring the real
 * `process.stdout.write` (and any exitCode side effect) afterwards.
 */
async function captureDoctor(fn: () => Promise<void>): Promise<{ output: string; exitCode: number | undefined }> {
  const realWrite = process.stdout.write.bind(process.stdout);
  const priorExit = process.exitCode;
  process.exitCode = undefined;
  let buffer = '';
  process.stdout.write = ((chunk: string) => {
    buffer += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return { output: buffer, exitCode: process.exitCode };
  } finally {
    process.stdout.write = realWrite;
    process.exitCode = priorExit;
  }
}

const NO_CODEX = { cliAvailable: false, status: 'unavailable' as const, installed: false, detail: 'fixture absent' };
const ISOLATED_ENV_KEYS = ['HOME', 'GENIE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HERMES_HOME'] as const;
let isolatedHome: string;
let savedIsolatedEnv: Partial<Record<(typeof ISOLATED_ENV_KEYS)[number], string>>;

beforeEach(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), 'genie-doctor-home-'));
  savedIsolatedEnv = {};
  for (const key of ISOLATED_ENV_KEYS) {
    if (process.env[key] !== undefined) savedIsolatedEnv[key] = process.env[key];
  }
  process.env.HOME = isolatedHome;
  process.env.GENIE_HOME = join(isolatedHome, 'genie');
  process.env.CODEX_HOME = join(isolatedHome, 'codex');
  process.env.CLAUDE_CONFIG_DIR = join(isolatedHome, 'claude');
  process.env.HERMES_HOME = join(isolatedHome, 'hermes');
  mkdirSync(join(isolatedHome, 'repo'), { recursive: true });
});

afterEach(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    const saved = savedIsolatedEnv[key];
    if (saved === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = saved;
  }
  rmSync(isolatedHome, { recursive: true, force: true });
});

function isolatedDoctorDeps(root = join(isolatedHome, 'repo')) {
  return { root, databaseRoot: root, pluginProbe: NO_CODEX };
}

describe('doctorCommand', () => {
  // The suite runs from within the genie repo — a healthy checkout with git,
  // bun, and skills/ present. Every check should therefore pass.
  let json: { ok: boolean; checks: Array<{ name: string; status: string }> };

  beforeEach(async () => {
    const { output } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps()));
    json = JSON.parse(output);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  test('emits a check for each pillar', () => {
    const names = json.checks.map((c) => c.name).join('\n');
    expect(names).toMatch(/genie version/);
    expect(names).toMatch(/git present/);
    expect(names).toMatch(/genie\.db/);
    expect(names).toMatch(/skills present/);
    expect(names).toMatch(/bun/);
  });

  test('healthy checkout has no failing checks', () => {
    const failed = json.checks.filter((c) => c.status === 'fail');
    expect(failed).toEqual([]);
    expect(json.ok).toBe(true);
  });

  test('git and bun checks pass on a healthy checkout', () => {
    const git = json.checks.find((c) => c.name === 'git present');
    const bun = json.checks.find((c) => c.name.startsWith('bun'));
    expect(git?.status).toBe('pass');
    expect(bun?.status).toBe('pass');
  });

  test('does not set a failing exit code when all checks pass', async () => {
    const { exitCode } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps()));
    expect(exitCode).toBeUndefined();
  });

  test('human output renders a header and a summary line', async () => {
    const { output } = await captureDoctor(() => doctorCommand({}, isolatedDoctorDeps()));
    expect(output).toContain('genie doctor');
    expect(output).toContain('All checks passed.');
  });
});

describe('Codex doctor lifecycle results', () => {
  test('a timed-out plugin query is a structured hard failure, not a false pass', async () => {
    const checks = await checkCodexIntegration(process.cwd(), {
      cliAvailable: true,
      status: 'error',
      installed: false,
      detail: 'codex plugin list timed out after 25ms; retaining the project fallback',
      timedOut: true,
    });
    const plugin = checks.find((check) => check.name === 'Codex Genie plugin');
    expect(plugin?.status).toBe('fail');
    expect(plugin?.detail).toContain('timed out');
    expect(plugin?.suggestion).toContain('fallback');
  });

  test('missing configured Node is actionable and never displaces the fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-node-availability-'));
    try {
      reconcileCodexProjectMcp(
        root,
        { cliAvailable: true, status: 'ok', installed: true, enabled: false, usable: false, detail: 'disabled' },
        { command: '/absolute/genie', args: ['mcp'] },
      );
      const checks = await checkCodexIntegration(root, {
        cliAvailable: true,
        status: 'ok',
        installed: true,
        enabled: true,
        usable: false,
        usabilityDetail: 'configured plugin MCP command "node" is not available on PATH',
        detail: 'Node unavailable',
      });
      const plugin = checks.find((check) => check.name === 'Codex Genie plugin');
      const route = checks.find((check) => check.name === 'Codex Genie MCP registration');
      expect(plugin?.detail).toContain('"node" is not available on PATH');
      expect(route).toMatchObject({ status: 'pass' });
      expect(route?.detail).toContain('fallback');
      expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toContain('/absolute/genie');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('healthy source bundle cannot make an unproven active plugin capability pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-active-plugin-'));
    const priorCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, 'codex-home');
    try {
      expect(existsSync(join(import.meta.dir, '..', '..', 'plugins', 'genie', '.codex-plugin', 'plugin.json'))).toBe(
        true,
      );
      const probe = {
        cliAvailable: true,
        status: 'ok' as const,
        installed: true,
        enabled: true,
        usable: false,
        usabilityDetail: 'active plugin cache root is missing',
        detail: 'active plugin cache root is missing',
      };
      reconcileCodexProjectMcp(root, probe, { command: '/absolute/genie', args: ['mcp'] });
      const checks = await checkCodexIntegration(root, probe);
      const plugin = checks.find((check) => check.name === 'Codex Genie plugin');
      const capability = checks.find((check) => check.name === 'Codex Genie MCP capability');
      const route = checks.find((check) => check.name === 'Codex Genie MCP registration');
      expect(plugin).toMatchObject({ status: 'warn' });
      expect(capability).toMatchObject({ status: 'warn' });
      expect(capability?.detail).toContain('source-bundle declarations do not establish runtime health');
      expect(route).toMatchObject({ status: 'pass' });
      expect(route?.detail).toContain('fallback');
    } finally {
      if (priorCodexHome === undefined) Reflect.deleteProperty(process.env, 'CODEX_HOME');
      else process.env.CODEX_HOME = priorCodexHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('linked worktree routes stay local while the database check uses the common checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-linked-worktree-'));
    try {
      const repo = join(root, 'repo');
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'root'], { cwd: repo });
      const linked = join(root, 'linked');
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'doctor-linked', linked], { cwd: repo });
      const roots = resolveGitProjectRoots(linked);
      expect(roots).toEqual({ worktreeRoot: linked, commonRoot: repo });
      reconcileCodexProjectMcp(
        linked,
        { cliAvailable: true, status: 'ok', installed: true, enabled: false, usable: false, detail: 'disabled' },
        { command: '/absolute/genie', args: ['mcp'] },
      );
      expect(existsSync(join(linked, '.codex', 'config.toml'))).toBe(true);
      expect(existsSync(join(repo, '.codex', 'config.toml'))).toBe(false);

      const { output } = await captureDoctor(() =>
        doctorCommand(
          { json: true },
          {
            root: linked,
            databaseRoot: repo,
            pluginProbe: { cliAvailable: false, status: 'unavailable', installed: false, detail: 'fixture absent' },
          },
        ),
      );
      const json = JSON.parse(output) as { checks: Array<{ name: string; detail?: string }> };
      expect(json.checks.find((check) => check.name === 'genie.db')?.detail).toContain(
        join(repo, '.genie', 'genie.db'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('injected default doctor median stays within the 120ms latency budget', async () => {
    const durations: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      await captureDoctor(() =>
        doctorCommand(
          { json: true },
          {
            root: process.cwd(),
            databaseRoot: process.cwd(),
            pluginProbe: { cliAvailable: false, status: 'unavailable', installed: false, detail: 'fixture absent' },
          },
        ),
      );
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    expect(durations[2]).toBeLessThan(120);
  });
});

describe('CLAUDE_CODE_SUBAGENT_MODEL override warning', () => {
  const key = 'CLAUDE_CODE_SUBAGENT_MODEL';
  let hadValue: boolean;
  let savedValue: string | undefined;

  beforeEach(() => {
    hadValue = process.env[key] !== undefined;
    savedValue = process.env[key];
  });

  afterEach(() => {
    if (hadValue) process.env[key] = savedValue;
    else {
      delete process.env[key];
    }
  });

  test('warns non-fatally when set and explains that per-agent pins are overridden', async () => {
    process.env[key] = 'sonnet';

    const { output, exitCode } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps()));
    const json = JSON.parse(output) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; detail?: string }>;
    };
    const warning = json.checks.find((check) => check.name.includes(key));

    expect(warning?.status).toBe('warn');
    expect(warning?.detail).toContain('overrides per-agent model pins');
    expect(json.ok).toBe(true);
    expect(exitCode).toBeUndefined();
  });

  test('is silent when unset, including in the doctor output', async () => {
    delete process.env[key];

    expect(checkSubagentModelOverride()).toEqual([]);
    const { output } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps()));

    expect(output).not.toContain(key);
  });
});

describe('omni hook-timeout guardrail', () => {
  const DISPATCH = '"$HOME/.genie/bin/genie" hook dispatch';

  test('finds the smallest dispatch timeout across PreToolUse entries', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ command: 'bash git-safety.sh', timeout: 5 }] },
          { matcher: '*', hooks: [{ command: DISPATCH, timeout: 30 }] },
          { matcher: 'Write', hooks: [{ command: DISPATCH, timeout: 15 }] },
        ],
      },
    };
    expect(findDispatchHookTimeoutSec(settings)).toBe(15);
  });

  test('returns null when no dispatch hook is present', () => {
    expect(
      findDispatchHookTimeoutSec({ hooks: { PreToolUse: [{ hooks: [{ command: 'other', timeout: 9 }] }] } }),
    ).toBeNull();
    expect(findDispatchHookTimeoutSec({})).toBeNull();
  });

  test('warns when the hook timeout is below pollBudgetMs', () => {
    const res = evaluateOmniHookTimeout({ enabled: true, pollBudgetMs: 110_000, timeoutSec: 5 });
    expect(res?.status).toBe('warn');
    expect(res?.detail).toContain('≤ pollBudget');
    expect(res?.suggestion).toContain('120');
  });

  test('warns at the exact boundary (timeoutMs === pollBudgetMs — strictly-below contract)', () => {
    // 110s → 110_000ms === pollBudget: no margin, so the strict contract must warn.
    const res = evaluateOmniHookTimeout({ enabled: true, pollBudgetMs: 110_000, timeoutSec: 110 });
    expect(res?.status).toBe('warn');
    // smallest safe whole-second timeout strictly exceeds the budget → 111s.
    expect(res?.suggestion).toContain('111');
  });

  test('warns when approvals are enabled but no dispatch timeout is found', () => {
    const res = evaluateOmniHookTimeout({ enabled: true, pollBudgetMs: 110_000, timeoutSec: null });
    expect(res?.status).toBe('warn');
    expect(res?.detail).toContain('no `genie hook dispatch`');
  });

  test('passes when the hook timeout strictly exceeds pollBudgetMs', () => {
    const res = evaluateOmniHookTimeout({ enabled: true, pollBudgetMs: 110_000, timeoutSec: 120 });
    expect(res?.status).toBe('pass');
    expect(res?.detail).toContain('> pollBudget');
  });

  test('emits no check when omni approvals are disabled', () => {
    expect(evaluateOmniHookTimeout({ enabled: false, pollBudgetMs: 110_000, timeoutSec: 1 })).toBeNull();
  });
});

describe('doctorCommand — genie.db check branches', () => {
  // The db check resolves its path from the current repo root (git rev-parse),
  // so we drive doctorCommand inside a throwaway git repo to exercise the
  // absent-DB and open-error branches without touching the real repo's db.
  let tmp: string;
  let priorCwd: string;

  beforeEach(() => {
    priorCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'genie-doctor-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(priorCwd);
    process.exitCode = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  // The schema-version test drives doctorCommand to set `process.exitCode = 1`.
  // bun treats `process.exitCode = undefined` as a no-op (it does not clear a
  // previously-set code), so the per-test resets above cannot undo it — the 1
  // would leak and make the entire `bun test` run exit non-zero despite every
  // test passing. Clear it to 0 once, after this file's tests complete.
  afterAll(() => {
    process.exitCode = 0;
  });

  test('absent genie.db → pass ("absent"), no failing exit code', async () => {
    const dbCandidate = join(tmp, '.genie', 'genie.db');
    expect(existsSync(dbCandidate)).toBe(false);

    const { output, exitCode } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps(tmp)));
    const json = JSON.parse(output) as { checks: Array<{ name: string; status: string; detail?: string }> };
    const db = json.checks.find((c) => c.name === 'genie.db');
    expect(db?.status).toBe('pass');
    expect(db?.detail).toContain('absent');
    expect(exitCode).toBeUndefined();
  });

  test('genie.db at an unrecognized schema version → fail + exit code 1', async () => {
    const dbPath = join(tmp, '.genie', 'genie.db');
    mkdirSync(join(tmp, '.genie'), { recursive: true });
    // Seed a real SQLite file whose user_version is neither 0 (fresh) nor the
    // current schema — openDb rejects it as foreign, which the check surfaces.
    const seed = new Database(dbPath);
    seed.exec('PRAGMA user_version = 99');
    seed.close();

    const { output, exitCode } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps(tmp)));
    const json = JSON.parse(output) as { ok: boolean; checks: Array<{ name: string; status: string }> };
    const db = json.checks.find((c) => c.name === 'genie.db');
    expect(db?.status).toBe('fail');
    expect(json.ok).toBe(false);
    expect(exitCode).toBe(1);
  });
});

// ============================================================================
// v4 residue check (wish v4-home-residue-doctor)
// ============================================================================

describe('checkV4Residue', () => {
  let residueHome: string;
  let residueGenieHome: string;
  let savedGenieHomeEnv: string | undefined;

  beforeEach(() => {
    residueHome = mkdtempSync(join(tmpdir(), 'doctor-v4-'));
    residueGenieHome = join(residueHome, '.genie');
    savedGenieHomeEnv = process.env.GENIE_HOME;
  });

  afterEach(() => {
    rmSync(residueHome, { recursive: true, force: true });
    if (savedGenieHomeEnv === undefined) {
      // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
      delete process.env.GENIE_HOME;
    } else process.env.GENIE_HOME = savedGenieHomeEnv;
  });

  function seed(): string[] {
    mkdirSync(join(residueGenieHome, 'spawn-scripts'), { recursive: true });
    writeFileSync(join(residueGenieHome, 'spawn-scripts', 'run.sh'), '#!/bin/sh\n', 'utf-8');
    writeFileSync(join(residueGenieHome, 'serve.pid'), '999\n', 'utf-8');
    writeFileSync(join(residueGenieHome, 'config.json'), '{"version":2}\n', 'utf-8'); // live
    return [join(residueGenieHome, 'spawn-scripts'), join(residueGenieHome, 'serve.pid')];
  }

  /** Recursive (path, size, mtimeMs) snapshot — proves detection mutates nothing. */
  function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        const s = statSync(p);
        out.push(`${p}|${s.size}|${s.mtimeMs}`);
        if (entry.isDirectory()) walk(p);
      }
    };
    walk(dir);
    return out.sort();
  }

  test('clean home → single pass line', () => {
    const results = checkV4Residue(residueHome, residueGenieHome);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'v4 residue', status: 'pass' });
  });

  test('residue → warn summary (count + size) plus per-path list; detection is a pure read', () => {
    seed();
    const before = snapshot(residueHome);

    const results = checkV4Residue(residueHome, residueGenieHome);

    expect(snapshot(residueHome)).toEqual(before); // zero mutation
    const summary = results[0];
    expect(summary.status).toBe('warn');
    expect(summary.detail).toContain('2 reclaimable item(s) (2 genie-home, 0 claude)');
    expect(summary.suggestion).toContain('--fix');
    const paths = results
      .slice(1)
      .map((r) => r.name)
      .sort();
    expect(paths).toEqual(['v4 residue: serve.pid', 'v4 residue: spawn-scripts']);
  });

  test('--fix path (cleanupV4) clears the check; live config.json untouched', () => {
    seed();
    expect(checkV4Residue(residueHome, residueGenieHome)[0].status).toBe('warn');

    cleanupV4({ home: residueHome, genieHome: residueGenieHome });

    const after = checkV4Residue(residueHome, residueGenieHome);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('pass');
    expect(readFileSync(join(residueGenieHome, 'config.json'), 'utf-8')).toBe('{"version":2}\n');
  });

  test('doctorCommand without --fix mutates nothing (GENIE_HOME fixture)', async () => {
    seed();
    process.env.GENIE_HOME = residueGenieHome;
    const before = snapshot(residueHome);

    const { output } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps()));

    expect(snapshot(residueHome)).toEqual(before); // no fix flag → zero disk change
    const parsed = JSON.parse(output) as { checks: Array<{ name: string; status: string }> };
    const relicChecks = parsed.checks.filter((c) => c.name.startsWith('v4 residue:'));
    expect(relicChecks.map((c) => c.name)).toContain('v4 residue: serve.pid');
  });

  test('doctorCommand wires cleanup strictly behind the fix flag (source lock)', () => {
    const source = readFileSync(join(import.meta.dir, 'doctor.ts'), 'utf-8');
    expect(source).toMatch(/if \(options\?\.fix\) \{\s*\n\s*cleanupV4\(/);
  });
});

describe('checkV4Residue — accounting + uncertain keeps + json fix', () => {
  let fxHome: string;
  let fxGenieHome: string;
  let savedGenieHomeEnv: string | undefined;
  let savedHomeEnv: string | undefined;

  beforeEach(() => {
    fxHome = mkdtempSync(join(tmpdir(), 'doctor-v4b-'));
    fxGenieHome = join(fxHome, '.genie');
    savedGenieHomeEnv = process.env.GENIE_HOME;
    savedHomeEnv = process.env.HOME;
  });

  afterEach(() => {
    if (savedHomeEnv === undefined) {
      // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
      delete process.env.HOME;
    } else process.env.HOME = savedHomeEnv;
    if (savedGenieHomeEnv === undefined) {
      // biome-ignore lint/performance/noDelete: same env-unset contract as above
      delete process.env.GENIE_HOME;
    } else process.env.GENIE_HOME = savedGenieHomeEnv;
    rmSync(fxHome, { recursive: true, force: true });
  });

  test('user-modified rules file: kept, labeled, never counted as reclaimable', () => {
    mkdirSync(join(fxHome, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(fxHome, '.claude', 'rules', 'genie-orchestration.md'), '# my own rules\n', 'utf-8');
    mkdirSync(fxGenieHome, { recursive: true });
    writeFileSync(join(fxGenieHome, 'serve.pid'), '1\n', 'utf-8');

    const results = checkV4Residue(fxHome, fxGenieHome);

    const summary = results[0];
    expect(summary.detail).toContain('1 reclaimable item(s) (1 genie-home, 0 claude)');
    const rulesRow = results.find((r) => r.name === 'v4 residue: ~/.claude rules file');
    expect(rulesRow?.detail).toContain('kept (user-modified)');
    // still kept on disk after a fix run
    cleanupV4({ home: fxHome, genieHome: fxGenieHome });
    expect(readFileSync(join(fxHome, '.claude', 'rules', 'genie-orchestration.md'), 'utf-8')).toBe('# my own rules\n');
  });

  test('marker rules file is counted and byte-sized in the claude bucket', () => {
    mkdirSync(join(fxHome, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(fxHome, '.claude', 'rules', 'genie-orchestration.md'), 'genie spawn everything\n', 'utf-8');

    const results = checkV4Residue(fxHome, fxGenieHome);

    expect(results[0].detail).toContain('1 reclaimable item(s) (0 genie-home, 1 claude)');
    expect(results.find((r) => r.name === 'v4 residue: ~/.claude rules file')?.detail).toMatch(/\d+ B/);
  });

  test('uncertain keeps are report-only rows and survive --fix', () => {
    mkdirSync(join(fxGenieHome, '.genie'), { recursive: true });
    writeFileSync(join(fxGenieHome, 'tmux.conf.bak'), 'old tmux\n', 'utf-8');
    writeFileSync(join(fxGenieHome, 'serve.pid'), '1\n', 'utf-8');

    const results = checkV4Residue(fxHome, fxGenieHome);
    const keptNames = results.filter((r) => r.name.startsWith('kept (uncertain):')).map((r) => r.name);
    expect(keptNames.sort()).toEqual(['kept (uncertain): .genie', 'kept (uncertain): tmux.conf.bak']);
    for (const r of results.filter((x) => x.name.startsWith('kept (uncertain):'))) expect(r.status).toBe('pass');

    cleanupV4({ home: fxHome, genieHome: fxGenieHome });
    expect(existsSync(join(fxGenieHome, 'tmux.conf.bak'))).toBe(true);
    expect(existsSync(join(fxGenieHome, '.genie'))).toBe(true);
    expect(existsSync(join(fxGenieHome, 'serve.pid'))).toBe(false);
  });

  test('doctor --fix --json: stdout is valid JSON, relic removed (chatter on stderr)', () => {
    // Subprocess drive: bun's homedir() does not re-read a runtime HOME change,
    // so the fixture home must be injected at process spawn — which also tests
    // the CLI exactly as a user invokes it.
    mkdirSync(fxGenieHome, { recursive: true });
    writeFileSync(join(fxGenieHome, 'serve.pid'), '77\n', 'utf-8');
    const repoRoot = join(import.meta.dir, '..', '..');

    const proc = Bun.spawnSync([process.execPath, join(repoRoot, 'src', 'genie.ts'), 'doctor', '--fix', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: fxHome, GENIE_HOME: fxGenieHome },
    });

    const stdout = proc.stdout.toString();
    const parsed = JSON.parse(stdout) as { checks: Array<{ name: string; status: string }> }; // whole stdout is the document
    expect(existsSync(join(fxGenieHome, 'serve.pid'))).toBe(false);
    expect(parsed.checks.find((c) => c.name === 'v4 residue')?.status).toBe('pass'); // post-fix state
    expect(proc.stderr.toString()).toContain('Removed v4 residue'); // chatter rerouted, not lost
  });
});

// ============================================================================
// agent-sync freshness (wish agent-sync, Group 3) — read-only, path-injected
// ============================================================================

describe('checkAgentSync', () => {
  let tmp: string;
  let genieHome: string;
  let pluginRoot: string;
  let claudeDir: string;
  let codexDir: string;
  let agentsSkillsDir: string;
  let hermesHome: string;

  function writeSourceSkill(name: string, body: string): void {
    mkdirSync(join(pluginRoot, 'skills', name), { recursive: true });
    writeFileSync(join(pluginRoot, 'skills', name, 'SKILL.md'), body, 'utf8');
  }

  /** Copy a source skill into a target parent + stamp a manifest (current unless a digest is forced). */
  function seedManaged(sourceDir: string, destDir: string, digest?: string): void {
    cpSync(sourceDir, destDir, { recursive: true });
    writeFileSync(
      join(destDir, '.genie-sync.json'),
      JSON.stringify({
        managedBy: 'genie-agent-sync',
        version: '1',
        digest: digest ?? computeDirDigest(sourceDir),
        syncedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );
  }

  function stampCouncil(lensRoot: string): void {
    mkdirSync(join(claudeDir, 'workflows'), { recursive: true });
    writeFileSync(
      join(claudeDir, 'workflows', 'council.js'),
      `export const meta = { name: 'council' };\nconst LENS_ROOT = '${lensRoot}';\n`,
      'utf8',
    );
  }

  function paths() {
    return {
      genieHome,
      claudeDir,
      codexDir,
      agentsSkillsDir,
      hermesHome,
      settingsPath: join(claudeDir, 'settings.json'),
    };
  }

  const find = (results: ReturnType<typeof checkAgentSync>, name: string) => results.find((r) => r.name === name);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'doctor-agentsync-'));
    genieHome = join(tmp, 'genie');
    pluginRoot = join(genieHome, 'plugins', 'genie');
    claudeDir = join(tmp, 'claude');
    codexDir = join(tmp, 'codex');
    agentsSkillsDir = join(tmp, 'agents', 'skills');
    hermesHome = join(tmp, 'hermes');
    mkdirSync(join(pluginRoot, 'skills'), { recursive: true });
    mkdirSync(join(genieHome, 'plugins', 'hermes-genie'), { recursive: true });
    writeFileSync(join(genieHome, 'VERSION'), '5.0.0\n', 'utf8');
    writeSourceSkill('wish', '# wish\n');
    writeSourceSkill('review', '# review\n');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('no plugin source → one pass advisory pointing at genie update', () => {
    const results = checkAgentSync({ genieHome: join(tmp, 'absent'), claudeDir, codexDir, hermesHome });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'agent sync', status: 'pass' });
    expect(results[0].detail).toContain('genie update');
  });

  test('undetected agents each report "not detected", never a failure', () => {
    const results = checkAgentSync(paths());
    expect(find(results, 'agent sync: claude')?.detail).toBe('not detected');
    expect(find(results, 'agent sync: codex')?.detail).toBe('not detected');
    expect(find(results, 'agent sync: hermes')?.detail).toBe('not detected');
    expect(results.every((r) => r.status !== 'fail')).toBe(true);
  });

  test('all-current skills + correct council stamp + correct hermes link → pass, no advice', () => {
    seedManaged(join(pluginRoot, 'skills', 'wish'), join(claudeDir, 'skills', 'wish'));
    seedManaged(join(pluginRoot, 'skills', 'review'), join(claudeDir, 'skills', 'review'));
    stampCouncil(pluginRoot);
    seedManaged(join(pluginRoot, 'skills', 'wish'), join(agentsSkillsDir, 'wish'));
    seedManaged(join(pluginRoot, 'skills', 'review'), join(agentsSkillsDir, 'review'));
    mkdirSync(join(hermesHome, 'plugins'), { recursive: true });
    symlinkSync(join(genieHome, 'plugins', 'hermes-genie'), join(hermesHome, 'plugins', 'genie'));

    const results = checkAgentSync(paths());
    const claude = find(results, 'agent sync: claude');
    expect(claude?.status).toBe('pass');
    expect(claude?.detail).toContain('2/2 source skills current');
    expect(claude?.detail).toContain('council.js current');
    expect(claude?.suggestion).toBeUndefined();
    expect(find(results, 'agent sync: codex')?.status).toBe('pass');
    const hermes = find(results, 'agent sync: hermes');
    expect(hermes?.status).toBe('pass');
    expect(hermes?.detail).toContain('linked');
  });

  test('claude excludes council: expected set is source minus exclusions → pass, no advisory (BUG C)', () => {
    // `council` is a source skill the native /council workflow owns, so claude
    // legitimately never receives it. Doctor must subtract it from claude's
    // expected source set — otherwise it reports "2/3 current" and advises
    // `genie update` forever even though claude is fully converged.
    writeSourceSkill('council', '# council\n');
    seedManaged(join(pluginRoot, 'skills', 'wish'), join(claudeDir, 'skills', 'wish'));
    seedManaged(join(pluginRoot, 'skills', 'review'), join(claudeDir, 'skills', 'review'));
    stampCouncil(pluginRoot);

    const claude = find(checkAgentSync(paths()), 'agent sync: claude');
    expect(claude?.status).toBe('pass');
    // 3 source skills, council excluded → expected 2, both present → 2/2 current.
    expect(claude?.detail).toContain('2/2 source skills current');
    expect(claude?.detail).toContain('council.js current');
    expect(claude?.suggestion).toBeUndefined();
  });

  test('stale managed skill + wrong council stamp → warn + genie-update advice', () => {
    seedManaged(join(pluginRoot, 'skills', 'wish'), join(claudeDir, 'skills', 'wish'));
    seedManaged(join(pluginRoot, 'skills', 'review'), join(claudeDir, 'skills', 'review'), 'deadbeef');
    stampCouncil('/old/plugin/root');

    const claude = find(checkAgentSync(paths()), 'agent sync: claude');
    expect(claude?.status).toBe('warn');
    expect(claude?.detail).toContain('1 stale');
    expect(claude?.detail).toContain('council.js stale');
    expect(claude?.suggestion).toContain('genie update');
  });

  test('unmanaged skill dirs are never counted (genie only speaks for what it shipped)', () => {
    mkdirSync(join(claudeDir, 'skills', 'my-own'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'my-own', 'SKILL.md'), '# mine\n', 'utf8');
    stampCouncil(pluginRoot);

    const claude = find(checkAgentSync(paths()), 'agent sync: claude');
    expect(claude?.detail).toContain('0/2 source skills current');
  });

  test('hermes link pointing elsewhere → warn', () => {
    mkdirSync(join(hermesHome, 'plugins'), { recursive: true });
    symlinkSync(join(tmp, 'somewhere-else'), join(hermesHome, 'plugins', 'genie'));
    const hermes = find(checkAgentSync(paths()), 'agent sync: hermes');
    expect(hermes?.status).toBe('warn');
    expect(hermes?.detail).toContain('points elsewhere');
  });

  test('codex detected but ~/.agents/skills tier empty → warn (not populated)', () => {
    mkdirSync(codexDir, { recursive: true });
    const codex = find(checkAgentSync(paths()), 'agent sync: codex');
    expect(codex?.status).toBe('warn');
    expect(codex?.detail).toContain('.agents/skills not populated');
  });

  test('marketplace plugin: disabled/absent → optional pass note; enabled → silent', () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'genie@automagik': false } }),
      'utf8',
    );
    let mkt = find(checkAgentSync(paths()), 'agent sync: marketplace plugin');
    expect(mkt?.status).toBe('pass');
    expect(mkt?.detail).toContain('not enabled');

    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'genie@automagik': true } }),
      'utf8',
    );
    mkt = find(checkAgentSync(paths()), 'agent sync: marketplace plugin');
    expect(mkt).toBeUndefined();
  });
});
