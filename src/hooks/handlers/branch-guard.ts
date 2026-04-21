/**
 * Branch Guard Handler — PreToolUse:Bash
 *
 * Blocks git/gh commands that target main/master branches.
 * This is the hard enforcement layer for branch protection.
 *
 * Standing law §19 (v2, 2026-04-21): Agents MAY merge PRs targeting `dev`.
 * Merge to `main` / `master` is humans-only (GitHub UI). This handler enforces
 * that by resolving the PR's `baseRefName` at check time and denying on any
 * non-dev base. Fall-closed policy: if the base cannot be resolved, deny.
 *
 * Priority: 1 (runs FIRST, before all other handlers)
 */

import { spawnSync } from 'node:child_process';
import type { HandlerResult, HookPayload } from '../types.js';

/** Branches that agents are allowed to merge PRs into. */
const ALLOWED_MERGE_BASES = new Set(['dev']);

interface SyncDenyPattern {
  test: (command: string) => boolean;
  reason: string;
}

const SYNC_DENY_PATTERNS: SyncDenyPattern[] = [
  {
    // git push origin main, git push -u origin master, git push --set-upstream origin main
    // Must match main/master as a standalone arg (space-preceded), not inside a path like feat/main-feature
    test: (cmd) => /git\s+push\b/i.test(cmd) && /(?:^|\s)(main|master)(?:\s|$)/.test(cmd),
    reason: 'BLOCKED: Push to main/master is FORBIDDEN. Push to a feature branch and create a PR targeting dev.',
  },
  {
    // git push origin HEAD:main, git push origin feat:master
    test: (cmd) => /git\s+push\b/.test(cmd) && /:(main|master)\b/.test(cmd),
    reason: 'BLOCKED: Push refspec targeting main/master is FORBIDDEN.',
  },
  // Agents CAN create PRs targeting any branch (including main/master).
  // PRs are proposals for human review — the protection is on MERGING, not proposing.
  {
    // gh pr create without --base (defaults to main — require explicit intent)
    test: (cmd) => /gh\s+pr\s+create\b/.test(cmd) && !/(--base|-B)\s+\S/.test(cmd),
    reason:
      'BLOCKED: gh pr create requires explicit --base flag. Use: gh pr create --base dev (or --base main for releases)',
  },
  {
    // git checkout main && git commit/merge/push/add/cherry-pick/rebase
    test: (cmd) =>
      /git\s+checkout\s+(main|master)\s*[;&|]+\s*git\s+(commit|merge|cherry-pick|rebase|push|add)\b/.test(cmd),
    reason: 'BLOCKED: Committing or mutating on main/master is FORBIDDEN. Work on feature branches.',
  },
];

/**
 * Result of a PR base-branch resolution attempt.
 * - `{ base: string }` — lookup succeeded; caller checks base against allowlist.
 * - `{ reason: string }` — lookup failed for a reason the caller surfaces in
 *   the deny message so humans can diagnose without re-running.
 *
 * The reason-channel replaces the older `null` sentinel (which collapsed
 * "subprocess threw", "exit != 0", and "exit=0 but empty stdout" into one
 * opaque deny — undiagnosable when it fires in production).
 */
export type ResolvePrBaseResult = { base: string } | { reason: string };

/**
 * Dependencies injection surface — tests supply a mock `resolvePrBase` so
 * the hook can be exercised without a live GitHub call.
 */
export interface BranchGuardDeps {
  /**
   * Resolve the base branch of a GitHub PR. Callers fall-closed on any
   * failure shape (`reason` present) — that's the §19 v2 safety contract.
   */
  resolvePrBase: (prNum: string) => Promise<ResolvePrBaseResult>;
}

/** Maximum stderr bytes we surface in a deny reason. Protects against gh
 *  emitting a wall of text and flooding the hook decision payload. */
const STDERR_SURFACE_CAP = 500;

const defaultDeps: BranchGuardDeps = {
  async resolvePrBase(prNum) {
    // spawnSync (not execSync) so we can inspect exit code AND stderr
    // independently. The previous `stdio: ['ignore','pipe','ignore']` routed
    // stderr to /dev/null, making every fall-closed deny undiagnosable.
    // Timeout bumped 5s→10s for headroom during `gh auth` token refreshes.
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync('gh', ['pr', 'view', prNum, '--json', 'baseRefName', '-q', '.baseRefName'], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { reason: `spawnSync threw: ${message.slice(0, STDERR_SURFACE_CAP)}` };
    }
    if (result.error) {
      return { reason: `subprocess error: ${result.error.message.slice(0, STDERR_SURFACE_CAP)}` };
    }
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    if (result.status !== 0) {
      const tail = stderr.slice(-STDERR_SURFACE_CAP) || 'no stderr captured';
      return { reason: `gh pr view exited ${result.status}: ${tail}` };
    }
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (!stdout) {
      const tail = stderr.slice(-STDERR_SURFACE_CAP) || 'none';
      return { reason: `gh pr view exited 0 with empty stdout (stderr: ${tail})` };
    }
    return { base: stdout };
  },
};

