import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeDirDigest, computeFileDigest } from '../lib/agent-sync.js';
import { reconcileCodexProjectMcp, resolveGitProjectRoots } from '../lib/codex-project-mcp.js';
import { CANONICAL_GENIE_SKILL_NAMES } from '../lib/runtime-integrations.js';
import { VERSION } from '../lib/version.js';
import {
  MINIMUM_BUN_VERSION,
  checkAgentSync,
  checkCodexIntegration,
  checkIndexLaneDrift,
  checkSubagentModelOverride,
  checkV4Residue,
  doctorCommand,
  evaluateBunVersion,
  evaluateIndexLaneDrift,
  evaluateOmniHookTimeout,
  findDispatchHookTimeoutSec,
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
  return { root, databaseRoot: root, pluginProbe: NO_CODEX, bunVersion: '1.3.10', bunPath: '/usr/bin/bun' };
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

  test('human output renders a header and a summary line', async () => {
    const { output } = await captureDoctor(() => doctorCommand({}, isolatedDoctorDeps()));
    expect(output).toContain('genie doctor');
    expect(output).toContain('All checks passed.');
  });
});

/**
 * Group E: mark a project trusted in the isolated CODEX_HOME global config so
 * the route-layer classifier can claim route health for it.
 */
function trustProjectInCodexConfig(root: string): void {
  const configPath = join(process.env.CODEX_HOME as string, 'config.toml');
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  writeFileSync(configPath, `${existing}[projects."${root}"]\ntrust_level = "trusted"\n`);
}

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
      trustProjectInCodexConfig(root);
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

  test('post-A manifest truth: declaring NO mcpServers is the healthy shape; declaring one warns (live-QA regression)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-manifest-truth-'));
    const priorCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, 'codex-home');
    try {
      trustProjectInCodexConfig(root);
      const activePluginRoot = join(root, 'active-plugin');
      mkdirSync(join(activePluginRoot, '.codex-plugin'), { recursive: true });
      const manifestPath = join(activePluginRoot, '.codex-plugin', 'plugin.json');
      const probe = {
        cliAvailable: true,
        status: 'ok' as const,
        installed: true,
        enabled: true,
        // The probe still reports the stale pre-A manifest expectation; doctor
        // must not surface it as a defect on a post-A generation.
        usable: false,
        usabilityDetail: 'plugin manifest does not point mcpServers to ./.mcp.json',
        version: VERSION,
        activePluginRoot,
        detail: 'installed',
      };

      // Post-A shape: no mcpServers key → capability pass, plugin check pass.
      writeFileSync(manifestPath, JSON.stringify({ name: 'genie', version: VERSION, skills: './skills/' }));
      const healthy = await checkCodexIntegration(root, probe);
      const capability = healthy.find((check) => check.name === 'Codex Genie MCP capability');
      const plugin = healthy.find((check) => check.name === 'Codex Genie plugin');
      expect(capability).toMatchObject({ status: 'pass' });
      expect(capability?.detail).toContain('declares no MCP route');
      expect(plugin).toMatchObject({ status: 'pass' });
      expect(plugin?.detail).not.toContain('does not point mcpServers');
      expect(plugin?.detail).not.toContain('unusable');

      // Regression shape: a declared route is the defect (second Genie route).
      writeFileSync(manifestPath, JSON.stringify({ name: 'genie', version: VERSION, mcpServers: './.mcp.json' }));
      const regressed = await checkCodexIntegration(root, probe);
      const declared = regressed.find((check) => check.name === 'Codex Genie MCP capability');
      expect(declared).toMatchObject({ status: 'warn' });
      expect(declared?.detail).toContain('still declares mcpServers');
    } finally {
      if (priorCodexHome === undefined) Reflect.deleteProperty(process.env, 'CODEX_HOME');
      else process.env.CODEX_HOME = priorCodexHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('healthy source bundle cannot make an unproven active plugin capability pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-active-plugin-'));
    const priorCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, 'codex-home');
    try {
      trustProjectInCodexConfig(root);
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

  test('plugin payload completeness reports canonical skill presence from the active plugin root (R5, read-only)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-payload-'));
    try {
      const activePluginRoot = join(root, 'active-plugin');
      const skillsRoot = join(activePluginRoot, 'skills');
      // Ship every canonical skill except one → payload is short, not healthy.
      for (const name of CANONICAL_GENIE_SKILL_NAMES.slice(0, -1)) {
        mkdirSync(join(skillsRoot, name), { recursive: true });
      }
      const missing = CANONICAL_GENIE_SKILL_NAMES[CANONICAL_GENIE_SKILL_NAMES.length - 1];
      const probe = {
        cliAvailable: true,
        status: 'ok' as const,
        installed: true,
        enabled: true,
        usable: true,
        version: '5.0.0',
        activePluginRoot,
        detail: 'installed',
      };
      const checks = await checkCodexIntegration(root, probe);
      const payload = checks.find((check) => check.name === 'Codex Genie plugin payload');
      expect(payload?.status).toBe('warn');
      expect(payload?.detail).toContain(
        `${CANONICAL_GENIE_SKILL_NAMES.length - 1}/${CANONICAL_GENIE_SKILL_NAMES.length}`,
      );
      expect(payload?.detail).toContain(missing);

      // Complete payload → pass, no remediation.
      mkdirSync(join(skillsRoot, missing), { recursive: true });
      const complete = (await checkCodexIntegration(root, probe)).find(
        (check) => check.name === 'Codex Genie plugin payload',
      );
      expect(complete?.status).toBe('pass');
      expect(complete?.suggestion).toBeUndefined();
    } finally {
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
      if (roots === null) throw new Error('linked worktree roots were not resolved');
      expect(realpathSync(roots.worktreeRoot)).toBe(realpathSync(linked));
      expect(realpathSync(roots.commonRoot)).toBe(realpathSync(repo));
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
            bunVersion: '1.3.10',
            bunPath: '/usr/bin/bun',
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
            bunVersion: '1.3.10',
            bunPath: '/usr/bin/bun',
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
    expect(exitCode).toBe(0);
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

  /**
   * Copy a source skill into a target parent + stamp a manifest (current unless
   * a digest is forced). Stamps `identityVersion: 2`, matching what the real
   * `buildManifest` always writes — the Codex-fallback ownership gate
   * (`strictFallbackMarker`) requires that exact tag, so an untagged manifest
   * would misrepresent a byte-identical, freshly-synced managed dir as
   * unrecognized instead of clean.
   */
  function seedManaged(sourceDir: string, destDir: string, digest?: string): void {
    cpSync(sourceDir, destDir, { recursive: true });
    writeFileSync(
      join(destDir, '.genie-sync.json'),
      JSON.stringify({
        managedBy: 'genie-agent-sync',
        version: '1',
        digest: digest ?? computeDirDigest(sourceDir),
        syncedAt: '2026-01-01T00:00:00.000Z',
        identityVersion: 2,
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
      // Disable the best-effort `hermes plugins list` enable probe by default so no
      // test ever spawns a real process; probe-specific tests inject a reader.
      hermesBinary: null as string | null,
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

  test('genie@automagik plugin enabled + no mirrors → pass, "skills mirror suppressed"', () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'genie@automagik': true } }),
      'utf8',
    );
    stampCouncil(pluginRoot);

    const claude = find(checkAgentSync(paths()), 'agent sync: claude');
    expect(claude?.status).toBe('pass');
    expect(claude?.detail).toContain('skills mirror suppressed (genie@automagik plugin enabled)');
    expect(claude?.detail).toContain('council.js current');
    expect(claude?.suggestion).toBeUndefined();
  });

  test('genie@automagik plugin enabled + leftover managed mirror → warn advising genie update to prune', () => {
    seedManaged(join(pluginRoot, 'skills', 'wish'), join(claudeDir, 'skills', 'wish'));
    stampCouncil(pluginRoot);
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'genie@automagik': true } }),
      'utf8',
    );

    const claude = find(checkAgentSync(paths()), 'agent sync: claude');
    expect(claude?.status).toBe('warn');
    expect(claude?.detail).toContain('mirror suppressed — leftover mirrors');
    expect(claude?.detail).toContain('genie update');
    expect(claude?.suggestion).toContain('genie update');
  });

  test('malformed settings.json behaves as not-enabled: mirror freshness expectations hold (fail-open)', () => {
    seedManaged(join(pluginRoot, 'skills', 'wish'), join(claudeDir, 'skills', 'wish'));
    seedManaged(join(pluginRoot, 'skills', 'review'), join(claudeDir, 'skills', 'review'));
    stampCouncil(pluginRoot);
    writeFileSync(join(claudeDir, 'settings.json'), '{oops', 'utf8');

    const claude = find(checkAgentSync(paths()), 'agent sync: claude');
    expect(claude?.status).toBe('pass');
    expect(claude?.detail).toContain('2/2 source skills current');
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

  // Codex Genie skills are plugin-only (R5): an EMPTY user tier is the healthy
  // state, and a clean managed fallback there is repairable duplicate state.
  test('codex detected, empty ~/.agents/skills tier → pass (plugin-only)', () => {
    mkdirSync(codexDir, { recursive: true });
    const codex = find(checkAgentSync(paths()), 'agent sync: codex');
    expect(codex?.status).toBe('pass');
    expect(codex?.detail).toContain('plugin-only');
    expect(codex?.suggestion).toBeUndefined();
  });

  test('codex clean managed fallback → warn repairable duplicate (run authenticated setup)', () => {
    mkdirSync(codexDir, { recursive: true });
    seedManaged(join(pluginRoot, 'skills', 'wish'), join(agentsSkillsDir, 'wish'));
    const codex = find(checkAgentSync(paths()), 'agent sync: codex');
    expect(codex?.status).toBe('warn');
    expect(codex?.detail).toContain('repairable duplicate provider state');
    expect(codex?.detail).toContain('wish');
    expect(codex?.suggestion).toContain('genie setup --codex');
    expect(codex?.suggestion).toContain('matching authenticated delivery');
    expect(codex?.suggestion).toContain('plugin health');
  });

  test('codex preserved personal collision → DISTINCT manual remediation', () => {
    mkdirSync(codexDir, { recursive: true });
    // Valid managed marker but content diverged from its digest → managed-modified.
    seedManaged(join(pluginRoot, 'skills', 'wish'), join(agentsSkillsDir, 'wish'));
    writeFileSync(join(agentsSkillsDir, 'wish', 'SKILL.md'), '# my personal edit\n', 'utf8');
    const results = checkAgentSync(paths());
    const codex = find(results, 'agent sync: codex');
    expect(codex?.status).toBe('pass'); // no CLEAN fallback → main line stays plugin-only
    const collision = find(results, 'agent sync: codex collisions');
    expect(collision?.status).toBe('warn');
    expect(collision?.detail).toContain('collide with plugin names');
    expect(collision?.suggestion).toContain('manually');
    // DISTINCT from the repairable-duplicate remediation: personal collisions are
    // never retired by setup, only reviewed/removed by the user.
    expect(collision?.suggestion).not.toContain('retire');
  });

  test('codex retirement quarantine with retained evidence → R8 manual-recovery line naming the actual evidence path', () => {
    mkdirSync(codexDir, { recursive: true });
    const txn = join(agentsSkillsDir, '.genie-codex-fallback-retirement', 'txn-abc');
    mkdirSync(join(txn, 'quarantine'), { recursive: true });
    mkdirSync(join(txn, 'evidence', 'wish'), { recursive: true });
    writeFileSync(join(txn, 'evidence', 'wish', 'SKILL.md'), '# changed copy\n', 'utf8');
    const results = checkAgentSync(paths());
    const codex = find(results, 'agent sync: codex');
    expect(codex?.status).toBe('pass');
    expect(codex?.detail).toContain('retired quarantine transaction(s) retained');
    const evidence = find(results, 'agent sync: codex quarantine evidence');
    expect(evidence?.status).toBe('warn');
    expect(evidence?.detail).toContain('retained changed-tree evidence');
    expect(evidence?.detail).toContain('txn-abc');
    // Item 3(b): naming the transaction id alone leaves the user to guess where
    // the archived copy actually lives — the message must carry the real path.
    expect(evidence?.detail).toContain(join(txn, 'evidence'));
    expect(evidence?.suggestion).toContain('reconcile it manually');
  });

  test('codex well-formed but unrecognized fallback → distinct manual warn, main line stays plugin-only, never advises setup will retire it', () => {
    // identityVersion:2, digest self-consistent with its own manifest — but the
    // content is NOT the installed plugin's payload and not in the frozen
    // historical allowlist, so `planCodexFallbackRetirement` would refuse it
    // ('ambiguous-ownership'). This is the PR #2575 no-op-loop bug: doctor must
    // never call this "clean" or tell the user authenticated setup fixes it.
    mkdirSync(codexDir, { recursive: true });
    const dir = join(agentsSkillsDir, 'orphaned-content');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# not the installed plugin payload\n', 'utf8');
    writeFileSync(
      join(dir, '.genie-sync.json'),
      JSON.stringify({
        managedBy: 'genie-agent-sync',
        version: '1',
        digest: computeDirDigest(dir),
        syncedAt: '2026-01-01T00:00:00.000Z',
        identityVersion: 2,
      }),
      'utf8',
    );

    const results = checkAgentSync(paths());
    const codex = find(results, 'agent sync: codex');
    expect(codex?.status).toBe('pass'); // no RECOGNIZED clean fallback → main line stays plugin-only
    expect(codex?.detail).toContain('plugin-only');
    const unrecognized = find(results, 'agent sync: codex unrecognized');
    expect(unrecognized?.status).toBe('warn');
    expect(unrecognized?.detail).toContain('unrecognized managed fallback');
    expect(unrecognized?.detail).toContain('review manually');
    expect(unrecognized?.detail).toContain('orphaned-content');
    // The whole point: this warning must never send the user down the same
    // no-op loop authenticated setup already refuses to close.
    expect(unrecognized?.suggestion).toContain('`genie setup --codex` will NOT retire');
  });

  test('codex ~/.agents/skills exists but is unreadable → warn, never a false-healthy plugin-only pass', () => {
    mkdirSync(codexDir, { recursive: true });
    // A regular file at the fallback-tier path makes readdirSync fail ENOTDIR —
    // portable across CI/root vs non-root, unlike permission-bit simulation.
    mkdirSync(dirname(agentsSkillsDir), { recursive: true });
    writeFileSync(agentsSkillsDir, '', 'utf8');

    const codex = find(checkAgentSync(paths()), 'agent sync: codex');
    expect(codex?.status).toBe('warn');
    expect(codex?.detail).toContain(agentsSkillsDir);
    expect(codex?.suggestion).toContain('permissions');
  });

  test('codex quarantine root is never counted as a managed fallback', () => {
    mkdirSync(codexDir, { recursive: true });
    // A retirement root with a committed txn but no live fallbacks stays plugin-only.
    mkdirSync(join(agentsSkillsDir, '.genie-codex-fallback-retirement', 'txn-xyz', 'quarantine'), { recursive: true });
    const codex = find(checkAgentSync(paths()), 'agent sync: codex');
    expect(codex?.status).toBe('pass');
    expect(codex?.detail).toContain('plugin-only');
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

  // -------------------------------------------------------------------------
  // Hermes per-leg health: link / mcp / skills / enable probe — independent
  // -------------------------------------------------------------------------

  /** The product-skills root doctor resolves in this fixture (plugin mirror). */
  function productSkillsRoot(): string {
    return join(pluginRoot, 'skills');
  }

  function presentHermes(): void {
    mkdirSync(join(hermesHome, 'plugins'), { recursive: true });
    symlinkSync(join(genieHome, 'plugins', 'hermes-genie'), join(hermesHome, 'plugins', 'genie'));
  }

  function writeHermesConfig(text: string): void {
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(join(hermesHome, 'config.yaml'), text, 'utf8');
  }

  /** An absolute, executable fake genie binary for the MCP command check. */
  function presentGenieBinary(): string {
    const bin = join(tmp, 'bin', 'genie');
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/usr/bin/env bun\n', { mode: 0o755 });
    chmodSync(bin, 0o755);
    return bin;
  }

  const mcpConfig = (command: string) =>
    `mcp_servers:\n  genie:\n    command: ${JSON.stringify(command)}\n    args:\n      - mcp\n`;
  const skillsConfig = (dir: string) => `skills:\n  external_dirs:\n    - ${JSON.stringify(dir)}\n`;

  test('hermes mcp leg: absolute executable command → pass; each unhealthy shape → warn', () => {
    presentHermes();
    const bin = presentGenieBinary();

    writeHermesConfig(mcpConfig(bin));
    let mcp = find(checkAgentSync(paths()), 'agent sync: hermes mcp');
    expect(mcp?.status).toBe('pass');
    expect(mcp?.detail).toContain(bin);

    // Relative command → warn.
    writeHermesConfig(mcpConfig('genie'));
    mcp = find(checkAgentSync(paths()), 'agent sync: hermes mcp');
    expect(mcp?.status).toBe('warn');
    expect(mcp?.detail).toContain('not absolute');

    // Absolute but non-existent/non-executable → warn.
    writeHermesConfig(mcpConfig(join(tmp, 'bin', 'nope')));
    mcp = find(checkAgentSync(paths()), 'agent sync: hermes mcp');
    expect(mcp?.status).toBe('warn');
    expect(mcp?.detail).toContain('not executable');

    // Config absent entirely → warn advising genie update.
    rmSync(join(hermesHome, 'config.yaml'), { force: true });
    mcp = find(checkAgentSync(paths()), 'agent sync: hermes mcp');
    expect(mcp?.status).toBe('warn');
    expect(mcp?.detail).toContain('config.yaml absent');
    expect(mcp?.suggestion).toContain('genie update');
  });

  test('hermes skills leg: external_dirs contains the product root → pass', () => {
    presentHermes();
    writeHermesConfig(skillsConfig(productSkillsRoot()));
    const skills = find(checkAgentSync(paths()), 'agent sync: hermes skills');
    expect(skills?.status).toBe('pass');
    expect(skills?.detail).toContain(productSkillsRoot());
  });

  test('hermes skills leg: managed-copy fallback count ≥ product count → pass', () => {
    presentHermes();
    // No external_dirs entry; instead seed a managed copy under <configHome>/skills
    // with at least as many SKILL.md dirs as the product source (wish + review = 2).
    writeHermesConfig('other: {}\n');
    for (const name of ['wish', 'review']) {
      mkdirSync(join(hermesHome, 'skills', name), { recursive: true });
      writeFileSync(join(hermesHome, 'skills', name, 'SKILL.md'), `# ${name}\n`, 'utf8');
    }
    const skills = find(checkAgentSync(paths()), 'agent sync: hermes skills');
    expect(skills?.status).toBe('pass');
    expect(skills?.detail).toContain('managed copy 2/2');
  });

  test('hermes skills leg: neither external_dirs nor a full managed copy → warn', () => {
    presentHermes();
    writeHermesConfig('other: {}\n');
    const skills = find(checkAgentSync(paths()), 'agent sync: hermes skills');
    expect(skills?.status).toBe('warn');
    expect(skills?.suggestion).toContain('genie update');
  });

  test('hermes legs are independent: healthy MCP + unhealthy skills', () => {
    presentHermes();
    const bin = presentGenieBinary();
    // MCP block healthy, skills block absent → mcp pass, skills warn.
    writeHermesConfig(mcpConfig(bin));
    const results = checkAgentSync(paths());
    expect(find(results, 'agent sync: hermes mcp')?.status).toBe('pass');
    expect(find(results, 'agent sync: hermes skills')?.status).toBe('warn');
    // The link leg stays independently healthy.
    expect(find(results, 'agent sync: hermes')?.status).toBe('pass');
  });

  test('hermes inline top-level mcp_servers → WARN (never FAIL) with block-mapping hint', () => {
    presentHermes();
    writeHermesConfig(`mcp_servers: {}\nskills:\n  external_dirs:\n    - ${JSON.stringify(productSkillsRoot())}\n`);
    const results = checkAgentSync(paths());
    const mcp = find(results, 'agent sync: hermes mcp');
    expect(mcp?.status).toBe('warn');
    expect(mcp?.detail).toContain('inline value');
    expect(mcp?.suggestion).toContain('block mapping');
    // The skills leg (block-shaped) still evaluates healthy — inline is per-leg.
    expect(find(results, 'agent sync: hermes skills')?.status).toBe('pass');
    // No hermes check is ever a hard failure.
    expect(results.filter((r) => r.name.startsWith('agent sync: hermes')).every((r) => r.status !== 'fail')).toBe(true);
  });

  test('hermes inline top-level skills → WARN with block-mapping hint', () => {
    presentHermes();
    writeHermesConfig('skills: {}\n');
    const skills = find(checkAgentSync(paths()), 'agent sync: hermes skills');
    expect(skills?.status).toBe('warn');
    expect(skills?.detail).toContain('inline value');
    expect(skills?.suggestion).toContain('block mapping');
  });

  test('hermes enable probe: enabled → pass, disabled → warn, CLI absent → no check emitted', () => {
    presentHermes();
    const base = paths();

    let hermes = checkAgentSync({
      ...base,
      hermesBinary: '/fake/hermes',
      hermesPluginsList: () => 'genie   enabled\n',
    });
    expect(find(hermes, 'agent sync: hermes plugin enabled')?.status).toBe('pass');

    hermes = checkAgentSync({ ...base, hermesBinary: '/fake/hermes', hermesPluginsList: () => 'genie   disabled\n' });
    const disabled = find(hermes, 'agent sync: hermes plugin enabled');
    expect(disabled?.status).toBe('warn');
    expect(disabled?.detail).toContain('not enabled');

    // CLI absent (binary null) → probe is skipped silently, no check line.
    hermes = checkAgentSync({ ...base, hermesBinary: null });
    expect(find(hermes, 'agent sync: hermes plugin enabled')).toBeUndefined();
  });

  test('hermes enable probe: a throwing CLI is best-effort, never a failure', () => {
    presentHermes();
    const hermes = checkAgentSync({
      ...paths(),
      hermesBinary: '/fake/hermes',
      hermesPluginsList: () => {
        throw new Error('hermes wedged');
      },
    });
    const probe = find(hermes, 'agent sync: hermes plugin enabled');
    expect(probe?.status).toBe('pass');
    expect(probe?.detail).toContain('unknown');
  });

  // -------------------------------------------------------------------------
  // Textual duplicate-key detection (DF-1): the mcp/skills legs must WARN when
  // a spec-invalid duplicate child key is present under mcp_servers:/skills: —
  // even when the last-wins PARSED value looks perfectly healthy, since that
  // is exactly what let the duplicate persist forever before the repair.
  // -------------------------------------------------------------------------

  const dupMcpConfig = (command: string) =>
    `mcp_servers:\n  genie:\n  genie:\n    command: ${JSON.stringify(command)}\n    args:\n      - mcp\n`;
  const dupSkillsConfig = (dir: string) =>
    `skills:\n  external_dirs: []\n  external_dirs:\n    - ${JSON.stringify(dir)}\n`;

  test('hermes mcp leg: textual duplicate genie key → warn naming the config path, even though the parsed value is healthy', () => {
    presentHermes();
    const bin = presentGenieBinary();
    writeHermesConfig(dupMcpConfig(bin));

    // The parsed (last-wins) value looks completely correct...
    const parsed = Bun.YAML.parse(readFileSync(join(hermesHome, 'config.yaml'), 'utf8')) as {
      mcp_servers: { genie: { command: string } };
    };
    expect(parsed.mcp_servers.genie.command).toBe(bin);

    // ...but doctor must still flag the textual duplicate.
    const mcp = find(checkAgentSync(paths()), 'agent sync: hermes mcp');
    expect(mcp?.status).toBe('warn');
    expect(mcp?.detail).toContain('duplicate');
    expect(mcp?.detail).toContain(join(hermesHome, 'config.yaml'));
    expect(mcp?.suggestion).toContain('genie update');
  });

  test('hermes skills leg: textual duplicate external_dirs key → warn naming the config path, even though the parsed value is healthy', () => {
    presentHermes();
    writeHermesConfig(dupSkillsConfig(productSkillsRoot()));

    const parsed = Bun.YAML.parse(readFileSync(join(hermesHome, 'config.yaml'), 'utf8')) as {
      skills: { external_dirs: string[] };
    };
    expect(parsed.skills.external_dirs).toEqual([productSkillsRoot()]);

    const skills = find(checkAgentSync(paths()), 'agent sync: hermes skills');
    expect(skills?.status).toBe('warn');
    expect(skills?.detail).toContain('duplicate');
    expect(skills?.detail).toContain(join(hermesHome, 'config.yaml'));
    expect(skills?.suggestion).toContain('genie update');
  });

  test('after repair (single key, no duplicate): both legs pass, no duplicate warning', () => {
    presentHermes();
    const bin = presentGenieBinary();
    writeHermesConfig(`${mcpConfig(bin)}${skillsConfig(productSkillsRoot())}`);

    const results = checkAgentSync(paths());
    expect(find(results, 'agent sync: hermes mcp')?.status).toBe('pass');
    expect(find(results, 'agent sync: hermes skills')?.status).toBe('pass');
  });
});

// ============================================================================
// Claude role-agent delivery (wish routing-delivery-fix, Group B) — per-file
// classifier over the Group-A `~/.claude/agents/.genie-sync.json` manifest.
// Read-only, all paths injected via checkAgentSync — the real $HOME is untouched.
// ============================================================================

describe('checkAgentSync — claude role agents', () => {
  const ROLE_CHECK = 'agent sync: claude role agents';
  const DUP_CHECK = 'agent sync: duplicate role-agent surface';

  let tmp: string;
  let genieHome: string;
  let pluginRoot: string;
  let claudeDir: string;
  let agentsDir: string;

  function paths() {
    return {
      genieHome,
      claudeDir,
      codexDir: join(tmp, 'codex'),
      agentsSkillsDir: join(tmp, 'agents', 'skills'),
      hermesHome: join(tmp, 'hermes'),
      settingsPath: join(claudeDir, 'settings.json'),
    };
  }

  const find = (results: ReturnType<typeof checkAgentSync>, name: string) => results.find((r) => r.name === name);

  /** name → state map off the machine-readable rider (what `--json` carries). */
  function stateMap(check: ReturnType<typeof checkAgentSync>[number] | undefined): Record<string, string> {
    const files = check?.roleAgents?.files ?? [];
    return Object.fromEntries(files.map((f) => [f.name, f.state]));
  }

  function writeSourceAgent(name: string, body: string): void {
    mkdirSync(join(pluginRoot, 'agents'), { recursive: true });
    writeFileSync(join(pluginRoot, 'agents', `${name}.md`), body, 'utf8');
  }

  function writeTargetAgent(name: string, body: string): void {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, `${name}.md`), body, 'utf8');
  }

  /** Stamp the shared dir-level agent manifest (Group A shape: filename → digest entry). */
  function writeAgentManifest(files: Record<string, { digest: string; version?: string; syncedAt?: string }>): void {
    mkdirSync(agentsDir, { recursive: true });
    const entries = Object.fromEntries(
      Object.entries(files).map(([name, e]) => [
        name,
        { digest: e.digest, version: e.version ?? '5.0.0', syncedAt: e.syncedAt ?? '2026-01-01T00:00:00.000Z' },
      ]),
    );
    writeFileSync(
      join(agentsDir, '.genie-sync.json'),
      JSON.stringify({ managedBy: 'genie-agent-sync', files: entries }),
      'utf8',
    );
  }

  function writeSettings(value: unknown): void {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(value), 'utf8');
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'doctor-roleagents-'));
    genieHome = join(tmp, 'genie');
    pluginRoot = join(genieHome, 'plugins', 'genie');
    claudeDir = join(tmp, 'claude');
    agentsDir = join(claudeDir, 'agents');
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(claudeDir, { recursive: true }); // claude "detected" so role-agent checks run
    writeFileSync(join(genieHome, 'VERSION'), '5.0.0\n', 'utf8');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('an empty canonical source inventory warns instead of reporting an empty set healthy', () => {
    const check = find(checkAgentSync(paths()), ROLE_CHECK);

    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('source role-agent inventory is empty');
    expect(check?.roleAgents?.sourceIssues).toEqual([
      `source role-agent inventory is empty at ${join(pluginRoot, 'agents')}`,
    ]);
    expect(check?.roleAgents?.files).toEqual([]);
  });

  test('a source inventory enumeration error is preserved in the warning', () => {
    writeFileSync(join(pluginRoot, 'agents'), 'not a directory', 'utf8');

    const check = find(checkAgentSync(paths()), ROLE_CHECK);

    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('cannot enumerate source role agents');
    expect(check?.roleAgents?.sourceIssues).toHaveLength(1);
    expect(check?.roleAgents?.sourceIssues[0]).toContain(join(pluginRoot, 'agents'));
    expect(check?.roleAgents?.files).toEqual([]);
  });

  test('an unreadable source agent is not silently omitted from a healthy result', () => {
    writeSourceAgent('scout', '# scout\n');
    const sourcePath = join(pluginRoot, 'agents', 'scout.md');
    chmodSync(sourcePath, 0o000);
    try {
      const check = find(checkAgentSync(paths()), ROLE_CHECK);

      expect(check?.status).toBe('warn');
      expect(check?.detail).toContain('cannot read source role agent scout.md');
      expect(check?.roleAgents?.sourceIssues).toHaveLength(1);
      expect(check?.roleAgents?.sourceIssues[0]).toContain('scout.md');
      expect(check?.roleAgents?.files).toEqual([]);
    } finally {
      chmodSync(sourcePath, 0o600);
    }
  });

  test('hand-copy (no manifest) reports present-unmanaged, NOT healthy genie-managed', () => {
    // The 2026-07-11 false-PASS discriminator: files present + agents surface,
    // but no stamp → doctor must NOT call it genie-managed-current.
    writeSourceAgent('scout', '# scout\n');
    writeTargetAgent('scout', '# scout\n');

    const check = find(checkAgentSync(paths()), ROLE_CHECK);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('present-unmanaged'); // human output carries the state
    expect(check?.roleAgents?.manifestStatus).toBe('absent');
    expect(stateMap(check)['scout.md']).toBe('present-unmanaged');
    expect(stateMap(check)['scout.md']).not.toBe('genie-managed-current');
  });

  test('stamped + byte-matching target reports genie-managed-current → pass', () => {
    writeSourceAgent('scout', '# scout\n');
    writeTargetAgent('scout', '# scout\n');
    writeAgentManifest({ 'scout.md': { digest: computeFileDigest(join(agentsDir, 'scout.md')) } });

    const check = find(checkAgentSync(paths()), ROLE_CHECK);
    expect(check?.status).toBe('pass');
    expect(check?.roleAgents?.manifestStatus).toBe('managed');
    expect(stateMap(check)['scout.md']).toBe('genie-managed-current');
  });

  test('source drifted past a stamped target reports genie-managed-stale → warn', () => {
    writeTargetAgent('scout', '# scout v1\n');
    const v1Digest = computeFileDigest(join(agentsDir, 'scout.md'));
    writeAgentManifest({ 'scout.md': { digest: v1Digest } }); // on-disk == manifest
    writeSourceAgent('scout', '# scout v2\n'); // but source moved on

    const check = find(checkAgentSync(paths()), ROLE_CHECK);
    expect(check?.status).toBe('warn');
    expect(check?.suggestion).toContain('genie update');
    expect(stateMap(check)['scout.md']).toBe('genie-managed-stale');
  });

  test('source agent absent from the target reports missing-from-target → warn', () => {
    writeSourceAgent('fixer', '# fixer\n'); // no target file, no manifest entry

    const check = find(checkAgentSync(paths()), ROLE_CHECK);
    expect(check?.status).toBe('warn');
    expect(stateMap(check)['fixer.md']).toBe('missing-from-target');
  });

  test('manifest-owned entry absent from both source and target remains visible as missing', () => {
    writeAgentManifest({ 'retired.md': { digest: 'a'.repeat(64) } });

    const check = find(checkAgentSync(paths()), ROLE_CHECK);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('missing-from-target');
    expect(check?.roleAgents?.manifestStatus).toBe('managed');
    expect(stateMap(check)['retired.md']).toBe('missing-from-target');
  });

  test('a user-authored agent (not in source, unmanaged) is never reported', () => {
    writeSourceAgent('scout', '# scout\n');
    writeTargetAgent('scout', '# scout\n');
    writeAgentManifest({ 'scout.md': { digest: computeFileDigest(join(agentsDir, 'scout.md')) } });
    writeTargetAgent('my-own-agent', '# mine\n'); // genie does not speak for it

    const check = find(checkAgentSync(paths()), ROLE_CHECK);
    const states = stateMap(check);
    expect(states['my-own-agent.md']).toBeUndefined();
    expect(states['scout.md']).toBe('genie-managed-current');
    expect(check?.status).toBe('pass');
  });

  test('an unsafe (symlinked) manifest warns instead of silently reporting healthy', () => {
    writeSourceAgent('scout', '# scout\n');
    writeTargetAgent('scout', '# scout\n');
    symlinkSync(join(tmp, 'elsewhere.json'), join(agentsDir, '.genie-sync.json'));

    const check = find(checkAgentSync(paths()), ROLE_CHECK);
    expect(check?.status).toBe('warn');
    expect(check?.roleAgents?.manifestStatus).toBe('unsafe');
    expect(check?.detail).toContain('manifest unusable');
  });

  test('a malformed Genie-owned manifest is unsafe rather than foreign', () => {
    writeSourceAgent('scout', '# scout\n');
    writeTargetAgent('scout', '# scout\n');
    writeAgentManifest({ 'scout.md': { digest: 'not-a-sha256' } });

    const check = find(checkAgentSync(paths()), ROLE_CHECK);

    expect(check?.status).toBe('warn');
    expect(check?.roleAgents?.manifestStatus).toBe('unsafe');
    expect(check?.roleAgents?.manifestReason).toContain('claims Genie ownership');
    expect(check?.detail).toContain('manifest unusable');
  });

  test('a truncated ownership manifest is unsafe rather than unproven foreign state', () => {
    writeSourceAgent('scout', '# scout\n');
    writeTargetAgent('scout', '# scout\n');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, '.genie-sync.json'), '{"managedBy":"genie-agent-sync","files":{', 'utf8');

    const check = find(checkAgentSync(paths()), ROLE_CHECK);

    expect(check?.status).toBe('warn');
    expect(check?.roleAgents?.manifestStatus).toBe('unsafe');
    expect(check?.roleAgents?.manifestReason).toContain('invalid JSON');
    expect(check?.detail).toContain('manifest unusable');
  });

  test('plugin enabled → duplicate-surface warning + duplicateSurface flag true', () => {
    writeSourceAgent('scout', '# scout\n');
    writeTargetAgent('scout', '# scout\n');
    writeAgentManifest({ 'scout.md': { digest: computeFileDigest(join(agentsDir, 'scout.md')) } });
    writeSettings({ enabledPlugins: { 'genie@automagik': true } });

    const results = checkAgentSync(paths());
    const dup = find(results, DUP_CHECK);
    expect(dup?.status).toBe('warn');
    expect(dup?.detail).toContain('both surface');
    expect(find(results, ROLE_CHECK)?.roleAgents?.duplicateSurface).toBe(true);
  });

  test('plugin disabled or absent → no duplicate warning, duplicateSurface flag false', () => {
    writeSourceAgent('scout', '# scout\n');
    writeTargetAgent('scout', '# scout\n');
    writeAgentManifest({ 'scout.md': { digest: computeFileDigest(join(agentsDir, 'scout.md')) } });

    writeSettings({ enabledPlugins: { 'genie@automagik': false } });
    let results = checkAgentSync(paths());
    expect(find(results, DUP_CHECK)).toBeUndefined();
    expect(find(results, ROLE_CHECK)?.roleAgents?.duplicateSurface).toBe(false);

    // absent settings.json → still no warning, flag false
    rmSync(join(claudeDir, 'settings.json'), { force: true });
    results = checkAgentSync(paths());
    expect(find(results, DUP_CHECK)).toBeUndefined();
    expect(find(results, ROLE_CHECK)?.roleAgents?.duplicateSurface).toBe(false);
  });

  test('--json carries the per-file states under stable field names (dashboard-consumable)', () => {
    // Drive the exact document doctorCommand serializes: { ok, checks: results }.
    writeSourceAgent('scout', '# scout\n'); // hand-copy → present-unmanaged
    writeTargetAgent('scout', '# scout\n');
    writeSourceAgent('reviewer', '# reviewer\n'); // stamped-current
    writeTargetAgent('reviewer', '# reviewer\n');
    writeSourceAgent('fixer', '# fixer\n'); // missing-from-target
    writeAgentManifest({ 'reviewer.md': { digest: computeFileDigest(join(agentsDir, 'reviewer.md')) } });

    const results = checkAgentSync(paths());
    const doc = JSON.parse(JSON.stringify({ ok: true, checks: results })) as {
      checks: Array<{ name: string; roleAgents?: { files: Array<{ name: string; state: string }> } }>;
    };
    const rider = doc.checks.find((c) => c.name === ROLE_CHECK)?.roleAgents;
    const states = Object.fromEntries((rider?.files ?? []).map((f) => [f.name, f.state]));
    expect(states['scout.md']).toBe('present-unmanaged');
    expect(states['reviewer.md']).toBe('genie-managed-current');
    expect(states['fixer.md']).toBe('missing-from-target');
  });
});

