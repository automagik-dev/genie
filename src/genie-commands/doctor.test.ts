import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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
import { dirname, join } from 'node:path';
import { resolveGitProjectRoots } from '../lib/codex-project-mcp.js';
import { type SkillsInstallRecord, releaseTag, writeSkillsInstallRecord } from '../lib/skills-installer.js';
import { VERSION } from '../lib/version.js';
import {
  type CheckResult,
  type LegacyClassifier,
  MINIMUM_BUN_VERSION,
  checkBudgets,
  checkCodexProjectContext,
  checkGlobalDbContamination,
  checkIndexLaneDrift,
  checkLegacyIntegrations,
  checkRetiredJsonMcpEntry,
  checkSkillsChannel,
  checkSubagentModelOverride,
  checkTrackedMachineState,
  checkV4Residue,
  checkWorkflowsChannel,
  doctorCommand,
  evaluateBunVersion,
  evaluateIndexLaneDrift,
  globalDbContaminationBunAlternative,
  globalDbContaminationRemedy,
  globalDbContaminationSqliteAlternative,
  probeTrackedMachineState,
  repairGlobalDbContamination,
} from './doctor.js';
import { cleanupV4 } from './legacy-v4.js';

/**
 * Capture everything written to stdout during `fn` with a deterministic
 * non-failing exit-code baseline. Bun keeps the last numeric `process.exitCode`
 * when assigned `undefined`, so using `undefined` as the success sentinel makes
 * this helper depend on worker/test ordering (Linux CI commonly enters at 0).
 */
async function captureDoctor(fn: () => Promise<void>): Promise<{ output: string; exitCode: number }> {
  const realWrite = process.stdout.write.bind(process.stdout);
  const priorExit = process.exitCode;
  process.exitCode = 0;
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
    // Bun cannot restore `undefined` after a numeric exitCode was assigned.
    // Preserve a prior numeric failure, otherwise leave the test process in
    // the canonical non-failing state.
    process.exitCode = priorExit ?? 0;
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
  return {
    root,
    databaseRoot: root,
    pluginProbe: NO_CODEX,
    codexActivation: null,
    bunVersion: '1.3.10',
    bunPath: '/usr/bin/bun',
  };
}

describe('Bun runtime contract', () => {
  test('doctor minimum matches the package engine contract', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as {
      engines: { bun: string };
    };
    expect(pkg.engines.bun).toBe(`>=${MINIMUM_BUN_VERSION}`);
  });

  test('fails below or outside the declared minimum and passes equal/above versions', () => {
    const belowMinimum = evaluateBunVersion('1.3.9', '/usr/bin/bun')[0];
    expect(belowMinimum).toMatchObject({ status: 'fail' });
    expect(belowMinimum.suggestion).toContain('bun upgrade');
    expect(evaluateBunVersion('not-semver', '/usr/bin/bun')[0]).toMatchObject({ status: 'fail' });
    expect(evaluateBunVersion('1.3.10-canary.1', '/usr/bin/bun')[0]).toMatchObject({ status: 'fail' });
    expect(evaluateBunVersion('1.3.10-rc.9+build.1', '/usr/bin/bun')[0]).toMatchObject({ status: 'fail' });
    expect(evaluateBunVersion('1.3.10', '/usr/bin/bun')[0]).toMatchObject({ status: 'pass' });
    expect(evaluateBunVersion('1.3.10+build.1', '/usr/bin/bun')[0]).toMatchObject({ status: 'pass' });
    expect(evaluateBunVersion('1.3.11-canary.1', '/usr/bin/bun')[0]).toMatchObject({ status: 'pass' });
    expect(evaluateBunVersion('1.4.0', '/usr/bin/bun')[0]).toMatchObject({ status: 'pass' });
  });
});

describe('doctorCommand', () => {
  // The suite runs from within the genie repo — a healthy checkout with git,
  // bun, and skills/ present. Every check should therefore pass.
  let json: { ok: boolean; checks: Array<{ name: string; status: string }> };

  beforeEach(async () => {
    const { output } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps()));
    json = JSON.parse(output);
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  test('emits a check for each pillar', () => {
    const names = json.checks.map((c) => c.name).join('\n');
    expect(names).toMatch(/genie version/);
    expect(names).toMatch(/git present/);
    expect(names).toMatch(/genie\.db/);
    expect(names).toMatch(/skills present/);
    expect(names).toMatch(/bun/);
  });

  // m16: check NAMES are the cross-release diff key, so none of them may carry
  // the running version — a naive name-set diff would report a false
  // removal + addition pair on every release.
  test('no check name embeds the running version; the version check carries it as detail', () => {
    const checks = json.checks as Array<{ name: string; status: string; detail?: string }>;
    const embedding = checks.map((c) => c.name).filter((name) => name.includes(VERSION));
    expect(embedding).toEqual([]);
    expect(checks.find((c) => c.name === 'genie version')).toMatchObject({ status: 'pass', detail: VERSION });
  });

  // r2 #7 (m16 class): no check NAME may carry ANY version string — `bun
  // 1.3.11` reproduced exactly the removed/added diff pair m16 eliminated, and
  // it was invisible to a guard that only looked for the genie version.
  test('no check name embeds any version number', () => {
    const versioned = json.checks.map((c) => c.name).filter((name) => /\d+\.\d+/.test(name));
    expect(versioned).toEqual([]);
    const bun = (json.checks as Array<{ name: string; detail?: string }>).find((c) => c.name === 'bun present');
    expect(bun?.name).toBe('bun present');
    expect(bun?.detail).toContain('1.3.10');
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
    expect(exitCode).toBe(0);
  });

  test('human output renders a header and an honest warning summary', async () => {
    const { output } = await captureDoctor(() => doctorCommand({}, isolatedDoctorDeps()));
    expect(output).toContain('genie doctor');
    expect(output).toContain('warning(s) need attention.');
    expect(output).not.toContain('All checks passed.');
  });
});

