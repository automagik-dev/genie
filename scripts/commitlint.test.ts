import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const temporary: string[] = [];
const FOREIGN_MESSAGE = 'update: BAD FOREIGN HISTORY';
function environment(repo: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: repo,
    GENIE_HOME: join(repo, '.genie'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
}
function git(repo: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd: repo, env: environment(repo), input, encoding: 'utf8' }).trim();
}
function fixture(): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), 'genie-commit-ownership-'));
  temporary.push(repo);
  mkdirSync(join(repo, 'scripts'));
  for (const name of ['commitlint.ts', 'git-history-ownership.ts'])
    copyFileSync(join(ROOT, 'scripts', name), join(repo, 'scripts', name));
  copyFileSync(join(ROOT, 'commitlint.config.ts'), join(repo, 'commitlint.config.ts'));
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.genie\n');
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Commit ownership fixture']);
  git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.hooksPath', '/dev/null']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'chore: seed tooling']);
  return { repo, base: git(repo, ['rev-parse', 'HEAD']) };
}
function commit(repo: string, tree: string, parents: string[], message: string): string {
  return git(repo, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent])], `${message}\n`);
}
function imported(
  repo: string,
  genie: string,
  options: { shared?: string; body?: string; split?: string; mismatch?: boolean; source?: string } = {},
): { foreign: string; head: string } {
  const blob = git(repo, ['hash-object', '-w', '--stdin'], 'foreign-only source\n');
  const sourceTree = git(repo, ['mktree'], `100644 blob ${blob}\tforeign.txt\n`);
  const foreign = options.source ?? commit(repo, sourceTree, options.shared ? [options.shared] : [], FOREIGN_MESSAGE);
  const foreignTree = git(repo, ['rev-parse', `${foreign}^{tree}`]);
  git(repo, ['read-tree', genie]);
  git(repo, ['read-tree', '--prefix=mikro/', options.mismatch ? `${genie}^{tree}` : foreignTree]);
  const tree = git(repo, ['write-tree']);
  const body =
    options.body ??
    `feat(mikro): import source\n\ngit-subtree-dir: mikro\ngit-subtree-split: ${options.split ?? foreign}`;
  return { foreign, head: commit(repo, tree, [genie, foreign], body.replaceAll('FOREIGN_OID', foreign)) };
}
function check(repo: string, from: string, to: string) {
  return spawnSync(process.execPath, ['scripts/commitlint.ts', '--from', from, '--to', to], {
    cwd: repo,
    env: environment(repo),
    encoding: 'utf8',
    timeout: 30_000,
  });
}
afterEach(() => {
  for (const repo of temporary.splice(0)) rmSync(repo, { recursive: true, force: true });
});

test('strict CI accepts a proven foreign import and is idempotent, but rejects an identical bad message owned by Genie', () => {
  const { repo, base } = fixture();
  const { foreign, head } = imported(repo, base);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = check(repo, base, head);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`${head}: valid`);
    expect(result.stdout).not.toContain(`${foreign}: invalid`);
  }
  const bad = commit(repo, git(repo, ['rev-parse', `${head}^{tree}`]), [head], FOREIGN_MESSAGE);
  const result = check(repo, base, bad);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${bad}: error [type-enum]`);
});

test('shared Genie ancestry remains strict even when reachable through the Mikro parent', () => {
  const { repo, base } = fixture();
  const tree = git(repo, ['rev-parse', `${base}^{tree}`]);
  const shared = commit(repo, tree, [base], 'update: BAD SHARED GENIE HISTORY');
  const genie = commit(repo, tree, [shared], 'chore: prepare import');
  const { head } = imported(repo, genie, { shared });
  const result = check(repo, base, head);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${shared}: error [type-enum]`);
});

test('foreign nested imports cannot exclude shared Genie ancestors, and ordinary Genie merges retain every parent', () => {
  const { repo, base } = fixture();
  const tree = git(repo, ['rev-parse', `${base}^{tree}`]);
  const shared = commit(repo, tree, [base], 'update: BAD SHARED GENIE HISTORY');
  const genie = commit(repo, tree, [shared], 'chore: prepare import');
  const foreignSeed = commit(repo, tree, [], FOREIGN_MESSAGE);
  const nested = imported(repo, foreignSeed, { shared });
  const outer = imported(repo, genie, { source: nested.head });
  const sharedResult = check(repo, base, outer.head);
  expect(sharedResult.status).toBe(1);
  expect(sharedResult.stderr).toContain(`${shared}: error [type-enum]`);

  const another = fixture();
  const original = imported(another.repo, another.base);
  const merged = commit(
    another.repo,
    git(another.repo, ['rev-parse', `${original.head}^{tree}`]),
    [original.head, original.foreign],
    'chore: merge external change directly',
  );
  const mergeResult = check(another.repo, another.base, merged);
  expect(mergeResult.status).toBe(1);
  expect(mergeResult.stderr).toContain(`${original.foreign}: error [type-enum]`);
});

test('the Genie import commit itself retains body-length and subject rules', () => {
  const { repo, base } = fixture();
  const { head } = imported(repo, base, {
    body: `feat(mikro): Bad Import\n\n${'long '.repeat(30)}\n\ngit-subtree-dir: mikro\ngit-subtree-split: FOREIGN_OID`,
  });
  const result = check(repo, base, head);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${head}: error [body-max-line-length]`);
  expect(result.stderr).toContain(`${head}: error [subject-case]`);
});

test('ownership fails closed for wrong parents, duplicate or noncanonical trailers, and mismatched source trees', () => {
  const cases = [
    { split: '0'.repeat(40) },
    {
      body: 'feat(mikro): import source\n\ngit-subtree-dir: mikro\ngit-subtree-dir: mikro\ngit-subtree-split: FOREIGN_OID',
    },
    { body: 'feat(mikro): import source\n\ngit-subtree-dir: mikro/subdir\ngit-subtree-split: FOREIGN_OID' },
    { mismatch: true },
  ];
  for (const options of cases) {
    const { repo, base } = fixture();
    const { head } = imported(repo, base, options);
    const result = check(repo, base, head);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      options.mismatch ? 'tree does not match its source' : 'invalid Mikro subtree import metadata',
    );
  }
});

test('unrelated archived imports cannot authorize excluding a bad commit on the checked branch', () => {
  const { repo, base } = fixture();
  const { foreign, head } = imported(repo, base);
  git(repo, ['update-ref', 'refs/heads/archive', head]);
  const ordinaryMerge = commit(
    repo,
    git(repo, ['rev-parse', `${base}^{tree}`]),
    [base, foreign],
    'chore: merge external change',
  );
  const result = check(repo, base, ordinaryMerge);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${foreign}: error [type-enum]`);
});

test('shallow history and invalid or unavailable commit refs refuse ownership instead of silently passing', () => {
  const { repo, base } = fixture();
  const { head } = imported(repo, base);
  git(repo, ['update-ref', 'refs/heads/main', head]);
  const shallow = mkdtempSync(join(tmpdir(), 'genie-commit-shallow-'));
  temporary.push(shallow);
  git(shallow, ['clone', '-q', '--depth=1', `file://${repo}`, '.']);
  symlinkSync(join(ROOT, 'node_modules'), join(shallow, 'node_modules'), 'dir');
  const refused = check(shallow, head, head);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('refusing incomplete commit ownership on a shallow clone');
  const invalid = check(repo, 'HEAD', head);
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).toContain('usage:');
  const absent = check(repo, '0'.repeat(40), head);
  expect(absent.status).toBe(1);
  expect(absent.stderr).toContain('Not a valid object name');
});
