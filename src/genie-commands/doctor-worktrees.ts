/**
 * doctor: accumulated `genie launch` worktrees.
 *
 * `genie launch` materializes one git worktree per wish group under
 * `<GENIE_HOME>/worktrees/` on branch `wish/<slug>-<group>` and never removes
 * one, so they pile up invisibly. This module makes them visible in
 * `genie doctor` and removable by `genie doctor --fix` — but only when removal
 * is provably safe.
 *
 * Two properties govern everything here:
 *
 *  1. Enumeration is authoritative, never heuristic. Entries come from
 *     `git worktree list --porcelain` — the same source `genie launch` itself
 *     trusts — not from reading directory names under the worktrees base. A
 *     directory git does not know about is not a worktree and is never touched;
 *     a worktree git knows about outside the base is not ours and is never
 *     touched either.
 *
 *  2. Removal is fail-closed. An entry is reclaimable only when BOTH proofs
 *     hold: its branch tip is an ancestor of the integration branch (every
 *     commit it carries is already contained there) AND its tree is clean.
 *     A dirty tree, an unmerged branch, an unresolvable integration branch, or
 *     ANY git probe that errors all land in a `kept` class: reported with the
 *     reason, excluded from the reclaimable count and bytes, and unreachable by
 *     `--fix`.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { type IntegrationBranch, resolveIntegration } from '../lib/v5/base-state.js';
import { resolveWorktreesBase } from '../lib/v5/launch-worktrees.js';
import type { CheckResult } from './doctor.js';
import { sizeOfPathTree } from './legacy-v4.js';

/**
 * Branch shape `genie launch` creates (`wish/<slug>-<group>`, both components
 * restricted to the launch charset). Necessary but not sufficient: an entry is
 * only treated as launch-created when its PATH also sits under the worktrees
 * base, so a hand-made worktree that merely borrowed the naming scheme stays
 * foreign.
 */
const LAUNCH_BRANCH_PATTERN = /^wish\/[A-Za-z0-9._-]+-[A-Za-z0-9._-]+$/;

/**
 * How one enumerated worktree may be disposed of. Exactly one class —
 * `removable` — is reachable by `--fix`; every other class is a kept line.
 */
export type WorktreeDisposition =
  /** Branch fully contained in the integration branch AND tree clean. */
  | 'removable'
  /** Uncommitted (or untracked) changes in the worktree. */
  | 'dirty'
  /** Carries commits the integration branch does not contain. */
  | 'unmerged'
  /** No integration branch could be resolved, so nothing is provably merged. */
  | 'unresolved'
  /** A git probe failed; without its answer nothing is proven. */
  | 'error'
  /** Not a launch worktree of this repo. */
  | 'foreign';

export interface LaunchWorktreeEntry {
  /** Absolute worktree path exactly as git reported it. */
  path: string;
  /** Short branch name, or null for a detached worktree. */
  branch: string | null;
  disposition: WorktreeDisposition;
  /** Why it landed in that class; surfaced verbatim in the doctor line. */
  reason: string;
  /**
   * Reclaimable bytes. Non-zero ONLY for `removable` entries — a kept entry is
   * never counted, so the reported total always equals what `--fix` would free.
   */
  sizeBytes: number;
}

export interface LaunchWorktreeScan {
  entries: LaunchWorktreeEntry[];
  /** Branch the ancestry proof ran against; null ⇒ unresolvable (nothing removable). */
  integrationBranch: string | null;
  /** Non-null when enumeration itself failed; `entries` is then empty. */
  enumerationError: string | null;
}

export interface LaunchWorktreeDeps {
  /** Base dir launch worktrees live under. Defaults to `genie launch`'s own resolution. */
  worktreesBase?: string;
  /** Line sink for `--fix` chatter. Defaults to stdout. */
  logSink?: (line: string) => void;
}

/** One porcelain record, reduced to the two fields classification needs. */
interface WorktreeRecord {
  path: string;
  branch: string | null;
}

