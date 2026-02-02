import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

const exec = promisify(execCallback);

/**
 * Get the directory for tmux debug logs
 */
function getLogDir(): string {
  const logDir = join(homedir(), '.genie', 'logs', 'tmux');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

/**
 * Strip verbose flags (-v, -vv, -vvv, etc.) from tmux arguments
 */
function stripVerboseFlags(args: string[]): string[] {
  return args.filter(arg => !/^-v+$/.test(arg));
}

/**
 * Check if tmux debug mode is enabled via environment variable
 */
function isTmuxDebugEnabled(): boolean {
  return process.env.GENIE_TMUX_DEBUG === '1';
}

/**
 * Execute a tmux command with verbose flag filtering.
 *
 * By default, strips any -v flags to prevent debug logs from being created
 * in the current working directory.
 *
 * If GENIE_TMUX_DEBUG=1 is set, verbose logging is enabled and logs are
 * written to ~/.genie/logs/tmux/ instead.
 */
export async function executeTmux(args: string | string[]): Promise<string> {
  // Parse arguments
  const argList = typeof args === 'string' ? args.split(/\s+/).filter(Boolean) : args;

  // Strip verbose flags unless debug mode is explicitly enabled
  let finalArgs = stripVerboseFlags(argList);

  const debugMode = isTmuxDebugEnabled();
  const options: { cwd?: string } = {};

  if (debugMode) {
    // Re-add verbose flag and redirect logs to our log directory
    finalArgs = ['-v', ...finalArgs];
    options.cwd = getLogDir();
  }

  const command = `tmux ${finalArgs.join(' ')}`;
  const { stdout } = await exec(command, options);
  return stdout.trim();
}
