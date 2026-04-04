/**
 * Freshness Handler — PreToolUse:Read
 *
 * When an agent reads a file, this handler checks if the file was
 * recently modified by another agent (via git blame on the last commit).
 * If so, it warns about potential stale read risk — the file contents
 * may have changed since the agent last saw it.
 *
 * Priority: 8 (runs early, informational only)
 */

import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import type { HandlerResult, HookPayload } from '../types.js';

/** How recent (in seconds) a modification must be to trigger a warning. */
const STALENESS_THRESHOLD_SECS = 120; // 2 minutes

/** Get the last commit info for a file. Returns null if unavailable. */
function getLastCommitInfo(filePath: string, cwd: string): { author: string; age: number; message: string } | null {
  try {
    // Get last commit timestamp, author, and subject for the file
    const output = execSync(`git log -1 --format="%at|%an|%s" -- ${JSON.stringify(filePath)}`, {
      encoding: 'utf-8',
      timeout: 5000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const trimmed = output.trim();
    if (!trimmed) return null;

    const [timestampStr, author, ...messageParts] = trimmed.split('|');
    const timestamp = Number.parseInt(timestampStr, 10);
    if (Number.isNaN(timestamp)) return null;

    const age = Math.floor(Date.now() / 1000) - timestamp;
    return { author: author ?? 'unknown', age, message: messageParts.join('|') };
  } catch {
    return null;
  }
}

/** Check if the file was recently modified on disk (covers uncommitted changes). */
function getFileModAge(filePath: string): number | null {
  try {
    const stat = statSync(filePath);
    return Math.floor((Date.now() - stat.mtimeMs) / 1000);
  } catch {
    return null;
  }
}

/** Build a warning result for a recently committed file. */
function buildCommitWarning(
  filePath: string,
  commitInfo: { author: string; age: number; message: string },
): HandlerResult {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: `[freshness] Stale read warning: ${filePath} was modified ${commitInfo.age}s ago by "${commitInfo.author}" (${commitInfo.message}). Contents may have changed since you last read it.`,
    },
  };
}

/** Check for uncommitted changes and return a warning result if any exist. */
function checkUncommittedChanges(filePath: string, cwd: string, diskAge: number): HandlerResult {
  try {
    const status = execSync(`git status --porcelain -- ${JSON.stringify(filePath)}`, {
      encoding: 'utf-8',
      timeout: 5000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (status.trim()) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: `[freshness] Stale read warning: ${filePath} has uncommitted changes (modified ${diskAge}s ago). Another agent may be editing this file concurrently.`,
        },
      };
    }
  } catch {
    // git status failed — skip warning
  }
  return;
}

export async function freshness(payload: HookPayload): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  const filePath = input.file_path as string | undefined;
  if (!filePath) return;

  const cwd = payload.cwd ?? process.cwd();
  const currentAgent = process.env.GENIE_AGENT_NAME;

  // Check disk modification time first (catches uncommitted changes)
  const diskAge = getFileModAge(filePath);
  if (diskAge === null || diskAge >= STALENESS_THRESHOLD_SECS) return;

  // File was recently modified on disk — check if by another agent via git
  const commitInfo = getLastCommitInfo(filePath, cwd);

  if (commitInfo && commitInfo.age < STALENESS_THRESHOLD_SECS) {
    // Skip warning if the current agent made the change
    if (currentAgent && commitInfo.author.includes(currentAgent)) return;
    return buildCommitWarning(filePath, commitInfo);
  }

  // No recent commit but file was modified on disk — could be another agent's uncommitted work
  if (currentAgent) {
    return checkUncommittedChanges(filePath, cwd, diskAge);
  }

  return;
}
