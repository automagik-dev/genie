/**
 * CodexProvider — Limited ExecutorProvider for Codex.
 *
 * Transport: api (fire-and-forget)
 * State detection: returns 'working' (API polling is future work)
 * Session extraction: not supported (no JSONL)
 * Resume: not supported
 * Termination: no-op (API cancel is future work)
 */

import type {
  Executor,
  ExecutorProvider,
  ExecutorState,
  LaunchCommand,
  SpawnContext,
  TransportType,
} from '../executor-types.js';
import type { SpawnParams } from '../provider-adapters.js';
import { buildCodexCommand } from '../provider-adapters.js';

// ============================================================================
// Provider Implementation
// ============================================================================

export class CodexProvider implements ExecutorProvider {
  readonly name = 'codex';
  readonly transport: TransportType = 'api';

  /**
   * Build the shell command to spawn a new Codex executor.
   *
   * Translates SpawnContext to SpawnParams and delegates to buildCodexCommand().
   */
  buildSpawnCommand(ctx: SpawnContext): LaunchCommand {
    const params = spawnContextToParams(ctx);
    return buildCodexCommand(params);
  }

  /**
   * Extract session metadata from a running executor.
   *
   * Codex has no JSONL logs or session tracking. Returns null.
   */
  async extractSession(_executor: Executor): Promise<{ sessionId: string; logPath?: string } | null> {
    return null;
  }

  /**
   * Detect the current state of an executor.
   *
   * Codex is fire-and-forget — returns 'working' for any non-terminated executor.
   * API-based state polling is future work.
   */
  async detectState(executor: Executor): Promise<ExecutorState> {
    if (executor.state === 'terminated' || executor.endedAt) return 'terminated';
    return 'working';
  }

  /**
   * Terminate the executor process.
   *
   * No-op for Codex. API cancellation is future work.
   * If a PID is available (unlikely for API transport), attempts SIGTERM.
   */
  async terminate(executor: Executor): Promise<void> {
    if (executor.pid) {
      try {
        process.kill(executor.pid, 'SIGTERM');
      } catch {
        // Process already gone
      }
    }
  }

  /** Codex does not support session resume. */
  canResume(): boolean {
    return false;
  }

  // buildResumeCommand is intentionally undefined — Codex cannot resume.

  /**
   * Deliver a message to a running executor.
   *
   * Codex has no native inbox — this is a no-op.
   * PG mailbox write happens separately in event-router (always).
   */
  async deliverMessage(_executorId: string, _message: { text: string; traceId: string }): Promise<void> {
    // No-op — Codex has no native inbox mechanism
  }
}

// ============================================================================
// Context Translator
// ============================================================================

/** Translate SpawnContext to the existing SpawnParams format for Codex. */
function spawnContextToParams(ctx: SpawnContext): SpawnParams {
  return {
    provider: 'codex',
    team: ctx.team,
    role: ctx.role,
    skill: ctx.skill,
    agentId: ctx.agentId,
    executorId: ctx.executorId,
    extraArgs: ctx.extraArgs,
  };
}
