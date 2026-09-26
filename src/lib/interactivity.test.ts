import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { commandRequiresWorkspace } from './interactivity.js';

/**
 * `WORKSPACE_EXEMPT` is a private set, so it is pinned through the one function
 * that reads it. Until this file existed nothing pinned that set at all, and the
 * v4 workspace gate silently owned which verbs work outside a genie workspace:
 * a verb dropped from the set starts prompting for `genie init` (interactive) or
 * exiting 2 (everywhere else) in exactly the repositories it exists for.
 */

/** Build `genie <root> [<sub>]` and return the command the action would run on. */
function actionCommand(root: string, sub?: string): Command {
  const program = new Command('genie');
  const group = program.command(root);
  if (sub === undefined) return group;
  return group.command(sub);
}

describe('the v4 workspace gate exempts every verb that must run outside a genie workspace', () => {
  test.each([
    // `wish lint` is the whole reason this verb exists: it reports on ANOTHER
    // repository's `.genie/wishes`, so a workspace gate would refuse or prompt
    // in every repository it is meant for. Removing 'wish' from WORKSPACE_EXEMPT
    // fails here.
    ['wish', 'lint'],
    // The retired `orca` stub reads no repository state; a host script calling
    // it from an Orca-managed worktree must reach its retirement notice.
    ['orca', 'mirror'],
    // The microagent runtime, for the same reason.
    ['mikro', 'call'],
    // Lifecycle verbs that run before any workspace can exist.
    ['init', undefined],
    ['setup', undefined],
    ['doctor', undefined],
    ['update', undefined],
    ['install', undefined],
    ['uninstall', undefined],
    ['shortcuts', undefined],
    ['help', undefined],
    // The v5 SQLite-backed verbs self-resolve from the git common dir.
    ['task', 'create'],
    ['board', undefined],
    ['context', undefined],
    ['idea', undefined],
    // Read-only global config.
    ['config', 'get'],
  ] as Array<[string, string | undefined]>)('genie %s %s requires no workspace', (root, sub) => {
    expect(commandRequiresWorkspace(actionCommand(root, sub))).toBe(false);
  });

  test('a verb that is not exempt still requires a workspace', () => {
    expect(commandRequiresWorkspace(actionCommand('not-a-real-genie-verb'))).toBe(true);
  });
});