/**
 * Extract PR number from a `gh pr merge <num>` command. `gh pr merge` with no
 * number uses the current branch's PR, which is too ambiguous for the hook to
 * verify safely — we treat that form as "cannot verify" = deny.
 */
function extractPrNumber(cmd: string): string | null {
  const match = cmd.match(/gh\s+pr\s+merge\s+(\d+)\b/);
  return match ? match[1] : null;
}

/**
 * Mask the interior of single/double-quoted shell regions with spaces,
 * preserving string length so regex word-boundaries behave identically on the
 * remaining unmasked characters.
 *
 * Closes a class of over-matches where a blocked substring (`gh pr merge N`,
 * `git push origin main`, `git checkout main && git commit`) appearing inside
 * a `--body` / `--message` / `-m` argument triggered a false-positive deny.
 *
 * Live reproducer: opening PR #1264 (the branch-guard subprocess-diagnostics
 * fix) was blocked twice because the PR body described the very commands the
 * hook denies. Required a workaround — paraphrase every literal occurrence —
 * that doesn't generalize.
 *
 * Scope: handles single-quotes (no escapes), double-quotes with `\X` escapes,
 * and unterminated quotes (mask to end of string — safer than the alternative
 * of leaving a runaway region unmasked). Backtick command substitution and
 * heredocs are intentionally not parsed — they're rare in agent-issued
 * commands and falling back to fully unmasked treatment is fail-closed for
 * the original policy, which matches the hook's overall posture.
 */
type QuoteState = 'none' | 'single' | 'double';
interface MaskStep {
  out: string;
  next: QuoteState;
  consumed: number;
}

/** Unquoted char: pass through, or open a quote region. */
function stepUnquoted(ch: string): MaskStep {
  if (ch === "'") return { out: ' ', next: 'single', consumed: 1 };
  if (ch === '"') return { out: ' ', next: 'double', consumed: 1 };
  return { out: ch, next: 'none', consumed: 1 };
}

/** Single-quoted char: always masked; `'` closes the region (no escapes in bash single-quotes). */
function stepSingleQuoted(ch: string): MaskStep {
  return { out: ' ', next: ch === "'" ? 'none' : 'single', consumed: 1 };
}

/** Double-quoted char: always masked; `\X` consumes two chars; `"` closes. */
function stepDoubleQuoted(ch: string, hasNext: boolean): MaskStep {
  if (ch === '\\' && hasNext) return { out: '  ', next: 'double', consumed: 2 };
  return { out: ' ', next: ch === '"' ? 'none' : 'double', consumed: 1 };
}

function maskQuotedRegions(cmd: string): string {
  let out = '';
  let state: QuoteState = 'none';
  let i = 0;
  while (i < cmd.length) {
    const step: MaskStep =
      state === 'double'
        ? stepDoubleQuoted(cmd[i], i + 1 < cmd.length)
        : state === 'single'
          ? stepSingleQuoted(cmd[i])
          : stepUnquoted(cmd[i]);
    out += step.out;
    state = step.next;
    i += step.consumed;
  }
  return out;
}

export async function branchGuard(payload: HookPayload, deps: BranchGuardDeps = defaultDeps): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  const command = input.command as string | undefined;
  if (!command) return;

  // Match against a quote-masked view of the command so blocked substrings
  // appearing inside `--body` / `--message` / `-m` arguments don't trigger
  // false-positive denies. The mask preserves string length, so word-boundary
  // regex tests on the unmasked portion behave identically.
  const matchTarget = maskQuotedRegions(command);

  // Quick exit: if the unquoted portion doesn't mention git or gh, skip.
  if (!/\b(git|gh)\b/.test(matchTarget)) return;

  for (const pattern of SYNC_DENY_PATTERNS) {
    if (pattern.test(matchTarget)) {
      return { decision: 'deny', reason: pattern.reason };
    }
  }

  // §19 (v2): gh pr merge — allow if PR targets an allowed base (dev), deny otherwise.
  if (/gh\s+pr\s+merge\b/.test(matchTarget)) {
    const prNum = extractPrNumber(matchTarget);
    if (!prNum) {
      return {
        decision: 'deny',
        reason:
          'BLOCKED: `gh pr merge` requires an explicit PR number so the target base branch can be verified. §19 (v2): agents merge PRs targeting `dev` only; main/master is humans-only via GitHub UI.',
      };
    }
    const resolved = await deps.resolvePrBase(prNum);
    if ('reason' in resolved) {
      return {
        decision: 'deny',
        reason: `BLOCKED: could not resolve base branch of PR #${prNum} — ${resolved.reason}. §19 (v2): cannot merge without verifying base is \`dev\`. Check the PR exists and try again, or ask a human to merge via GitHub UI.`,
      };
    }
    const base = resolved.base;
    if (!ALLOWED_MERGE_BASES.has(base)) {
      return {
        decision: 'deny',
        reason: `BLOCKED: PR #${prNum} targets \`${base}\`. §19 (v2): agents may merge PRs targeting \`dev\` only. Main/master merges are humans-only via GitHub UI.`,
      };
    }
    // base is `dev` → fall through to implicit allow below
  }

  return; // implicit allow
}