interface GitOutcome {
  ok: boolean;
  /** Exit status, or null when the process could not be spawned at all. */
  status: number | null;
  stdout: string;
  stderr: string;
}

function gitFailure(stderr: string): GitOutcome {
  return { ok: false, status: null, stdout: '', stderr };
}

/**
 * Run git without ever throwing: a failed spawn (e.g. the worktree directory
 * vanished, so `cwd` no longer exists — reported as an `error` result on some
 * runtimes and thrown on others) is reported like any non-zero exit, and every
 * caller turns an unsuccessful outcome into a refusal.
 */
function git(cwd: string, args: string[]): GitOutcome {
  try {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Bounded: a probe hanging on a lock, credential prompt, or network mount
      // must not wedge `genie doctor`; a timeout surfaces as a refusal.
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (res.error) return gitFailure(res.error.message);
    return { ok: res.status === 0, status: res.status, stdout: res.stdout ?? '', stderr: (res.stderr ?? '').trim() };
  } catch (error) {
    return gitFailure(error instanceof Error ? error.message : String(error));
  }
}

function firstLine(text: string, fallback: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line === '' ? fallback : line;
}

/** Bytes → short human string. Deliberately duplicated from doctor.ts: importing
 * a value from it would close a runtime import cycle (doctor.ts imports this module). */
function prettyBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function safeSizeOf(path: string): number {
  try {
    return sizeOfPathTree(path);
  } catch {
    return 0;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `path` is `base` itself or lives beneath it (symlinks resolved). */
function isUnder(base: string, path: string): boolean {
  const root = canonical(base);
  const target = canonical(path);
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated and
 * open with a `worktree <path>` line; `branch <ref>` is absent for a detached
 * or bare worktree. Pure + exported so the parser is tested without git.
 */
export function parseWorktreePorcelain(text: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length).trim();
      branch = null;
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line.trim() === '' && path !== null) {
      records.push({ path, branch });
      path = null;
      branch = null;
    }
  }
  if (path !== null) records.push({ path, branch });
  return records;
}

/**
 * The branch a launch branch must already be contained in before anything is
 * deleted. Resolved through the shared policy in `src/lib/v5/base-state.ts`
 * (local `dev` → remote default → null; config-free) — the single policy
 * point the `genie context` verb consumes too.
 */
export function resolveIntegrationBranch(root: string): string | null {
  return resolveIntegration(root)?.name ?? null;
}

/**
 * Chain both proofs for ONE launch worktree, refusing on the first that fails.
 * `git status --porcelain` reports untracked files too, which is exactly the
 * condition `git worktree remove` itself refuses on, so a tree this classifier
 * calls clean is a tree git will agree to remove without `--force`.
 *
 * BOTH sides of the ancestry probe are fully qualified. A bare `<branch>` picks
 * up `refs/tags/<branch>` ahead of `refs/heads/<branch>`, so a tag colliding
 * with a launch branch would prove ITS containment while the `git branch -D`
 * below still deletes the branch — orphaning every commit the branch carried.
 */
/**
 * Gitignored files are deleted by `git worktree remove` (git's documented
 * semantics) and are usually the point of the reclaim — node_modules, build
 * output. The exception is user-owned secret material, which must never ride a
 * cleanup. The probe refuses removal when an ignored file's basename matches a
 * small sensitive-pattern set; everything else stays disclosed-but-removable.
 * A probe failure (timeout, oversized listing) refuses via the caller's
 * fail-closed error class — an unanswered probe proves nothing.
 */
const SENSITIVE_IGNORED = [/^\.env(\..+)?$/, /\.pem$/, /\.key$/, /^id_(rsa|ed25519|ecdsa)/, /credential/i, /secret/i];

function findIgnoredSecret(path: string): string | null {
  // `traditional` collapses a fully-ignored directory (node_modules/) to one
  // line, keeping the listing bounded on exactly the worktrees worth reclaiming.
  const listing = git(path, ['status', '--porcelain', '--ignored=traditional']);
  if (!listing.ok) return 'unlistable ignored files';
  for (const line of listing.stdout.split('\n')) {
    if (!line.startsWith('!!')) continue;
    const rel = line.slice(2).trim().replace(/\/$/, '');
    const base = rel.split('/').pop() ?? rel;
    if (SENSITIVE_IGNORED.some((re) => re.test(base))) return rel;
  }
  return null;
}

