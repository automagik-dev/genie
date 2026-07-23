import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNNER = join(import.meta.dir, '..', '..', '..', 'tests', 'support', 'update-current-boundary-runner.ts');
const roots: string[] = [];

interface BoundaryResult {
  deliveries: number;
  convergenceRuns: number;
  deliveredExact: boolean;
  markerExists: boolean;
  markerText: string | null;
  commandExitCode: number;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runBoundary(scenario: 'failed' | 'route-upgrade' | 'repaired-current' | 'exit-handoff'): {
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

describe('updateCommand current-version repair boundary', () => {
  test('failed repair exits before selected-target delivery and preserves the real legacy marker', () => {
    const { exitCode, result } = runBoundary('failed');
    expect(exitCode).toBe(1);
    expect(result.commandExitCode).toBe(1);
    expect(result.deliveries).toBe(0);
    expect(result.convergenceRuns).toBe(0);
    expect(result.markerExists).toBe(true);
    expect(result.markerText).toBe('prior-marker\n');
  });

  test('channel advance feeds the exact pinned manifest into ordinary selected-target delivery', () => {
    const { exitCode, result } = runBoundary('route-upgrade');
    expect(exitCode).toBe(0);
    expect(result.commandExitCode).toBe(0);
    expect(result.deliveries).toBe(1);
    expect(result.deliveredExact).toBe(true);
    expect(result.convergenceRuns).toBe(0);
  });

  for (const directive of ['repaired-current', 'exit-handoff'] as const) {
    test(`${directive} retires the real legacy marker without entering convergence or selected-target delivery`, () => {
      const { exitCode, result } = runBoundary(directive);
      const expectedExit = directive === 'exit-handoff' ? 2 : 0;
      expect(exitCode).toBe(expectedExit);
      expect(result.commandExitCode).toBe(expectedExit);
      expect(result.deliveries).toBe(0);
      expect(result.convergenceRuns).toBe(0);
      expect(result.markerExists).toBe(false);
      expect(result.markerText).toBeNull();
    });
  }
});
