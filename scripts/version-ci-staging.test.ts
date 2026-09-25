import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { synchronizeVersionFiles } from './version.ts';

/**
 * D2: `synchronizeVersionFiles` owns the version-carrying file list, so it must
 * `git add` every file it rewrote when running in CI — otherwise the release
 * workflow's own (stale) `git add` list re-guesses the set and ships a bump
 * with a stale manifest.
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
    for (const path of ['package.json', 'plugins/genie/orca-plugin.json', 'plugins/genie/package.json']) {
      writeJson(path, { name: 'genie', version: '5.000000.0' });
    }
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

  test('stages every rewritten manifest when GITHUB_ACTIONS=true', async () => {
    const root = versionFixture();
    initGitRepo(root);
    process.env.GITHUB_ACTIONS = 'true';

    await synchronizeVersionFiles(root, '5.260713.3');

    const staged = stagedPaths(root);
    expect(staged).toContain('plugins/genie/package.json');
    expect(staged).toContain('plugins/genie/orca-plugin.json');
    expect(staged).toContain('package.json');
    // The rewritten value is actually on disk (staging did not mask a no-op).
    expect(JSON.parse(readFileSync(join(root, 'plugins/genie/package.json'), 'utf8')).version).toBe('5.260713.3');
  });

  test('stages package.json alone when the plugin version files are absent', async () => {
    const root = versionFixture();
    rmSync(join(root, 'plugins'), { recursive: true });
    initGitRepo(root);
    process.env.GITHUB_ACTIONS = 'true';

    await synchronizeVersionFiles(root, '5.260713.6');

    expect(stagedPaths(root)).toEqual(['package.json']);
  });

  test('stages nothing when GITHUB_ACTIONS is unset', async () => {
    const root = versionFixture();
    initGitRepo(root);
    Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');

    await synchronizeVersionFiles(root, '5.260713.4');

    expect(stagedPaths(root)).toEqual([]);
    // Files were still rewritten locally — only the staging is CI-gated.
    expect(JSON.parse(readFileSync(join(root, 'plugins/genie/package.json'), 'utf8')).version).toBe('5.260713.4');
  });

  test('fails the sync when git add fails (not a git repo)', async () => {
    const root = versionFixture(); // deliberately NOT a git repo
    process.env.GITHUB_ACTIONS = 'true';

    // A CI staging failure must fail the sync — silently continuing would
    // re-introduce the version-skew defect this staging exists to prevent (the
    // workflow's own `git add` list is stale and would ship a bump with a stale
    // manifest).
    await expect(synchronizeVersionFiles(root, '5.260713.5')).rejects.toThrow(/CI staging failed/);
    // The version files are still fully rewritten on disk before staging ran —
    // only the staging (and therefore the auto-version commit) is blocked.
    expect(JSON.parse(readFileSync(join(root, 'plugins/genie/package.json'), 'utf8')).version).toBe('5.260713.5');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('5.260713.5');
  });
});

/**
 * The version.yml bump step, executed as written: it bumps `package.json` plus
 * each `plugins/genie/*` version file that exists, and stages exactly that set.
 */
describe('version.yml version-field synchronization step', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function syncStepScript(): string {
    const workflow = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'version.yml'), 'utf8');
    const lines = workflow.split('\n');
    const start = lines.findIndex((line) => line.trim() === '- name: Synchronize the present version fields');
    if (start < 0) throw new Error('version.yml synchronization step not found');
    const run = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
    const body: string[] = [];
    for (const line of lines.slice(run + 1)) {
      if (line.trim() !== '' && !line.startsWith('          ')) break;
      body.push(line.slice(10));
    }
    return body.join('\n');
  }

  function repo(files: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'genie-version-yml-'));
    roots.push(root);
    for (const path of files) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), `${JSON.stringify({ name: 'genie', version: '6.000000.0' }, null, 2)}\n`);
    }
    const opts = { cwd: root, stdio: 'pipe' as const };
    execFileSync('git', ['init', '-q'], opts);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], opts);
    execFileSync('git', ['config', 'user.name', 'Test'], opts);
    execFileSync('git', ['add', '-A'], opts);
    execFileSync('git', ['commit', '-q', '-m', 'initial'], opts);
    return root;
  }

  function runStep(root: string) {
    return Bun.spawnSync(['bash', '-c', syncStepScript()], {
      cwd: root,
      env: { ...process.env, VERSION: '6.260925.1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  function staged(root: string): string[] {
    return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean);
  }

  const ALL = ['package.json', 'plugins/genie/orca-plugin.json', 'plugins/genie/package.json'];

  test('bumps and stages all three files while the plugin files exist', () => {
    const root = repo(ALL);
    const result = runStep(root);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(staged(root)).toEqual(ALL);
    for (const path of ALL) expect(JSON.parse(readFileSync(join(root, path), 'utf8')).version).toBe('6.260925.1');
  });

  test('bumps and stages package.json alone when the plugin files are absent', () => {
    const root = repo(['package.json']);
    const result = runStep(root);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(staged(root)).toEqual(['package.json']);
  });

  test('bumps a lone remaining plugin file and still rejects a symlinked one', () => {
    const root = repo(['package.json', 'plugins/genie/package.json']);
    expect(runStep(root).exitCode).toBe(0);
    expect(staged(root)).toEqual(['package.json', 'plugins/genie/package.json']);

    const linked = repo(['package.json', 'other.json']);
    mkdirSync(join(linked, 'plugins/genie'), { recursive: true });
    symlinkSync('../../other.json', join(linked, 'plugins/genie/orca-plugin.json'));
    const result = runStep(linked);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('release-version.invalid_path plugins/genie/orca-plugin.json');
  });
});