function classifyEntry(
  root: string,
  path: string,
  branch: string,
  integration: IntegrationBranch | null,
): LaunchWorktreeEntry {
  const entry = { path, branch, sizeBytes: 0 };
  if (integration === null) return { ...entry, disposition: 'unresolved', reason: 'integration branch unresolvable' };
  const status = git(path, ['status', '--porcelain']);
  if (!status.ok) return { ...entry, disposition: 'error', reason: firstLine(status.stderr, 'git status failed') };
  if (status.stdout.trim() !== '') return { ...entry, disposition: 'dirty', reason: 'uncommitted changes' };
  const secret = findIgnoredSecret(path);
  if (secret !== null) return { ...entry, disposition: 'dirty', reason: `ignored secret present (${secret})` };
  const ancestry = git(root, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, integration.ref]);
  if (ancestry.ok) return { ...entry, disposition: 'removable', reason: 'merged+clean', sizeBytes: safeSizeOf(path) };
  // `--is-ancestor` exits 1 for a definitive "no"; anything else is a broken
  // probe, and an unanswered probe proves nothing.
  if (ancestry.status === 1) return { ...entry, disposition: 'unmerged', reason: `commits not in ${integration.name}` };
  return { ...entry, disposition: 'error', reason: firstLine(ancestry.stderr, 'ancestry probe failed') };
}

/**
 * Enumerate and classify every worktree of the repo at `root`.
 *
 * The main worktree and the checkout doctor is running from are dropped before
 * classification — the first is the repo itself rather than residue, and the
 * second must never become a removal candidate (git cannot remove the worktree
 * you are standing in). Both would classify as `foreign` anyway; dropping them
 * only keeps the report free of lines about the repo the user is already in.
 */
export function scanLaunchWorktrees(root: string, worktreesBase?: string): LaunchWorktreeScan {
  const base = worktreesBase ?? resolveWorktreesBase({});
  const list = git(root, ['worktree', 'list', '--porcelain']);
  if (!list.ok) {
    return {
      entries: [],
      integrationBranch: null,
      enumerationError: firstLine(list.stderr, 'git worktree list failed'),
    };
  }
  const records = parseWorktreePorcelain(list.stdout);
  const integration = resolveIntegration(root);
  const skip = new Set([canonical(root), canonical(records[0]?.path ?? root)]);
  const entries: LaunchWorktreeEntry[] = [];
  for (const record of records) {
    if (skip.has(canonical(record.path))) continue;
    // Launch-created iff BOTH the branch shape and the location say so.
    const launchBranch =
      record.branch !== null && LAUNCH_BRANCH_PATTERN.test(record.branch) && isUnder(base, record.path)
        ? record.branch
        : null;
    entries.push(
      launchBranch === null
        ? { ...record, disposition: 'foreign', reason: 'not a launch worktree of this repo', sizeBytes: 0 }
        : classifyEntry(root, record.path, launchBranch, integration),
    );
  }
  return { entries, integrationBranch: integration?.name ?? null, enumerationError: null };
}

const CHECK_NAME = 'launch worktrees';

const UNRESOLVED_ADVICE =
  'Create a local `dev` branch or set the remote default (`git remote set-head origin -a`), then re-run.';
const FIX_ADVICE = 'Run `genie doctor --fix` to remove the reclaimable worktrees and delete their branches.';
/**
 * The remedy for the commonest `error` entry: a registration whose directory is
 * gone. Every probe inside it fails, so it can never be proven safe and would
 * warn forever — only a prune clears the registration.
 */
const PRUNE_ADVICE = 'Run `git worktree prune` to drop registrations whose directory no longer exists.';

