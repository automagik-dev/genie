/**
 * Ground truth built from real commits, in real temporary git repositories — never a
 * mocked git, because what is being pinned here IS git's behaviour: what
 * `--name-only` prints for a rename, what a merge commit's combined diff looks like,
 * and which paths a later deletion removes from HEAD.
 *
 * No model, no provider, no `mikro` runtime: this half of the loop is deterministic
 * by construction, which is the point of Decision 12.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadFixtureSet } from './bench';
import {
  FixturesUsageError,
  buildCommitFixtures,
  commitPrompt,
  fixtureSetDocument,
  rangeError,
  runFixturesCli,
} from './fixtures-from-commits';

const trash: string[] = [];
afterEach(() => {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  const probe = Bun.spawnSync(['git', '-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (probe.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${probe.stderr.toString()}`);
  return probe.stdout.toString().trim();
}

function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

function commit(root: string, subject: string): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', subject]);
}

/**
 * A repository with the five shapes that matter: a root commit, an ordinary commit,
 * a rename, a commit whose file is deleted later, and a merge.
 */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'mikro-fixtures-'));
  trash.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'src/a.ts', 'export const a = 1;\n');
  commit(root, 'feat: add a');
  write(root, 'src/b.ts', 'export const b = 2;\n');
  write(root, 'src/a.ts', 'export const a = 11;\n');
  commit(root, 'feat: add b and bump a');
  return root;
}