// ============================================================================
// jar: index-lane drift
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
    const entries = evaluateIndexLaneDrift(INDEX, laneForSlug);
    const byEntry = Object.fromEntries(entries.map((e) => [e.entry, e]));
    expect(byEntry.alpha.state).toBe('ok');
    expect(byEntry.alpha.lane).toBe('Idea');
    expect(byEntry.beta.state).toBe('drift');
    expect(byEntry['WISH: gamma'].state).toBe('ok');
  });

  test('the FIRST brainstorms/wishes link decides the slug', () => {
    const entries = evaluateIndexLaneDrift(INDEX, laneForSlug);
    const delta = entries.find((e) => e.entry === 'delta');
    expect(delta?.slug).toBe('delta');
    expect(delta?.state).toBe('ok');
  });

  test('linkless entries and laneless cards are unlinked, never drift', () => {
    const entries = evaluateIndexLaneDrift(INDEX, laneForSlug);
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
    const entries = evaluateIndexLaneDrift(INDEX, laneForSlug);
    expect(entries.some((e) => e.slug === 'zeta')).toBe(false);
    // Raw(2) + Simmering(1) + Ready(1) + Poured(2) = 6 entries.
    expect(entries).toHaveLength(6);
  });

  test('order is stable (INDEX document order)', () => {
    const slugs = evaluateIndexLaneDrift(INDEX, laneForSlug).map((e) => e.slug);
    expect(slugs).toEqual(['alpha', null, 'beta', 'gamma', 'delta', 'epsilon']);
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genie-jar-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a resolved card whose lane agrees passes with a per-entry ok state', () => {
    writeIndex('# Plans Index\n## Poured\n- [WISH: boards](wishes/boards-first-class/WISH.md) — shipped\n');
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
    seedDb([{ title: 'Boards first-class', wish: 'boards-first-class', lane: 'Idea' }]);
    const [result] = checkIndexLaneDrift(dir, dir);
    expect(result.status).toBe('warn'); // warn, not fail
    expect(result.detail).toContain('1 drift');
    expect(result.indexLane?.entries[0].state).toBe('drift');
    expect(result.suggestion).toBeDefined();
  });

  test('a laneless card is unlinked, not drift', () => {
    writeIndex('# Plans Index\n## Raw\n- [alpha](brainstorms/alpha/DRAFT.md)\n');
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
    seedDb([
      { title: 'Alpha', wish: 'alpha', lane: 'Idea' },
      { title: 'Beta', wish: 'beta', lane: 'Idea' },
    ]);
    const [result] = checkIndexLaneDrift(dir, dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toBe('3 INDEX entries: 1 ok, 1 drift, 1 unlinked');
    const states = Object.fromEntries((result.indexLane?.entries ?? []).map((e) => [e.slug, e.state]));
    expect(states.alpha).toBe('ok');
    expect(states.beta).toBe('drift');
    expect(states.orphan).toBe('unlinked');
  });

  test('--json rider is present under the stable name with per-entry states', () => {
    writeIndex('# Plans Index\n## Poured\n- [WISH: boards](wishes/boards-first-class/WISH.md)\n');
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
});

// ============================================================================
// Codex integration summary — additive `doctor --json` rider (Group D, D3/D4)
// ============================================================================

import {
  type CanonicalFact,
  type CodexActivationSnapshot,
  type FamilyWitness,
  type PhysicalCacheFact,
  type QueryFact,
  parseReleaseVersion,
} from '../lib/codex-activation.js';
import {
  DELIVERY_EVIDENCE_DIGEST_ALGORITHM,
  DELIVERY_EVIDENCE_REPOSITORY,
  type VerifiedDeliveryEvidenceFacts,
  deriveDeliveryId,
} from '../lib/codex-delivery-evidence.js';

const DOC_T = '5.260712.1';
const DOC_OLD = '5.260711.9';
const DOC_DIGEST = 'a'.repeat(64);
const DOC_BINARY_DIGEST = 'b'.repeat(64);
const DOC_MANIFEST_DIGEST = 'c'.repeat(64);
const DOC_ARTIFACT_DIGEST = 'd'.repeat(64);
const DOC_PLATFORM = 'darwin-arm64';
const DOC_DELIVERY_ROOT = '/fixture/genie/deliveries/current';
const DOC_EVIDENCE_DIGEST = 'e'.repeat(64);

function docVer(s: string) {
  const parsed = parseReleaseVersion(s);
  if (!parsed) throw new Error(`bad test version ${s}`);
  return parsed;
}
function docFamily(): FamilyWitness {
  return { status: 'present', digest: 'f'.repeat(64), identity: '10:300' };
}
function docOkCanonical(): CanonicalFact {
  return {
    status: 'ok',
    version: docVer(DOC_T),
    digest: DOC_DIGEST,
    identity: '10:100',
    platformTriple: DOC_PLATFORM,
    installedBinarySha256: DOC_BINARY_DIGEST,
    deliveryRoot: DOC_DELIVERY_ROOT,
  };
}
function docRegPresent(version = DOC_T): QueryFact {
  return { status: 'ok', registration: { present: true, enabled: true, version: docVer(version) } };
}
function docCachePresent(digest = DOC_DIGEST): PhysicalCacheFact {
  return { kind: 'present', digest, identity: '10:200' };
}
/** A matching authenticated delivery record binding the canonical target (Group E delivery gate). */
function docDeliveryPresent(): CodexActivationSnapshot['delivery'] {
  return {
    status: 'present',
    record: {
      schemaVersion: 2,
      deliveryId: deriveDeliveryId(DOC_EVIDENCE_DIGEST, DOC_DELIVERY_ROOT),
      targetVersion: DOC_T,
      canonicalPayloadSha256: DOC_DIGEST,
      channel: 'stable',
      deliveredAt: '2026-07-12T00:00:00.000Z',
      evidenceDigest: DOC_EVIDENCE_DIGEST,
      platformId: 'darwin-arm64',
      platformTriple: DOC_PLATFORM,
      releaseTag: `v${DOC_T}`,
      releaseName: `genie-${DOC_T}-${DOC_PLATFORM}.tar.gz`,
      releaseManifestSha256: DOC_MANIFEST_DIGEST,
      artifactSha256: DOC_ARTIFACT_DIGEST,
      installedBinarySha256: DOC_BINARY_DIGEST,
      deliveryRoot: DOC_DELIVERY_ROOT,
    },
    evidence: docDeliveryEvidenceFacts(),
  };
}

function docDeliveryEvidenceFacts(): VerifiedDeliveryEvidenceFacts {
  return {
    evidenceDigest: DOC_EVIDENCE_DIGEST,
    deliveredAt: '2026-07-12T00:00:00.000Z',
    descriptor: {
      schemaVersion: 1 as const,
      repository: DELIVERY_EVIDENCE_REPOSITORY,
      version: DOC_T,
      channel: 'stable' as const,
      platformId: 'darwin-arm64' as const,
      platformTriple: DOC_PLATFORM,
      releaseTag: `v${DOC_T}`,
      releaseName: `genie-${DOC_T}-${DOC_PLATFORM}.tar.gz`,
      releaseManifestSha256: DOC_MANIFEST_DIGEST,
      artifactSha256: DOC_ARTIFACT_DIGEST,
      installedBinarySha256: DOC_BINARY_DIGEST,
      canonicalPayloadSha256: DOC_DIGEST,
      sourceSha: '1'.repeat(40),
      sourceBranch: 'main',
      sourceCiRunId: '123',
      controlSha: '2'.repeat(40),
      digestAlgorithm: DELIVERY_EVIDENCE_DIGEST_ALGORITHM,
    },
  };
}
function docCurrentSnapshot(): CodexActivationSnapshot {
  return {
    canonical: docOkCanonical(),
    query: docRegPresent(),
    cache: docCachePresent(),
    receipt: { status: 'absent' },
    delivery: docDeliveryPresent(),
    intent: { status: 'absent' },
    receiptConsumed: false,
    observationWitness: { before: docFamily(), after: docFamily() },
    observedAt: '2026-07-12T00:00:00.000Z',
  };
}
function docPendingSnapshot(): CodexActivationSnapshot {
  return { ...docCurrentSnapshot(), query: docRegPresent(DOC_OLD), cache: docCachePresent('b'.repeat(64)) };
}
function docQueryFailedSnapshot(): CodexActivationSnapshot {
  return { ...docCurrentSnapshot(), query: { status: 'failed', detail: 'codex plugin list timed out' } };
}
function docAbsentSnapshot(): CodexActivationSnapshot {
  return {
    ...docCurrentSnapshot(),
    query: { status: 'ok', registration: { present: false } },
    cache: { kind: 'absent' },
  };
}

function doctorDepsWith(snapshot: CodexActivationSnapshot | null) {
  return {
    root: join(tmpdir(), 'doc-int-nonexistent'),
    databaseRoot: join(tmpdir(), 'doc-int-nonexistent'),
    pluginProbe: NO_CODEX,
    bunVersion: '1.3.10',
    bunPath: '/usr/bin/bun',
    codexActivation: snapshot,
  };
}

interface DoctorJson {
  ok: boolean;
  checks: Array<{ name: string; status: string }>;
  integrationSummary?: {
    schemaVersion: number;
    codexPlugin: {
      state: string;
      installedVersion: string | null;
      targetVersion: string | null;
      actionRequired: boolean;
      deliveryComplete: boolean;
      mutationAuthority: string;
      authorization: { result: string; reason: string | null };
      cache: string;
      recovery: string;
    };
  };
}

describe('doctor --json integrationSummary (Group D)', () => {
  test('current: integrationSummary present, ok:true, exit 0, actionRequired false', async () => {
    const { output, exitCode } = await captureDoctor(() =>
      doctorCommand({ json: true }, doctorDepsWith(docCurrentSnapshot())),
    );
    const json = JSON.parse(output) as DoctorJson;
    expect(json.integrationSummary?.schemaVersion).toBe(1);
    expect(json.integrationSummary?.codexPlugin.state).toBe('current');
    expect(json.integrationSummary?.codexPlugin.actionRequired).toBe(false);
    expect(json.integrationSummary?.codexPlugin.deliveryComplete).toBe(true);
    expect(json.integrationSummary?.codexPlugin.cache).toBe('verified-current');
    expect(json.ok).toBe(true);
    expect(exitCode).toBe(0);
  });

  test('pending: ok stays true while the command exits 2 and actionRequired is true', async () => {
    const { output, exitCode } = await captureDoctor(() =>
      doctorCommand({ json: true }, doctorDepsWith(docPendingSnapshot())),
    );
    const json = JSON.parse(output) as DoctorJson;
    expect(json.integrationSummary?.codexPlugin.state).toBe('activation-pending');
    expect(json.integrationSummary?.codexPlugin.actionRequired).toBe(true);
    expect(json.integrationSummary?.codexPlugin.deliveryComplete).toBe(true);
    expect(json.integrationSummary?.codexPlugin.installedVersion).toBe(DOC_OLD);
    expect(json.integrationSummary?.codexPlugin.targetVersion).toBe(DOC_T);
    // Pending exit-2 authorization is 'required' via the doctor (non-setup) entry.
    expect(json.integrationSummary?.codexPlugin.authorization.result).toBe('required');
    expect(json.ok).toBe(true); // no failed hard checks — {ok} meaning unchanged
    expect(exitCode).toBe(2);
  });

  test('registration-absent activation-required exits 2', async () => {
    const { output, exitCode } = await captureDoctor(() =>
      doctorCommand({ json: true }, doctorDepsWith(docAbsentSnapshot())),
    );
    const json = JSON.parse(output) as DoctorJson;
    expect(json.integrationSummary?.codexPlugin.state).toBe('registration-absent');
    expect(exitCode).toBe(2);
  });

  test('query-failed is broken/retry: exit 1, mutationAuthority none', async () => {
    const { output, exitCode } = await captureDoctor(() =>
      doctorCommand({ json: true }, doctorDepsWith(docQueryFailedSnapshot())),
    );
    const json = JSON.parse(output) as DoctorJson;
    expect(json.integrationSummary?.codexPlugin.state).toBe('query-failed');
    expect(json.integrationSummary?.codexPlugin.mutationAuthority).toBe('none');
    expect(exitCode).toBe(1);
  });

  test('codex absent (explicit null): no integrationSummary key, exit 0', async () => {
    const { output, exitCode } = await captureDoctor(() => doctorCommand({ json: true }, doctorDepsWith(null)));
    const json = JSON.parse(output) as DoctorJson;
    expect(json.integrationSummary).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(exitCode).toBe(0);
    // {ok,checks} shape unchanged.
    expect(Array.isArray(json.checks)).toBe(true);
  });

  test('pending projection is identical across repeated runs (deterministic, inert)', async () => {
    const first = await captureDoctor(() => doctorCommand({ json: true }, doctorDepsWith(docPendingSnapshot())));
    const second = await captureDoctor(() => doctorCommand({ json: true }, doctorDepsWith(docPendingSnapshot())));
    const a = JSON.parse(first.output) as DoctorJson;
    const b = JSON.parse(second.output) as DoctorJson;
    expect(a.integrationSummary).toEqual(b.integrationSummary);
    expect(first.exitCode).toBe(2);
    expect(second.exitCode).toBe(2);
  });

  test('human mode: pending status prints to stdout with the recovery path', async () => {
    const { output } = await captureDoctor(() => doctorCommand({}, doctorDepsWith(docPendingSnapshot())));
    expect(output).toContain('Codex integration:');
    expect(output).toContain('activation-pending');
    expect(output).toContain('genie setup --codex');
  });

  test('doctor.ts never touches the lifecycle lease (read-only observer path)', () => {
    const source = readFileSync(join(import.meta.dir, 'doctor.ts'), 'utf8');
    expect(source.includes('acquireLifecycleLease')).toBe(false);
  });
});

describe('Group E lifecycle truth (doctor)', () => {
  test('current state with an ABSENT delivery record presents delivery-incomplete, exit 1, recovery command', async () => {
    const missingRecord = { ...docCurrentSnapshot(), delivery: { status: 'absent' as const } };
    const { output, exitCode } = await captureDoctor(() =>
      doctorCommand({ json: true }, doctorDepsWith(missingRecord)),
    );
    const json = JSON.parse(output) as DoctorJson;
    expect(json.integrationSummary?.codexPlugin).toMatchObject({
      state: 'delivery-incomplete',
      deliveryComplete: false,
      actionRequired: true,
      mutationAuthority: 'none',
    });
    expect(json.integrationSummary?.codexPlugin.recovery).toContain('genie update');
    expect(exitCode).toBe(1);
  });

  test('an INVALID record and a MISMATCHED record present the same consistent delivery-incomplete state', async () => {
    const invalid = { ...docCurrentSnapshot(), delivery: { status: 'invalid' as const, detail: 'corrupt' } };
    const mismatched = {
      ...docCurrentSnapshot(),
      delivery: {
        status: 'present' as const,
        record: {
          schemaVersion: 2 as const,
          deliveryId: deriveDeliveryId(DOC_EVIDENCE_DIGEST, DOC_DELIVERY_ROOT),
          targetVersion: DOC_OLD,
          canonicalPayloadSha256: DOC_DIGEST,
          channel: 'stable',
          deliveredAt: '2026-07-12T00:00:00.000Z',
          evidenceDigest: DOC_EVIDENCE_DIGEST,
          platformId: 'darwin-arm64',
          platformTriple: DOC_PLATFORM,
          releaseTag: `v${DOC_OLD}`,
          releaseName: `genie-${DOC_OLD}-${DOC_PLATFORM}.tar.gz`,
          releaseManifestSha256: DOC_MANIFEST_DIGEST,
          artifactSha256: DOC_ARTIFACT_DIGEST,
          installedBinarySha256: DOC_BINARY_DIGEST,
          deliveryRoot: DOC_DELIVERY_ROOT,
        },
        evidence: docDeliveryEvidenceFacts(),
      },
    };
    for (const snapshot of [invalid, mismatched]) {
      const { output, exitCode } = await captureDoctor(() => doctorCommand({ json: true }, doctorDepsWith(snapshot)));
      const json = JSON.parse(output) as DoctorJson;
      expect(json.integrationSummary?.codexPlugin.state).toBe('delivery-incomplete');
      expect(json.integrationSummary?.codexPlugin.deliveryComplete).toBe(false);
      expect(exitCode).toBe(1);
    }
  });

  test('a harder exit-1 state (query-failed) keeps its own presentation; deliveryComplete still false', async () => {
    const queryFailedNoRecord = { ...docQueryFailedSnapshot(), delivery: { status: 'absent' as const } };
    const { output, exitCode } = await captureDoctor(() =>
      doctorCommand({ json: true }, doctorDepsWith(queryFailedNoRecord)),
    );
    const json = JSON.parse(output) as DoctorJson;
    expect(json.integrationSummary?.codexPlugin.state).toBe('query-failed');
    expect(json.integrationSummary?.codexPlugin.deliveryComplete).toBe(false);
    expect(exitCode).toBe(1);
  });

  test('matching record keeps current green: exit 0, deliveryComplete true (regression anchor)', async () => {
    const { output, exitCode } = await captureDoctor(() =>
      doctorCommand({ json: true }, doctorDepsWith(docCurrentSnapshot())),
    );
    const json = JSON.parse(output) as DoctorJson;
    expect(json.integrationSummary?.codexPlugin).toMatchObject({ state: 'current', deliveryComplete: true });
    expect(exitCode).toBe(0);
  });

  test('unified host path: one canned query feeds advisory rider AND a non-query-failed summary (Decision 11)', async () => {
    const calls: string[][] = [];
    const stdout = JSON.stringify({
      installed: [{ pluginId: 'genie@automagik', version: '5.260722.1', enabled: true }],
    });
    const { output } = await captureDoctor(() =>
      doctorCommand(
        { json: true },
        {
          root: join(isolatedHome, 'repo'),
          databaseRoot: join(isolatedHome, 'repo'),
          bunVersion: '1.3.10',
          bunPath: '/usr/bin/bun',
          codexHost: {
            which: () => process.execPath,
            codexHome: join(isolatedHome, 'codex'),
            runner: (command, args) => {
              calls.push([command, ...args]);
              return {
                exitCode: 0,
                stdout,
                stderr: '\x1b[33mWARN: PATH advisory\x1b[0m',
              };
            },
          },
        },
      ),
    );
    // Exactly one spawn fed the probe AND (via replay) the activation snapshot.
    expect(calls).toEqual([[process.execPath, 'plugin', 'list', '--json']]);
    const json = JSON.parse(output) as DoctorJson;
    const cli = json.checks.find((check) => check.name === 'Codex CLI') as
      | { name: string; status: string; advisory?: string; detail?: string }
      | undefined;
    expect(cli?.advisory).toBe('WARN: PATH advisory');
    expect(cli?.detail).toContain('advisory: WARN: PATH advisory');
    // The advisory did NOT flip the fail-closed activation parser to query-failed.
    expect(json.integrationSummary?.codexPlugin.state).not.toBe('query-failed');
    // One ANSI-free JSON document: the raw advisory's escape bytes never reach stdout.
    expect(output).not.toContain('\x1b[33m');
  });

  test('project context: ok / database-unavailable / unsupported-layout map to pass / warn / fail', async () => {
    const openableDbPath = join(isolatedHome, 'project-context-openable.db');
    const openableDb = new Database(openableDbPath);
    openableDb.close();
    const base = {
      effectiveLaunchCwd: '/repo',
      worktreeConfigRoot: '/repo',
      gitCommonDir: '/repo/.git',
      genieStorageRoot: '/repo',
      dbPath: openableDbPath,
    };
    const cases = [
      { context: { kind: 'ok' as const, ...base }, status: 'pass' },
      {
        context: { kind: 'project-database-unavailable' as const, effectiveLaunchCwd: '/repo', detail: 'no db' },
        status: 'warn',
      },
      {
        context: { kind: 'unsupported-project-layout' as const, effectiveLaunchCwd: '/repo', detail: 'bare repo' },
        status: 'fail',
      },
    ];
    for (const { context, status } of cases) {
      const { output } = await captureDoctor(() =>
        doctorCommand({ json: true }, { ...doctorDepsWith(null), projectContext: context }),
      );
      const json = JSON.parse(output) as DoctorJson;
      const check = json.checks.find((c) => c.name === 'Codex project context');
      expect(check?.status).toBe(status);
    }
  });

  test('injected root without injected context skips the context check (unit-test seam, not a repo)', async () => {
    const { output } = await captureDoctor(() => doctorCommand({ json: true }, doctorDepsWith(null)));
    const json = JSON.parse(output) as DoctorJson;
    expect(json.checks.find((c) => c.name === 'Codex project context')).toBeUndefined();
  });
});
