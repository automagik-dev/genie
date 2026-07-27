/**
 * Git-Freeze Guard Handler — PreToolUse:Bash
 *
 * Mechanical enforcement of the shared-workspace git-state freeze recorded in
 * AGENTS.md ("Engineering rules"): *shared-workspace subagents never mutate
 * repo-level git state (no `checkout`/`switch`/`reset`/`stash`/`rebase`) — only
 * the orchestrator moves HEAD*. Until this handler, that invariant was enforced
 * by brief prose alone (issue #2705).
 *
 * ## Why this can be enforced at all
 *
 * Claude Code's PreToolUse payload carries `agent_id` / `agent_type`. Measured
 * on Claude Code 2.1.220: the main thread's Bash calls arrive with
 * `agent_id: null, agent_type: null`; a spawned subagent's Bash calls arrive
 * with `agent_id: "<id>", agent_type: "general-purpose"` under the *same*
 * `session_id` and the *same* `cwd`. That is the orchestrator-vs-subagent
 * discriminator the freeze needs.
 *
 * ## Fail-open, deliberately
 *
 * Every ambiguity resolves to *allow*, not deny:
 *   - no `agent_id` on the payload (main thread, Codex, an older/newer client
 *     that drops the field) → allow;
 *   - a `cd` / `git -C` target that isn't a literal path (variable, glob,
 *     `~`, command substitution, quoted-and-masked) → allow;
 *   - `git --git-dir` / `--work-tree` / `--namespace` overrides → allow;
 *   - a worktree root that git cannot resolve → allow.
 *
 * This is the opposite of {@link branchGuard}'s fail-closed posture, and it is
 * the point. The freeze has no server-side backstop the way branch protection
 * backstops `gh pr merge`, so a wrong deny here has no escape hatch and simply
 * breaks a working agent. The founding incident was an *accidental* HEAD move
 * in a shared checkout, not an adversarial one; a guard that reliably catches
 * the literal, common forms and never fires on a legitimate one is worth more
 * than a guard nobody can keep enabled. This is a guardrail, not a sandbox: an
 * agent that wants to route around it trivially can.
 *
 * ## What "targets the shared checkout" means
 *
 * A linked worktree has its own HEAD, so `git switch` inside one is exactly the
 * escape hatch AGENTS.md points at (`genie launch`). The guard therefore
 * compares `git rev-parse --show-toplevel` of the command's effective directory
 * against the same for the session `cwd`, and denies only when they are the
 * same working tree. Subagents operating in their own worktree are untouched.
 *
 * Priority: 2 (a deny-guard — runs with branch-guard/orchestration-guard,
 * before omni-approval (5) and the context handlers (8)).
 */

import { execFileSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { resolveTrustedExecutable } from '../../lib/trusted-executable.js';
import { maskQuotedRegions } from '../shell-quoting.js';
import type { HandlerResult, HookPayload } from '../types.js';

/**
 * Git subcommands the freeze names. Kept literally in sync with AGENTS.md so a
 * reader can diff the two lists by eye.
 */
const FROZEN_SUBCOMMANDS = new Set(['checkout', 'switch', 'reset', 'stash', 'rebase']);

/**
 * `git stash list` / `git stash show` mutate nothing. Denying them would be a
 * pure false positive against a subcommand the freeze only cares about because
 * of its *mutating* forms.
 */
const READ_ONLY_STASH_VERBS = new Set(['list', 'show']);

/** Git global options that consume the following token as their value. */
const VALUE_TAKING_GLOBAL_FLAGS = new Set(['-C', '-c', '--config-env']);

/**
 * Git global options that re-point the repository itself. Resolving what they
 * mean would duplicate git's own discovery rules, so their presence makes the
 * invocation opaque and the guard steps aside.
 */
const REPO_REDIRECTING_GLOBAL_FLAGS = ['--git-dir', '--work-tree', '--namespace', '--exec-path'];

/** Shell metacharacters that make a path argument non-literal. */
const NON_LITERAL_PATH = /[$`*?~!]|\\$/;

/** Statement separators. `&&` and `||` must be tried before `&` and `|`. */
const SEGMENT_SEPARATORS = /&&|\|\||;|\||&|\n/;

/** git must answer fast; a hook that stalls is worse than a hook that allows. */
const GIT_TIMEOUT_MS = 2_000;

export interface GitFreezeGuardDeps {
  /**
   * Resolve the working-tree root containing `dir`, or `null` when `dir` is not
   * inside a git working tree / git is unavailable. Injected so tests can
   * exercise the classifier without a real repository on disk.
   */
  resolveWorktreeRoot: (dir: string) => string | null;
}

const defaultDeps: GitFreezeGuardDeps = {
  resolveWorktreeRoot(dir) {
    let git: string;
    try {
      git = resolveTrustedExecutable('git', dir);
    } catch {
      return null;
    }
    try {
      const out = execFileSync(git, ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        cwd: dir,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  },
};

/**
 * True when this payload came from a subagent rather than the orchestrator.
 *
 * `agent_id` is the discriminator; `agent_type === 'main'` is checked as well
 * because Claude Code labels the main thread that way internally and a future
 * build could populate both fields for it.
 */
function isSubagentPayload(payload: HookPayload): boolean {
  const agentId = payload.agent_id;
  if (typeof agentId !== 'string' || agentId.length === 0) return false;
  return payload.agent_type !== 'main';
}

/** Join `arg` onto `base`, or return `null` when either side is unusable. */
function joinPath(base: string | null, arg: string | undefined): string | null {
  if (!arg || NON_LITERAL_PATH.test(arg)) return null;
  if (isAbsolute(arg)) return resolve(arg);
  if (base === null) return null;
  return resolve(base, arg);
}

interface GitInvocation {
  subcommand: string;
  /** Tokens after the subcommand. */
  rest: string[];
  /** Directory the invocation runs in, or `null` when it could not be resolved. */
  dir: string | null;
}

/**
 * Parse a single statement into a git invocation, or `null` when the statement
 * is not a plain `git …` call the guard can reason about.
 */
function parseGitInvocation(tokens: string[], cwd: string | null): GitInvocation | null {
  if (tokens[0] !== 'git') return null;
  let dir = cwd;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith('-')) {
      return { subcommand: token, rest: tokens.slice(i + 1), dir };
    }
    if (REPO_REDIRECTING_GLOBAL_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`))) return null;
    if (VALUE_TAKING_GLOBAL_FLAGS.has(token)) {
      if (token === '-C') dir = joinPath(dir, tokens[i + 1]);
      i += 2;
      continue;
    }
    i += 1;
  }
  return null;
}

