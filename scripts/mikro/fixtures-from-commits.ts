#!/usr/bin/env bun
/**
 * scripts/mikro/fixtures-from-commits.ts — ground truth from a repository's own history.
 *
 *   genie mikro fixtures --from-commits <range> --agent <wish-context|review-prep>
 *       [--dir repo] [--out path] [--max n] [--force]
 *   bun scripts/mikro/fixtures-from-commits.ts …      # the same code, inside this checkout
 *
 * genie's own fixture sets were derived by hand from merged PRs. A repository that
 * commits straight to its base branch has no PRs to derive anything from, which is
 * the whole reason this exists (Decision 12): a commit is already a labelled example
 * — an intent in its subject, and the file set a competent agent should have named.
 *
 * The truth is MECHANICAL, and every rule below is one an operator can re-run by hand:
 *
 *   files   `git show --name-only` of the commit. Rename detection is git's default,
 *           so a renamed path appears once, as the NEW path — the path the tree has.
 *   prompt  `Intent: <commit subject>` for wish-context;
 *           `Prepare the review of commit <sha> against <sha>^` for review-prep.
 *   id      the first 12 characters of the commit sha. Not `git rev-parse --short`,
 *           whose length follows `core.abbrev` and the repository's object count, so
 *           the same range would build different ids on different hosts.
 *
 * What is SKIPPED, always with a reason, never silently:
 *
 *   - a merge commit: its `--name-only` set is a combined diff, not one author's change;
 *   - a root commit, for review-prep only: there is no `<sha>^` to review against;
 *   - a commit with no files (an empty or purely-metadata commit);
 *   - a commit ANY of whose files no longer exists at HEAD. The verifier scores the
 *     TREE, not the commit: `call.ts` drops a citation whose path is not there, so a
 *     fixture naming a deleted file would score an agent down for being right.
 *
 * The output is byte-stable across runs of the same argv — no timestamps, no host
 * paths, commits oldest first and each file list sorted — so a rebuilt set is a real
 * diff rather than noise, and it is exactly the shape `bench.ts` loads
 * (`loadFixtureSet`, proven by a test that builds a set and loads it back).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Fixture } from './bench';
import { gitProbeEnv } from './trusted-source';

/** The two agents whose ground truth a commit can state. `issue-triage` needs an issue; `mikro-coach` needs a bench. */
export const COMMIT_FIXTURE_AGENTS = ['wish-context', 'review-prep'] as const;
export type CommitFixtureAgent = (typeof COMMIT_FIXTURE_AGENTS)[number];

export const isCommitFixtureAgent = (value: string): value is CommitFixtureAgent =>
  (COMMIT_FIXTURE_AGENTS as readonly string[]).includes(value);

/** A refusal that costs nothing: the CLI prints `message` and exits 2. */
export class FixturesUsageError extends Error {}

export interface SkippedCommit {
  sha: string;
  reason: string;
}

export interface CommitFixtures {
  fixtures: Fixture[];
  skipped: SkippedCommit[];
}

/** How many characters of the sha an id and a prompt carry. Fixed here, never taken from git config. */
const SHORT_SHA = 12;

