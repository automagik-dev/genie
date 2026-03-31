import { exec as execCallback } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tmuxBin } from './ensure-tmux.js';

const exec = promisify(execCallback);

/** Dedicated tmux socket name for all genie agent operations. */
const GENIE_TMUX_SOCKET = process.env.GENIE_TMUX_SOCKET || 'genie';

/**
 * Resolve the genie tmux config path.
 * Priority: ~/.genie/tmux.conf → shipped scripts/tmux/genie.tmux.conf → /dev/null
 */
function resolveGenieTmuxConf(): string {
  const home = homedir();
  const genieHome = process.env.GENIE_HOME ?? join(home, '.genie');
  const candidates = [join(genieHome, 'tmux.conf'), join(__dirname, '..', '..', 'scripts', 'tmux', 'genie.tmux.conf')];
  return candidates.find((p) => existsSync(p)) ?? '/dev/null';
}

/**
 * Build the tmux prefix args for the genie server: `-L <socket> -f <config>`.
 * Used by both the async wrapper and bare execSync calls that can't go through executeTmux().
 */
export function genieTmuxPrefix(): string[] {
  return ['-L', GENIE_TMUX_SOCKET, '-f', resolveGenieTmuxConf()];
}

/** Build a tmux command string prefixed with `-L genie -f <config>`. */
export function genieTmuxCmd(subcommand: string): string {
  return `${tmuxBin()} ${genieTmuxPrefix().join(' ')} ${subcommand}`;
}

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
  return args.filter((arg) => !/^-v+$/.test(arg));
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

  // Prepend genie server flags: -L genie -f <config>
  finalArgs = [...genieTmuxPrefix(), ...finalArgs];

  const command = `${tmuxBin()} ${finalArgs.join(' ')}`;
  const { stdout } = await exec(command, options);
  return stdout.trim();
}
