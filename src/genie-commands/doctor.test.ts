import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorCommand, evaluateOmniHookTimeout, findDispatchHookTimeoutSec } from './doctor.js';

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

describe('doctorCommand', () => {
  // The suite runs from within the genie repo — a healthy checkout with git,
  // bun, and skills/ present. Every check should therefore pass.
  let json: { ok: boolean; checks: Array<{ name: string; status: string }> };

  beforeEach(async () => {
    const { output } = await captureDoctor(() => doctorCommand({ json: true }));
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
    const { exitCode } = await captureDoctor(() => doctorCommand({ json: true }));
    expect(exitCode).toBeUndefined();
  });

  test('human output renders a header and a summary line', async () => {
    const { output } = await captureDoctor(() => doctorCommand());
    expect(output).toContain('genie doctor');
    expect(output).toContain('All checks passed.');
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
    expect(res?.suggestion).toContain('111'); // floor(110_000/1000)+1 — strictly above the budget
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

    const { output, exitCode } = await captureDoctor(() => doctorCommand({ json: true }));
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

    const { output, exitCode } = await captureDoctor(() => doctorCommand({ json: true }));
    const json = JSON.parse(output) as { ok: boolean; checks: Array<{ name: string; status: string }> };
    const db = json.checks.find((c) => c.name === 'genie.db');
    expect(db?.status).toBe('fail');
    expect(json.ok).toBe(false);
    expect(exitCode).toBe(1);
  });
});
