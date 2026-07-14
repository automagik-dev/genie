import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Colocated fixtures for scripts/release-guard.sh (wish
// stable-release-security-gate, F17). CI has no workflow simulator, so the
// ref/tag guard and the run-id provenance validation are exercised here as a
// shell test spawned inside the normal `bun test` gate.

const SCRIPT = join(import.meta.dir, 'release-guard.sh');
const REPO_ROOT = join(import.meta.dir, '..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mkroot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function guard(subcommand: string, env: Record<string, string>, args: string[] = []) {
  return Bun.spawnSync(['bash', SCRIPT, subcommand, ...args], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

const VALID_RUN = {
  repository: { full_name: 'automagik-dev/genie' },
  path: '.github/workflows/build-tarballs.yml',
  conclusion: 'success',
  status: 'completed',
  head_branch: 'v5.260714.1',
  head_sha: 'a'.repeat(40),
};

function runJson(root: string, overrides: Record<string, unknown> = {}): string {
  const path = join(root, 'run.json');
  writeFileSync(path, JSON.stringify({ ...VALID_RUN, ...overrides }));
  return path;
}

const PROVENANCE_ENV = {
  EXPECTED_REPO: 'automagik-dev/genie',
  EXPECTED_WORKFLOW: '.github/workflows/build-tarballs.yml',
  EXPECTED_REF: 'refs/tags/v5.260714.1',
  EXPECTED_SHA: 'a'.repeat(40),
  EXPECTED_VERSION: '5.260714.1',
};

describe('require-dispatch-tag (F16 ref guard)', () => {
  test('non-dispatch events are a no-op (tag push / pull_request / workflow_call)', () => {
    for (const event of ['push', 'pull_request', 'workflow_call', '']) {
      const result = guard('require-dispatch-tag', { EVENT: event, REF: 'refs/heads/dev' });
      expect(result.exitCode).toBe(0);
    }
  });

  test('dev-channel dispatch on the freshly-pushed v<version> tag is allowed (HARD INVARIANT)', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/v5.260714.1',
      CHANNEL: 'dev',
      VERSION: '5.260714.1',
    });
    expect(result.exitCode).toBe(0);
  });

  test('stable dispatch on a valid tag is allowed', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/v5.260714.1',
      CHANNEL: 'stable',
    });
    expect(result.exitCode).toBe(0);
  });

  test('a non-tag ref fails closed at a stable-capable dispatch', () => {
    for (const ref of ['refs/heads/dev', 'refs/heads/main', 'refs/heads/attacker', 'refs/pull/1/merge']) {
      const result = guard('require-dispatch-tag', { EVENT: 'workflow_dispatch', REF: ref, CHANNEL: 'stable' });
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain('non-tag ref');
    }
  });

  test('a malformed tag ref fails closed', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/not-a-version',
    });
    expect(result.exitCode).toBe(3);
  });

  test('a version input that does not match the dispatched tag fails closed', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/v5.260714.1',
      VERSION: '5.260714.2',
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('does not match dispatched tag');
  });

  test('a version input failing the grammar fails closed', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/v5.260714.1',
      VERSION: '5.260714.1; rm -rf /',
    });
    expect(result.exitCode).toBe(3);
  });
});

describe('check-run-provenance (F17 upstream identity)', () => {
  test('a matching upstream run record passes', () => {
    const root = mkroot('genie-run-ok-');
    const result = guard('check-run-provenance', PROVENANCE_ENV, [runJson(root)]);
    expect(result.exitCode).toBe(0);
  });

  test('a run from another repository fails closed', () => {
    const root = mkroot('genie-run-repo-');
    const result = guard('check-run-provenance', PROVENANCE_ENV, [
      runJson(root, { repository: { full_name: 'attacker/genie' } }),
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('repository');
  });

  test('a run from a different workflow file fails closed', () => {
    const root = mkroot('genie-run-wf-');
    const result = guard('check-run-provenance', PROVENANCE_ENV, [runJson(root, { path: '.github/workflows/ci.yml' })]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('workflow');
  });

  test('a failed or incomplete upstream run cannot be signed/published', () => {
    const root = mkroot('genie-run-fail-');
    const failed = guard('check-run-provenance', PROVENANCE_ENV, [runJson(root, { conclusion: 'failure' })]);
    expect(failed.exitCode).toBe(3);
    const incomplete = guard('check-run-provenance', PROVENANCE_ENV, [
      runJson(root, { status: 'in_progress', conclusion: null }),
    ]);
    expect(incomplete.exitCode).toBe(3);
  });

  test('a run whose head ref differs from the dispatched tag fails closed', () => {
    const root = mkroot('genie-run-ref-');
    const result = guard('check-run-provenance', PROVENANCE_ENV, [runJson(root, { head_branch: 'dev' })]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('head ref');
  });

  test('a run whose head SHA differs from the dispatched SHA fails closed', () => {
    const root = mkroot('genie-run-sha-');
    const result = guard('check-run-provenance', PROVENANCE_ENV, [runJson(root, { head_sha: 'b'.repeat(40) })]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('head SHA');
  });

  test('a missing provenance file fails closed', () => {
    const result = guard('check-run-provenance', PROVENANCE_ENV, [join(mkroot('genie-run-miss-'), 'absent.json')]);
    expect(result.exitCode).toBe(3);
  });

  test('a non-tag EXPECTED_REF is rejected as misconfiguration', () => {
    const root = mkroot('genie-run-badref-');
    const result = guard('check-run-provenance', { ...PROVENANCE_ENV, EXPECTED_REF: 'refs/heads/dev' }, [
      runJson(root),
    ]);
    expect(result.exitCode).toBe(3);
  });
});

describe('guard-run-provenance (orchestrated vs break-glass)', () => {
  test('an empty run_id is the orchestrated same-run path and is a no-op', () => {
    const result = guard('guard-run-provenance', {
      RUN_ID: '',
      EXPECTED_REPO: 'automagik-dev/genie',
      EXPECTED_WORKFLOW: '.github/workflows/build-tarballs.yml',
      EXPECTED_REF: 'refs/tags/v5.260714.1',
    });
    expect(result.exitCode).toBe(0);
  });

  test('a non-numeric run_id fails closed before any network call', () => {
    const result = guard('guard-run-provenance', {
      RUN_ID: 'not-a-run',
      EXPECTED_REPO: 'automagik-dev/genie',
    });
    expect(result.exitCode).toBe(3);
  });

  test('a numeric run_id fetches via gh and validates the returned record', () => {
    // Fake gh in PATH returns the fixture record for `gh api repos/.../runs/<id>`.
    const root = mkroot('genie-run-gh-');
    const ghPath = join(root, 'gh');
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bun\nimport { writeSync } from 'node:fs';\nconst rec = ${JSON.stringify(
        VALID_RUN,
      )};\nwriteSync(1, JSON.stringify(rec));\nprocess.exit(0);\n`,
    );
    chmodSync(ghPath, 0o755);
    const result = guard('guard-run-provenance', {
      ...PROVENANCE_ENV,
      RUN_ID: '123456',
      PATH: `${root}:${process.env.PATH ?? ''}`,
    });
    expect(result.exitCode).toBe(0);
  });
});
