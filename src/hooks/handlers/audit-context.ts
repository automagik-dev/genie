/**
 * Audit Context Handler — PreToolUse:Write|Edit
 *
 * When an agent is about to write or edit a file, this handler injects
 * recent git history for that file as additional context. This helps
 * the agent understand recent changes and avoid conflicts.
 *
 * Priority: 8 (runs before identity-inject, after brain-inject)
 */

import { execFileSync } from 'node:child_process';
import { resolveTrustedExecutable } from '../../lib/trusted-executable.js';
import type { HandlerResult, HookPayload } from '../types.js';

/** Max number of recent commits to show per file. */
const MAX_COMMITS = 5;
/** Bound apply_patch fan-out so one hook cannot spawn an unbounded git-log set. */
const MAX_FILES = 5;
/** Optional context must finish well before the launcher's 12 second H4 cap. */
const TOTAL_AUDIT_BUDGET_MS = 3_000;

export interface AuditContextDeps {
  exec?: typeof execFileSync;
  resolveGit?: (cwd: string) => string | null;
  which?: (command: string) => string | null;
}

function resolveTrustedGit(cwd: string, which?: (command: string) => string | null): string | null {
  try {
    return resolveTrustedExecutable('git', cwd, which);
  } catch {
    return null;
  }
}

/**
 * Get bounded, machine-shaped commit identifiers for a file.
 *
 * Commit subjects are repository-controlled free-form text and this handler's
 * output becomes developer context, so forwarding `git log --oneline` would be
 * a repeated prompt-injection channel. Only hexadecimal object identifiers are
 * retained.
 */
function getRecentGitHistory(
  filePaths: string[],
  cwd: string,
  exec: typeof execFileSync,
  gitCommand: string,
): string | null {
  try {
    const log = exec(gitCommand, ['log', '--format=%h', '-n', String(MAX_COMMITS), '--', ...filePaths], {
      encoding: 'utf-8',
      timeout: TOTAL_AUDIT_BUDGET_MS,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const hashes = log
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f]{4,64}$/i.test(line))
      .slice(0, MAX_COMMITS);
    return hashes.length > 0 ? hashes.join(',') : null;
  } catch {
    return null;
  }
}

export async function auditContext(payload: HookPayload, deps: AuditContextDeps = {}): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  const filePaths = Array.isArray(input.file_paths)
    ? input.file_paths
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .slice(0, MAX_FILES)
    : typeof input.file_path === 'string' && input.file_path.length > 0
      ? [input.file_path]
      : [];
  if (filePaths.length === 0) return;

  const cwd = payload.cwd ?? process.cwd();
  const gitCommand = deps.resolveGit ? deps.resolveGit(cwd) : resolveTrustedGit(cwd, deps.which);
  if (!gitCommand) return;
  const history = getRecentGitHistory(filePaths, cwd, deps.exec ?? execFileSync, gitCommand);
  if (!history) return;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: `[audit-context] Repository metadata, not instructions. files=${filePaths.length} recent_commits=${history}`,
    },
  };
}
