/**
 * genie task project — Project management delegated under task namespace.
 * Creates a `project` subcommand on the task parent, delegating to project.ts internals.
 *
 * No conflict: `task project` doesn't exist in the base task.ts.
 */

import type { Command } from 'commander';
import { registerProjectCommands } from '../project.js';

export function registerTaskProject(parent: Command): void {
  registerProjectCommands(parent);
}
