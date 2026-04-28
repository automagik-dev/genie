/**
 * CodexProvider — ExecutorProvider for Codex.
 *
 * Transport: api (fire-and-forget) + tmux pane.
 * State detection: pane-content based via `detectCodexState` (Group 1
 *   of codex-provider-parity wish — was previously a hardcoded 'working'
 *   stub, leaving genie ls/status blind to codex activity).
 * Session extraction: not supported (no JSONL — `~/.codex/sessions/`
 *   ingest tracked as Group 4 of codex-provider-parity).
 * Resume: not supported (codex's --fork is the upstream-owned mechanic).
 * Termination: best-effort SIGTERM when PID is available.
 */

import type {
  Executor,
  ExecutorProvider,
  ExecutorState,
  LaunchCommand,
  SpawnContext,
  TransportType,
} from '../executor-types.js';
import { detectCodexState, mapCodexToExecutorState } from '../orchestrator/codex-state.js';
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
   * Detect the current state of an executor via tmux pane capture +
   * codex-specific pattern matching (`detectCodexState`).
   *
   * Group 1 of codex-provider-parity wish: was a hardcoded 'working'
   * stub. Now mirrors ClaudeCodeProvider's pane-capture flow but
   * recognizes codex's prompt glyph (`›`), spinner glyphs, and
   * permission affordances.
   *
   * Falls back to 'working' (the prior stub behavior) if pane capture
   * fails — preserves "the worker is alive but state is uncertain"
   * semantics rather than mis-marking as 'idle' or 'terminated'.
   */
  async detectState(executor: Executor): Promise<ExecutorState> {
    if (executor.state === 'terminated' || executor.endedAt) return 'terminated';

    const paneId = executor.tmuxPaneId;
    if (!paneId) return 'working'; // No pane to inspect — keep prior semantics.

    try {
      const { capturePaneContent } = await import('../tmux.js');
      const content = await capturePaneContent(paneId, 50);
      if (!content || !content.trim()) return 'working';
      const result = detectCodexState(content);
      return mapCodexToExecutorState(result.type);
    } catch {
      // Pane gone or tmux not running — caller will reconcile via
      // pane-liveness probe; here we fall back to 'working' to avoid
      // false-positive transitions to terminated/idle.
      return 'working';
    }
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
    model: ctx.model,
    systemPromptFile: ctx.systemPromptFile,
    systemPrompt: ctx.systemPrompt,
    promptMode: ctx.promptMode,
    initialPrompt: ctx.initialPrompt,
    name: ctx.name,
    nativeTeam: ctx.nativeTeam,
    otelPort: ctx.otelPort,
    otelLogPrompts: ctx.otelLogPrompts,
    otelWishSlug: ctx.otelWishSlug,
  };
}