/** Headline detail + the advice that goes with it, before any prune rider. */
function summarizeCounts(scan: LaunchWorktreeScan, launch: LaunchWorktreeEntry[]): [string, string] {
  if (scan.integrationBranch === null) {
    return [`${launch.length} present; integration branch unresolvable — --fix will remove nothing`, UNRESOLVED_ADVICE];
  }
  const removable = launch.filter((entry) => entry.disposition === 'removable');
  if (removable.length === 0) {
    return [`0 of ${launch.length} reclaimable — all kept (integration branch: ${scan.integrationBranch})`, ''];
  }
  const bytes = removable.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const merged = `merged into ${scan.integrationBranch}, clean`;
  return [`${removable.length} of ${launch.length} reclaimable (${merged}), ${prettyBytes(bytes)}`, FIX_ADVICE];
}

/** Headline: how many of the launch worktrees `--fix` would actually reclaim. */
function summarizeScan(scan: LaunchWorktreeScan): CheckResult {
  const launch = scan.entries.filter((entry) => entry.disposition !== 'foreign');
  if (launch.length === 0) return { name: CHECK_NAME, status: 'pass', detail: 'none found' };
  const [detail, advice] = summarizeCounts(scan, launch);
  const prune = launch.some((entry) => entry.disposition === 'error') ? PRUNE_ADVICE : '';
  const suggestion = [advice, prune].filter((part) => part !== '').join(' ');
  return suggestion === ''
    ? { name: CHECK_NAME, status: 'warn', detail }
    : { name: CHECK_NAME, status: 'warn', detail, suggestion };
}

/** One line per LAUNCH worktree, stating its disposition and the reason. */
function describeEntry(entry: LaunchWorktreeEntry): CheckResult {
  const name = `${CHECK_NAME}: ${basename(entry.path)}${entry.branch === null ? '' : ` (${entry.branch})`}`;
  if (entry.disposition === 'removable') {
    // `git worktree remove` deletes gitignored content along with the tracked
    // tree — build output, node_modules, local .env files — and the byte figure
    // counts it, so the line says so rather than implying a tracked-only sweep.
    const detail = `reclaimable (${entry.reason}; includes gitignored files), ${prettyBytes(entry.sizeBytes)}`;
    return { name, status: 'warn', detail };
  }
  return {
    name,
    status: 'warn',
    detail: `kept (${entry.reason}) — not counted as reclaimable; --fix will not touch it`,
  };
}

/**
 * Detect-only view of the launch worktrees. Pure read: doctor without `--fix`
 * mutates nothing here. Outside a git repo (`root === null`) there is nothing to
 * enumerate and no check is emitted.
 */
export function checkLaunchWorktrees(root: string | null, deps: LaunchWorktreeDeps = {}): CheckResult[] {
  if (root === null) return [];
  const scan = scanLaunchWorktrees(root, deps.worktreesBase);
  if (scan.enumerationError !== null) {
    return [
      {
        name: CHECK_NAME,
        status: 'warn',
        detail: `enumeration failed: ${scan.enumerationError}`,
        suggestion: 'Run `git worktree list` from the repo root to see why git refused.',
      },
    ];
  }
  const foreign = scan.entries.filter((entry) => entry.disposition === 'foreign');
  return [
    summarizeScan(scan),
    ...scan.entries.filter((entry) => entry.disposition !== 'foreign').map(describeEntry),
    // Foreign checkouts collapse into ONE line: a repo can carry dozens of
    // hand-made worktrees, and a line each would bury the residue the check
    // exists to surface. They stay visible (and provably untouched) as a count.
    ...(foreign.length === 0
      ? []
      : [
          {
            name: `${CHECK_NAME}: other checkouts`,
            status: 'pass' as const,
            detail: `${foreign.length} kept (not launch worktrees of this repo) — never touched by --fix`,
          },
        ]),
  ];
}

