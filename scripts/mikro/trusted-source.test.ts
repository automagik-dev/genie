/**
 * The trusted source, on real git repositories: which ref is trusted, what a
 * materialized agent is proven to be, and that nothing survives the run on disk.
 *
 * Every repository here is built with `git update-ref` / `git symbolic-ref` rather than
 * a clone, so `origin/HEAD` exists without a network and the base branch is chosen by
 * the test rather than by whatever the host's git defaults to.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MIKRO_CONFIG_FILES,
  materializeAgent,
  readTrustedBlob,
  refFormatError,
  resolveTrustedRef,
} from './trusted-source';

const trash: string[] = [];
afterAll(() => {
  for (const dir of trash) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

function git(root: string, args: string[]): string {
  const probe = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (probe.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${probe.stderr.toString()}`);
  return probe.stdout.toString().trim();
}

function commit(root: string, message: string): void {
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message]);
}

/** A repository on branch `main` with an `origin/HEAD` that points at it. */
function repoWithBase(prefix: string, system: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  trash.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, '.mikro/agents/wish-context/agent.yaml', 'model: deepseek-api/deepseek-flash\nsystem: SYSTEM.md\n');
  write(root, '.mikro/agents/wish-context/SYSTEM.md', system);
  commit(root, 'seed');
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return root;
}

describe('refFormatError', () => {
  test('a leading dash is refused before git sees the token', () => {
    expect(refFormatError('-evil')).toContain('may not start with');
    expect(refFormatError('--upload-pack=touch /tmp/pwned')).toContain('may not start with');
  });

  test('the ref-name grammar is git’s, not ours', () => {
    expect(refFormatError('origin/dev')).toBeNull();
    expect(refFormatError('dev')).toBeNull();
    expect(refFormatError('refs/remotes/origin/main')).toBeNull();
    expect(refFormatError('bad..name')).toContain('not a valid git ref name');
    expect(refFormatError('trailing.lock')).toContain('not a valid git ref name');
    expect(refFormatError('with space')).toContain('not a valid git ref name');
    expect(refFormatError('   ')).toBe('a ref is required');
  });
});

describe('resolveTrustedRef', () => {
  test('origin/HEAD names the base branch, and the local branch wins when it contains origin/<base>', () => {
    const root = repoWithBase('mikro-ref-local-', '# A\n');
    // Committed but not pushed: origin/main is still an ancestor of main, so the local
    // branch is the trusted one — the rule that makes a seeded agent usable on a
    // repository that commits straight to its base branch.
    write(root, '.mikro/agents/wish-context/SYSTEM.md', '# A2\n');
    commit(root, 'local-only');
    const resolved = resolveTrustedRef(root);
    expect(resolved.ref).toBe('refs/heads/main');
    expect(resolved.reason).toContain('local branch main');
  });

  test('a local base branch that diverged from origin/<base> is not trusted', () => {
    const root = repoWithBase('mikro-ref-diverged-', '# A\n');
    // origin/main moves somewhere main does not contain: the two have diverged, and the
    // remote-tracking ref is the one this run trusts.
    write(root, 'other.txt', 'x\n');
    commit(root, 'a commit only the remote has');
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(root, ['reset', '-q', '--hard', 'HEAD~1']);
    expect(resolveTrustedRef(root)).toEqual({
      ref: 'refs/remotes/origin/main',
      reason: 'origin/main',
    });
  });

  test('no origin/HEAD resolves no ref, and says what to run', () => {
    const root = mkdtempSync(join(tmpdir(), 'mikro-ref-none-'));
    trash.push(root);
    git(root, ['init', '-q']);
    const resolved = resolveTrustedRef(root);
    expect(resolved.ref).toBeNull();
    expect(resolved.reason).toContain('git remote set-head origin -a');
  });

  test('an explicit ref is normalized to its full name; a malformed or absent one resolves nothing', () => {
    const root = repoWithBase('mikro-ref-explicit-', '# A\n');
    expect(resolveTrustedRef(root, 'origin/main')).toEqual({
      ref: 'refs/remotes/origin/main',
      reason: '--agents-ref origin/main',
    });
    expect(resolveTrustedRef(root, '-evil').ref).toBeNull();
    expect(resolveTrustedRef(root, 'origin/no-such-branch')).toEqual({
      ref: null,
      reason: '--agents-ref origin/no-such-branch names no commit in the invoking checkout',
    });
    // A bare object name is a commit-ish git cannot name: it is used as typed.
    const sha = git(root, ['rev-parse', 'HEAD']);
    expect(resolveTrustedRef(root, sha).ref).toBe(sha);
  });
});

