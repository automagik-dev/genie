/**
 * Spawn Command Builder
 *
 * Builds command strings for spawning Claude workers based on WorkerProfile configuration.
 * Also provides readiness detection for freshly-spawned agents via tmux pane inspection.
 */

import { detectState } from './orchestrator/index.js';
import { capturePaneContent } from './tmux.js';

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

// ============================================================================
// Readiness Detection
// ============================================================================

/** Default timeout for readiness detection (30s). */
export const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;

/** Polling interval for readiness checks (2s). */
export const READINESS_POLL_INTERVAL_MS = 2_000;

/** Result of a readiness check. */
export interface ReadinessResult {
  ready: boolean;
  elapsedMs: number;
}

/**
 * Wait for a spawned agent to become ready by polling tmux pane output.
 *
 * Readiness is detected via the orchestrator's `detectState()` which looks
 * for idle indicators (prompt characters, status bar idle state, etc.) and
 * tool_use patterns in the pane output.
 *
 * @param paneId - tmux pane ID to monitor (e.g. "%5")
 * @param opts.timeoutMs - Max wait time (default: GENIE_SPAWN_TIMEOUT_MS env or 30s)
 * @param opts.pollIntervalMs - Polling interval (default: 2s)
 * @returns ReadinessResult with ready flag and elapsed time
 */
export async function waitForAgentReady(
  paneId: string,
  opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<ReadinessResult> {
  const timeoutMs =
    opts?.timeoutMs ??
    (process.env.GENIE_SPAWN_TIMEOUT_MS ? Number(process.env.GENIE_SPAWN_TIMEOUT_MS) : DEFAULT_SPAWN_TIMEOUT_MS);
  const pollIntervalMs = opts?.pollIntervalMs ?? READINESS_POLL_INTERVAL_MS;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const content = await capturePaneContent(paneId, 50);
      if (content) {
        const state = detectState(content);
        if (state.type === 'idle' || state.type === 'tool_use') {
          return { ready: true, elapsedMs: Date.now() - start };
        }
      }
    } catch {
      /* pane not ready yet — keep polling */
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return { ready: false, elapsedMs: Date.now() - start };
}
