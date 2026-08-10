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

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolveTrustedExecutable } from '../../lib/trusted-executable.js';
import { readEnvAgentId, readEnvAgentName } from '../env-identity.js';
import type { HandlerResult, HookPayload } from '../types.js';

/** How recent (in seconds) a modification must be to trigger a warning. */
const STALENESS_THRESHOLD_SECS = 120; // 2 minutes

export interface FreshnessDeps {
  /** git subprocess runner (tests inject a recorder). */
  exec?: typeof execFileSync;
  /** Resolve the trusted git executable for `cwd`; null when unavailable. */
  resolveGit?: (cwd: string) => string | null;
}

/**
 * Resolve git through the trusted-executable gate, like the sibling handlers
 * (audit-context, git-freeze-guard): a repository-local `git` shim on PATH must
 * never run with the agent's privileges.
 */
function resolveTrustedGit(cwd: string, resolveGit?: (cwd: string) => string | null): string | null {
  if (resolveGit) return resolveGit(cwd);
  try {
    return resolveTrustedExecutable('git', cwd);
  } catch {
    return null;
  }
}

/**
 * Get bounded, machine-shaped commit info for a file. Returns null if
 * unavailable.
 *
 * Commit subjects and author names are repository-controlled free-form text
 * and this handler's output becomes developer context, so forwarding them
 * would be a repeated prompt-injection channel (the same rule audit-context
 * documents for `git log --oneline`). Only the numeric age and the hexadecimal
 * object id are retained; the author is read internally ONLY so the handler
 * can skip self-authored commits, and never forwarded.
 */
function getLastCommitInfo(
  filePath: string,
  cwd: string,
  gitCommand: string,
  exec: typeof execFileSync,
): { author: string; age: number; hash: string } | null {
  try {
    // `%at` epoch-seconds, `%an` author (internal use only), `%h` short hash.
    const output = exec(gitCommand, ['log', '-1', '--format=%at|%an|%h', '--', filePath], {
      encoding: 'utf-8',
      timeout: 5000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const trimmed = output.trim();
    if (!trimmed) return null;

    // Author names may legally contain '|'; the hash is the last field (hex
    // never contains '|'), so split from the right instead of positional.
    const [timestampStr, ...rest] = trimmed.split('|');
    const hash = rest.length > 0 ? (rest[rest.length - 1] ?? '') : '';
    const author = rest.slice(0, -1).join('|');
    const timestamp = Number.parseInt(timestampStr, 10);
    if (Number.isNaN(timestamp)) return null;

    const age = Math.floor(Date.now() / 1000) - timestamp;
    return { author: author || 'unknown', age, hash };
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
  commitInfo: { author: string; age: number; hash: string },
): HandlerResult {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      // Hex object id + numeric age only — repo-controlled subject/author are
      // deliberately absent (see getLastCommitInfo).
      additionalContext: `[freshness] Stale read warning: ${filePath} was modified ${commitInfo.age}s ago by another agent (commit ${commitInfo.hash}). Contents may have changed since you last read it.`,
    },
  };
}

/** Check for uncommitted changes and return a warning result if any exist. */
function checkUncommittedChanges(
  filePath: string,
  cwd: string,
  diskAge: number,
  gitCommand: string,
  exec: typeof execFileSync,
): HandlerResult {
  try {
    const status = exec(gitCommand, ['status', '--porcelain', '--', filePath], {
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

export async function freshness(payload: HookPayload, deps: FreshnessDeps = {}): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  const filePath = input.file_path as string | undefined;
  if (!filePath) return;

  const cwd = payload.cwd ?? process.cwd();
  const exec = deps.exec ?? execFileSync;
  // Prefer GENIE_AGENT_ID (UUID) when present, but keep the name as a
  // secondary self-identifier — git authors are usually human-readable, so
  // we check both against commitInfo.author below.
  const envAgentId = readEnvAgentId();
  const envAgentName = readEnvAgentName();
  const currentAgent = envAgentId ?? envAgentName;

  // Check disk modification time first (catches uncommitted changes)
  const diskAge = getFileModAge(filePath);
  if (diskAge === null || diskAge >= STALENESS_THRESHOLD_SECS) return;

  // Resolve git only AFTER the mtime gate: this handler fires on every Read
  // tool call, and the dominant path (file untouched in the last 2 minutes)
  // must stay one statSync — not a PATH scan + realpath walk per read.
  const gitCommand = resolveTrustedGit(cwd, deps.resolveGit);
  if (!gitCommand) return;

  // File was recently modified on disk — check if by another agent via git
  const commitInfo = getLastCommitInfo(filePath, cwd, gitCommand, exec);

  if (commitInfo && commitInfo.age < STALENESS_THRESHOLD_SECS) {
    // Skip warning if the current agent made the change. Match by either
    // env value — git author is typically the human-readable name, but the
    // UUID match catches CI / id-keyed identities.
    if (envAgentId && commitInfo.author.includes(envAgentId)) return;
    if (envAgentName && commitInfo.author.includes(envAgentName)) return;
    return buildCommitWarning(filePath, commitInfo);
  }

  // No recent commit but file was modified on disk — could be another agent's uncommitted work
  if (currentAgent) {
    return checkUncommittedChanges(filePath, cwd, diskAge, gitCommand, exec);
  }

  return;
}
