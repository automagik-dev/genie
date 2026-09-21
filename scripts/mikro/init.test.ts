/**
 * `genie mikro init` is the one command in this runtime that writes into a
 * repository, so what it must NOT do is most of this file: overwrite a specialized
 * prompt, follow a symlink out of the tree, duplicate an ignore line, or write a
 * single byte outside `<repo>`.
 *
 * No provider, no `mikro` runtime: seeding is file copies and one git probe.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InitError, SEEDED_AGENTS, ensureRunsIgnored, nextStepForCommit, runInitCli, seedAgents } from './init';

const trash: string[] = [];
afterEach(() => {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

function git(root: string, args: string[]): void {
  const probe = Bun.spawnSync(['git', '-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (probe.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${probe.stderr.toString()}`);
}

/** A GENIE_HOME whose `templates/mikro/agents` carries what a release ships. */
function shippedHome(agents: readonly string[] = SEEDED_AGENTS): string {
  const home = tmp('mikro-init-home-');
  for (const agent of agents) {
    const dir = join(home, 'templates', 'mikro', 'agents', agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.yaml'), `model: deepseek-api/deepseek-flash\nsystem: SYSTEM.md\n# ${agent}\n`);
    writeFileSync(join(dir, 'SYSTEM.md'), `# ${agent} — shipped default\n`);
  }
  return home;
}

describe('seedAgents', () => {
  test('copies both agents, ignores the ledger, and writes nothing outside the repository', () => {
    const dir = tmp('mikro-init-repo-');
    const genieHome = shippedHome();
    const first = seedAgents({ dir, genieHome });
    expect(first.refused).toEqual([]);
    expect(first.gitignore).toBe('created');
    expect(first.written.every((path) => path.startsWith(resolve(dir)))).toBe(true);
    for (const agent of SEEDED_AGENTS) {
      expect(readdirSync(join(dir, '.mikro', 'agents', agent)).sort()).toEqual(['SYSTEM.md', 'agent.yaml']);
      expect(readFileSync(join(dir, '.mikro', 'agents', agent, 'SYSTEM.md'), 'utf8')).toContain('shipped default');
    }
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.mikro/runs/\n');
    // EVIDENCE.md is a bench record, not a payload: nothing claims one exists yet.
    expect(existsSync(join(dir, '.mikro', 'agents', 'wish-context', 'EVIDENCE.md'))).toBe(false);
    // mikro-coach is a tool, not an agent a repository specializes.
    expect(readdirSync(join(dir, '.mikro', 'agents')).sort()).toEqual([...SEEDED_AGENTS].sort());
  });

  test('a second run refuses every agent and changes nothing at all', () => {
    const dir = tmp('mikro-init-twice-');
    const genieHome = shippedHome();
    seedAgents({ dir, genieHome });
    const mine = '# my own prompt, specialized over six rounds\n';
    writeFileSync(join(dir, '.mikro', 'agents', 'wish-context', 'SYSTEM.md'), mine);
    const ignoreBefore = readFileSync(join(dir, '.gitignore'), 'utf8');

    const second = seedAgents({ dir, genieHome });
    expect(second.written).toEqual([]);
    expect(second.refused).toEqual([...SEEDED_AGENTS]);
    expect(second.gitignore).toBe('present');
    expect(readFileSync(join(dir, '.mikro', 'agents', 'wish-context', 'SYSTEM.md'), 'utf8')).toBe(mine);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(ignoreBefore);
  });

  test('a symlinked .mikro or .mikro/agents is refused, never followed', () => {
    const elsewhere = tmp('mikro-init-elsewhere-');
    const dir = tmp('mikro-init-symlink-');
    symlinkSync(elsewhere, join(dir, '.mikro'));
    expect(() => seedAgents({ dir, genieHome: shippedHome() })).toThrow(InitError);
    expect(readdirSync(elsewhere)).toEqual([]);

    const other = tmp('mikro-init-symlink2-');
    mkdirSync(join(other, '.mikro'), { recursive: true });
    symlinkSync(elsewhere, join(other, '.mikro', 'agents'));
    expect(() => seedAgents({ dir: other, genieHome: shippedHome() })).toThrow(InitError);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test('a symlinked .gitignore is left alone — the line would land outside the repository', () => {
    const outside = tmp('mikro-init-outside-');
    const target = join(outside, 'someone-elses.gitignore');
    writeFileSync(target, 'node_modules\n');
    const dir = tmp('mikro-init-ignorelink-');
    symlinkSync(target, join(dir, '.gitignore'));

    const seeded = seedAgents({ dir, genieHome: shippedHome() });
    // The agents are still seeded — one ignore line is not worth refusing the whole seed…
    expect(seeded.written.length).toBeGreaterThan(0);
    expect(seeded.gitignore).toBe('skipped');
    // …and the file outside the repository is byte-for-byte what it was.
    expect(readFileSync(target, 'utf8')).toBe('node_modules\n');
    expect(ensureRunsIgnored(dir)).toBe('skipped');
    expect(readFileSync(target, 'utf8')).toBe('node_modules\n');
  });

  test('a release that ships no agents is a refusal naming genie update', () => {
    const dir = tmp('mikro-init-empty-');
    expect(() => seedAgents({ dir, genieHome: tmp('mikro-init-nohome-') })).toThrow(/genie update/);
    expect(existsSync(join(dir, '.mikro'))).toBe(false);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });
});

describe('ensureRunsIgnored', () => {
  test('creates, appends once, and recognizes the spellings that already mean it', () => {
    const dir = tmp('mikro-init-ignore-');
    expect(ensureRunsIgnored(dir)).toBe('created');
    expect(ensureRunsIgnored(dir)).toBe('present');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.mikro/runs/\n');

    const withOther = tmp('mikro-init-ignore2-');
    writeFileSync(join(withOther, '.gitignore'), 'node_modules\ndist');
    expect(ensureRunsIgnored(withOther)).toBe('added');
    expect(readFileSync(join(withOther, '.gitignore'), 'utf8')).toBe('node_modules\ndist\n.mikro/runs/\n');

    for (const line of ['.mikro/runs', '/.mikro/runs/', '.mikro/']) {
      const already = tmp('mikro-init-ignore3-');
      writeFileSync(join(already, '.gitignore'), `# notes\n${line}\n`);
      expect(ensureRunsIgnored(already)).toBe('present');
      expect(readFileSync(join(already, '.gitignore'), 'utf8')).toBe(`# notes\n${line}\n`);
    }
  });
});

describe('the next step it prints', () => {
  test('names the push when the trusted ref is the remote branch, and the local-base rule when it is not', () => {
    const dir = tmp('mikro-init-git-');
    git(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'seed']);
    // No origin/HEAD at all: the agent cannot be used until the checkout names a base.
    expect(nextStepForCommit(dir)).toContain('git remote set-head origin -a');

    // origin/main at the same commit, and a local main that contains it: the local-base rule.
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'unpushed']);
    expect(nextStepForCommit(dir)).toContain('no push needed yet');

    // A local branch that does NOT contain origin/main: the trusted ref is the remote one.
    git(dir, ['checkout', '-q', '-b', 'other']);
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(dir, ['update-ref', '-d', 'refs/heads/main']);
    expect(nextStepForCommit(dir)).toContain('PUSH it');
  });
});

