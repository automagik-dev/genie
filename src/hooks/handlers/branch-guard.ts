/**
 * Branch Guard Handler — PreToolUse:Bash
 *
 * Blocks git/gh commands that target main/master branches.
 * This is the hard enforcement layer for branch protection.
 *
 * Priority: 1 (runs FIRST, before all other handlers)
 */

import type { HandlerResult, HookPayload } from '../types.js';

interface DenyPattern {
  test: (command: string) => boolean;
  reason: string;
}

const DENY_PATTERNS: DenyPattern[] = [
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
    // gh pr merge (agents cannot merge PRs at all)
    test: (cmd) => /gh\s+pr\s+merge\b/.test(cmd),
    reason: 'BLOCKED: Agents may NOT merge PRs. Only humans merge via GitHub UI.',
  },
  {
    // git checkout main && git commit/merge/push/add/cherry-pick/rebase
    test: (cmd) =>
      /git\s+checkout\s+(main|master)\s*[;&|]+\s*git\s+(commit|merge|cherry-pick|rebase|push|add)\b/.test(cmd),
    reason: 'BLOCKED: Committing or mutating on main/master is FORBIDDEN. Work on feature branches.',
  },
];

export async function branchGuard(payload: HookPayload): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  const command = input.command as string | undefined;
  if (!command) return;

  // Quick exit: if command doesn't mention git or gh, skip
  if (!/\b(git|gh)\b/.test(command)) return;

  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(command)) {
      return { decision: 'deny', reason: pattern.reason };
    }
  }

  return; // implicit allow
}
