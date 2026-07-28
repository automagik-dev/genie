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
 *   - a worktree root that git cannot resolve → allow;
 *   - a `cd` inside a subshell — `(cd /elsewhere && git switch main)` — moves
 *     only that subshell, and the guard tracks it that way rather than judging
 *     the git call against the session cwd;
 *   - a frozen call nested *inside* a command substitution — `$(git switch dev)`
 *     — is not descended into and so is allowed. The substitution's interior is
 *     masked wholesale because its parentheses and separators are not the outer
 *     statement's, and reading it would mean tracking a second scope's cwd
 *     through the same walk. That is a knowing gap, and a cheap one: the freeze
 *     exists to catch the accidental `git switch dev`, and nobody types the
 *     substituted form by accident.
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
 * A compound command can hold several frozen invocations in several directories
 * — `git -C /elsewhere switch main && git switch dev`. *Every* one is resolved
 * and the deny is raised for the first that lands in the shared checkout, so a
 * legitimate lead invocation cannot shield a frozen one behind it.
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

/**
 * Statement separators. `&&` and `||` must be tried before `&` and `|`.
 *
 * The group is capturing so `String.split` interleaves each operator between
 * the statements it joins: a `cd`'s effect on the parent shell depends on which
 * separators sit either side of it, and that is unreadable from the statements
 * alone.
 */
const SEGMENT_SEPARATORS = /(&&|\|\||;|\||&|\n)/;

/**
 * Separators that put the statement beside them in a subshell: a pipeline
 * component and a backgrounded job both get their own process, so a `cd` there
 * never moves the parent shell's directory and must not move the guard's.
 */
const SUBSHELL_SEPARATORS = new Set(['|', '&']);

/** Openers of a region that runs in its own shell and yields a value, not a statement. */
const OPAQUE_REGION_OPENERS = ['$(', '<(', '>('];

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