/** One git read in the repository under `--dir`, with the ambient git environment stripped. */
function git(dir: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const probe = Bun.spawnSync(['git', '-C', dir, ...args], {
      env: gitProbeEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { ok: probe.exitCode === 0, out: probe.stdout.toString(), err: probe.stderr.toString().trim() };
  } catch {
    return { ok: false, out: '', err: 'no usable git on this host' };
  }
}

/**
 * A range is joined into a git command line, so a leading `-` would be read as an
 * option — refused before git ever sees the token, the same rule `refFormatError`
 * applies to a ref. Everything else is left to `git log`, which owns the grammar.
 */
export function rangeError(range: string): string | null {
  if (!range.trim()) return 'a commit range is required, e.g. --from-commits HEAD~20..HEAD';
  if (range.startsWith('-')) return `${range} may not start with "-": a commit range is never an option`;
  return null;
}

/** The prompt one commit becomes, for one agent. The one place the two recipes live. */
export function commitPrompt(agent: CommitFixtureAgent, shortSha: string, subject: string): string {
  return agent === 'wish-context'
    ? `Intent: ${subject}`
    : `Prepare the review of commit ${shortSha} against ${shortSha}^`;
}

/**
 * Every fixture this range can state, oldest first, and every commit it could not —
 * with the reason, because a range that yields three fixtures out of forty is
 * evidence about the repository, not a silent result.
 */
export function buildCommitFixtures(options: {
  dir: string;
  range: string;
  agent: CommitFixtureAgent;
  max?: number;
}): CommitFixtures {
  const dir = resolve(options.dir);
  const bad = rangeError(options.range);
  if (bad) throw new FixturesUsageError(`${bad}\n`);
  if (options.max !== undefined && (!Number.isInteger(options.max) || options.max < 1))
    throw new FixturesUsageError(`--max must be a positive integer, got ${options.max}\n`);

  const head = git(dir, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
  if (!head.ok) throw new FixturesUsageError(`${dir} has no readable HEAD tree: ${head.err}\n`);
  const atHead = new Set(head.out.split('\0').filter(Boolean));

  // %x1f (unit separator) cannot occur in a sha or a parent list, and a subject is one line.
  const log = git(dir, ['log', '--reverse', '--format=%H%x1f%P%x1f%s', options.range]);
  if (!log.ok) throw new FixturesUsageError(`git log ${options.range} failed in ${dir}: ${log.err}\n`);

  const fixtures: Fixture[] = [];
  const skipped: SkippedCommit[] = [];
  for (const line of log.out.split('\n').filter(Boolean)) {
    if (options.max !== undefined && fixtures.length >= options.max) break;
    const [sha, parents, ...rest] = line.split('\x1f');
    const subject = rest.join('\x1f').trim();
    const id = sha.slice(0, SHORT_SHA);
    const parentCount = parents.trim() ? parents.trim().split(' ').length : 0;
    if (parentCount > 1) {
      skipped.push({ sha: id, reason: 'merge commit: --name-only is a combined diff, not one change' });
      continue;
    }
    if (parentCount === 0 && options.agent === 'review-prep') {
      skipped.push({ sha: id, reason: 'root commit: there is no <sha>^ to review it against' });
      continue;
    }
    const shown = git(dir, ['show', '--name-only', '--format=', sha]);
    if (!shown.ok) {
      skipped.push({ sha: id, reason: `git show failed: ${shown.err}` });
      continue;
    }
    const files = [...new Set(shown.out.split('\n').filter(Boolean))].sort();
    if (!files.length) {
      skipped.push({ sha: id, reason: 'no files changed' });
      continue;
    }
    const gone = files.filter((file) => !atHead.has(file));
    if (gone.length) {
      skipped.push({ sha: id, reason: `${gone[0]} no longer exists at HEAD (the verifier scores the tree)` });
      continue;
    }
    if (options.agent === 'wish-context' && !subject) {
      skipped.push({ sha: id, reason: 'empty commit subject: there is no intent to state' });
      continue;
    }
    fixtures.push({ id, prompt: commitPrompt(options.agent, id, subject), truth: { files } });
  }
  return { fixtures, skipped };
}

/** The fixture file, exactly as `bench.ts` loads it. `notes` says how to re-derive every row by hand. */
export function fixtureSetDocument(args: { agent: CommitFixtureAgent; range: string; fixtures: Fixture[] }): string {
  const notes =
    args.agent === 'wish-context'
      ? `Ground truth: files = git show --name-only of each commit in ${args.range} (renames: the new path); prompt = the commit subject. Built by genie mikro fixtures --from-commits. Commits whose files no longer exist at HEAD are skipped: the verifier scores the tree, not the commit.`
      : `Ground truth: files = git show --name-only of each commit in ${args.range} (renames: the new path); prompt reviews the commit against its parent. Built by genie mikro fixtures --from-commits. Merge commits, root commits and commits whose files no longer exist at HEAD are skipped: the verifier scores the tree, not the commit.`;
  return `${JSON.stringify({ agent: args.agent, notes, fixtures: args.fixtures }, null, 2)}\n`;
}

export const FIXTURES_USAGE = `usage: genie mikro fixtures --from-commits <range> --agent <${COMMIT_FIXTURE_AGENTS.join('|')}> [--dir repo] [--out path] [--max n] [--force]
       (inside this checkout the same code runs as: bun scripts/mikro/fixtures-from-commits.ts …)
`;

function usage(reason?: string): number {
  if (reason) process.stderr.write(reason.endsWith('\n') ? reason : `${reason}\n`);
  process.stderr.write(FIXTURES_USAGE);
  return 2;
}

/**
 * Build one fixture set and write it. Returns 0 on a written set, 1 when the range
 * stated no fixture at all (nothing is written: an empty set would only fail a bench
 * later, further from the cause), and 2 for a refusal.
 */
export function runFixturesCli(argv: string[]): number {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const agent = opt('--agent');
  if (!agent) return usage('--agent is required');
  if (!isCommitFixtureAgent(agent))
    return usage(`--agent must be one of ${COMMIT_FIXTURE_AGENTS.join(', ')}, got ${agent}`);
  const range = opt('--from-commits');
  if (range === undefined) return usage('--from-commits <range> is required');
  const dir = resolve(opt('--dir') ?? process.cwd());
  const maxRaw = opt('--max');
  const max = maxRaw === undefined ? undefined : Number(maxRaw);
  const out = resolve(opt('--out') ?? join(dir, '.mikro', 'fixtures', `${agent}.json`));

  let built: CommitFixtures;
  try {
    built = buildCommitFixtures({ dir, range, agent, ...(max === undefined ? {} : { max }) });
  } catch (error) {
    if (error instanceof FixturesUsageError) return usage(error.message);
    throw error;
  }

  for (const skip of built.skipped.slice(0, 5)) process.stderr.write(`· skipped ${skip.sha}: ${skip.reason}\n`);
  if (built.skipped.length > 5) process.stderr.write(`· +${built.skipped.length - 5} more skipped\n`);
  if (!built.fixtures.length) {
    process.stderr.write(
      `no fixture could be built from ${range} in ${dir} (${built.skipped.length} commit(s) skipped); nothing was written\n`,
    );
    return 1;
  }
  if (existsSync(out) && !argv.includes('--force')) {
    process.stderr.write(`${out} already exists: pass --force to replace it, or --out <path> to write elsewhere\n`);
    return 2;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, fixtureSetDocument({ agent, range, fixtures: built.fixtures }));
  process.stdout.write(
    `wrote ${built.fixtures.length} fixture(s) from ${range} to ${out} (${built.skipped.length} commit(s) skipped)\n`,
  );
  process.stdout.write(`next: genie mikro bench ${agent} --dir ${dir} --reps 1\n`);
  return 0;
}

// No top-level `await`: this module is imported by the genie CLI, where
// `import.meta.main` is false and nothing below must run.
if (import.meta.main) {
  process.exit(runFixturesCli(process.argv.slice(2)));
}
