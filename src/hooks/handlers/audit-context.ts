/**
 * Audit Context Handler — PreToolUse:Write|Edit
 *
 * When an agent is about to write or edit a file, this handler injects
 * recent git history for that file as additional context. This helps
 * the agent understand recent changes and avoid conflicts.
 *
 * Priority: 8 (runs before identity-inject, after brain-inject)
 */

import { execSync } from 'node:child_process';
import type { HandlerResult, HookPayload } from '../types.js';

/** Max number of recent commits to show per file. */
const MAX_COMMITS = 5;

/** Get recent git log for a specific file. Returns null if git is unavailable or file is untracked. */
function getRecentGitHistory(filePath: string, cwd: string): string | null {
  try {
    const log = execSync(
      `git log --oneline -n ${MAX_COMMITS} -- ${JSON.stringify(filePath)}`,
      { encoding: 'utf-8', timeout: 5000, cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const trimmed = log.trim();
    if (!trimmed) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export async function auditContext(payload: HookPayload): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  const filePath = input.file_path as string | undefined;
  if (!filePath) return;

  const cwd = payload.cwd ?? process.cwd();

  const history = getRecentGitHistory(filePath, cwd);
  if (!history) return;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: `[audit-context] Recent git history for ${filePath}:\n${history}`,
    },
  };
}