describe('materializeAgent', () => {
  test('the agent is extracted into a 0700 temp dir, byte-equal to the blobs at the ref', () => {
    const root = repoWithBase('mikro-mat-', '# the committed prompt\n');
    // The working tree says something else entirely: what is materialized is the REF.
    write(root, '.mikro/agents/wish-context/SYSTEM.md', '# the working tree\n');
    const material = materializeAgent(root, 'refs/remotes/origin/main', 'wish-context');
    if (!material) throw new Error('expected the agent to materialize');
    const file = join(material.agentsDir, 'wish-context', 'SYSTEM.md');
    expect(readFileSync(file, 'utf8')).toBe('# the committed prompt\n');
    expect(readFileSync(file, 'utf8')).toBe(
      readTrustedBlob(root, 'refs/remotes/origin/main', '.mikro/agents/wish-context/SYSTEM.md'),
    );
    expect(statSync(file).size).toBeGreaterThan(0);
    // The temp ROOT is 0700: the materialized prompt is readable by this run alone.
    const temp = join(material.agentsDir, '..', '..');
    expect(statSync(temp).mode & 0o777).toBe(0o700);
    material.dispose();
    expect(existsSync(material.agentsDir)).toBe(false);
    material.dispose(); // idempotent: a second disposal is not an error
  });

  test('an export-ignore attribute that drops a file from the archive is caught, not obeyed', () => {
    const root = repoWithBase('mikro-mat-ignore-', '# A\n');
    // `git archive` honours .gitattributes at the ref; `git show` does not. Without the
    // fidelity proof the agent would silently run with no SYSTEM.md at all.
    write(root, '.gitattributes', '.mikro/agents/wish-context/SYSTEM.md export-ignore\n');
    commit(root, 'drop the prompt from archives');
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const reasons: string[] = [];
    expect(materializeAgent(root, 'refs/remotes/origin/main', 'wish-context', (r) => reasons.push(r))).toBeNull();
    expect(reasons[0]).toContain('missing from the archive');
  });

  test('an export-subst attribute that rewrites a line is caught', () => {
    const root = repoWithBase('mikro-mat-subst-', '# A\n');
    write(root, '.mikro/agents/wish-context/SYSTEM.md', '# A $Format:%H$\n');
    write(root, '.gitattributes', '.mikro/agents/wish-context/SYSTEM.md export-subst\n');
    commit(root, 'rewrite the prompt in archives');
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const reasons: string[] = [];
    expect(materializeAgent(root, 'refs/remotes/origin/main', 'wish-context', (r) => reasons.push(r))).toBeNull();
    expect(reasons[0]).toContain('differs from');
  });

  test('a ref with no such agent, and a name that is not a directory name, materialize nothing', () => {
    const root = repoWithBase('mikro-mat-absent-', '# A\n');
    const reasons: string[] = [];
    expect(materializeAgent(root, 'refs/remotes/origin/main', 'review-prep', (r) => reasons.push(r))).toBeNull();
    expect(reasons[0]).toContain('carries no .mikro/agents/review-prep/agent.yaml');
    expect(materializeAgent(root, 'refs/remotes/origin/main', '../evil', (r) => reasons.push(r))).toBeNull();
    expect(reasons[1]).toContain('not a usable agent directory name');
    expect(
      materializeAgent(root, 'refs/remotes/origin/no-such-ref', 'wish-context', (r) => reasons.push(r)),
    ).toBeNull();
    expect(reasons[2]).toContain('could not be read');
  });

  test('an empty agent.yaml at the ref is refused rather than handed to the runtime', () => {
    const root = repoWithBase('mikro-mat-empty-', '# A\n');
    write(root, '.mikro/agents/wish-context/agent.yaml', '');
    commit(root, 'empty the agent');
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const reasons: string[] = [];
    expect(materializeAgent(root, 'refs/remotes/origin/main', 'wish-context', (r) => reasons.push(r))).toBeNull();
    expect(reasons[0]).toContain('is empty at');
  });
});

describe('readTrustedBlob', () => {
  test('reads the four configuration files at the ref, and answers null for what the ref does not carry', () => {
    const root = repoWithBase('mikro-blob-', '# A\n');
    write(root, '.mikro/mikro.yaml', 'model: flash\n');
    commit(root, 'add config');
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    // The working tree is then edited: the blob is unchanged, which is the whole point.
    write(root, '.mikro/mikro.yaml', 'model: attacker\n');
    expect(readTrustedBlob(root, 'refs/remotes/origin/main', '.mikro/mikro.yaml')).toBe('model: flash\n');
    for (const name of MIKRO_CONFIG_FILES.filter((n) => n !== 'mikro.yaml'))
      expect(readTrustedBlob(root, 'refs/remotes/origin/main', `.mikro/${name}`)).toBeNull();
  });
});
