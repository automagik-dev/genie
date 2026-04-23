/**
 * Interactivity layer — gates all interactive prompts on TTY + CI + --no-interactive.
 *
 * Also provides `ensureWorkspace()` middleware that every workspace-requiring
 * command calls before executing. In interactive mode it offers to run `genie init`;
 * in non-interactive mode it exits with code 2.
 */

import type { Command } from 'commander';
import { findWorkspace } from './workspace.js';

// ─── Interactivity Detection ─────────────────────────────────────────────────

/**
 * Returns true if the current process can prompt the user interactively.
 *
 * Returns false when ANY of these are true:
 *   - stdout is not a TTY (piped output)
 *   - `CI` environment variable is truthy (any non-empty value)
 *   - `--no-interactive` flag is present in process.argv
 */
export function isInteractive(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.CI) return false;
  if (process.argv.includes('--no-interactive')) return false;
  return true;
}

// ─── Workspace Check Middleware ──────────────────────────────────────────────

/**
 * Commands that do NOT require a workspace.
 * These are matched against the root-level command name (first subcommand under `genie`).
 *
 * `hook` is exempt because Claude Code calls `genie hook dispatch` on every
 * PreToolUse / Stop / UserPromptSubmit event from whatever cwd the user's
 * editor or terminal happens to be in — often far outside any `.genie/`
 * workspace. If the hook exits non-zero (which `ensureWorkspace` did for
 * any missing-workspace cwd, because hook stdin is piped so `isInteractive`
 * is always false), Claude Code treats it as a blocking deny and the tool
 * call dies. That was the fleet-breaking P0 regression in #1295: one
 * non-zero exit from a single hook invocation blocks every tool call on
 * the host. Hooks must never gate on environmental state.
 */
const WORKSPACE_EXEMPT = new Set([
  'init',
  'setup',
  'doctor',
  'update',
  'uninstall',
  'shortcuts',
  'team',
  'version',
  'help',
  'hook',
]);

/**
 * Get the root command name (the first subcommand under the program).
 * For `genie serve` → "serve". For `genie team create` → "team".
 */
function getRootCommandName(cmd: Command): string {
  let current = cmd;
  while (current.parent?.parent) {
    current = current.parent;
  }
  return current.name();
}

/**
 * Check whether the given command requires a workspace.
 * Returns false for init, setup, doctor, update, uninstall, shortcuts.
 */
export function commandRequiresWorkspace(cmd: Command): boolean {
  return !WORKSPACE_EXEMPT.has(getRootCommandName(cmd));
}

/**
 * Ensure a workspace exists before a command runs.
 *
 * - If workspace found → returns immediately.
 * - If interactive and no workspace → prompts "No workspace found. Initialize? [Y/n]"
 *   - Yes → runs init inline (workspace is created, command continues)
 *   - No → exits with code 2
 * - If non-interactive → exits with code 2 with guidance message.
 */
export async function ensureWorkspace(): Promise<void> {
  const ws = findWorkspace();
  if (ws) return;

  if (!isInteractive()) {
    console.error('No workspace found. Run `genie init` to set up.');
    process.exit(2);
  }

  // Interactive mode — offer to initialize
  const { confirm } = await import('@inquirer/prompts');
  const shouldInit = await confirm({
    message: 'No workspace found. Initialize? [Y/n]',
    default: true,
  });

  if (!shouldInit) {
    console.error('No workspace found. Run `genie init` to set up.');
    process.exit(2);
  }

  // Run init inline — import dynamically to avoid circular deps
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { basename, join } = await import('node:path');

  const cwd = process.cwd();
  const genieDir = join(cwd, '.genie');
  mkdirSync(genieDir, { recursive: true });

  const config = {
    name: basename(cwd),
    agents: { defaults: {} },
    tmux: { socket: 'genie' },
    sdk: {},
  };

  writeFileSync(join(genieDir, 'workspace.json'), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Workspace initialized: ${cwd}`);

  // Original command will continue after this returns — workspace now exists
}

/**
 * Install `ensureWorkspace()` as a Commander preAction hook on the program.
 * Skips workspace-exempt commands (init, setup, doctor, etc.).
 */
export function installWorkspaceCheck(program: Command): void {
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    if (!commandRequiresWorkspace(actionCommand)) return;
    await ensureWorkspace();
  });
}
