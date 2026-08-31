import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
import { dirname, join } from 'node:path';
import { resolveGitProjectRoots } from '../lib/codex-project-mcp.js';
import { type SkillsInstallRecord, releaseTag, writeSkillsInstallRecord } from '../lib/skills-installer.js';
import { VERSION } from '../lib/version.js';
import {
  type CheckResult,
  type LegacyClassifier,
  MINIMUM_BUN_VERSION,
  checkCodexProjectContext,
  checkIndexLaneDrift,
  checkLegacyIntegrations,
  checkOmniBridgeHealth,
  checkRetiredJsonMcpEntry,
  checkSkillsChannel,
  checkSubagentModelOverride,
  checkV4Residue,
  doctorCommand,
  evaluateBunVersion,
  evaluateIndexLaneDrift,
  evaluateOmniBridgeHealth,
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

describe('omni bridge health probe (retired SessionStart hook replacement)', () => {
  test('emits no check when omni is not configured', () => {
    expect(evaluateOmniBridgeHealth({ configured: false, apiStatus: null })).toBeNull();
  });

  test('passes when the bridge reports healthy', () => {
    const res = evaluateOmniBridgeHealth({ configured: true, apiStatus: 'healthy', version: '2.1.0' });
    expect(res).toMatchObject({ name: 'omni bridge health', status: 'pass' });
    expect(res?.detail).toContain('(v2.1.0)');
  });

  test('warns when the bridge reports a non-healthy status', () => {
    const res = evaluateOmniBridgeHealth({ configured: true, apiStatus: 'degraded' });
    expect(res).toMatchObject({ status: 'warn' });
    expect(res?.detail).toContain('degraded');
    expect(res?.suggestion).toContain('omni status');
  });

  test('warns when the bridge is unreachable, with a start suggestion', () => {
    const res = evaluateOmniBridgeHealth({ configured: true, apiStatus: null, error: 'fetch failed' });
    expect(res).toMatchObject({ status: 'warn' });
    expect(res?.detail).toContain('unreachable');
    expect(res?.suggestion).toContain('omni start');
  });

  test('checkOmniBridgeHealth probes the configured URL and stays silent when unconfigured', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ status: 'healthy', version: '2.1.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    // Unconfigured (isolated GENIE_HOME has no omni section, env unset) → silent.
    const priorUrl = process.env.OMNI_API_URL;
    const priorKey = process.env.OMNI_API_KEY;
    Reflect.deleteProperty(process.env, 'OMNI_API_URL');
    Reflect.deleteProperty(process.env, 'OMNI_API_KEY');
    try {
      expect(await checkOmniBridgeHealth(fakeFetch)).toEqual([]);
      expect(calls).toEqual([]);

      process.env.OMNI_API_URL = 'http://127.0.0.1:8882';
      const results = await checkOmniBridgeHealth(fakeFetch);
      expect(calls).toEqual(['http://127.0.0.1:8882/api/v2/health']);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ name: 'omni bridge health', status: 'pass' });
    } finally {
      if (priorUrl === undefined) Reflect.deleteProperty(process.env, 'OMNI_API_URL');
      else process.env.OMNI_API_URL = priorUrl;
      if (priorKey === undefined) Reflect.deleteProperty(process.env, 'OMNI_API_KEY');
      else process.env.OMNI_API_KEY = priorKey;
    }
  });

  test('checkOmniBridgeHealth degrades to warn on a throwing fetch', async () => {
    const prior = process.env.OMNI_API_URL;
    process.env.OMNI_API_URL = 'http://127.0.0.1:9999';
    try {
      const throwingFetch = (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch;
      const results = await checkOmniBridgeHealth(throwingFetch);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ status: 'warn' });
      expect(results[0].detail).toContain('connection refused');
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, 'OMNI_API_URL');
      else process.env.OMNI_API_URL = prior;
    }
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
    expect(results.filter((r) => r.status === 'warn')).toEqual([]);
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
