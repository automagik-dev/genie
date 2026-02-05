/**
 * Session Namespace - Tmux primitives
 *
 * Groups all low-level tmux session management commands under `term session`.
 * These are the building blocks, but most users will use higher-level
 * worker commands (spawn, work) instead.
 *
 * Commands:
 *   term session new <name>     - Create tmux session
 *   term session ls             - List sessions
 *   term session attach <name>  - Attach to session
 *   term session rm <name>      - Remove session
 *   term session exec <n> <cmd> - Execute command
 *   term session send <n> <keys>- Send keys
 *   term session read <n>       - Read output
 *   term session info <n>       - Session state
 *   term session split <n>      - Split pane
 *   term session window <sub>   - Window management
 *   term session pane <sub>     - Pane management
 */

import { Command } from 'commander';

// Re-export from existing command files
export * as newCmd from '../new.js';
export * as lsCmd from '../ls.js';
export * as attachCmd from '../attach.js';
export * as rmCmd from '../rm.js';
export * as execCmd from '../exec.js';
export * as sendCmd from '../send.js';
export * as readCmd from '../read.js';
export * as statusCmd from '../status.js';
export * as splitCmd from '../split.js';
export * as windowCmd from '../window.js';
export * as paneCmd from '../pane.js';

/**
 * Register session subcommands on a parent command
 */
export function registerSessionCommands(program: Command): Command {
  const sessionProgram = program
    .command('session')
    .description('Tmux session management (low-level primitives)');

  // Import dynamically to avoid circular deps
  return sessionProgram;
}

/**
 * Deprecation warning helper
 */
export function showDeprecationWarning(oldCmd: string, newCmd: string): void {
  console.warn(`⚠️  '${oldCmd}' is deprecated. Use '${newCmd}' instead.`);
}