/** Index just past the `)` that closes the group opened before `from`, or the end of `cmd`. */
function closingParen(cmd: string, from: number): number {
  let depth = 1;
  for (let i = from; i < cmd.length; i += 1) {
    if (cmd[i] === '(') depth += 1;
    else if (cmd[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return cmd.length;
}

/**
 * Mask command/process substitutions and backticks with `$`, preserving length
 * the way {@link maskQuotedRegions} does.
 *
 * Two things would otherwise be misread. Their parentheses are not the subshell
 * grouping {@link findFrozenInvocations} tracks, so the stray `)` of a `$(pwd)`
 * would close a real `(…)` group early and leak its `cd` outward. And their
 * result is not a literal path, so `$` — which {@link NON_LITERAL_PATH} already
 * rejects — is the mask character that keeps `git -C $(pwd)` failing open.
 *
 * An unterminated region masks to end of string, matching the quote masker's
 * treatment of a runaway quote.
 */
function maskOpaqueRegions(cmd: string): string {
  let out = '';
  let i = 0;
  while (i < cmd.length) {
    const opener = OPAQUE_REGION_OPENERS.find((candidate) => cmd.startsWith(candidate, i));
    if (opener) {
      const end = closingParen(cmd, i + opener.length);
      out += '$'.repeat(end - i);
      i = end;
      continue;
    }
    if (cmd[i] === '`') {
      const close = cmd.indexOf('`', i + 1);
      const end = close === -1 ? cmd.length : close + 1;
      out += '$'.repeat(end - i);
      i = end;
      continue;
    }
    out += cmd[i];
    i += 1;
  }
  return out;
}

interface Statement {
  tokens: string[];
  /** Subshell groups this statement opens with `(` and closes with `)`. */
  opened: number;
  closed: number;
}

/**
 * Tokenize one statement, peeling the subshell parentheses off its ends. Both
 * spellings occur in the wild — `(cd /x` and `( cd /x` — so the parens are
 * stripped character-wise rather than expected as tokens of their own.
 */
function parseStatement(segment: string): Statement {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let opened = 0;
  while (tokens.length > 0 && tokens[0].startsWith('(')) {
    const head = tokens[0].slice(1);
    opened += 1;
    if (head.length === 0) tokens.shift();
    else tokens[0] = head;
  }
  let closed = 0;
  while (tokens.length > 0 && tokens[tokens.length - 1].endsWith(')')) {
    const tail = tokens[tokens.length - 1].slice(0, -1);
    closed += 1;
    if (tail.length === 0) tokens.pop();
    else tokens[tokens.length - 1] = tail;
  }
  return { tokens, opened, closed };
}

/** True when this separator makes the statement beside it run in its own shell. */
function isSubshellEdge(separator: string | undefined): boolean {
  return separator !== undefined && SUBSHELL_SEPARATORS.has(separator);
}

/** How far a `cd`/`pushd` statement reaches, given the operators around it. */
interface DirectoryChange {
  /** The scope's directory afterwards — unchanged when the `cd` ran in a subshell. */
  scope: string | null;
  /** Pre-`cd` directory the `||` else-branch runs in, when one follows. */
  elseDir?: string | null;
}

/**
 * Decide what a `cd <target>` does to the directories the walk tracks.
 *
 * Beside `|` or `&` it does nothing: that `cd` is a separate process, and the
 * parent shell — where the later statements run — never moves. Before `||` it
 * applies, but the else-branch it guards runs only on failure, so that one
 * statement belongs to the directory the shell was in beforehand.
 */
function applyDirectoryChange(
  target: string | undefined,
  dir: string | null,
  before: string | undefined,
  after: string | undefined,
): DirectoryChange {
  if (isSubshellEdge(before) || isSubshellEdge(after)) return { scope: dir };
  return { scope: joinPath(dir, target), elseDir: after === '||' ? dir : undefined };
}

/**
 * Walk the statements of a compound command left to right, tracking `cd` as it
 * goes, and return every frozen git invocation found.
 *
 * Directories are a stack rather than a single value because `(` opens a scope
 * the shell discards at the matching `)`: a `cd` inside a subshell applies to
 * the statements within it and to nothing after it.
 *
 * A `cd`'s reach also depends on the separators around it, so the walk reads
 * the operators as well as the statements:
 *   - beside `|` or `&` the `cd` is its own process and moves nothing the later
 *     statements can see (`cd /other | git switch dev` runs git in the *shared*
 *     checkout, and treating the `cd` as effective let it through);
 *   - before `||` the `cd` does apply, but the statement guarded by the `||`
 *     runs only when the `cd` *failed*, so that one statement is judged against
 *     the directory the shell was in beforehand. Both halves matter: without
 *     the first, `cd /missing || git rebase origin/dev` slips past; without the
 *     second, the routine `cd <worktree> || exit 1; git switch dev` is denied.
 */
function findFrozenInvocations(command: string, cwd: string | null): GitInvocation[] {
  const masked = maskOpaqueRegions(maskQuotedRegions(command));
  if (!/\bgit\b/.test(masked)) return [];
  // Capturing separators, so even indices are statements and odd are operators.
  const parts = masked.split(SEGMENT_SEPARATORS);
  const scopes: (string | null)[] = [cwd];
  const found: GitInvocation[] = [];
  /** One-shot override: the pre-`cd` directory an `||` else-branch runs in. */
  let elseDir: string | null | undefined;
  for (let p = 0; p < parts.length; p += 2) {
    const { tokens, opened, closed } = parseStatement(parts[p]);
    for (let n = 0; n < opened; n += 1) scopes.push(scopes[scopes.length - 1]);
    const dir = elseDir === undefined ? scopes[scopes.length - 1] : elseDir;
    elseDir = undefined;
    if (tokens[0] === 'cd' || tokens[0] === 'pushd') {
      const change = applyDirectoryChange(tokens[1], dir, parts[p - 1], parts[p + 1]);
      scopes[scopes.length - 1] = change.scope;
      elseDir = change.elseDir;
    } else if (tokens[0] === 'popd') {
      scopes[scopes.length - 1] = null;
    } else {
      const invocation = parseGitInvocation(tokens, dir);
      if (invocation && isFrozenInvocation(invocation)) found.push(invocation);
    }
    for (let n = 0; n < closed && scopes.length > 1; n += 1) scopes.pop();
  }
  return found;
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
  if (sessionCwd === null) return;

  // Only invocations whose directory resolved are decidable; the rest fail open.
  // Nothing below this point runs — no `git` subprocess — unless one survives.
  const targets = findFrozenInvocations(command, sessionCwd).filter(
    (invocation): invocation is GitInvocation & { dir: string } => invocation.dir !== null,
  );
  if (targets.length === 0) return;

  const sharedRoot = deps.resolveWorktreeRoot(sessionCwd);
  if (sharedRoot === null) return;

  const rootCache = new Map<string, string | null>();
  const rootOf = (dir: string): string | null => {
    if (!rootCache.has(dir)) rootCache.set(dir, deps.resolveWorktreeRoot(dir));
    return rootCache.get(dir) ?? null;
  };

  for (const target of targets) {
    if (rootOf(target.dir) === sharedRoot) {
      return {
        decision: 'deny',
        reason: denyReason(target.subcommand, sharedRoot),
      };
    }
  }
  return;
}