describe('budget echo', () => {
  test('reports the schema default as a default on a fresh GENIE_HOME', async () => {
    const [check] = await checkBudgets();
    expect(check.name).toBe('budgets: maxEscalationsPerGroup=2 (default)');
    expect(check.status).toBe('pass');
  });

  test('reports a configured budget as coming from the file', async () => {
    const genieHome = process.env.GENIE_HOME as string;
    mkdirSync(genieHome, { recursive: true });
    writeFileSync(join(genieHome, 'config.json'), JSON.stringify({ budgets: { maxEscalationsPerGroup: 4 } }), 'utf-8');
    const [check] = await checkBudgets();
    expect(check.name).toBe('budgets: maxEscalationsPerGroup=4 (file)');
  });

  test('is read-only — it never creates a config file', async () => {
    const genieHome = process.env.GENIE_HOME as string;
    await checkBudgets();
    expect(existsSync(join(genieHome, 'config.json'))).toBe(false);
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
    expect(exitCode).toBe(0);
  });

  test('is silent when unset, including in the doctor output', async () => {
    delete process.env[key];

    expect(checkSubagentModelOverride()).toEqual([]);
    const { output } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps()));

    expect(output).not.toContain(key);
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
    process.exitCode = 0;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('absent genie.db → pass ("absent"), no failing exit code', async () => {
    const dbCandidate = join(tmp, '.genie', 'genie.db');
    expect(existsSync(dbCandidate)).toBe(false);

    const { output, exitCode } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps(tmp)));
    const json = JSON.parse(output) as { checks: Array<{ name: string; status: string; detail?: string }> };
    const db = json.checks.find((c) => c.name === 'genie.db');
    expect(db?.status).toBe('pass');
    expect(db?.detail).toContain('absent');
    expect(exitCode).toBe(0);
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

  for (const fixture of ['directory', 'malformed-file'] as const) {
    test(`existing ${fixture} genie.db cannot produce a passing Codex project context`, async () => {
      const dbPath = join(tmp, '.genie', 'genie.db');
      mkdirSync(join(tmp, '.genie'), { recursive: true });
      if (fixture === 'directory') mkdirSync(dbPath);
      else writeFileSync(dbPath, 'not a sqlite database');
      const roots = resolveGitProjectRoots(tmp);
      if (roots === null) throw new Error('expected fixture roots');

      const { output, exitCode } = await captureDoctor(() =>
        doctorCommand(
          { json: true },
          {
            ...isolatedDoctorDeps(tmp),
            projectContext: {
              kind: 'ok',
              effectiveLaunchCwd: tmp,
              worktreeConfigRoot: roots.worktreeRoot,
              gitCommonDir: join(roots.commonRoot, '.git'),
              genieStorageRoot: roots.commonRoot,
              dbPath,
            },
          },
        ),
      );
      const json = JSON.parse(output) as {
        ok: boolean;
        checks: Array<{ name: string; status: string; detail: string }>;
      };
      const context = json.checks.find((check) => check.name === 'Codex project context');
      expect(context?.status).toBe('fail');
      expect(context?.detail).toContain('project-database-unavailable');
      expect(context?.detail).toContain(dbPath);
      expect(json.ok).toBe(false);
      expect(exitCode).toBe(1);
    });
  }
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
    // ONE summarized row: the entry names ride the detail, because a name built
    // from whatever the genie home holds is not a stable cross-release diff key
    // (r2 #7 — same class as `v4 residue: plugin cache <version>`).
    const kept = results.filter((r) => r.name === 'kept (uncertain)');
    expect(kept).toHaveLength(1);
    expect(kept[0]?.status).toBe('pass');
    expect(kept[0]?.detail).toContain('.genie, tmux.conf.bak');
    expect(results.filter((r) => r.name.startsWith('kept (uncertain):'))).toEqual([]);

    cleanupV4({ home: fxHome, genieHome: fxGenieHome });
    expect(existsSync(join(fxGenieHome, 'tmux.conf.bak'))).toBe(true);
    expect(existsSync(join(fxGenieHome, '.genie'))).toBe(true);
    expect(existsSync(join(fxGenieHome, 'serve.pid'))).toBe(false);
  });

  // r2 #7 residual: the healthy-checkout scan in `doctorCommand` only sees the
  // names ONE residue-free run happened to emit, so every failure-branch and
  // every dynamically built name was structurally outside its reach — and
  // `v4 residue: plugin cache 4.260421.17` lived there. This scans the
  // name-producing function itself, with every dynamic branch seeded at once.
  test('no check name embeds a version, on the fully seeded v4-residue path', () => {
    mkdirSync(join(fxGenieHome, 'state'), { recursive: true });
    writeFileSync(join(fxGenieHome, 'serve.pid'), '1\n', 'utf-8');
    writeFileSync(join(fxGenieHome, 'tmux.conf.bak'), 'old tmux\n', 'utf-8');
    mkdirSync(join(fxHome, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(fxHome, '.claude', 'rules', 'genie-orchestration.md'), 'genie spawn everything\n', 'utf-8');
    for (const version of ['4.260421.17', '4.250101.1']) {
      const dir = join(fxHome, '.claude', 'plugins', 'cache', 'automagik', 'genie', version);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.orphaned_at'), '2026-01-01\n', 'utf-8');
      writeFileSync(join(dir, 'plugin.json'), '{}\n', 'utf-8');
    }

    const results = checkV4Residue(fxHome, fxGenieHome);

    expect(results.map((r) => r.name).filter((name) => /\d+\.\d+/.test(name))).toEqual([]);
    const cache = results.find((r) => r.name === 'v4 residue: plugin cache');
    expect(cache?.status).toBe('warn');
    expect(cache?.detail).toContain('2 orphaned version dir(s)');
    expect(cache?.detail).toContain('4.250101.1, 4.260421.17');
    // One row per cache dir would also reintroduce duplicate names.
    expect(new Set(results.map((r) => r.name)).size).toBe(results.length);
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
// skills freshness — read-only, path-injected
// ============================================================================

describe('evaluateIndexLaneDrift (pure section↔lane parser)', () => {
  const INDEX = [
    '# Plans Index',
    '',
    '## Raw',
    '- [alpha](brainstorms/alpha/DRAFT.md) — an idea',
    '- a linkless note with no slug',
    '',
    '## Simmering',
    '- [beta](brainstorms/beta/DRAFT.md) — refining',
    '',
    '## Ready',
    '- [WISH: gamma](wishes/gamma/WISH.md) — ready to pour',
    '',
    '## Poured',
    '- [delta](brainstorms/delta/DESIGN.md) · [WISH](wishes/delta/WISH.md) — first link wins',
    '- [epsilon](wishes/epsilon/WISH.md) — laneless card',
    '',
    '## Some Other Heading',
    '- [zeta](brainstorms/zeta/DRAFT.md) — ignored, not a lifecycle section',
  ].join('\n');

  const lanes = new Map<string, string>([
    ['alpha', 'Idea'], // Raw → Idea = ok
    ['beta', 'Wish'], // Simmering allows only Brainstorm → drift
    ['gamma', 'Wish'], // Ready allows Brainstorm|Wish → ok
    ['delta', 'Review'], // Poured allows Wish|Work|Review|Done → ok (via wishes/delta first link)
    // epsilon: card exists but no lane → laneForSlug returns null → unlinked
  ]);
  const laneForSlug = (slug: string): string | null => lanes.get(slug) ?? null;

  test('agreeing lane → ok; contradicting lane → drift', () => {
    const entries = evaluateIndexLaneDrift(INDEX, laneForSlug, () => true);
    const byEntry = Object.fromEntries(entries.map((e) => [e.entry, e]));
    expect(byEntry.alpha.state).toBe('ok');
    expect(byEntry.alpha.lane).toBe('Idea');
    expect(byEntry.beta.state).toBe('drift');
    expect(byEntry['WISH: gamma'].state).toBe('ok');
  });

  test('the FIRST brainstorms/wishes link decides the slug', () => {
    const entries = evaluateIndexLaneDrift(INDEX, laneForSlug, () => true);
    const delta = entries.find((e) => e.entry === 'delta');
    expect(delta?.slug).toBe('delta');
    expect(delta?.state).toBe('ok');
  });

  test('linkless entries and laneless cards are unlinked, never drift', () => {
    const entries = evaluateIndexLaneDrift(INDEX, laneForSlug, () => true);
    const linkless = entries.find((e) => e.slug === null);
    expect(linkless?.state).toBe('unlinked');
    expect(linkless?.section).toBe('Raw');
    const epsilon = entries.find((e) => e.entry === 'epsilon');
    expect(epsilon?.state).toBe('unlinked');
    expect(epsilon?.lane).toBeNull();
    // No entry is ever both resolved-with-lane and unlinked.
    for (const e of entries) if (e.state === 'unlinked') expect(e.lane).toBeNull();
  });

  test('bullets under non-lifecycle headings are excluded', () => {
    const entries = evaluateIndexLaneDrift(INDEX, laneForSlug, () => true);
    expect(entries.some((e) => e.slug === 'zeta')).toBe(false);
    // Raw(2) + Simmering(1) + Ready(1) + Poured(2) = 6 entries.
    expect(entries).toHaveLength(6);
  });

  test('order is stable (INDEX document order)', () => {
    const slugs = evaluateIndexLaneDrift(INDEX, laneForSlug, () => true).map((e) => e.slug);
    expect(slugs).toEqual(['alpha', null, 'beta', 'gamma', 'delta', 'epsilon']);
  });

  test('the resolver receives the reconstructed <dir>/<slug>/<remainder> target', () => {
    const seen: string[] = [];
    evaluateIndexLaneDrift(INDEX, laneForSlug, (target) => {
      seen.push(target);
      return true;
    });
    expect(seen).toEqual([
      'brainstorms/alpha/DRAFT.md',
      'brainstorms/beta/DRAFT.md',
      'wishes/gamma/WISH.md',
      'brainstorms/delta/DESIGN.md',
      'wishes/epsilon/WISH.md',
    ]);
  });

  test('a missing target is broken, and broken outranks drift', () => {
    // beta would be drift (Simmering allows only Brainstorm, card says Wish).
    const entries = evaluateIndexLaneDrift(INDEX, laneForSlug, (target) => target !== 'brainstorms/beta/DRAFT.md');
    const byEntry = Object.fromEntries(entries.map((e) => [e.entry, e]));
    expect(byEntry.beta.state).toBe('broken');
    expect(byEntry.beta.lane).toBe('Wish'); // lane still reported for context
    expect(byEntry.alpha.state).toBe('ok');
  });

  test('broken also outranks unlinked, and linkless entries never reach the resolver', () => {
    const entries = evaluateIndexLaneDrift(INDEX, laneForSlug, () => false);
    const byState = entries.map((e) => e.state);
    // Only the one linkless bullet stays unlinked; every linked entry is broken.
    expect(byState).toEqual(['broken', 'unlinked', 'broken', 'broken', 'broken', 'broken']);
  });
});

describe('checkIndexLaneDrift (DB-backed, warning-level)', () => {
  let dir: string;

  function seedDb(cards: Array<{ title: string; wish: string | null; lane: string | null }>): void {
    mkdirSync(join(dir, '.genie'), { recursive: true });
    const db = new Database(join(dir, '.genie', 'genie.db'));
    db.run(
      'CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, lanes TEXT)',
    );
    db.run(
      'CREATE TABLE tasks (id TEXT PRIMARY KEY, board_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, wish TEXT, lane TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    );
    db.run("INSERT INTO boards VALUES ('b_road', 'roadmap', 0, NULL)");
    let i = 0;
    for (const c of cards) {
      db.query('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        `t_${i}`,
        'b_road',
        c.title,
        'ready',
        c.wish,
        c.lane,
        i,
        i,
      );
      i += 1;
    }
    db.close();
  }

  function writeIndex(text: string): void {
    mkdirSync(join(dir, '.genie'), { recursive: true });
    writeFileSync(join(dir, '.genie', 'INDEX.md'), text);
  }

  /** Materialize a `.genie`-relative link target so the entry is not 'broken'. */
  function writeTarget(relativePath: string): void {
    const full = join(dir, '.genie', relativePath);
    if (relativePath.endsWith('/')) {
      mkdirSync(full, { recursive: true });
      return;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '# target\n');
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genie-jar-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a resolved card whose lane agrees passes with a per-entry ok state', () => {
    writeIndex('# Plans Index\n## Poured\n- [WISH: boards](wishes/boards-first-class/WISH.md) — shipped\n');
    writeTarget('wishes/boards-first-class/WISH.md');
    seedDb([{ title: 'Boards first-class', wish: 'boards-first-class', lane: 'Wish' }]);
    const [result] = checkIndexLaneDrift(dir, dir);
    expect(result.name).toBe('jar: index-lane drift');
    expect(result.status).toBe('pass');
    const entry = result.indexLane?.entries[0];
    expect(entry?.slug).toBe('boards-first-class');
    expect(entry?.lane).toBe('Wish');
    expect(entry?.state).toBe('ok');
  });

  test('a contradicting lane warns (never flips ok:false) and reports drift', () => {
    // Card sits in the Idea lane but the INDEX files it under Poured → drift.
    writeIndex('# Plans Index\n## Poured\n- [WISH: boards](wishes/boards-first-class/WISH.md)\n');
    writeTarget('wishes/boards-first-class/WISH.md');
    seedDb([{ title: 'Boards first-class', wish: 'boards-first-class', lane: 'Idea' }]);
    const [result] = checkIndexLaneDrift(dir, dir);
    expect(result.status).toBe('warn'); // warn, not fail
    expect(result.detail).toContain('1 drift');
    expect(result.indexLane?.entries[0].state).toBe('drift');
    expect(result.suggestion).toBeDefined();
  });

  test('a laneless card is unlinked, not drift', () => {
    writeIndex('# Plans Index\n## Raw\n- [alpha](brainstorms/alpha/DRAFT.md)\n');
    writeTarget('brainstorms/alpha/DRAFT.md');
    seedDb([{ title: 'Alpha', wish: 'alpha', lane: null }]);
    const [result] = checkIndexLaneDrift(dir, dir);
    expect(result.status).toBe('pass');
    expect(result.indexLane?.entries[0].state).toBe('unlinked');
  });

  test('absent INDEX.md is a benign pass (nothing to lint)', () => {
    seedDb([{ title: 'Alpha', wish: 'alpha', lane: 'Idea' }]);
    const [result] = checkIndexLaneDrift(dir, dir);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('nothing to lint');
    expect(result.indexLane).toBeUndefined();
  });

  test('absent DB degrades every linked entry to unlinked (never throws, never drift)', () => {
    writeIndex('# Plans Index\n## Raw\n- [alpha](brainstorms/alpha/DRAFT.md)\n');
    writeTarget('brainstorms/alpha/DRAFT.md');
    const [result] = checkIndexLaneDrift(dir, dir); // no seedDb → no genie.db
    expect(result.status).toBe('pass');
    expect(result.indexLane?.entries[0].state).toBe('unlinked');
  });

  test('mixed board: ≥1 live resolving entry alongside drift and unlinked', () => {
    writeIndex(
      [
        '# Plans Index',
        '## Raw',
        '- [alpha](brainstorms/alpha/DRAFT.md)', // lane Idea → ok
        '## Poured',
        '- [beta](wishes/beta/WISH.md)', // lane Idea (should be Wish-ish) → drift
        '- [orphan](wishes/orphan/WISH.md)', // no card → unlinked
      ].join('\n'),
    );
    for (const t of ['brainstorms/alpha/DRAFT.md', 'wishes/beta/WISH.md', 'wishes/orphan/WISH.md']) writeTarget(t);
    seedDb([
      { title: 'Alpha', wish: 'alpha', lane: 'Idea' },
      { title: 'Beta', wish: 'beta', lane: 'Idea' },
    ]);
    const [result] = checkIndexLaneDrift(dir, dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toBe('3 INDEX entries: 1 ok, 1 drift, 0 broken, 1 unlinked');
    const states = Object.fromEntries((result.indexLane?.entries ?? []).map((e) => [e.slug, e.state]));
    expect(states.alpha).toBe('ok');
    expect(states.beta).toBe('drift');
    expect(states.orphan).toBe('unlinked');
  });

  test('--json rider is present under the stable name with per-entry states', () => {
    writeIndex('# Plans Index\n## Poured\n- [WISH: boards](wishes/boards-first-class/WISH.md)\n');
    writeTarget('wishes/boards-first-class/WISH.md');
    seedDb([{ title: 'Boards first-class', wish: 'boards-first-class', lane: 'Wish' }]);
    const results = checkIndexLaneDrift(dir, dir);
    // Serialize exactly as doctorCommand does and re-parse — the rider must survive.
    const doc = JSON.parse(JSON.stringify({ ok: true, checks: results })) as {
      checks: Array<{
        name: string;
        indexLane?: {
          entries: Array<{ entry: string; slug: string | null; section: string; lane: string | null; state: string }>;
        };
      }>;
    };
    const rider = doc.checks.find((c) => c.name === 'jar: index-lane drift')?.indexLane;
    expect(rider?.entries[0]).toEqual({
      entry: 'WISH: boards',
      slug: 'boards-first-class',
      section: 'Poured',
      lane: 'Wish',
      state: 'ok',
    });
  });

  test('a deleted WISH.md is broken, not ok, and warns', () => {
    // Lane agrees with the section — only the dead target separates this from ok.
    writeIndex('# Plans Index\n## Poured\n- [WISH: boards](wishes/boards-first-class/WISH.md)\n');
    seedDb([{ title: 'Boards first-class', wish: 'boards-first-class', lane: 'Wish' }]);
    const [result] = checkIndexLaneDrift(dir, dir); // no writeTarget → target absent
    expect(result.status).toBe('warn');
    expect(result.detail).toBe('1 INDEX entries: 0 ok, 0 drift, 1 broken, 0 unlinked');
    expect(result.indexLane?.entries[0].state).toBe('broken');
    expect(result.suggestion).toContain('no longer exists');
  });

  test('an #anchor suffix resolves against the file, and a directory link against the directory', () => {
    writeIndex(
      [
        '# Plans Index',
        '## Poured',
        '- [anchored](wishes/anchored/WISH.md#acceptance-criteria)',
        '## Simmering',
        '- [dirlink](brainstorms/dirlink/)',
      ].join('\n'),
    );
    writeTarget('wishes/anchored/WISH.md');
    writeTarget('brainstorms/dirlink/');
    seedDb([
      { title: 'Anchored', wish: 'anchored', lane: 'Wish' }, // Poured allows Wish → ok
      { title: 'Dirlink', wish: 'dirlink', lane: 'Wish' }, // Simmering allows only Brainstorm → drift
    ]);
    const [result] = checkIndexLaneDrift(dir, dir);
    const states = Object.fromEntries((result.indexLane?.entries ?? []).map((e) => [e.slug, e.state]));
    expect(states.anchored).toBe('ok');
    expect(states.dirlink).toBe('drift'); // resolved target → still lane-checked, never broken
  });

  test('an entry that is both dangling and lane-mismatched reports broken', () => {
    writeIndex('# Plans Index\n## Poured\n- [gone](wishes/gone/WISH.md)\n');
    seedDb([{ title: 'Gone', wish: 'gone', lane: 'Idea' }]); // Poured excludes Idea → would be drift
    const [result] = checkIndexLaneDrift(dir, dir);
    expect(result.indexLane?.entries[0].state).toBe('broken');
    expect(result.detail).toContain('0 drift, 1 broken');
  });

  test('a link that traverses outside .genie is broken even when the outside path exists', () => {
    // `..` is a legal slug for the link regex, so the target must be contained,
    // not merely stat-ed — otherwise doctor --json reports whether any path on
    // the machine exists.
    const outside = join(dir, 'outside.md');
    writeFileSync(outside, '# outside\n');
    expect(existsSync(outside)).toBe(true);
    writeIndex('# Plans Index\n## Poured\n- [escape](wishes/../../outside.md)\n');
    const [result] = checkIndexLaneDrift(dir, dir);
    expect(result.indexLane?.entries[0].state).toBe('broken');
    expect(result.detail).toContain('1 broken');
  });

  test('a linkless entry is still unlinked and does not warn', () => {
    writeIndex('# Plans Index\n## Raw\n- a linkless note\n');
    const [result] = checkIndexLaneDrift(dir, dir);
    expect(result.status).toBe('pass');
    expect(result.indexLane?.entries[0].state).toBe('unlinked');
    expect(result.suggestion).toBeUndefined();
  });
});

describe('doctorCommand — index-lane human output and ok invariance', () => {
  function seedIndexFixture(): string {
    const root = join(isolatedHome, 'repo');
    mkdirSync(join(root, '.genie', 'brainstorms', 'live'), { recursive: true });
    writeFileSync(join(root, '.genie', 'brainstorms', 'live', 'DRAFT.md'), '# live\n');
    writeFileSync(
      join(root, '.genie', 'INDEX.md'),
      [
        '# Plans Index',
        '## Raw',
        '- [live](brainstorms/live/DRAFT.md)',
        '- [deleted wish](wishes/deleted/WISH.md)',
        '- a linkless note',
      ].join('\n'),
    );
    return root;
  }

  test('human output names the broken and unlinked entries', async () => {
    seedIndexFixture();
    const { output } = await captureDoctor(() => doctorCommand({}, isolatedDoctorDeps()));
    expect(output).toContain('jar: index-lane drift');
    // No genie.db in the fixture, so the resolving entry is unlinked, not ok.
    expect(output).toContain('0 ok, 0 drift, 1 broken, 2 unlinked');
    expect(output).toContain('· broken: deleted wish');
    expect(output).toContain('· unlinked: a linkless note');
  });

  test('unlinked lines are capped at five while every broken entry is named', async () => {
    const root = join(isolatedHome, 'repo');
    mkdirSync(join(root, '.genie'), { recursive: true });
    const bullets = Array.from({ length: 8 }, (_, i) => `- a linkless note ${i}`);
    // Two dangling links: broken must survive the cap that trims unlinked.
    bullets.push('- [gone one](wishes/gone-one/WISH.md)', '- [gone two](wishes/gone-two/WISH.md)');
    writeFileSync(join(root, '.genie', 'INDEX.md'), ['# Plans Index', '## Raw', ...bullets].join('\n'));
    const { output } = await captureDoctor(() => doctorCommand({}, isolatedDoctorDeps()));
    expect(output).toContain('· unlinked: a linkless note 4');
    expect(output).not.toContain('· unlinked: a linkless note 5');
    expect(output).toContain('· …and 3 more unlinked');
    expect(output).toContain('· broken: gone one');
    expect(output).toContain('· broken: gone two');
  });

  test('broken and unlinked entries never flip doctor ok', async () => {
    seedIndexFixture();
    const { output } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps()));
    const doc = JSON.parse(output) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; indexLane?: { entries: Array<{ state: string }> } }>;
    };
    const check = doc.checks.find((c) => c.name === 'jar: index-lane drift');
    expect(check?.status).toBe('warn');
    expect(check?.indexLane?.entries.map((e) => e.state)).toEqual(['unlinked', 'broken', 'unlinked']);
    expect(doc.checks.some((c) => c.status === 'fail')).toBe(false);
    expect(doc.ok).toBe(true);
  });
});

