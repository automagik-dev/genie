/**
 * Spawn Command Builder
 *
 * Builds command strings for spawning Claude workers based on WorkerProfile configuration.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Worker profile configuration
 * Defines how to launch a Claude worker
 */
export interface WorkerProfile {
  /** Which binary to invoke */
  launcher: 'claude';
  /** CLI arguments passed to Claude Code */
  claudeArgs: string[];
}

/**
 * Options for building a spawn command
 */
interface SpawnOptions {
  /** Session ID for new sessions (--session-id flag) */
  sessionId?: string;
  /** Session ID to resume (--resume flag) */
  resume?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Escape a string for safe use in single-quoted shell arguments
 * Single quotes in the string are escaped as: '\''
 */
function escapeForShell(str: string): string {
  return str.replace(/'/g, "'\\''");
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Build a spawn command string based on profile and options
 *
 * @param profile - WorkerProfile defining launcher and args
 * @param options - SpawnOptions with sessionId and resume
 * @returns Command string ready to be passed to tmux.executeCommand()
 * @throws Error if no profile is provided
 *
 * @example
 * // Claude profile
 * buildSpawnCommand({ launcher: 'claude', claudeArgs: ['--dangerously-skip-permissions'] }, { sessionId: 'abc' })
 * // Returns: "claude '--dangerously-skip-permissions' --session-id 'abc'"
 */
export function buildSpawnCommand(profile: WorkerProfile | undefined, options: SpawnOptions): string {
  if (!profile) {
    throw new Error(
      'No worker profile configured. Please configure a worker profile in ~/.genie/config.json under "workerProfiles".',
    );
  }

  const parts: string[] = [];

  // Build command
  parts.push('claude');

  // Add claude args (escaped for shell safety)
  for (const arg of profile.claudeArgs) {
    parts.push(`'${escapeForShell(arg)}'`);
  }

  // Add session-id or resume flag
  // sessionId takes precedence over resume
  if (options.sessionId) {
    parts.push('--session-id');
    parts.push(`'${escapeForShell(options.sessionId)}'`);
  } else if (options.resume) {
    parts.push('--resume');
    parts.push(`'${escapeForShell(options.resume)}'`);
  }

  return parts.join(' ');
}
