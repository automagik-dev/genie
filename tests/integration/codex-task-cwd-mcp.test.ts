import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDogfoodFixture } from '../support/codex-dogfood-fixture.js';
import { runDogfoodEntry } from '../support/codex-dogfood-harness.js';

let root: string | null = null;
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('dogfood task-CWD MCP proof', () => {
  test('two unpredictable seeded repos stay exact and untouched B has no pre-init fallback', async () => {
    root = mkdtempSync(join(tmpdir(), 'genie-dogfood-cwd-'));
    const fixture = buildDogfoodFixture(root);
    const result = await runDogfoodEntry(fixture.input, fixture.dependencies);
    const proof = result.manifest.repositories as Record<string, any>;
    const a = proof.a;
    const b = proof.b as Record<string, any>;
    expect(a.requestedCwd).toBe(a.root);
    expect(a.effectiveCwd).toBe(a.root);
    expect(a.sentinel.observed).toEqual(a.sentinel.expected);
    expect(a.sentinel.boardCount).toBe(1);
    expect(b.beforeInit).toEqual({
      routeState: 'absent',
      fallbackUsed: false,
      result: 'project-database-unavailable',
      returnedTasks: 0,
    });
    expect(b.afterInit.routeState).toBe('managed-project');
    expect(b.afterInit.requestedCwd).toBe(b.root);
    expect(b.afterInit.effectiveCwd).toBe(b.root);
    expect(b.afterInit.sentinel.observed).toEqual(b.afterInit.sentinel.expected);
    expect(a.sentinel.token).not.toBe(b.afterInit.sentinel.token);
    expect(a.childPid).not.toBe(b.afterInit.childPid);
    expect(a.effectiveCwd).not.toContain(proof.cacheRoot);
    expect(b.afterInit.effectiveCwd).not.toContain(proof.cacheRoot);
  }, 60_000);
});