describe('checkRetiredJsonMcpEntry', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'genie-doctor-mcpjson-'));
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  test('warns, names the file, and names the fix when the dead registration is still there', () => {
    writeFileSync(
      join(repoRoot, '.mcp.json'),
      '{"mcpServers":{"genie":{"command":"/home/u/.genie/bin/genie","args":["mcp"]}}}',
    );
    const [check] = checkRetiredJsonMcpEntry(repoRoot);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain(join(repoRoot, '.mcp.json'));
    expect(check.suggestion).toContain('genie init');
  });

  test('passes on an absent, clean, symlinked, or unparseable .mcp.json', () => {
    expect(checkRetiredJsonMcpEntry(repoRoot)[0].status).toBe('pass');

    writeFileSync(join(repoRoot, '.mcp.json'), '{"mcpServers":{"other":{"command":"x"}}}');
    expect(checkRetiredJsonMcpEntry(repoRoot)[0].status).toBe('pass');

    // A user wrapper under the same key is not the retired registration.
    writeFileSync(join(repoRoot, '.mcp.json'), '{"mcpServers":{"genie":{"command":"/mine","args":["mcp"]}}}');
    expect(checkRetiredJsonMcpEntry(repoRoot)[0].status).toBe('pass');

    writeFileSync(join(repoRoot, '.mcp.json'), 'not json');
    expect(checkRetiredJsonMcpEntry(repoRoot)[0].status).toBe('pass');
  });

  test('never flips doctor ok:false — it is warning-level on a user-owned file', () => {
    writeFileSync(join(repoRoot, '.mcp.json'), '{"mcpServers":{"genie":{"command":"genie","args":["mcp"]}}}');
    expect(checkRetiredJsonMcpEntry(repoRoot).every((c) => c.status !== 'fail')).toBe(true);
  });
});

