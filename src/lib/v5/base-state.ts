/**
 * Genie v5 base state — the single shared integration-branch policy plus the
 * recorded per-wish spawn base.
 *
 * The policy was extracted from doctor's worktree classifier
 * (see genie-commands/doctor-worktrees.ts) so every consumer resolves "the
 * integration branch" through ONE config-free function. In order:
 *
 *   1. a local `dev` branch — this repo's integration line;
 *   2. else the remote default branch (`refs/remotes/origin/HEAD`);
 *   3. else null — nothing is resolvable, every consumer fails closed.
 *
 * Both candidates are carried as fully-qualified refs because a SHORT name is
 * ambiguous: per gitrevisions a bare `dev` resolves `refs/tags/dev` before
 * `refs/heads/dev`, so a tag sitting on a work branch tip would satisfy a
 * probe the real `dev` fails.
 *
 * The recorded state is one `meta` row per wish (`wish_base:<slug>`): the
 * branch the wish was planned on plus the integration base SHA pinned at plan
 * time (wish skill on APPROVED) or at first non-`--plan` resolution (legacy
 * wishes). The full 40-hex SHA is the only value that ever crosses the spawn
 * boundary — never a raw ref (TOCTOU + argv-injection immunity).
 */

import type { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';

/**
 * The integration branch in its two non-interchangeable shapes. Every git
 * probe takes `ref`; only human output takes `name`.
 */
export interface IntegrationBranch {
  /** Short form, e.g. `dev` or `origin/main`. Display only — never a git argument. */
  name: string;
  /** Fully-qualified ref, e.g. `refs/heads/dev`. The only form a probe may use. */
  ref: string;
}

interface GitOutcome {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

function gitFailure(stderr: string): GitOutcome {
  return { ok: false, status: null, stdout: '', stderr };
}

/**
 * Run git without ever throwing: a failed spawn is reported like any non-zero
 * exit, and every caller turns an unsuccessful outcome into a refusal.
 * Bounded: a probe hanging on a lock, credential prompt, or network mount must
 * not wedge a CLI command; a timeout surfaces as a refusal.
 */
function git(root: string, args: string[]): GitOutcome {
  try {
    const res = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (res.error) return gitFailure(res.error.message);
    return { ok: res.status === 0, status: res.status, stdout: res.stdout ?? '', stderr: (res.stderr ?? '').trim() };
  } catch (error) {
    return gitFailure(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The integration branch a spawn base is resolved from. Stated here in code
 * with NO config surface (see module docs). Extracted from doctor's
 * `resolveIntegration` — this function is the single policy point.
 */
export function resolveIntegration(root: string): IntegrationBranch | null {
  if (git(root, ['show-ref', '--verify', '--quiet', 'refs/heads/dev']).ok) {
    return { name: 'dev', ref: 'refs/heads/dev' };
  }
  const head = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (!head.ok) return null;
  const ref = head.stdout.trim();
  return ref.startsWith('refs/remotes/') ? { name: ref.slice('refs/remotes/'.length), ref } : null;
}

/** A full commit SHA: 40 lowercase hex characters. */
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Peel `rev` to its full commit SHA via `git rev-parse --verify <rev>^{commit}`.
 * Null on ANY failure — an unresolvable base proves nothing and must fail
 * closed. The `^{commit}` suffix rejects anything that is not a commit object
 * (tags peel through to their target commit); callers only ever pass
 * internally-composed refs (`refs/...`) or a recorded 40-hex SHA here, never
 * user input, so the probe cannot be steered by argv injection.
 */
export function peelCommit(root: string, rev: string): string | null {
  const res = git(root, ['rev-parse', '--verify', `${rev}^{commit}`]);
  if (!res.ok) return null;
  const sha = res.stdout.trim();
  return FULL_SHA_PATTERN.test(sha) ? sha : null;
}

// ============================================================================
// Recorded per-wish base (one meta row per wish)
// ============================================================================

/** `meta` key prefix for a wish's recorded base. */
const WISH_BASE_KEY_PREFIX = 'wish_base:';

function wishBaseKey(slug: string): string {
  return `${WISH_BASE_KEY_PREFIX}${slug}`;
}

/** One recorded wave base: the wish's plan branch plus its pinned base SHA. */
export interface WishBaseRecord {
  branch: string;
  base: string;
  recordedAt: number;
}

/**
 * Read the recorded base for `slug`: `null` when absent, the record when
 * valid, or the literal `'corrupt'` when a row exists but does not parse to a
 * valid record (non-empty branch, full-SHA base, numeric timestamp). A corrupt
 * record is NEVER auto-healed here — callers fail closed so a re-resolve
 * replaces it deliberately.
 */
export function readWishBase(db: Database, slug: string): WishBaseRecord | null | 'corrupt' {
  const row = db.query('SELECT value FROM meta WHERE key = ?').get(wishBaseKey(slug)) as {
    value: string;
  } | null;
  if (row === null) return null;
  try {
    const parsed = JSON.parse(row.value) as WishBaseRecord;
    if (
      typeof parsed.branch === 'string' &&
      parsed.branch !== '' &&
      typeof parsed.base === 'string' &&
      FULL_SHA_PATTERN.test(parsed.base) &&
      typeof parsed.recordedAt === 'number'
    ) {
      return parsed;
    }
  } catch {
    // fall through to corrupt
  }
  return 'corrupt';
}

/** Upsert the recorded base for `slug` (INSERT OR REPLACE — idempotent). */
export function writeWishBase(db: Database, slug: string, record: WishBaseRecord): void {
  db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(wishBaseKey(slug), JSON.stringify(record));
}