describe('buildCommitFixtures', () => {
  test('truth.files equals git show --name-only, oldest first, with the commit subject as the intent', () => {
    const root = repo();
    const { fixtures, skipped } = buildCommitFixtures({ dir: root, range: 'HEAD~1..HEAD', agent: 'wish-context' });
    expect(skipped).toEqual([]);
    expect(fixtures).toHaveLength(1);
    const head = git(root, ['rev-parse', 'HEAD']);
    expect(fixtures[0].id).toBe(head.slice(0, 12));
    expect(fixtures[0].prompt).toBe('Intent: feat: add b and bump a');
    // …and this is literally what git prints for that commit.
    const shown = git(root, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort();
    expect(fixtures[0].truth.files).toEqual(shown);
    expect(fixtures[0].truth.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('a rename contributes the NEW path, which is the path the tree has', () => {
    const root = repo();
    git(root, ['mv', 'src/b.ts', 'src/renamed.ts']);
    commit(root, 'refactor: rename b');
    const { fixtures } = buildCommitFixtures({ dir: root, range: 'HEAD~1..HEAD', agent: 'wish-context' });
    expect(fixtures[0].truth.files).toEqual(['src/renamed.ts']);
  });

  test('a commit whose file was deleted later is skipped with the reason', () => {
    const root = repo();
    write(root, 'src/doomed.ts', 'export const d = 3;\n');
    commit(root, 'feat: add doomed');
    rmSync(join(root, 'src/doomed.ts'));
    commit(root, 'chore: remove doomed');
    const { fixtures, skipped } = buildCommitFixtures({ dir: root, range: 'HEAD~2..HEAD', agent: 'wish-context' });
    // Both the adding commit and the removing one name a path HEAD no longer carries.
    expect(fixtures).toHaveLength(0);
    expect(skipped).toHaveLength(2);
    for (const skip of skipped) expect(skip.reason).toContain('no longer exists at HEAD');
  });

  test('a merge commit is skipped, and review-prep also skips the root commit', () => {
    const root = repo();
    git(root, ['checkout', '-q', '-b', 'side', 'HEAD~1']);
    write(root, 'src/side.ts', 'export const s = 4;\n');
    commit(root, 'feat: side');
    git(root, ['checkout', '-q', 'main']);
    git(root, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);

    const all = buildCommitFixtures({ dir: root, range: 'HEAD', agent: 'wish-context' });
    expect(all.skipped.some((s) => s.reason.startsWith('merge commit'))).toBe(true);
    expect(all.fixtures.map((f) => f.prompt)).not.toContain('Intent: merge side');

    // Every commit in the repository, for review-prep: the root commit has no parent.
    const fromRoot = buildCommitFixtures({ dir: root, range: 'HEAD', agent: 'review-prep' });
    expect(fromRoot.skipped.some((s) => s.reason.startsWith('root commit'))).toBe(true);
    const first = fromRoot.fixtures[0];
    expect(first.prompt).toBe(`Prepare the review of commit ${first.id} against ${first.id}^`);
  });

  test('--max stops at n fixtures, oldest first', () => {
    const root = repo();
    write(root, 'src/c.ts', 'export const c = 3;\n');
    commit(root, 'feat: add c');
    const all = buildCommitFixtures({ dir: root, range: 'HEAD', agent: 'wish-context' });
    const capped = buildCommitFixtures({ dir: root, range: 'HEAD', agent: 'wish-context', max: 2 });
    expect(all.fixtures).toHaveLength(3);
    expect(capped.fixtures).toHaveLength(2);
    expect(capped.fixtures).toEqual(all.fixtures.slice(0, 2));
  });

  test('a range that is not a range, and one that could be an option, are refused', () => {
    const root = repo();
    expect(rangeError('--exec=rm -rf /')).toContain('never an option');
    expect(rangeError('  ')).toContain('required');
    expect(rangeError('HEAD~2..HEAD')).toBeNull();
    expect(() => buildCommitFixtures({ dir: root, range: '-x', agent: 'wish-context' })).toThrow(FixturesUsageError);
    expect(() => buildCommitFixtures({ dir: root, range: 'no-such-ref..HEAD', agent: 'wish-context' })).toThrow(
      FixturesUsageError,
    );
    expect(() => buildCommitFixtures({ dir: root, range: 'HEAD', agent: 'wish-context', max: 0 })).toThrow(
      FixturesUsageError,
    );
  });

  test('the same argv builds the same bytes twice — no timestamp, no host path', () => {
    const root = repo();
    const once = fixtureSetDocument({
      agent: 'wish-context',
      range: 'HEAD',
      fixtures: buildCommitFixtures({ dir: root, range: 'HEAD', agent: 'wish-context' }).fixtures,
    });
    const twice = fixtureSetDocument({
      agent: 'wish-context',
      range: 'HEAD',
      fixtures: buildCommitFixtures({ dir: root, range: 'HEAD', agent: 'wish-context' }).fixtures,
    });
    expect(twice).toBe(once);
    expect(once).not.toContain(root);
    expect(once).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('commitPrompt is the one place the two recipes live', () => {
    expect(commitPrompt('wish-context', 'abc123', 'fix: thing')).toBe('Intent: fix: thing');
    expect(commitPrompt('review-prep', 'abc123', 'fix: thing')).toBe(
      'Prepare the review of commit abc123 against abc123^',
    );
  });
});

describe('runFixturesCli', () => {
  test('writes the default path, refuses to overwrite it, and yields a set bench.ts can load', () => {
    const root = repo();
    const out = join(root, '.mikro', 'fixtures', 'wish-context.json');
    expect(runFixturesCli(['--from-commits', 'HEAD', '--agent', 'wish-context', '--dir', root])).toBe(0);

    // The proof that matters: the file goes through the bench's OWN loader, not a second
    // copy of the shape, and every fixture carries what `runBenchCli` reads off it.
    const loaded = loadFixtureSet(out);
    expect(loaded.fixtures).toHaveLength(2);
    for (const fixture of loaded.fixtures) {
      expect(typeof fixture.id).toBe('string');
      expect(fixture.prompt).toStartWith('Intent: ');
      expect(Array.isArray(fixture.truth.files)).toBe(true);
    }
    const document = JSON.parse(readFileSync(out, 'utf8')) as { agent: string; notes: string };
    expect(document.agent).toBe('wish-context');
    expect(document.notes).toContain('git show --name-only');

    // A second run refuses rather than replacing what an operator may have edited…
    const before = readFileSync(out, 'utf8');
    expect(runFixturesCli(['--from-commits', 'HEAD', '--agent', 'wish-context', '--dir', root])).toBe(2);
    expect(readFileSync(out, 'utf8')).toBe(before);
    // …and --force is the way through, which is byte-identical here.
    expect(runFixturesCli(['--from-commits', 'HEAD', '--agent', 'wish-context', '--dir', root, '--force'])).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(before);
  });

  test('a range that states no fixture writes nothing and exits 1', () => {
    const root = repo();
    const out = join(root, 'out.json');
    expect(
      runFixturesCli(['--from-commits', 'HEAD..HEAD', '--agent', 'wish-context', '--dir', root, '--out', out]),
    ).toBe(1);
    expect(() => readFileSync(out, 'utf8')).toThrow();
  });

  test('a missing or unregistered --agent is a usage refusal', () => {
    const root = repo();
    expect(runFixturesCli(['--from-commits', 'HEAD', '--dir', root])).toBe(2);
    expect(runFixturesCli(['--from-commits', 'HEAD', '--agent', 'issue-triage', '--dir', root])).toBe(2);
    expect(runFixturesCli(['--agent', 'wish-context', '--dir', root])).toBe(2);
  });
});