describe('runInitCli', () => {
  test('prints the whole sequence and the host prerequisites, and exits 0 twice', () => {
    const dir = tmp('mikro-init-cli-');
    const genieHome = shippedHome();
    const previous = process.env.GENIE_HOME;
    process.env.GENIE_HOME = genieHome;
    const chunks: string[] = [];
    const stdout = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runInitCli(['--dir', dir])).toBe(0);
      expect(runInitCli(['--dir', dir])).toBe(0);
    } finally {
      process.stdout.write = stdout;
      // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
      if (previous === undefined) delete process.env.GENIE_HOME;
      else process.env.GENIE_HOME = previous;
    }
    const out = chunks.join('');
    expect(out).toContain('git -C');
    expect(out).toContain('genie mikro fixtures --from-commits');
    expect(out).toContain('genie mikro bench wish-context');
    // Step 4 is runnable as printed: the evidence bench writes and the fixture set step 3
    // built are both untracked, and coach's Gate 1 refuses a dirty .mikro/agents.
    expect(out).toContain('.mikro/agents/wish-context/EVIDENCE.md .mikro/fixtures/wish-context.json');
    expect(out).toContain(`git -C ${dir} commit -m "chore(mikro): record the wish-context baseline and fixtures"`);
    expect(out).toContain('a dirty .mikro/agents aborts the round');
    expect(out).toContain('mikro >= 1.260909.1 on PATH');
    expect(out).toContain('DEEPSEEK_API_KEY');
    expect(out).toContain('deepseek-flash');
    // The second run says what it kept rather than claiming to have seeded again.
    expect(out).toContain('it already exists, nothing was overwritten');
  });

  test('a --dir that does not exist, and a --dir with no value, are refused', () => {
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(runInitCli(['--dir', join(tmpdir(), 'mikro-init-absent-nothing-here')])).toBe(2);
      expect(runInitCli(['--dir'])).toBe(2);
    } finally {
      process.stderr.write = stderr;
    }
  });
});
