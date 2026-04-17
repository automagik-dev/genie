/**
 * Spawn Invocation Builder — Single source of truth for TUI spawn/team commands.
 *
 * The TUI renders a preview line for `genie spawn …` / `genie team create …`
 * and then executes the same command. Hand-assembling the preview string and
 * the argv list separately causes drift (missing quotes, forgotten escapes).
 *
 * This helper returns both shapes from a single intent:
 *   - `argv`: the exact argument array an executor passes to `child_process.spawn`
 *            (or to `genie` directly). Starts with the subcommand — NOT `genie`
 *            itself (the caller supplies the binary).
 *   - `cli` : a shell-ready single-line string, derivable from `argv` by
 *            `argv.map(shellQuote).join(' ')`. The round-trip invariant is
 *            enforced by unit tests.
 *
 * This is a pure library module. Groups 4–7 of the tui-spawn-dx wish will
 * consume it from the TUI render/execute layers.
 */

import { shellQuote } from './team-lead-command.js';

/**
 * A declarative description of a spawn-like CLI invocation.
 *
 * Member hiring for teams is intentionally NOT modelled here — that's a
 * follow-up sequence of `team hire` invocations, out of scope for this helper.
 */
export type SpawnIntent =
  | {
      kind: 'spawn-agent';
      name: string;
      team?: string;
      session?: string;
      window?: string;
      newWindow?: boolean;
      prompt?: string;
    }
  | {
      kind: 'create-team';
      name: string;
      repo?: string;
      members?: string[];
      baseBranch?: string;
    };

/**
 * Branch-safe name regex.
 *
 * A name must be non-empty and contain only characters that are valid in a
 * filesystem path / git branch component: letters, digits, dot, hyphen,
 * underscore, slash. No spaces, no shell metachars, no unicode punctuation.
 */
const SAFE_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

function assertNonEmptyName(field: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`buildSpawnInvocation: "${field}" is required and must be a non-empty string`);
  }
}

function assertSafeBranchName(field: string, value: string): void {
  if (!SAFE_BRANCH_NAME.test(value)) {
    throw new Error(
      `buildSpawnInvocation: "${field}" contains unsafe characters for a branch name (got ${JSON.stringify(value)}); allowed: letters, digits, '.', '_', '-', '/'`,
    );
  }
}

/**
 * Build the argv for a spawn-agent intent.
 *
 * Shape: ['spawn', name, '--team', team?, '--session', session?, '--window', window?, '--new-window'?, '--prompt', prompt?]
 */
function buildSpawnAgentArgv(intent: Extract<SpawnIntent, { kind: 'spawn-agent' }>): string[] {
  assertNonEmptyName('name', intent.name);

  const argv: string[] = ['spawn', intent.name];
  if (intent.team !== undefined && intent.team.length > 0) {
    argv.push('--team', intent.team);
  }
  if (intent.session !== undefined && intent.session.length > 0) {
    argv.push('--session', intent.session);
  }
  if (intent.window !== undefined && intent.window.length > 0) {
    argv.push('--window', intent.window);
  }
  if (intent.newWindow === true) {
    argv.push('--new-window');
  }
  if (intent.prompt !== undefined && intent.prompt.length > 0) {
    argv.push('--prompt', intent.prompt);
  }
  return argv;
}

/**
 * Build the argv for a create-team intent.
 *
 * Shape: ['team', 'create', name, '--repo', repo?, '--base', baseBranch?]
 *
 * `members` on the intent is accepted for descriptor completeness but NOT
 * appended to argv — hiring members is a follow-up sequence of `genie team
 * hire …` invocations, handled by later wish groups.
 */
function buildCreateTeamArgv(intent: Extract<SpawnIntent, { kind: 'create-team' }>): string[] {
  assertNonEmptyName('name', intent.name);
  assertSafeBranchName('name', intent.name);

  const argv: string[] = ['team', 'create', intent.name];
  if (intent.repo !== undefined && intent.repo.length > 0) {
    argv.push('--repo', intent.repo);
  }
  if (intent.baseBranch !== undefined && intent.baseBranch.length > 0) {
    argv.push('--base', intent.baseBranch);
  }
  return argv;
}

/**
 * Build a {cli, argv} descriptor from a SpawnIntent.
 *
 * The returned `cli` is guaranteed to satisfy:
 *   argv.map(shellQuote).join(' ') === cli
 *
 * @throws Error if the intent is malformed (empty name, unsafe branch chars,
 *   unknown kind). The error message names the offending field.
 */
export function buildSpawnInvocation(intent: SpawnIntent): { cli: string; argv: string[] } {
  let argv: string[];
  switch (intent.kind) {
    case 'spawn-agent':
      argv = buildSpawnAgentArgv(intent);
      break;
    case 'create-team':
      argv = buildCreateTeamArgv(intent);
      break;
    default: {
      // Exhaustiveness check — if a new kind is added to SpawnIntent, the
      // compiler will flag this. At runtime we still throw a clear error.
      const exhaustive: never = intent;
      throw new Error(
        `buildSpawnInvocation: unknown intent "kind" (got ${JSON.stringify((exhaustive as { kind?: unknown })?.kind)})`,
      );
    }
  }

  const cli = argv.map(shellQuote).join(' ');
  return { cli, argv };
}
