/**
 * Tmux Launch Script — Write a temporary shell script for complex tmux spawns.
 *
 * Long commands with nested quotes, backticks, emojis, and JSON escapes corrupt
 * when passed through `tmux send-keys`. Writing the command to a script file and
 * sourcing it from the pane removes the escaping surface and keeps the launch
 * stable.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Write a temporary launch script for complex tmux spawns.
 *
 * @param workerId — identifier used in the filename (e.g. agent or chat id)
 * @param fullCommand — the complete shell command to execute
 * @returns absolute path to the written script
 */
export function writeTmuxLaunchScript(workerId: string, fullCommand: string): string {
  const dir = join(homedir(), '.genie', 'spawn-scripts');
  mkdirSync(dir, { recursive: true });
  const safeId = workerId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const scriptPath = join(dir, `${safeId}-${Date.now().toString(36)}.sh`);
  writeFileSync(scriptPath, `#!/bin/sh\n${fullCommand}\n`, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}
