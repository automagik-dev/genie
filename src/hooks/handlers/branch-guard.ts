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

import { execSync } from 'node:child_process';
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
 * Dependencies injection surface — tests supply a mock `resolvePrBase` so
 * the hook can be exercised without a live GitHub call.
 */
export interface BranchGuardDeps {
  /**
   * Resolve the base branch of a GitHub PR. Return `null` when the lookup
   * fails (network error, missing PR, auth failure). Callers treat `null`
   * as a deny.
   */
  resolvePrBase: (prNum: string) => Promise<string | null>;
}

const defaultDeps: BranchGuardDeps = {
  async resolvePrBase(prNum) {
    try {
      const out = execSync(`gh pr view ${prNum} --json baseRefName -q .baseRefName`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const base = out.trim();
      return base || null;
    } catch {
      return null;
    }
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

export async function branchGuard(payload: HookPayload, deps: BranchGuardDeps = defaultDeps): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  const command = input.command as string | undefined;
  if (!command) return;

  // Quick exit: if command doesn't mention git or gh, skip
  if (!/\b(git|gh)\b/.test(command)) return;

  for (const pattern of SYNC_DENY_PATTERNS) {
    if (pattern.test(command)) {
      return { decision: 'deny', reason: pattern.reason };
    }
  }

  // §19 (v2): gh pr merge — allow if PR targets an allowed base (dev), deny otherwise.
  if (/gh\s+pr\s+merge\b/.test(command)) {
    const prNum = extractPrNumber(command);
    if (!prNum) {
      return {
        decision: 'deny',
        reason:
          'BLOCKED: `gh pr merge` requires an explicit PR number so the target base branch can be verified. §19 (v2): agents merge PRs targeting `dev` only; main/master is humans-only via GitHub UI.',
      };
    }
    const base = await deps.resolvePrBase(prNum);
    if (!base) {
      return {
        decision: 'deny',
        reason: `BLOCKED: could not resolve base branch of PR #${prNum} (gh view failed or returned empty). §19 (v2): cannot merge without verifying base is \`dev\`. Check the PR exists and try again, or ask a human to merge via GitHub UI.`,
      };
    }
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
