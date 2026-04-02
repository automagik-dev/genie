/**
 * genie task board — Board management delegated under task namespace.
 * Creates a `board` subcommand on the task parent, delegating to board.ts internals.
 *
 * No conflict: `task board` doesn't exist in the base task.ts.
 */

import type { Command } from 'commander';
import { registerBoardCommands } from '../board.js';

export function registerTaskBoard(parent: Command): void {
  registerBoardCommands(parent);
}
