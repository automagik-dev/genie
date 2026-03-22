import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpecReport } from './qa-runner.js';
import { formatTimeAgo, isStale, listAllSpecs, loadResults, saveResult, specKeyFromPath } from './qa-state.js';

describe('qa-state', () => {
  let testDir: string;
  let genieHome: string;
  let origGenieHome: string | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'genie-qa-state-'));
    genieHome = join(testDir, '.genie-home');
    await mkdir(genieHome, { recursive: true });
    origGenieHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = genieHome;
  });

  afterEach(async () => {
    process.env.GENIE_HOME = origGenieHome;
    await rm(testDir, { recursive: true, force: true });
  });

  function makeReport(overrides: Partial<SpecReport> = {}): SpecReport {
    return {
      name: 'test-spec',
      file: join(testDir, 'spec.md'),
      result: 'pass',
      expectations: [{ description: 'it works', result: 'pass' }],
      collectedEvents: [],
      durationMs: 100,
      ...overrides,
    };
  }

  // ============================================================================
  // loadResults
  // ============================================================================

  describe('loadResults', () => {
    test('returns empty object when no results exist', async () => {
      const results = await loadResults('/some/repo');
      expect(results).toEqual({});
    });

    test('returns saved results', async () => {
      const repoPath = join(testDir, 'repo');
      const specFile = join(testDir, 'spec.md');
      await writeFile(specFile, '# Test Spec');

      await saveResult(repoPath, 'messaging/round-trip', makeReport({ file: specFile }));

      const results = await loadResults(repoPath);
      expect(results['messaging/round-trip']).toBeDefined();
      expect(results['messaging/round-trip'].result).toBe('pass');
      expect(results['messaging/round-trip'].durationMs).toBe(100);
    });
  });

  // ============================================================================
  // saveResult
  // ============================================================================

  describe('saveResult', () => {
    test('saves result under GENIE_HOME/qa/{repo-hash}/results.json', async () => {
      const repoPath = join(testDir, 'repo');
      const specFile = join(testDir, 'spec.md');
      await writeFile(specFile, '# Test Spec');

      await saveResult(repoPath, 'basic/test', makeReport({ file: specFile }));

      const results = await loadResults(repoPath);
      expect(results['basic/test']).toBeDefined();
      expect(results['basic/test'].result).toBe('pass');
      expect(results['basic/test'].expectations).toHaveLength(1);
    });

    test('merges multiple results into same file', async () => {
      const repoPath = join(testDir, 'repo');
      const specFile = join(testDir, 'spec.md');
      await writeFile(specFile, '# Test Spec');

      await saveResult(repoPath, 'spec-a', makeReport({ file: specFile }));
      await saveResult(repoPath, 'spec-b', makeReport({ file: specFile, result: 'fail' }));

      const results = await loadResults(repoPath);
      expect(results['spec-a'].result).toBe('pass');
      expect(results['spec-b'].result).toBe('fail');
    });
  });

  // ============================================================================
  // isStale
  // ============================================================================

  describe('isStale', () => {
    test('returns false when spec has not changed since last run', async () => {
      const repoPath = join(testDir, 'repo');
      const specFile = join(testDir, 'spec.md');
      await writeFile(specFile, '# Unchanged Spec');

      await saveResult(repoPath, 'basic/test', makeReport({ file: specFile }));

      const stale = await isStale(repoPath, 'basic/test', specFile);
      expect(stale).toBe(false);
    });

    test('returns true when spec file was modified', async () => {
      const repoPath = join(testDir, 'repo');
      const specFile = join(testDir, 'spec.md');
      await writeFile(specFile, '# Original');

      await saveResult(repoPath, 'basic/test', makeReport({ file: specFile }));

      // Modify the spec file
      await writeFile(specFile, '# Modified content');

      const stale = await isStale(repoPath, 'basic/test', specFile);
      expect(stale).toBe(true);
    });

    test('returns false when spec was never run (no stored result)', async () => {
      const repoPath = join(testDir, 'repo');
      const specFile = join(testDir, 'spec.md');
      await writeFile(specFile, '# New spec');

      const stale = await isStale(repoPath, 'never-run', specFile);
      expect(stale).toBe(false);
    });
  });

  // ============================================================================
  // listAllSpecs
  // ============================================================================

  describe('listAllSpecs', () => {
    test('discovers specs recursively in subdirectories (domains)', async () => {
      const specDir = join(testDir, 'specs');
      await mkdir(join(specDir, 'messaging'), { recursive: true });
      await mkdir(join(specDir, 'auth'), { recursive: true });

      await writeFile(join(specDir, 'messaging', 'round-trip.md'), '# Round Trip');
      await writeFile(join(specDir, 'auth', 'login.md'), '# Login');
      await writeFile(join(specDir, 'basic.md'), '# Basic');

      const specs = await listAllSpecs(specDir);
      expect(specs).toHaveLength(3);

      const keys = specs.map((s) => s.key);
      expect(keys).toContain('messaging/round-trip');
      expect(keys).toContain('auth/login');
      expect(keys).toContain('basic');
    });

    test('ignores non-.md files', async () => {
      const specDir = join(testDir, 'specs');
      await mkdir(specDir, { recursive: true });

      await writeFile(join(specDir, 'valid.md'), '# Valid');
      await writeFile(join(specDir, 'ignore.txt'), 'not a spec');
      await writeFile(join(specDir, 'ignore.json'), '{}');

      const specs = await listAllSpecs(specDir);
      expect(specs).toHaveLength(1);
      expect(specs[0].key).toBe('valid');
    });

    test('sorts by domain then name', async () => {
      const specDir = join(testDir, 'specs');
      await mkdir(join(specDir, 'z-domain'), { recursive: true });
      await mkdir(join(specDir, 'a-domain'), { recursive: true });

      await writeFile(join(specDir, 'z-domain', 'beta.md'), '# Beta');
      await writeFile(join(specDir, 'a-domain', 'alpha.md'), '# Alpha');
      await writeFile(join(specDir, 'z-domain', 'alpha.md'), '# Alpha');

      const specs = await listAllSpecs(specDir);
      expect(specs[0].key).toBe('a-domain/alpha');
      expect(specs[1].key).toBe('z-domain/alpha');
      expect(specs[2].key).toBe('z-domain/beta');
    });

    test('assigns (root) domain for top-level specs', async () => {
      const specDir = join(testDir, 'specs');
      await mkdir(specDir, { recursive: true });
      await writeFile(join(specDir, 'top-level.md'), '# Top');

      const specs = await listAllSpecs(specDir);
      expect(specs[0].domain).toBe('(root)');
    });
  });

  // ============================================================================
  // specKeyFromPath
  // ============================================================================

  describe('specKeyFromPath', () => {
    test('generates correct relative key', () => {
      const specDir = '/repo/.genie/qa';
      const filePath = '/repo/.genie/qa/messaging/round-trip.md';
      expect(specKeyFromPath(specDir, filePath)).toBe('messaging/round-trip');
    });

    test('handles root-level specs', () => {
      const specDir = '/repo/.genie/qa';
      const filePath = '/repo/.genie/qa/basic.md';
      expect(specKeyFromPath(specDir, filePath)).toBe('basic');
    });

    test('handles deeply nested specs', () => {
      const specDir = '/repo/.genie/qa';
      const filePath = '/repo/.genie/qa/a/b/c/deep.md';
      expect(specKeyFromPath(specDir, filePath)).toBe('a/b/c/deep');
    });
  });

  // ============================================================================
  // formatTimeAgo
  // ============================================================================

  describe('formatTimeAgo', () => {
    test('formats seconds', () => {
      const date = new Date(Date.now() - 30 * 1000).toISOString();
      expect(formatTimeAgo(date)).toBe('30s ago');
    });

    test('formats minutes', () => {
      const date = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(formatTimeAgo(date)).toBe('5m ago');
    });

    test('formats hours', () => {
      const date = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      expect(formatTimeAgo(date)).toBe('3h ago');
    });

    test('formats days', () => {
      const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatTimeAgo(date)).toBe('2d ago');
    });
  });

  // ============================================================================
  // Repo hash isolation
  // ============================================================================

  describe('repo hash isolation', () => {
    test('different repos get different result storage', async () => {
      const repoA = join(testDir, 'repo-a');
      const repoB = join(testDir, 'repo-b');
      const specFile = join(testDir, 'spec.md');
      await writeFile(specFile, '# Test');

      await saveResult(repoA, 'test', makeReport({ file: specFile }));
      await saveResult(repoB, 'test', makeReport({ file: specFile, result: 'fail' }));

      const resultsA = await loadResults(repoA);
      const resultsB = await loadResults(repoB);

      expect(resultsA.test.result).toBe('pass');
      expect(resultsB.test.result).toBe('fail');
    });

    test('saving result in repo A does not appear in repo B', async () => {
      const repoA = join(testDir, 'repo-alpha');
      const repoB = join(testDir, 'repo-beta');
      const specFile = join(testDir, 'spec.md');
      await writeFile(specFile, '# Test');

      await saveResult(repoA, 'messaging/chat', makeReport({ file: specFile }));

      const resultsB = await loadResults(repoB);
      expect(resultsB).toEqual({});
    });

    test('listAllSpecs returns only specs from its own specDir', async () => {
      const repoA = join(testDir, 'repo-a');
      const repoB = join(testDir, 'repo-b');
      const specDirA = join(repoA, '.genie', 'qa');
      const specDirB = join(repoB, '.genie', 'qa');
      await mkdir(join(specDirA, 'auth'), { recursive: true });
      await mkdir(join(specDirB, 'messaging'), { recursive: true });

      await writeFile(join(specDirA, 'auth', 'login.md'), '# Login');
      await writeFile(join(specDirA, 'health.md'), '# Health');
      await writeFile(join(specDirB, 'messaging', 'round-trip.md'), '# Round Trip');

      const specsA = await listAllSpecs(specDirA);
      const specsB = await listAllSpecs(specDirB);

      expect(specsA).toHaveLength(2);
      expect(specsA.map((s) => s.key).sort()).toEqual(['auth/login', 'health']);

      expect(specsB).toHaveLength(1);
      expect(specsB[0].key).toBe('messaging/round-trip');
    });

    test('isStale in repo B is not affected by spec changes in repo A', async () => {
      const repoA = join(testDir, 'repo-a');
      const repoB = join(testDir, 'repo-b');
      const specFileA = join(testDir, 'spec-a.md');
      const specFileB = join(testDir, 'spec-b.md');
      await writeFile(specFileA, '# Spec A original');
      await writeFile(specFileB, '# Spec B original');

      await saveResult(repoA, 'test', makeReport({ file: specFileA }));
      await saveResult(repoB, 'test', makeReport({ file: specFileB }));

      // Modify spec in repo A
      await writeFile(specFileA, '# Spec A modified');

      // repo A should be stale, repo B should not
      expect(await isStale(repoA, 'test', specFileA)).toBe(true);
      expect(await isStale(repoB, 'test', specFileB)).toBe(false);
    });
  });
});