describe('checkTrackedMachineState (committed machine-local .genie state)', () => {
  let repoRoot: string;

  function gitIn(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  }

  function commitPath(relative: string, body = '{}\n'): void {
    const target = join(repoRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    // `-f`: the point of the check is a file a LATER .gitignore rule covers.
    gitIn('add', '-f', relative);
    gitIn('commit', '-q', '-m', `add ${relative}`);
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'genie-doctor-tracked-'));
    execFileSync('git', ['init', '-q'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  test('a clean repo passes, and so does one that only tracks real board documents', () => {
    expect(checkTrackedMachineState(repoRoot)[0]).toMatchObject({ status: 'pass' });
    commitPath('.genie/roadmap.json', '{"schemaVersion":1}\n');
    commitPath('.genie/INDEX.md', '# Plans Index\n');
    expect(checkTrackedMachineState(repoRoot)[0]).toMatchObject({ status: 'pass' });
  });

  test('a committed .genie/roadmap-sync warns, names the file, and gives both repair steps', () => {
    commitPath('.genie/roadmap-sync');
    const [check] = checkTrackedMachineState(repoRoot);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('.genie/roadmap-sync');
    // Both halves of the remedy: the rule alone never untracks the file.
    expect(check.suggestion).toContain('genie init');
    expect(check.suggestion).toContain('git rm --cached .genie/roadmap-sync');
  });

  test('every machine-local path is observed, sorted, and bounded in the detail line', () => {
    commitPath('.genie/roadmap-sync');
    commitPath('.genie/genie.db', 'binary-ish\n');
    commitPath('.genie/launch/group.prompt', 'kickoff\n');
    expect(probeTrackedMachineState(repoRoot)).toEqual({
      observed: true,
      paths: ['.genie/genie.db', '.genie/launch/group.prompt', '.genie/roadmap-sync'],
    });
    const [check] = checkTrackedMachineState(repoRoot);
    expect(check.detail).toContain('3 machine-local path(s) are committed');
    expect(check.detail?.indexOf('.genie/genie.db')).toBeLessThan(check.detail?.indexOf('.genie/roadmap-sync') ?? -1);
  });

  /**
   * Dogfood r7: every unobservable case reported `pass`, so a consumer reading
   * `status` alone — or a dashboard counting pass/warn — was handed a clean bill
   * the check never earned. Unobservable is `warn` with the reason, always.
   */
  test('outside git, or where the index cannot be read, it warns with the reason instead of passing', () => {
    const [outside] = checkTrackedMachineState(null);
    expect(outside.status).toBe('warn');
    expect(outside.detail).toContain('not inside a git repository');
    expect(outside.detail).toContain('could not be checked');
    const notARepo = mkdtempSync(join(tmpdir(), 'genie-doctor-nogit-'));
    try {
      expect(probeTrackedMachineState(notARepo)).toEqual({ observed: false, reason: 'unreadable-index' });
      const [unreadable] = checkTrackedMachineState(notARepo);
      expect(unreadable.status).toBe('warn');
      expect(unreadable.detail).toContain(`could not query the git index at ${notARepo}`);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  /**
   * A real spawn against a real PATH with no git — the only way to observe the
   * genuine ENOENT the classifier keys on. Dogfood r7: inside a real work tree
   * with git absent the check said "not inside a git repository", which is a
   * false statement about the repository, not about the host.
   */
  test('a missing git binary is named as such, never as "not inside a git repository"', async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), 'genie-doctor-nopath-'));
    try {
      const module = join(import.meta.dir, 'doctor.ts');
      const script = [
        `const m = await import(${JSON.stringify(module)});`,
        'process.stdout.write(JSON.stringify({',
        `  probe: m.probeTrackedMachineState(${JSON.stringify(repoRoot)}),`,
        `  inRepo: m.checkTrackedMachineState(${JSON.stringify(repoRoot)})[0],`,
        '  outside: m.checkTrackedMachineState(null)[0],',
        '}));',
      ].join('\n');
      const proc = Bun.spawn([process.execPath, '-e', script], {
        env: { ...process.env, PATH: emptyBin },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const seen = JSON.parse(stdout) as {
        probe: unknown;
        inRepo: { status: string; detail: string; suggestion?: string };
        outside: { status: string; detail: string };
      };
      expect(seen.probe).toEqual({ observed: false, reason: 'no-git-binary' });
      for (const check of [seen.inRepo, seen.outside]) {
        expect(check.status).toBe('warn');
        expect(check.detail).toContain('git is not installed');
        expect(check.detail).not.toContain('not inside a git repository');
      }
      expect(seen.inRepo.suggestion).toContain('Install git');
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test('warning-level only: a tracked baseline never flips doctor ok:false', async () => {
    commitPath('.genie/roadmap-sync');
    const { output } = await captureDoctor(() => doctorCommand({ json: true }, isolatedDoctorDeps(repoRoot)));
    const doc = JSON.parse(output) as { ok: boolean; checks: Array<{ name: string; status: string }> };
    const check = doc.checks.find((c) => c.name === 'git: machine-local .genie state');
    expect(check?.status).toBe('warn');
    expect(doc.ok).toBe(true);
  });
});

// ============================================================================
// Orca lifecycle authority — doctor never opens the local store
// ============================================================================

describe('checkCodexProjectContext under Orca', () => {
  function writeOrchestrationMode(mode: string): void {
    const home = process.env.GENIE_HOME as string;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ orchestration: { mode } }));
  }

  test('reports the authority without resolving context or opening genie.db', () => {
    writeOrchestrationMode('orca');
    const repoRoot = join(isolatedHome, 'repo');
    const [check] = checkCodexProjectContext(repoRoot);
    expect(check.status).toBe('pass');
    expect(check.detail).toBe('not resolved — Orca is the selected lifecycle authority');
    // The guard forbids the open, so nothing may have been created either.
    expect(existsSync(join(repoRoot, '.genie', 'genie.db'))).toBe(false);
  });

  test('still resolves context in standalone mode', () => {
    writeOrchestrationMode('standalone');
    const [check] = checkCodexProjectContext(join(isolatedHome, 'repo'));
    expect(check.detail).not.toContain('Orca is the selected lifecycle authority');
  });
});

// ============================================================================
// skills.sh channel + legacy integrations (wish `skills-everywhere`, group 3)
// ============================================================================

interface SkillsChannelJson {
  ok: boolean;
  checks: Array<{
    name: string;
    status: string;
    detail?: string;
    suggestion?: string;
    skillsChannel?: {
      agent: string;
      present: number;
      total: number;
      ref: string;
      stale: boolean;
      detected: boolean;
      recorded: boolean;
    };
    legacyIntegrations?: { pending: Array<{ surface: string; path: string }>; available: boolean };
  }>;
}

/** `<home>/<...segments>/<name>/SKILL.md` for each name. */
function seedAgentSkills(home: string, segments: string[], names: string[]): void {
  for (const name of names) {
    const dir = join(home, ...segments, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`);
  }
}

function seedSkillsRecord(genieHome: string, overrides: Partial<SkillsInstallRecord> = {}): void {
  writeSkillsInstallRecord(genieHome, {
    ref: releaseTag(VERSION),
    cliVersion: '1.5.23',
    inventory: ['alpha', 'beta'],
    agentDirs: [join(isolatedHome, '.claude', 'skills'), join(isolatedHome, '.agents', 'skills')],
    installedAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  });
}

function skillsChannelResults(): CheckResult[] {
  return checkSkillsChannel({ home: isolatedHome, genieHome: process.env.GENIE_HOME as string });
}

function byName(results: CheckResult[], name: string): CheckResult {
  const found = results.find((result) => result.name === name);
  if (found === undefined) throw new Error(`no check named ${name} in ${results.map((r) => r.name).join(', ')}`);
  return found;
}

describe('doctor: skills.sh channel', () => {
  test('two detected agent homes with a complete current record report two pass lines', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedAgentSkills(isolatedHome, ['.agents', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string);

    const results = skillsChannelResults();
    const complete = results.filter((r) => r.status === 'pass' && r.detail === `2/2 @ ${releaseTag(VERSION)}`);
    expect(complete.map((r) => r.name)).toEqual(['skills: claude', 'skills: agents']);
    expect(results.filter((r) => r.status === 'warn')).toEqual([]);
    expect(byName(results, 'skills: claude').skillsChannel).toEqual({
      agent: 'claude',
      present: 2,
      total: 2,
      ref: releaseTag(VERSION),
      stale: false,
      detected: true,
      recorded: true,
    });
  });

  /** X3: a malformed record is a finding of its own, never "no install record". */
  test('a schema-invalid record warns with the offending field and the repair remedy', () => {
    const genieHome = process.env.GENIE_HOME as string;
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(genieHome);
    const recordPath = join(genieHome, 'skills-install.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    record.preserved = [{ agentDir: join(isolatedHome, '.claude', 'skills'), skill: '../etc', reason: 'x' }];
    writeFileSync(recordPath, JSON.stringify(record));

    const results = skillsChannelResults();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'skills: channel', status: 'warn' });
    expect(results[0]?.detail).toContain('preserved.0.skill');
    expect(results[0]?.detail).not.toContain('no install record');
    expect(results[0]?.suggestion).toContain(recordPath);
  });

  test('preserved retired skill dirs warn with their path and reason', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta', 'trace']);
    seedAgentSkills(isolatedHome, ['.agents', 'skills'], ['alpha', 'beta', 'perf']);
    // Retired dirs the last update could not archive. They are not in
    // `inventory`, so every per-home line still reads 2/2: without this check
    // the host reports clean while the directories sit there forever.
    seedSkillsRecord(process.env.GENIE_HOME as string, {
      preserved: [
        { agentDir: join(isolatedHome, '.claude', 'skills'), skill: 'trace', reason: 'no recorded content digest' },
        {
          agentDir: join(isolatedHome, '.agents', 'skills'),
          skill: 'perf',
          reason: 'content changed since the recorded install',
        },
      ],
    });

    const results = skillsChannelResults();
    expect(byName(results, 'skills: claude').status).toBe('pass');
    const retirement = byName(results, 'skills: retirement');
    expect(retirement.status).toBe('warn');
    expect(retirement.detail).toBe(
      `2 preserved retired skill dir(s): ${join(isolatedHome, '.claude', 'skills', 'trace')} (no recorded content digest); ${join(isolatedHome, '.agents', 'skills', 'perf')} (content changed since the recorded install)`,
    );
    expect(retirement.suggestion).toBe('Review them, remove them, then run `genie update` to retry retirement');
  });

  /**
   * m4: the check reproduced the record verbatim, so a preserved directory the
   * operator had already deleted was still named — byte-identically, count and
   * all — until the next `genie update` rewrote the record. A path that is gone
   * is resolved work, not outstanding work.
   */
  test('a preserved entry whose path is gone is reported resolved, not outstanding', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta', 'trace']);
    seedAgentSkills(isolatedHome, ['.agents', 'skills'], ['alpha', 'beta']);
    const gone = join(isolatedHome, '.agents', 'skills', 'perf');
    seedSkillsRecord(process.env.GENIE_HOME as string, {
      preserved: [
        { agentDir: join(isolatedHome, '.claude', 'skills'), skill: 'trace', reason: 'no recorded content digest' },
        { agentDir: join(isolatedHome, '.agents', 'skills'), skill: 'perf', reason: 'no recorded content digest' },
      ],
    });

    const retirement = byName(skillsChannelResults(), 'skills: retirement');
    expect(retirement.status).toBe('warn');
    expect(retirement.detail).toBe(
      `1 preserved retired skill dir(s): ${join(isolatedHome, '.claude', 'skills', 'trace')} (no recorded content digest); 1 already resolved (gone from disk, dropped from the record by the next \`genie update\`): ${gone}`,
    );
  });

  test('every preserved entry gone from disk passes instead of warning', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedAgentSkills(isolatedHome, ['.agents', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string, {
      preserved: [
        { agentDir: join(isolatedHome, '.claude', 'skills'), skill: 'trace', reason: 'no recorded content digest' },
      ],
    });

    const retirement = byName(skillsChannelResults(), 'skills: retirement');
    expect(retirement.status).toBe('pass');
    expect(retirement.detail).toContain('are gone from disk');
    expect(retirement.suggestion).toBeUndefined();
  });

  /**
   * m2: `agentDirs` is `genie uninstall`'s removal authority and held 57
   * entries on the 2026-09-15 dogfood host, while doctor could only see the
   * four rows of `KNOWN_AGENT_SKILL_HOMES` — so a home that lost content, or
   * vanished entirely, still read `ok: true`.
   */
  test('recorded agent dirs are compared against the record inventory', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedAgentSkills(isolatedHome, ['.agents', 'skills'], ['alpha', 'beta']);
    const extra = join(isolatedHome, '.openclaw', 'skills');
    seedAgentSkills(isolatedHome, ['.openclaw', 'skills'], ['alpha']);
    const missing = join(isolatedHome, '.ghosthome', 'skills');
    seedSkillsRecord(process.env.GENIE_HOME as string, {
      agentDirs: [join(isolatedHome, '.claude', 'skills'), join(isolatedHome, '.agents', 'skills'), extra, missing],
    });

    const agentDirs = byName(skillsChannelResults(), 'skills: agent dirs');
    expect(agentDirs.status).toBe('warn');
    expect(agentDirs.detail).toBe(
      `2/4 recorded homes complete @ ${releaseTag(VERSION)}; incomplete: ${extra} (1/2); ${missing} (not on disk)`,
    );
    expect(agentDirs.suggestion).toBe('Run `genie update` to reinstall the skills channel into every recorded home');
  });

  test('recorded agent dirs pass when every recorded home carries the full inventory', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedAgentSkills(isolatedHome, ['.agents', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string);

    const agentDirs = byName(skillsChannelResults(), 'skills: agent dirs');
    expect(agentDirs.status).toBe('pass');
    expect(agentDirs.detail).toBe(`2/2 recorded homes complete @ ${releaseTag(VERSION)}`);
  });

  test('a record with nothing preserved emits no retirement check', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string);
    expect(skillsChannelResults().map((result) => result.name)).not.toContain('skills: retirement');
  });

  test('a Codex host reports `skills: agents`, never a false `skills: codex` warning', () => {
    // skills.sh 1.5.23 `--all --copy -g` creates no `~/.codex/skills`; Codex
    // reads `~/.agents/skills`. A bare `~/.codex` must not produce a check.
    mkdirSync(join(isolatedHome, '.codex'), { recursive: true });
    seedAgentSkills(isolatedHome, ['.agents', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string);

    const results = skillsChannelResults();
    expect(results.map((r) => r.name)).not.toContain('skills: codex');
    expect(results.map((r) => r.name)).not.toContain('skills: cursor');
    expect(byName(results, 'skills: agents')).toMatchObject({
      status: 'pass',
      detail: `2/2 @ ${releaseTag(VERSION)}`,
    });
    // Per-agent rows only: the record names a `.claude` home this host does not
    // have, which is the `skills: agent dirs` line's business, not this one's.
    expect(results.filter((r) => r.status === 'warn' && r.skillsChannel !== undefined)).toEqual([]);
  });

  test('a file (not a directory) at an agent config home is `not detected`', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string);
    writeFileSync(join(isolatedHome, '.agents'), 'not a directory\n');

    const agents = byName(skillsChannelResults(), 'skills: agents');
    expect(agents.status).toBe('pass');
    expect(agents.detail).toBe('not detected');
  });

  test('a missing skill under one agent warns with the `genie update` remedy', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedAgentSkills(isolatedHome, ['.agents', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string);
    rmSync(join(isolatedHome, '.agents', 'skills', 'beta'), { recursive: true, force: true });

    const results = skillsChannelResults();
    const agentsHome = byName(results, 'skills: agents');
    expect(agentsHome.status).toBe('warn');
    expect(agentsHome.detail).toBe(`1/2 @ ${releaseTag(VERSION)}`);
    expect(agentsHome.suggestion).toBe('Run `genie update` to install the skills.sh channel');
    expect(agentsHome.skillsChannel).toMatchObject({ agent: 'agents', present: 1, total: 2, detected: true });
    // The healthy agent is untouched by its neighbour's drift.
    expect(byName(results, 'skills: claude').status).toBe('pass');
  });

  test('an undetected agent home passes as `not detected` and never warns', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string);
    expect(existsSync(join(isolatedHome, '.config', 'goose'))).toBe(false);

    const goose = byName(skillsChannelResults(), 'skills: goose');
    expect(goose.status).toBe('pass');
    expect(goose.detail).toBe('not detected');
    expect(goose.skillsChannel).toMatchObject({ agent: 'goose', detected: false, present: 0, total: 2 });
  });

  test('a record from an older release is stale even when every skill is present', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string, { ref: 'v5.000000.1' });

    const claude = byName(skillsChannelResults(), 'skills: claude');
    expect(claude.status).toBe('warn');
    expect(claude.detail).toBe(`2/2 @ v5.000000.1 (stale, binary is ${releaseTag(VERSION)})`);
    expect(claude.suggestion).toBe('Run `genie update` to install the skills.sh channel');
    expect(claude.skillsChannel).toMatchObject({ ref: 'v5.000000.1', stale: true });
  });

  test('no install record and no delivered tree is a single channel warning', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha']);
    const results = skillsChannelResults();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'skills: channel',
      status: 'warn',
      detail: 'no install record',
      suggestion: 'Run `genie update` to install the skills.sh channel',
    });
    expect(results[0]?.skillsChannel).toBeUndefined();
  });

  test('no install record but a delivered tree still compares against the tree', () => {
    const genieHome = process.env.GENIE_HOME as string;
    seedAgentSkills(genieHome, ['skills'], ['alpha', 'beta']);
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);

    const results = skillsChannelResults();
    expect(byName(results, 'skills: channel').status).toBe('warn');
    // No record => no provenance. The line must not read as if `ref` were the
    // release the skills were actually installed from.
    const claude = byName(results, 'skills: claude');
    expect(claude).toMatchObject({ status: 'pass', detail: `2/2 @ ${releaseTag(VERSION)} (unrecorded)` });
    expect(claude.skillsChannel).toMatchObject({ recorded: false, stale: false, ref: releaseTag(VERSION) });
  });

  /**
   * D4: `state-backups/` roots are never removed by anything genie runs, so the
   * record accumulates them and doctor is where an operator learns the kept
   * copies exist. Warn-level only while the newest is fresh — after a week it
   * is a fact about the host, not a finding — and always read-only.
   */
  function seedCollisionBackupRoot(genieHome: string, stamp: string): string {
    const root = join(genieHome, 'state-backups', `skills-collision-${stamp}`);
    mkdirSync(join(root, '.claude', 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'alpha', 'SKILL.md'), '# someone else\n');
    return root;
  }

  test('kept collision backup roots are listed, warning only while the newest is fresh', () => {
    const genieHome = process.env.GENIE_HOME as string;
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    const older = seedCollisionBackupRoot(genieHome, '2026-09-01T00-00-00-000Z');
    const newest = seedCollisionBackupRoot(genieHome, '2026-09-15T00-00-00-000Z');
    seedSkillsRecord(genieHome, {
      collisionBackups: [
        { root: older, entries: [{ dir: join(isolatedHome, '.claude', 'skills', 'alpha'), skill: 'alpha' }] },
        {
          root: newest,
          entries: [
            { dir: join(isolatedHome, '.claude', 'skills', 'alpha'), skill: 'alpha', kind: 'foreign' },
            { dir: join(isolatedHome, '.claude', 'skills', 'beta'), skill: 'beta', kind: 'modified' },
          ],
        },
      ],
    });
    const writtenAtMs = statSync(newest).mtimeMs;
    const detail = `2 root(s), latest ${newest} (2 replaced dir(s))`;

    const fresh = checkSkillsChannel({
      home: isolatedHome,
      genieHome,
      nowMs: () => writtenAtMs + 6 * 24 * 60 * 60 * 1000,
    });
    expect(byName(fresh, 'skills: collision backups')).toMatchObject({ status: 'warn', detail });

    const settled = checkSkillsChannel({
      home: isolatedHome,
      genieHome,
      nowMs: () => writtenAtMs + 8 * 24 * 60 * 60 * 1000,
    });
    expect(byName(settled, 'skills: collision backups')).toMatchObject({ status: 'pass', detail });
    expect(settled.find((result) => result.name === 'skills: collision backups')?.suggestion).toBeUndefined();
    // Read-only observer: nothing under state-backups was touched.
    expect(existsSync(join(older, '.claude', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(newest, '.claude', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
  });

  test('a recorded collision backup root the operator deleted reports as gone, never recreated', () => {
    const genieHome = process.env.GENIE_HOME as string;
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    const root = join(genieHome, 'state-backups', 'skills-collision-2026-09-01T00-00-00-000Z');
    seedSkillsRecord(genieHome, {
      collisionBackups: [
        { root, entries: [{ dir: join(isolatedHome, '.claude', 'skills', 'alpha'), skill: 'alpha' }] },
      ],
    });

    const results = skillsChannelResults();
    expect(byName(results, 'skills: collision backups')).toMatchObject({
      status: 'pass',
      detail: '1 recorded root(s), none still on disk',
    });
    expect(existsSync(root)).toBe(false);
  });

  test('a record with no collision backups prints no line at all', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string);
    expect(skillsChannelResults().some((result) => result.name === 'skills: collision backups')).toBe(false);
  });
});