/**
 * Remove ONE proven-safe worktree and its branch, returning a refusal reason or
 * null on success.
 *
 * The worktree removal is never forced: git's own "contains modified or
 * untracked files" refusal restates the clean-tree proof, so a tree that changed
 * between the scan and this call loses the removal instead of the work.
 *
 * The branch delete IS forced, and only this proof authorizes it: `git branch -d`
 * re-checks containment against the CURRENT HEAD rather than the integration
 * branch, so it would refuse a branch already proven fully contained in the
 * integration branch. `-D` deletes a ref whose every commit is reachable
 * elsewhere; nothing is lost.
 */
/**
 * Exported for direct testing: the ancestry re-proof below guards the window
 * BETWEEN cleanup's own scan and this removal, which no public-API test can
 * reach deterministically (cleanupLaunchWorktrees re-scans on entry, so a
 * commit landed before the call is already filtered by classification).
 */
export function removeLaunchWorktree(
  root: string,
  entry: LaunchWorktreeEntry,
  integration: IntegrationBranch,
): string | null {
  // Early re-proof: a commit landed since the scan refuses BEFORE the worktree
  // is touched, preserving it intact. This probe alone cannot close the race —
  // a commit can still land after it — so it is an ergonomic guard, not the
  // authoritative one.
  if (entry.branch !== null) {
    const ancestry = git(root, ['merge-base', '--is-ancestor', `refs/heads/${entry.branch}`, integration.ref]);
    if (!ancestry.ok) return `kept: branch advanced past ${integration.name} after the scan (ancestry re-proof failed)`;
  }
  const removed = git(root, ['worktree', 'remove', entry.path]);
  if (!removed.ok) return `git worktree remove refused: ${firstLine(removed.stderr, 'unknown git error')}`;
  if (entry.branch === null) return null;
  // AUTHORITATIVE re-proof, after removal and before the forced delete: with
  // the worktree gone the branch is frozen (git refuses a second checkout of a
  // checked-out branch, and no checkout holds it now), so an ancestry answer
  // taken HERE cannot be invalidated before `-D` — this is the only point in
  // the sequence where the proof and the delete are race-free.
  const frozen = git(root, ['merge-base', '--is-ancestor', `refs/heads/${entry.branch}`, integration.ref]);
  if (!frozen.ok) {
    return `worktree removed; branch ${entry.branch} kept: commits landed mid-removal (post-removal ancestry re-proof failed)`;
  }
  const deleted = git(root, ['branch', '-D', entry.branch]);
  if (!deleted.ok) {
    return `worktree removed; branch ${entry.branch} kept: ${firstLine(deleted.stderr, 'unknown git error')}`;
  }
  return null;
}

/**
 * `--fix` half: remove every worktree the scan proved merged+clean, and delete
 * its branch. Idempotent — a repo with no removable worktree is a strict no-op,
 * so the run right after a successful one does and prints nothing. A per-entry
 * git failure is reported and skipped; it never aborts the remaining entries and
 * never escalates into a force.
 */
export function cleanupLaunchWorktrees(root: string | null, deps: LaunchWorktreeDeps = {}): void {
  if (root === null) return;
  const removable = scanLaunchWorktrees(root, deps.worktreesBase).entries.filter(
    (entry) => entry.disposition === 'removable',
  );
  if (removable.length === 0) return;
  // A `removable` disposition implies the scan resolved an integration branch;
  // re-resolve rather than thread it through, and refuse everything if it
  // vanished mid-run (fail-closed, same posture as the scan).
  const integration = resolveIntegration(root);
  const emit = deps.logSink ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (integration === null) {
    emit(`  \x1b[33m!\x1b[0m kept all ${removable.length}: integration branch no longer resolvable`);
    return;
  }
  emit(`\x1b[2mRemoving ${removable.length} merged, clean launch worktree(s)...\x1b[0m`);
  for (const entry of removable) {
    const failure = removeLaunchWorktree(root, entry, integration);
    if (failure === null) emit(`  \x1b[32m✔\x1b[0m removed ${entry.path} (${entry.branch})`);
    else emit(`  \x1b[33m!\x1b[0m kept ${entry.path}: ${failure}`);
  }
}
