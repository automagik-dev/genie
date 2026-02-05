/**
 * Spawn Command Builder
 *
 * Builds command strings for spawning Claude workers based on WorkerProfile configuration.
 * Supports both direct `claude` invocation and `claudio` (LLM router) invocation.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Worker profile configuration
 * Defines how to launch a Claude worker
 */
export interface WorkerProfile {
  /** Which binary to invoke: 'claude' (direct) or 'claudio' (via LLM router) */
  launcher: 'claude' | 'claudio';
  /** Claudio profile name (required if launcher is 'claudio') */
  claudioProfile?: string;
  /** CLI arguments passed to Claude Code */
  claudeArgs: string[];
}

/**
 * Options for building a spawn command
 */
export interface SpawnOptions {
  /** Session ID for new sessions (--session-id flag) */
  sessionId?: string;
  /** Session ID to resume (--resume flag) */
  resume?: string;
  /** Path to beads directory for BEADS_DIR env var */
  beadsDir?: string;
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

/**
 * Check if claudio binary is available on PATH
 */
export function hasClaudioBinary(): boolean {
  // @ts-ignore - Bun.which may not be in type definitions
  if (typeof (Bun as any).which === 'function') {
    return Boolean((Bun as any).which('claudio'));
  }
  // Fallback: assume available (will fail at runtime if not)
  return true;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Build a spawn command string based on profile and options
 *
 * @param profile - WorkerProfile defining launcher and args, or undefined for legacy fallback
 * @param options - SpawnOptions with sessionId, resume, and beadsDir
 * @returns Command string ready to be passed to tmux.executeCommand()
 * @throws Error if claudio launcher is specified but claudio binary is not found
 *
 * @example
 * // Claude profile
 * buildSpawnCommand({ launcher: 'claude', claudeArgs: ['--dangerously-skip-permissions'] }, { sessionId: 'abc' })
 * // Returns: "claude --dangerously-skip-permissions --session-id 'abc'"
 *
 * @example
 * // Claudio profile
 * buildSpawnCommand({ launcher: 'claudio', claudioProfile: 'coding-fast', claudeArgs: ['--dangerously-skip-permissions'] }, { sessionId: 'abc' })
 * // Returns: "claudio launch coding-fast -- --dangerously-skip-permissions --session-id 'abc'"
 *
 * @example
 * // Legacy fallback (no profile)
 * buildSpawnCommand(undefined, { sessionId: 'abc' })
 * // Returns: "claude --dangerously-skip-permissions --session-id 'abc'"
 */
export function buildSpawnCommand(
  profile: WorkerProfile | undefined,
  options: SpawnOptions
): string {
  const parts: string[] = [];

  // 1. Add BEADS_DIR env prefix if provided
  if (options.beadsDir) {
    parts.push(`BEADS_DIR='${escapeForShell(options.beadsDir)}'`);
  }

  // 2. Handle legacy fallback (no profile)
  if (!profile) {
    parts.push('claude');
    parts.push('--dangerously-skip-permissions');
  } else if (profile.launcher === 'claudio') {
    // 3. Claudio launcher: claudio launch <profile> -- <args>
    // Verify claudio binary is available
    if (!hasClaudioBinary()) {
      throw new Error(
        'claudio binary not found on PATH. ' +
        'Install claudio or use a "claude" launcher profile instead. ' +
        'See: https://github.com/automagik/claudio'
      );
    }
    parts.push('claudio');
    parts.push('launch');
    parts.push(`'${escapeForShell(profile.claudioProfile || 'default')}'`);
    parts.push('--');

    // Add claude args (escaped for shell safety)
    for (const arg of profile.claudeArgs) {
      parts.push(`'${escapeForShell(arg)}'`);
    }
  } else {
    // 4. Claude launcher: claude <args>
    parts.push('claude');

    // Add claude args (escaped for shell safety)
    for (const arg of profile.claudeArgs) {
      parts.push(`'${escapeForShell(arg)}'`);
    }
  }

  // 5. Add session-id or resume flag
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