// ============================================================================
// Workflows channel (wish `global-workflows-local-mikro`, group 3)
// ============================================================================

describe('doctor: workflows channel', () => {
  const WORKFLOWS_LINE = 'workflows: catalog';
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

  function workflowsDir(): string {
    return join(isolatedHome, '.claude', 'workflows');
  }

  /** Write `<home>/.claude/workflows/<name>` and return its digest. */
  function seedWorkflowFile(name: string, body: string): string {
    mkdirSync(workflowsDir(), { recursive: true });
    writeFileSync(join(workflowsDir(), name), body);
    return sha256(body);
  }

  function seedWorkflowsRecord(files: Record<string, string>, ref = releaseTag(VERSION)): void {
    seedSkillsRecord(process.env.GENIE_HOME as string, {
      workflows: { dir: workflowsDir(), ref, files },
    });
  }

  function workflowsResults(): CheckResult[] {
    return checkWorkflowsChannel({ home: isolatedHome, genieHome: process.env.GENIE_HOME as string });
  }

  /** Every path under `root` with its size and mtime — a doctor run must not move one. */
  function snapshot(root: string): string[] {
    const seen: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = join(dir, entry.name);
        const stat = statSync(path);
        seen.push(`${path} ${stat.size} ${stat.mtimeMs}`);
        if (entry.isDirectory()) walk(path);
      }
    };
    walk(root);
    return seen;
  }

  test('a complete current record reports one pass line and writes nothing', () => {
    const files = {
      'council.js': seedWorkflowFile('council.js', "export const meta = { name: 'council' }\n"),
      'wish.js': seedWorkflowFile('wish.js', "export const meta = { name: 'wish' }\n"),
    };
    seedWorkflowsRecord(files);
    const before = snapshot(isolatedHome);

    expect(byName(workflowsResults(), WORKFLOWS_LINE)).toEqual({
      name: WORKFLOWS_LINE,
      status: 'pass',
      detail: `2/2 in ${workflowsDir()} @ ${releaseTag(VERSION)}`,
    });
    // Read-only observer: not one byte, and not one mtime, moved.
    expect(snapshot(isolatedHome)).toEqual(before);
  });

  test('a hand-edited file warns as modified and names it', () => {
    const files = {
      'council.js': seedWorkflowFile('council.js', "export const meta = { name: 'council' }\n"),
      'wish.js': seedWorkflowFile('wish.js', "export const meta = { name: 'wish' }\n"),
    };
    seedWorkflowsRecord(files);
    writeFileSync(join(workflowsDir(), 'council.js'), '// local edit\n');

    const result = byName(workflowsResults(), WORKFLOWS_LINE);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('1/2 ');
    expect(result.detail).toContain('council.js (modified)');
    expect(result.suggestion).toBe('Run `genie update` to reinstall the workflow catalog');
  });

  test('a deleted file warns as missing', () => {
    const files = {
      'council.js': seedWorkflowFile('council.js', "export const meta = { name: 'council' }\n"),
    };
    seedWorkflowsRecord(files);
    rmSync(join(workflowsDir(), 'council.js'));

    const result = byName(workflowsResults(), WORKFLOWS_LINE);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('0/1 ');
    expect(result.detail).toContain('council.js (missing)');
  });

  test('a symlink at a recorded name is never followed — it reports as not a regular file', () => {
    const files = { 'council.js': sha256("export const meta = { name: 'council' }\n") };
    mkdirSync(workflowsDir(), { recursive: true });
    writeFileSync(join(isolatedHome, 'elsewhere.js'), "export const meta = { name: 'council' }\n");
    symlinkSync(join(isolatedHome, 'elsewhere.js'), join(workflowsDir(), 'council.js'));
    seedWorkflowsRecord(files);

    const result = byName(workflowsResults(), WORKFLOWS_LINE);
    // The link TARGET hashes to the recorded digest; following it would have
    // read `1/1`. The check refuses to resolve it, so it stays drift.
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('0/1 ');
    expect(result.detail).toContain('council.js (not a regular file)');
  });

  test('a record from another release is stale even when every file matches', () => {
    const files = { 'council.js': seedWorkflowFile('council.js', "export const meta = { name: 'council' }\n") };
    seedWorkflowsRecord(files, 'v0.000000.1');

    const result = byName(workflowsResults(), WORKFLOWS_LINE);
    expect(result.status).toBe('warn');
    expect(result.detail).toBe(`1/1 in ${workflowsDir()} @ v0.000000.1 (stale, binary is ${releaseTag(VERSION)})`);
  });

  test('a record without the workflows field reads as unrecorded, or not detected without ~/.claude', () => {
    seedSkillsRecord(process.env.GENIE_HOME as string);
    expect(byName(workflowsResults(), WORKFLOWS_LINE)).toEqual({
      name: WORKFLOWS_LINE,
      status: 'pass',
      detail: 'not detected',
    });

    mkdirSync(join(isolatedHome, '.claude'), { recursive: true });
    // No shipped catalog under this GENIE_HOME, so the channel could not run
    // even if asked: the line states the fact and offers no remedy it cannot keep.
    expect(byName(workflowsResults(), WORKFLOWS_LINE)).toEqual({
      name: WORKFLOWS_LINE,
      status: 'pass',
      detail: '(unrecorded)',
    });
  });

  /** `<GENIE_HOME>/templates/workflows/<name>` for each name — the release's catalog. */
  function seedShippedCatalog(names: string[]): void {
    const root = join(process.env.GENIE_HOME as string, 'templates', 'workflows');
    mkdirSync(root, { recursive: true });
    for (const name of names) writeFileSync(join(root, name), `export const meta = { name: '${name}' }\n`);
  }

  test('an unrecorded stale file at a catalog name is named, with a remedy', () => {
    seedShippedCatalog(['council.js', 'wish.js']);
    seedWorkflowFile('council.js', '// the stale stamped install\n');
    seedSkillsRecord(process.env.GENIE_HOME as string);

    const result = byName(workflowsResults(), WORKFLOWS_LINE);
    expect(result.status).toBe('warn');
    expect(result.detail).toBe('(unrecorded) 1 file(s) genie did not record: council.js');
    expect(result.suggestion).toContain('genie update');
    expect(result.suggestion).toContain('state-backups');
  });

  test('an unrecorded scope holding only names this release does not ship stays a pass', () => {
    seedShippedCatalog(['council.js']);
    seedWorkflowFile('someone-elses.js', '// not genie namespace\n');
    seedSkillsRecord(process.env.GENIE_HOME as string);

    const before = snapshot(isolatedHome);
    const result = byName(workflowsResults(), WORKFLOWS_LINE);
    // A catalog NAME is the whole claim: doctor never lists the user's dir, so a
    // workflow outside genie's namespace is structurally invisible here.
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('(unrecorded)');
    // The channel could run, so the pass still carries the remedy.
    expect(result.suggestion).toContain('genie update');
    expect(snapshot(isolatedHome)).toEqual(before);
  });

  test('an unrecorded symlink at a catalog name is named, never followed', () => {
    seedShippedCatalog(['council.js']);
    mkdirSync(workflowsDir(), { recursive: true });
    writeFileSync(join(isolatedHome, 'elsewhere.js'), "export const meta = { name: 'council' }\n");
    symlinkSync(join(isolatedHome, 'elsewhere.js'), join(workflowsDir(), 'council.js'));
    seedSkillsRecord(process.env.GENIE_HOME as string);

    const result = byName(workflowsResults(), WORKFLOWS_LINE);
    expect(result.status).toBe('warn');
    expect(result.detail).toBe('(unrecorded) 1 file(s) genie did not record: council.js (not a regular file)');
    // Read-only, and the link is still a link pointing where it pointed.
    expect(readFileSync(join(isolatedHome, 'elsewhere.js'), 'utf8')).toBe("export const meta = { name: 'council' }\n");
  });

  test('with no install record at all the unrecorded scan still runs and writes nothing', () => {
    seedShippedCatalog(['council.js', 'wish.js']);
    seedWorkflowFile('council.js', '// the stale stamped install\n');
    seedWorkflowFile('wish.js', '// another one\n');

    const before = snapshot(isolatedHome);
    const result = byName(workflowsResults(), WORKFLOWS_LINE);
    // The host that carries pre-record leftovers is exactly the host with no
    // record, so the scan must not sit behind a record that exists.
    expect(result.status).toBe('warn');
    expect(result.detail).toBe('(unrecorded) 2 file(s) genie did not record: council.js; wish.js');
    expect(snapshot(isolatedHome)).toEqual(before);
  });

  test('a malformed record prints no workflows line — the skills check owns that one remedy', () => {
    const genieHome = process.env.GENIE_HOME as string;
    mkdirSync(genieHome, { recursive: true });
    writeFileSync(join(genieHome, 'skills-install.json'), '{"ref":"v1"}');

    expect(workflowsResults()).toEqual([]);
    expect(byName(skillsChannelResults(), 'skills: channel').status).toBe('warn');
  });

  test('more than five drifting files are named up to five with a remainder', () => {
    const files: Record<string, string> = {};
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      files[`${name}.js`] = sha256(`export const meta = { name: '${name}' }\n`);
    }
    seedWorkflowsRecord(files);

    const result = byName(workflowsResults(), WORKFLOWS_LINE);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('0/7 ');
    expect(result.detail).toContain('+2 more');
  });
});

