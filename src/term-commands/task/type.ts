/**
 * genie task types — Task type management delegated under task namespace.
 *
 * Named `types` (plural) to avoid potential future conflict.
 * Delegates to existing type.ts handlers.
 */

import type { Command } from 'commander';
import { registerTypeCommands } from '../type.js';

export function registerTaskType(parent: Command): void {
  registerTypeCommands(parent);
}
