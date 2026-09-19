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
 *   - stdin is not a TTY (closed, `< /dev/null`, or piped)
 *   - `CI` environment variable is truthy (any non-empty value)
 *   - `--no-interactive` flag is present in process.argv
 *
 * The stdin clause is load-bearing, not belt-and-braces: a prompt READS stdin,
 * and @inquirer/prompts against a non-TTY stdin renders its question and then
 * busy-loops at 100% CPU without ever resolving (2026-09-15 dogfood B1). Any
 * caller that gates a prompt on this function must therefore see stdin too.
 */
export function isInteractive(): boolean {
  if (!process.stdout.isTTY) return false;
  if (!process.stdin.isTTY) return false;
  if (process.env.CI) return false;
  if (process.argv.includes('--no-interactive')) return false;
  return true;
}

// ─── Workspace Check Middleware ──────────────────────────────────────────────

/**
 * Commands that do NOT require a workspace.
 * These are matched against the root-level command name (first subcommand under `genie`).
 */
const WORKSPACE_EXEMPT = new Set([
  '__install-promote',
  'init',
  'setup',
  'doctor',
  'update',
  'install', // post-install finisher — invoked by install.sh from arbitrary cwd, before any workspace exists
  'uninstall',
  'shortcuts',
  'team',
  'version',
  'help',
  // `task` / `board` / `launch` are the v5 sqlite-backed commands. They
  // self-resolve their shared `.genie/genie.db` from the git common-dir (see
  // src/lib/v5/genie-db.ts) and never read the v4 `.genie/workspace.json`, so
  // gating them on the legacy workspace concept is wrong — it made
  // `genie task create` in a fresh repo exit 2, and `genie launch` die with a
  // dead-end "run genie init" message on any clean machine/CI (v5 `genie init`
  // deliberately never writes a workspace.json, so the gate could never be
  // satisfied). This whole workspace gate is v4-legacy and dies with the
  // harness in Group 3/5; exempting the v5 commands is the interim correct
  // behavior.
  'task',
  'board',
  // `context` is the read-only spawn-context contract verb. Like `task`/
  // `board` it self-resolves from the git common-dir and must work in a fresh
  // repo with no workspace.json.
  'context',
  // `idea` is the one-verb quick-capture (roadmap board's Idea lane). Same v5
  // sqlite-backed self-resolving DB as `task`/`board`; it must work in a fresh
  // repo with no workspace.json (QA: `genie idea` on a fresh repo).
  'idea',
  'launch',
  // `mikro` is the microagent runtime, whose whole point is that any repository
  // on a host with genie installed can run it. It reads a git checkout and
  // `<GENIE_HOME>/templates`, never `.genie/workspace.json`; gating it would
  // make the offload fail in exactly the repositories this command exists for.
  'mikro',
  // `mcp` is now a retirement stub: it writes the stable diagnostic to stderr and
  // exits 1. It touches no workspace state, so the legacy workspace gate must not
  // exit 2 and mask the retirement diagnostic callers are told to expect.
  'mcp',
  // `ui-bridge` is now a retirement stub too: the Orca integration replaced the
  // UI-owned stdio bridge, so the command only writes its stable diagnostic to
  // stderr and exits 1. It touches no workspace state, so the legacy workspace
  // gate must not exit 2 and mask the diagnostic callers are told to expect.
  'ui-bridge',
  // `config` is the read-only global-config reader. It resolves keys against
  // `<GENIE_HOME>/config.json` and the schema, never against a repo, so the
  // legacy per-repo workspace gate must not exit 2 on a machine that has a
  // config but no workspace — which is every fresh install.
  'config',
  // `orca` writes genie's lifecycle onto an Orca workspace card through the
  // Orca CLI. It reads no repo state at all — not `.genie/workspace.json`, not
  // `genie.db` — so the v4 workspace gate would exit 2 on every Orca-managed
  // worktree (none of which carries a workspace.json) and mask the verb's own
  // 0/1/2 contract.
  'orca',
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