describe('doctor: legacy marker-owned integrations', () => {
  const pendingClassifier: LegacyClassifier = () => ({
    entries: [
      { surface: 'codex-skills', path: '/home/u/.codex/skills/genie-wish', state: 'managed-clean' },
      { surface: 'codex-agents', path: '/home/u/.codex/agents/genie.md', state: 'managed-modified' },
      { surface: 'claude-skills', path: '/home/u/.claude/skills/other', state: 'unmanaged' },
      { surface: 'gone', path: '/home/u/.agents/skills/old', state: 'absent' },
    ],
  });

  test('one managed-clean asset warns and names its path', async () => {
    const results = await checkLegacyIntegrations({ legacyClassifier: pendingClassifier });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'legacy integrations',
      status: 'warn',
      suggestion: 'Run `genie update` to retire them',
    });
    expect(results[0]?.detail).toBe('1 marker-owned assets pending: /home/u/.codex/skills/genie-wish');
    expect(results[0]?.legacyIntegrations).toEqual({
      pending: [{ surface: 'codex-skills', path: '/home/u/.codex/skills/genie-wish' }],
      available: true,
    });
  });

  test('nothing managed-clean is `retired`', async () => {
    const results = await checkLegacyIntegrations({
      legacyClassifier: () => ({
        entries: [{ surface: 'codex-skills', path: '/home/u/.codex/skills/x', state: 'unmanaged' as const }],
      }),
    });
    expect(results[0]).toMatchObject({ name: 'legacy integrations', status: 'pass', detail: 'retired' });
    expect(results[0]?.legacyIntegrations).toEqual({ pending: [], available: true });
  });

  test('more than five pending assets name five and count the remainder', async () => {
    const results = await checkLegacyIntegrations({
      legacyClassifier: () => ({
        entries: Array.from({ length: 7 }, (_, index) => ({
          surface: 'codex-skills',
          path: `/home/u/.codex/skills/s${index}`,
          state: 'managed-clean' as const,
        })),
      }),
    });
    expect(results[0]?.detail).toContain('7 marker-owned assets pending:');
    expect(results[0]?.detail).toContain('/home/u/.codex/skills/s4');
    expect(results[0]?.detail).toContain('…and 2 more');
    expect(results[0]?.detail).not.toContain('/home/u/.codex/skills/s5');
    expect(results[0]?.legacyIntegrations?.pending).toHaveLength(7);
  });

  test('a null classifier seam degrades to a passing `classifier unavailable` that still rides the rider', async () => {
    const results = await checkLegacyIntegrations({ legacyClassifier: null });
    expect(results[0]).toMatchObject({ name: 'legacy integrations', status: 'pass' });
    expect(results[0]?.detail).toBe('classifier unavailable');
    // `available:false` is what separates "nothing pending" from "nothing observed".
    expect(results[0]?.legacyIntegrations).toEqual({ pending: [], available: false });
  });

  test('the default path uses the real group-2 classifier: an empty home is `retired`', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'doctor-legacy-default-'));
    try {
      const results = await checkLegacyIntegrations({}, { home: tmpHome, genieHome: join(tmpHome, '.genie') });
      expect(results[0]).toMatchObject({ name: 'legacy integrations', status: 'pass', detail: 'retired' });
      expect(results[0]?.legacyIntegrations).toEqual({ pending: [], available: true });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('a throwing classifier never fails the doctor run', async () => {
    const results = await checkLegacyIntegrations({
      legacyClassifier: () => {
        throw new Error('boom');
      },
    });
    expect(results[0]).toMatchObject({ status: 'pass' });
    expect(results[0]?.detail).toContain('classifier unavailable (boom)');
    expect(results[0]?.legacyIntegrations).toEqual({ pending: [], available: false });
  });

  test('doctor imports the retirement classifier statically so `bun build` bundles it (source lock)', async () => {
    // A non-literal `await import(SPECIFIER)` is invisible to the bundler: the
    // shipped dist/genie.js would degrade to a permanent silent pass.
    const source = readFileSync(join(import.meta.dir, 'doctor.ts'), 'utf-8');
    expect(source).toMatch(
      /import \{ classifyLegacyIntegrations \} from '\.\.\/lib\/legacy-integration-retirement\.js';/,
    );
    expect(source).not.toMatch(/await import\(LEGACY_RETIREMENT_MODULE\)/);
    const loaded = await import('../lib/legacy-integration-retirement.js');
    expect(typeof loaded.classifyLegacyIntegrations).toBe('function');
  });
});