/** True when this invocation is one the freeze forbids (mutating forms only). */
function isFrozenInvocation(invocation: GitInvocation): boolean {
  if (!FROZEN_SUBCOMMANDS.has(invocation.subcommand)) return false;
  if (invocation.subcommand !== 'stash') return true;
  const verb = invocation.rest.find((token) => !token.startsWith('-'));
  return verb === undefined ? true : !READ_ONLY_STASH_VERBS.has(verb);
}

/**
 * Walk the statements of a compound command left to right, tracking `cd` as it
 * goes, and return the first frozen git invocation found.
 */
function findFrozenInvocation(command: string, cwd: string | null): GitInvocation | null {
  const masked = maskQuotedRegions(command);
  if (!/\bgit\b/.test(masked)) return null;
  let dir = cwd;
  for (const segment of masked.split(SEGMENT_SEPARATORS)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens[0] === 'cd' || tokens[0] === 'pushd') {
      dir = joinPath(dir, tokens[1]);
      continue;
    }
    if (tokens[0] === 'popd') {
      dir = null;
      continue;
    }
    const invocation = parseGitInvocation(tokens, dir);
    if (invocation && isFrozenInvocation(invocation)) return invocation;
  }
  return null;
}

function denyReason(subcommand: string, sharedRoot: string): string {
  return [
    `BLOCKED: \`git ${subcommand}\` targets the shared workspace at ${sharedRoot}.`,
    '',
    'AGENTS.md (Engineering rules) freezes repo-level git state for shared-workspace subagents:',
    'no `checkout`/`switch`/`reset`/`stash`/`rebase` — **only the orchestrator moves HEAD**.',
    '',
    'DO INSTEAD:',
    '- Need your own HEAD? Take a worktree and address it explicitly — `git worktree add` is',
    '  permitted plumbing, and this guard never fires on another working tree:',
    '    git worktree add <path> -b <branch> <base>',
    '    git -C <path> switch <branch>          # allowed: different working tree',
    '- Whole execution group needs isolation? `genie launch <wish-slug>` gives each group its',
    '  own pane + worktree by construction.',
    '- Otherwise sequence the work: hand the repo-level mutation back to the orchestrator,',
    '  which owns HEAD, and continue once it reports the move is done.',
    '- Read-only inspection stays allowed: `git status`, `git log`, `git diff`, `git show`,',
    '  `git stash list`, `git worktree list`.',
  ].join('\n');
}

export async function gitFreezeGuard(
  payload: HookPayload,
  deps: GitFreezeGuardDeps = defaultDeps,
): Promise<HandlerResult> {
  if (!isSubagentPayload(payload)) return;

  const command = payload.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return;

  const sessionCwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : null;
  const invocation = findFrozenInvocation(command, sessionCwd);
  if (!invocation || invocation.dir === null || sessionCwd === null) return;

  const sharedRoot = deps.resolveWorktreeRoot(sessionCwd);
  if (sharedRoot === null) return;
  const targetRoot = deps.resolveWorktreeRoot(invocation.dir);
  if (targetRoot === null || targetRoot !== sharedRoot) return;

  return {
    decision: 'deny',
    reason: denyReason(invocation.subcommand, sharedRoot),
  };
}
