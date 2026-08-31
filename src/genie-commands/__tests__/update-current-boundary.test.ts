import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNNER = join(import.meta.dir, '..', '..', '..', 'tests', 'support', 'update-current-boundary-runner.ts');
const roots: string[] = [];

interface BoundaryResult {
  deliveries: number;
  convergenceRuns: number;
  markerExists: boolean;
  markerText: string | null;
  commandExitCode: number;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runBoundary(scenario: 'already-current'): {
  exitCode: number;
  result: BoundaryResult;
} {
  const root = mkdtempSync(join(tmpdir(), `genie-update-current-${scenario}-`));
  roots.push(root);
  const env = { ...process.env };
  env.GENIE_BUNDLE_ROOT = undefined;
  env.GENIE_LIFECYCLE_LEASE_OWNER = undefined;
  env.GENIE_LIFECYCLE_LEASE_PATH = undefined;
  Object.assign(env, {
    HOME: join(root, 'user-home'),
    CODEX_HOME: join(root, 'codex-home'),
    GENIE_HOME: join(root, 'genie-home'),
    GENIE_TEST_UPDATE_CURRENT_SCENARIO: scenario,
  });
  const spawned = Bun.spawnSync(['bun', RUNNER], { env, stdout: 'pipe', stderr: 'pipe' });
  const stdout = spawned.stdout.toString().trim();
  if (stdout.length === 0) {
    throw new Error(`boundary runner emitted no result\n${spawned.stderr.toString()}`);
  }
  return {
    exitCode: spawned.exitCode,
    result: JSON.parse(stdout.split('\n').at(-1) as string) as BoundaryResult,
  };
}

describe('updateCommand already-current terminal', () => {
  test('reports, converges once, retires the legacy marker, and never enters selected-target delivery', () => {
    const { exitCode, result } = runBoundary('already-current');
    expect(exitCode).toBe(0);
    expect(result.commandExitCode).toBe(0);
    expect(result.deliveries).toBe(0);
    expect(result.convergenceRuns).toBe(1);
    expect(result.markerExists).toBe(false);
    expect(result.markerText).toBeNull();
  });
});
