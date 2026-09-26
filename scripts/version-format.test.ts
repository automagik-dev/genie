import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { synchronizeVersionFiles, updateJsonVersion, versionCheckReport } from './version.ts';

const PLUGIN_VERSION_FILES = ['plugins/genie/orca-plugin.json', 'plugins/genie/package.json'];

describe('manifest version formatting', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { path: string; original: string } {
    const root = mkdtempSync(join(tmpdir(), 'genie-version-format-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    const original = [
      '{',
      '  "name": "genie",',
      '  "version": "5.260710.14",',
      '  "keywords": ["workflow", "codex", "skills"],',
      '  "interface": {',
      '    "capabilities": ["Skills", "Hooks", "MCP"]',
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(path, original);
    return { path, original };
  }

  function writeJsonAt(root: string, relativePath: string, value: unknown): void {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  function synchronizationFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'genie-version-sync-'));
    roots.push(root);
    for (const path of ['package.json', ...PLUGIN_VERSION_FILES]) {
      writeJsonAt(root, path, { name: 'genie', version: '5.000000.0' });
    }
    return root;
  }

  test('version.ts changes only the version token', async () => {
    const { path, original } = fixture();
    await updateJsonVersion(path, '5.260711.1');
    expect(readFileSync(path, 'utf8')).toBe(original.replace('5.260710.14', '5.260711.1'));
  });

  test('version stampers target the top-level key when a nested version appears first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-version-nested-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    const original = '{\n  "metadata": { "version": "nested" },\n  "version": "5.0.0"\n}\n';

    writeFileSync(path, original);
    await updateJsonVersion(path, '5.260711.7');
    expect(readFileSync(path, 'utf8')).toBe(original.replace('"5.0.0"', '"5.260711.7"'));
    expect(JSON.parse(readFileSync(path, 'utf8')).metadata.version).toBe('nested');
  });

  test('--check reports exactly the three stamped version files and writes nothing', async () => {
    const root = synchronizationFixture();
    const before = ['package.json', 'plugins/genie/orca-plugin.json', 'plugins/genie/package.json'].map((path) =>
      readFileSync(join(root, path), 'utf8'),
    );
    const report = await versionCheckReport(root);
    expect(report.targets).toEqual([
      join(root, 'package.json'),
      join(root, 'plugins/genie/orca-plugin.json'),
      join(root, 'plugins/genie/package.json'),
    ]);
    expect(report.failures).toEqual([]);
    const after = ['package.json', 'plugins/genie/orca-plugin.json', 'plugins/genie/package.json'].map((path) =>
      readFileSync(join(root, path), 'utf8'),
    );
    expect(after).toEqual(before);
  });

  test('--check reports a malformed or missing target instead of rewriting it', async () => {
    const root = synchronizationFixture();
    writeFileSync(join(root, 'plugins/genie/orca-plugin.json'), '{"name":"genie"}\n');
    rmSync(join(root, 'package.json'));
    const report = await versionCheckReport(root);
    expect(report.targets).toHaveLength(3);
    expect(report.failures).toHaveLength(2);
    expect(report.failures.join('\n')).toContain('top-level version must be a string');
    expect(report.failures.join('\n')).toContain('file is missing');
  });

  // Wish `retire-orca-integration` deletes the plugin files; absent ones are skipped, not failures.
  test('--check skips absent plugin version files and still requires package.json', async () => {
    const root = synchronizationFixture();
    for (const path of PLUGIN_VERSION_FILES) rmSync(join(root, path));
    const report = await versionCheckReport(root);
    expect(report.targets).toEqual([join(root, 'package.json')]);
    expect(report.failures).toEqual([]);

    writeJsonAt(root, 'plugins/genie/package.json', { name: 'genie-plugin', version: '5.000000.0' });
    expect((await versionCheckReport(root)).targets).toEqual([
      join(root, 'package.json'),
      join(root, 'plugins/genie/package.json'),
    ]);
  });

  test('--check fails a dangling plugin symlink instead of skipping it, like version.yml', async () => {
    const root = synchronizationFixture();
    rmSync(join(root, 'plugins/genie/orca-plugin.json'));
    symlinkSync(join(root, 'nowhere.json'), join(root, 'plugins/genie/orca-plugin.json'));
    const report = await versionCheckReport(root);
    expect(report.targets).toContain(join(root, 'plugins/genie/orca-plugin.json'));
    expect(report.failures.join('\n')).toContain('file is missing');
  });

  test('synchronization updates every required file or rejects the run', async () => {
    // This fixture root is deliberately not a git repo — it exercises JSON
    // rewrite correctness, not CI staging. synchronizeVersionFiles only attempts
    // `git add` (and now fails hard on error — see version-ci-staging.test.ts)
    // under GITHUB_ACTIONS=true, which the real CI runner always sets; clear it
    // for the duration of this test so it stays about rewrite correctness.
    const savedGithubActions = process.env.GITHUB_ACTIONS;
    Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');
    try {
      const root = synchronizationFixture();
      await synchronizeVersionFiles(root, '5.260711.3');
      // Every remaining manifest carries the same release version.
      expect(JSON.parse(readFileSync(join(root, 'plugins/genie/package.json'), 'utf8')).version).toBe('5.260711.3');
      expect(JSON.parse(readFileSync(join(root, 'plugins/genie/orca-plugin.json'), 'utf8')).version).toBe('5.260711.3');

      rmSync(join(root, 'package.json'));
      await expect(synchronizeVersionFiles(root, '5.260711.4')).rejects.toThrow(
        'version synchronization preflight failed',
      );
      expect(JSON.parse(readFileSync(join(root, 'plugins/genie/package.json'), 'utf8')).version).toBe('5.260711.3');
    } finally {
      if (savedGithubActions === undefined) Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');
      else process.env.GITHUB_ACTIONS = savedGithubActions;
    }
  });

  test('synchronization bumps package.json alone when the plugin files are absent', async () => {
    const savedGithubActions = process.env.GITHUB_ACTIONS;
    Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');
    try {
      const root = synchronizationFixture();
      for (const path of PLUGIN_VERSION_FILES) rmSync(join(root, path));
      await synchronizeVersionFiles(root, '5.260711.5');
      expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('5.260711.5');
      for (const path of PLUGIN_VERSION_FILES) expect(existsSync(join(root, path))).toBe(false);
    } finally {
      if (savedGithubActions === undefined) Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');
      else process.env.GITHUB_ACTIONS = savedGithubActions;
    }
  });

  test('synchronization rejects malformed required metadata', async () => {
    const root = synchronizationFixture();
    writeFileSync(join(root, 'plugins/genie/orca-plugin.json'), '{"name":"genie"}\n');
    await expect(synchronizeVersionFiles(root, '5.260711.4')).rejects.toThrow(
      'version synchronization preflight failed',
    );
  });
});