describe('doctor --json: skills channel + legacy integration riders', () => {
  test('per-agent skillsChannel riders and the legacyIntegrations rider survive --json', async () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedAgentSkills(isolatedHome, ['.agents', 'skills'], ['alpha']);
    seedSkillsRecord(process.env.GENIE_HOME as string);

    const { output } = await captureDoctor(() =>
      doctorCommand(
        { json: true },
        {
          ...isolatedDoctorDeps(),
          legacyClassifier: () => ({
            entries: [{ surface: 'codex-skills', path: '/home/u/.codex/skills/genie-wish', state: 'managed-clean' }],
          }),
        },
      ),
    );
    const json = JSON.parse(output) as SkillsChannelJson;
    const riders = json.checks.filter((check) => check.skillsChannel !== undefined).map((c) => c.skillsChannel);
    expect(riders.map((r) => r?.agent)).toEqual(['claude', 'agents', 'goose', 'windsurf']);
    expect(riders[0]).toMatchObject({ present: 2, total: 2, detected: true, stale: false, recorded: true });
    expect(riders[1]).toMatchObject({ present: 1, total: 2, detected: true });
    expect(riders[2]).toMatchObject({ detected: false });
    const legacy = json.checks.find((check) => check.name === 'legacy integrations');
    expect(legacy).toMatchObject({ status: 'warn' });
    expect(legacy?.legacyIntegrations).toEqual({
      pending: [{ surface: 'codex-skills', path: '/home/u/.codex/skills/genie-wish' }],
      available: true,
    });
    // Warnings never flip the hard-failure verdict.
    expect(json.ok).toBe(true);
  });

  test('--fix retires nothing: the pending classification and the on-disk skills are unchanged', async () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string);
    const legacyAsset = join(isolatedHome, '.codex', 'skills', 'genie-legacy');
    mkdirSync(legacyAsset, { recursive: true });
    writeFileSync(join(legacyAsset, 'SKILL.md'), '# legacy\n');

    const { output } = await captureDoctor(() =>
      doctorCommand(
        { json: true, fix: true },
        {
          ...isolatedDoctorDeps(),
          legacyClassifier: () => ({
            entries: [{ surface: 'codex-skills', path: legacyAsset, state: 'managed-clean' }],
          }),
        },
      ),
    );
    const json = JSON.parse(output) as SkillsChannelJson;
    expect(json.checks.find((c) => c.name === 'legacy integrations')?.status).toBe('warn');
    expect(existsSync(join(legacyAsset, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(isolatedHome, '.claude', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
  });
});

describe('global db contamination (r2 #6 / M7 operator half)', () => {
  test('a clean global db passes and names the file', () => {
    const genieHome = join(isolatedHome, 'globaldb-clean');
    mkdirSync(genieHome, { recursive: true });
    const dbPath = join(genieHome, 'genie.db');
    const db = new Database(dbPath);
    db.run('CREATE TABLE approvals (id TEXT PRIMARY KEY)');
    db.run('CREATE TABLE inbound_messages (id TEXT PRIMARY KEY)');
    db.close();

    const results = checkGlobalDbContamination({ genieHome });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'global db', status: 'pass' });
    expect(results[0]?.detail).toContain(dbPath);
  });

  test('per-repo tables next to the approval queue warn and name the exact remedy', () => {
    const genieHome = join(isolatedHome, 'globaldb-dirty');
    mkdirSync(genieHome, { recursive: true });
    const dbPath = join(genieHome, 'genie.db');
    const db = new Database(dbPath);
    db.run('CREATE TABLE approvals (id TEXT PRIMARY KEY)');
    db.run('CREATE TABLE inbound_messages (id TEXT PRIMARY KEY)');
    db.run('CREATE TABLE boards (id TEXT PRIMARY KEY)');
    db.run('CREATE TABLE tasks (id TEXT PRIMARY KEY)');
    db.run('CREATE TABLE task_events (id TEXT PRIMARY KEY)');
    db.close();

    const results = checkGlobalDbContamination({ genieHome });
    expect(results).toHaveLength(1);
    const check = results[0] as CheckResult;
    expect(check).toMatchObject({ name: 'global db', status: 'warn' });
    expect(check.detail).toContain('per-repo tables present (boards, tasks, task_events)');
    expect(check.detail).toContain(dbPath);
    // The remedy is a genie subcommand: the only repair route that exists on a
    // stock install, which ships neither `bun` nor `sqlite3` on PATH.
    const remedy = globalDbContaminationRemedy();
    expect(remedy).toBe('genie doctor --fix-global-db');
    expect(check.suggestion).toBe(remedy);
    expect(check.detail).toContain(remedy);
    expect(remedy).not.toContain('sqlite3');
    expect(remedy).not.toContain('bun');
    // Both third-party spellings survive, named as alternatives only, and each
    // still drops ONLY the stray tables.
    const bunAlternative = globalDbContaminationBunAlternative(dbPath, ['boards', 'tasks', 'task_events']);
    const sqliteAlternative = globalDbContaminationSqliteAlternative(dbPath, ['boards', 'tasks', 'task_events']);
    expect(check.detail).toContain(`In a bun checkout: ${bunAlternative}`);
    expect(check.detail).toContain(`with sqlite3, if you have it: ${sqliteAlternative}`);
    expect(bunAlternative).toContain(`cp ${dbPath} ${dbPath}.backup-`);
    expect(bunAlternative).toContain('boards tasks task_events');
    for (const spelling of [bunAlternative, sqliteAlternative]) {
      expect(spelling).not.toContain('approvals');
      expect(spelling).not.toContain('inbound_messages');
    }
    // Read-only: the check never repairs, so the tables are still there.
    const after = new Database(dbPath, { readonly: true });
    const names = (
      after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    after.close();
    expect(names).toContain('boards');
  });

  /**
   * Regression (dogfood r6 Z10): `genie doctor --fix-global-db` is the repair
   * itself, so it needs nothing the install does not already ship. Backup-first
   * and surgical: only the per-repo strays go, the approval queue and its rows
   * survive, and the backup still holds the pre-repair schema.
   */
  test('--fix-global-db backs the file up, drops only the strays, and is idempotent', async () => {
    const genieHome = process.env.GENIE_HOME as string;
    mkdirSync(genieHome, { recursive: true });
    const dbPath = join(genieHome, 'genie.db');
    const seed = new Database(dbPath);
    seed.run('CREATE TABLE approvals (id TEXT PRIMARY KEY)');
    seed.run("INSERT INTO approvals (id) VALUES ('keep-me')");
    seed.run('CREATE TABLE inbound_messages (id TEXT PRIMARY KEY)');
    seed.run('CREATE TABLE boards (id TEXT PRIMARY KEY)');
    seed.run('CREATE TABLE tasks (id TEXT PRIMARY KEY)');
    seed.close();

    const { output, exitCode } = await captureDoctor(() => doctorCommand({ fixGlobalDb: true }));
    expect(exitCode).toBe(0);
    expect(output).toContain('dropped per-repo table(s): boards, tasks');
    // It ran the repair ALONE — no diagnostic report, so no unrelated check can
    // decide the exit code of a pasted remedy.
    expect(output).not.toContain('genie doctor\n\n');

    const tables = () => {
      const db = new Database(dbPath, { readonly: true });
      const names = (
        db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      db.close();
      return names;
    };
    expect(tables()).toContain('approvals');
    expect(tables()).toContain('inbound_messages');
    expect(tables()).not.toContain('boards');
    expect(tables()).not.toContain('tasks');

    // The operator's approval history is untouched.
    const live = new Database(dbPath, { readonly: true });
    expect((live.query('SELECT id FROM approvals').all() as Array<{ id: string }>).map((r) => r.id)).toEqual([
      'keep-me',
    ]);
    live.close();

    // Backed up first, so the repair is reversible: the backup still carries the
    // pre-repair schema.
    const backup = readdirSync(genieHome).find((entry) => entry.startsWith('genie.db.backup-'));
    expect(backup).toBeDefined();
    const restored = new Database(join(genieHome, backup as string), { readonly: true });
    const backedUp = (
      restored.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    restored.close();
    expect(backedUp).toContain('boards');
    expect(backedUp).toContain('approvals');

    // Doctor now passes, and a second repair is a no-op that makes no backup.
    expect(checkGlobalDbContamination({ genieHome })[0]).toMatchObject({ status: 'pass' });
    const again = await captureDoctor(() => doctorCommand({ fixGlobalDb: true }));
    expect(again.exitCode).toBe(0);
    expect(again.output).toContain('already clean');
    expect(readdirSync(genieHome).filter((entry) => entry.startsWith('genie.db.backup-'))).toHaveLength(1);
  });

  test('--fix-global-db on a host with no global database says so and exits 0', async () => {
    const { output, exitCode } = await captureDoctor(() => doctorCommand({ fixGlobalDb: true }));
    expect(exitCode).toBe(0);
    expect(output).toContain('no global database');
  });

  /**
   * The hand-written `cp` spellings copy `genie.db` alone, so with an
   * uncheckpointed WAL the "backup" is an empty database — voiding the
   * reversibility the remedy promises while another process holds the file.
   * The in-process repair folds the WAL back in before the byte copy.
   */
  test('--fix-global-db backs up a database with a live WAL completely', async () => {
    const genieHome = process.env.GENIE_HOME as string;
    mkdirSync(genieHome, { recursive: true });
    const dbPath = join(genieHome, 'genie.db');
    const seed = new Database(dbPath);
    seed.run('PRAGMA journal_mode = WAL');
    seed.run('CREATE TABLE approvals (id TEXT PRIMARY KEY)');
    seed.run("INSERT INTO approvals (id) VALUES ('pending-in-wal')");
    seed.run('CREATE TABLE boards (id TEXT PRIMARY KEY)');
    // Deliberately NOT checkpointed and NOT closed cleanly: the rows live in
    // genie.db-wal, exactly as a live writer leaves them.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    await captureDoctor(() => doctorCommand({ fixGlobalDb: true }));
    seed.close();

    const backup = readdirSync(genieHome).find((entry) => entry.startsWith('genie.db.backup-')) as string;
    // Read-write on purpose. This backup is a copy of a WAL-mode database, and a
    // read-only connection to one needs its `-shm` index: bun's bundled SQLite
    // creates it, the system SQLite bun uses on macOS answers SQLITE_CANTOPEN
    // instead (#2926). What is under test is the CONTENT of the backup, not
    // which handle can reach it, so open it the way a restore would.
    const restored = new Database(join(genieHome, backup));
    const rows = restored.query('SELECT id FROM approvals').all() as Array<{ id: string }>;
    restored.close();
    expect(rows.map((r) => r.id)).toEqual(['pending-in-wal']);
  });

  test('a repair failure is reported and exits 1 without claiming a backup', () => {
    const genieHome = join(isolatedHome, 'globaldb-unreadable');
    mkdirSync(genieHome, { recursive: true });
    const dbPath = join(genieHome, 'genie.db');
    writeFileSync(dbPath, 'this is not a sqlite database');
    const result = repairGlobalDbContamination({ genieHome });
    expect(result.status).toBe('failed');
    expect(result.backupPath).toBeNull();
    expect(result.dropped).toEqual([]);
    expect(readdirSync(genieHome).filter((entry) => entry.startsWith('genie.db.backup-'))).toEqual([]);
  });

  /**
   * THE Z10 regression, at the real boundary. The dogfood host proved the
   * previous two remedies both died at `command not found`: the installer
   * declares its prerequisites as `curl tar uname ln`, the shipped artifact is a
   * `bun --compile` static executable, and the frozen tarball payload carries
   * neither `bun` nor `sqlite3`. So the PATH here holds ONLY the installer's
   * prerequisites plus `genie` itself — `command -v bun` and `command -v sqlite3`
   * both fail — and the suggestion doctor emits is executed on it verbatim.
   */
  test('the emitted remedy runs on a stock PATH with no bun and no sqlite3', () => {
    const genieHome = join(isolatedHome, 'globaldb-stock-host');
    mkdirSync(genieHome, { recursive: true });
    const dbPath = join(genieHome, 'genie.db');
    const seed = new Database(dbPath);
    seed.run('CREATE TABLE approvals (id TEXT PRIMARY KEY)');
    seed.run("INSERT INTO approvals (id) VALUES ('keep-me')");
    seed.run('CREATE TABLE boards (id TEXT PRIMARY KEY)');
    seed.run('CREATE TABLE tasks (id TEXT PRIMARY KEY)');
    seed.close();

    const bin = join(genieHome, 'bin');
    mkdirSync(bin, { recursive: true });
    // install.sh's declared prerequisites plus the coreutils any paste-able
    // shell command may lean on — and nothing else.
    for (const tool of ['curl', 'tar', 'uname', 'ln', 'cp', 'date', 'ls', 'cat', 'rm', 'mkdir']) {
      const resolved = Bun.spawnSync(['/usr/bin/which', tool]).stdout.toString().trim();
      if (resolved !== '') symlinkSync(resolved, join(bin, tool));
    }
    // `genie` itself: the shipped artifact embeds its own runtime, so it resolves
    // neither its interpreter nor bun:sqlite through PATH. The shim models that
    // with absolute paths only.
    const repoRoot = join(import.meta.dir, '..', '..');
    const geniePath = join(bin, 'genie');
    writeFileSync(geniePath, `#!/bin/sh\nexec ${process.execPath} ${join(repoRoot, 'src', 'genie.ts')} "$@"\n`, {
      mode: 0o755,
    });

    const env = { PATH: bin, HOME: isolatedHome, GENIE_HOME: genieHome };
    const has = (tool: string) => Bun.spawnSync(['/bin/sh', '-c', `command -v ${tool}`], { env }).exitCode === 0;
    expect(has('bun')).toBe(false);
    expect(has('sqlite3')).toBe(false);
    expect(has('genie')).toBe(true);

    const suggestion = (checkGlobalDbContamination({ genieHome })[0] as CheckResult).suggestion as string;
    const run = Bun.spawnSync(['/bin/sh', '-c', suggestion], { env });
    expect(run.stderr.toString()).not.toContain('not found');
    expect(run.exitCode).toBe(0);

    const after = new Database(dbPath, { readonly: true });
    const names = (
      after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    const approvals = (after.query('SELECT id FROM approvals').all() as Array<{ id: string }>).map((r) => r.id);
    after.close();
    expect(names).toContain('approvals');
    expect(names).not.toContain('boards');
    expect(names).not.toContain('tasks');
    expect(approvals).toEqual(['keep-me']);
    expect(readdirSync(genieHome).some((entry) => entry.startsWith('genie.db.backup-'))).toBe(true);
    expect(checkGlobalDbContamination({ genieHome })[0]).toMatchObject({ status: 'pass' });
  });

  test('an absent global db is not a finding', () => {
    expect(checkGlobalDbContamination({ genieHome: join(isolatedHome, 'globaldb-missing') })).toEqual([]);
  });
});

/** Issue #2927: the record cannot name what predates it, so doctor scans the homes themselves. */
describe('doctor: pre-record genie leftovers', () => {
  const PM_DESCRIPTION =
    'Full PM playbook — triage backlog, prioritize, assign, track, report, escalate. Copilot, autopilot, or pair modes.';

  test('warns with every leftover path and its kind, in path order, and stays silent when there are none', () => {
    seedAgentSkills(isolatedHome, ['.claude', 'skills'], ['alpha', 'beta']);
    seedAgentSkills(isolatedHome, ['.agents', 'skills'], ['alpha', 'beta']);
    seedSkillsRecord(process.env.GENIE_HOME as string);
    expect(skillsChannelResults().some((result) => result.name === 'skills: legacy leftovers')).toBe(false);

    const agents = join(isolatedHome, '.agents', 'skills');
    mkdirSync(join(agents, 'genie-review'), { recursive: true });
    writeFileSync(
      join(agents, 'genie-review', 'SKILL.md'),
      `---\nname: genie-review\ndescription: "${PM_DESCRIPTION}"\n---\n`,
    );
    mkdirSync(join(agents, '.genie-codex-fallback-retirement', 'txn-1'), { recursive: true });
    const claude = join(isolatedHome, '.claude', 'skills');
    mkdirSync(join(claude, 'brain'), { recursive: true });
    writeFileSync(
      join(claude, 'brain', 'SKILL.md'),
      '---\nname: brain\ndescription: a live third-party product\n---\n',
    );

    const check = byName(skillsChannelResults(), 'skills: legacy leftovers');
    expect(check.status).toBe('warn');
    // The third row is a live third-party `brain`: it shares a name genie once shipped and nothing
    // else, so the line counts it apart and says genie claims none of those — calling every row a
    // genie skill dir told the operator their own product was genie's.
    expect(check.detail).toBe(
      `3 dir(s) predate the install record — 2 genie's own, 1 unproven (a retired genie name or description, not both; genie claims none of these): ${join(agents, '.genie-codex-fallback-retirement')} (marker); ${join(agents, 'genie-review')} (proven); ${join(claude, 'brain')} (unproven)`,
    );
    expect(check.suggestion).toContain('genie update');
    // Nothing on disk moved: doctor observes, update retires.
    expect(existsSync(join(agents, 'genie-review', 'SKILL.md'))).toBe(true);
  });

  test('covers a host with no record at all through every skills.sh registry home on disk', () => {
    const agents = join(isolatedHome, '.agents', 'skills');
    mkdirSync(join(agents, 'pm'), { recursive: true });
    writeFileSync(join(agents, 'pm', 'SKILL.md'), `---\nname: pm\ndescription: ${PM_DESCRIPTION}\n---\n`);
    // An `--all`-era home the four-row known table never lists (Codex review on PR #2928).
    const openclaw = join(isolatedHome, '.openclaw', 'skills');
    mkdirSync(join(openclaw, 'wizard'), { recursive: true });
    writeFileSync(
      join(openclaw, 'wizard', 'SKILL.md'),
      '---\nname: wizard\ndescription: "Guided onboarding — scaffold workspace, shape agent identity, create first wish, execute, and celebrate."\n---\n',
    );
    const check = byName(skillsChannelResults(), 'skills: legacy leftovers');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain(`${join(agents, 'pm')} (proven)`);
    expect(check.detail).toContain(`${join(openclaw, 'wizard')} (proven)`);
  });
});
