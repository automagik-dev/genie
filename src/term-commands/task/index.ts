/**
 * Task Namespace — `genie task` subcommand group.
 *
 * Re-exports existing task commands from task.ts and adds:
 *   - status (from state.ts)
 *   - reset (from state.ts)
 *   - board (delegates to board.ts)
 *   - project (delegates to project.ts)
 *   - release-mgmt (delegates to release.ts)
 *   - type (delegates to type.ts)
 */

import type { Command } from 'commander';
import { registerTaskBoard } from './board.js';
import { registerTaskProject } from './project.js';
import { registerTaskReleaseMgmt } from './release-mgmt.js';
import { registerTaskReset } from './reset.js';
import { registerTaskStatus } from './status.js';
import { registerTaskType } from './type.js';

/**
 * Extend the existing `task` command group with absorbed commands.
 *
 * This function finds the existing `task` command registered by registerTaskCommands()
 * in genie.ts and adds the new subcommands to it.
 */
export function extendTaskCommands(program: Command): void {
  // Find the existing 'task' command registered by registerTaskCommands
  const taskCmd = program.commands.find((c) => c.name() === 'task');
  if (!taskCmd) {
    throw new Error('Task command not found — registerTaskCommands must be called before extendTaskCommands');
  }

  registerTaskStatus(taskCmd);
  registerTaskReset(taskCmd);
  registerTaskBoard(taskCmd);
  registerTaskProject(taskCmd);
  registerTaskReleaseMgmt(taskCmd);
  registerTaskType(taskCmd);
}
