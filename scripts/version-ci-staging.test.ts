import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { synchronizeVersionFiles } from './version.ts';

/**
 * D2: `synchronizeVersionFiles` owns the version-carrying file list, so it must
 * `git add` every file it rewrote when running in CI — otherwise the release
 * workflow's own (stale) `git add` list omits plugins/hermes-genie/plugin.yaml
 * and ships a bump with a stale Hermes manifest.
 */
describe('synchronizeVersionFiles CI staging', () => {
  const roots: string[] = [];
  const savedGithubActions = process.env.GITHUB_ACTIONS;

  afterEach(() => {
    if (savedGithubActions === undefined) Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');
    else process.env.GITHUB_ACTIONS = savedGithubActions;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function versionFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'genie-version-ci-'));
    roots.push(root);
    const writeJson = (relativePath: string, value: unknown) => {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    };
    for (const path of [
      'package.json',
      'plugins/genie/.claude-plugin/plugin.json',
      'plugins/genie/.codex-plugin/plugin.json',
      'plugins/genie/package.json',
    ]) {
      writeJson(path, { name: 'genie', version: '5.000000.0' });
    }
    writeJson('.claude-plugin/marketplace.json', { plugins: [{ name: 'genie', version: '5.000000.0' }] });
    const yamlPath = join(root, 'plugins/hermes-genie/plugin.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, 'name: genie\nversion: 5.000000.0\ndescription: "Native surface"\n');
    return root;
  }

  function initGitRepo(root: string): void {
    const opts = { cwd: root, stdio: 'pipe' as const };
    execFileSync('git', ['init', '-q'], opts);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], opts);
    execFileSync('git', ['config', 'user.name', 'Test'], opts);
    execFileSync('git', ['add', '-A'], opts);
    execFileSync('git', ['commit', '-q', '-m', 'initial'], opts);
  }

  function stagedPaths(root: string): string[] {
    return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean);
  }

  test('stages the rewritten plugin.yaml when GITHUB_ACTIONS=true', async () => {
    const root = versionFixture();
    initGitRepo(root);
    process.env.GITHUB_ACTIONS = 'true';

    await synchronizeVersionFiles(root, '5.260713.3');

    const staged = stagedPaths(root);
    expect(staged).toContain('plugins/hermes-genie/plugin.yaml');
    expect(staged).toContain('package.json');
    expect(staged).toContain('.claude-plugin/marketplace.json');
    // The rewritten value is actually on disk (staging did not mask a no-op).
    expect(readFileSync(join(root, 'plugins/hermes-genie/plugin.yaml'), 'utf8')).toContain('version: 5.260713.3');
  });

  test('stages nothing when GITHUB_ACTIONS is unset', async () => {
    const root = versionFixture();
    initGitRepo(root);
    Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');

    await synchronizeVersionFiles(root, '5.260713.4');

    expect(stagedPaths(root)).toEqual([]);
    // Files were still rewritten locally — only the staging is CI-gated.
    expect(readFileSync(join(root, 'plugins/hermes-genie/plugin.yaml'), 'utf8')).toContain('version: 5.260713.4');
  });

  test('fails the sync when git add fails (not a git repo)', async () => {
    const root = versionFixture(); // deliberately NOT a git repo
    process.env.GITHUB_ACTIONS = 'true';

    // A CI staging failure must fail the sync — silently continuing would
    // re-introduce the plugin.yaml version-skew defect this staging exists
    // to prevent (the workflow's own `git add` list is stale and would ship
    // a bump with a stale Hermes manifest).
    await expect(synchronizeVersionFiles(root, '5.260713.5')).rejects.toThrow(/CI staging failed/);
    // The version files are still fully rewritten on disk before staging ran —
    // only the staging (and therefore the auto-version commit) is blocked.
    expect(readFileSync(join(root, 'plugins/hermes-genie/plugin.yaml'), 'utf8')).toContain('version: 5.260713.5');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('5.260713.5');
  });
});
