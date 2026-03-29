/**
 * AppPtyProvider — ExecutorProvider for genie-app PTY terminals.
 *
 * Transport: process (bun-pty, no tmux)
 * State detection: via PTY session registry (not tmux capture-pane)
 * Session extraction: from executor metadata
 * Resume: supported (re-spawns claude with --resume)
 * Termination: kills PTY child process
 */

import type {
  Executor,
  ExecutorProvider,
  ExecutorState,
  LaunchCommand,
  ResumeContext,
  SpawnContext,
  TransportType,
} from '../executor-types.js';
import type { SpawnParams } from '../provider-adapters.js';
import { buildClaudeCommand } from '../provider-adapters.js';

// ============================================================================
// Provider Implementation
// ============================================================================

export class AppPtyProvider implements ExecutorProvider {
  readonly name = 'app-pty';
  readonly transport: TransportType = 'process';

  /**
   * Build the shell command to spawn a new Claude Code executor.
   * Same command as ClaudeCodeProvider but with GENIE_APP_PTY=true env var.
   */
  buildSpawnCommand(ctx: SpawnContext): LaunchCommand {
    const params = spawnContextToParams(ctx);
    const launch = buildClaudeCommand(params);
    return {
      ...launch,
      env: { ...launch.env, GENIE_APP_PTY: 'true' },
    };
  }

  /**
   * Extract session metadata from a running executor.
   * Uses the same JSONL discovery as ClaudeCodeProvider.
   */
  async extractSession(executor: Executor): Promise<{ sessionId: string; logPath?: string } | null> {
    const sessionId = executor.claudeSessionId;
    if (!sessionId) return null;

    const { access, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const claudeDir = join(process.env.HOME || '', '.claude', 'projects');

    try {
      await access(claudeDir);
    } catch {
      return { sessionId };
    }

    const jsonlName = `${sessionId}.jsonl`;

    if (executor.repoPath || executor.worktree) {
      const { projectPathToHash } = await import('../claude-logs.js');
      const path = (executor.repoPath ?? executor.worktree) as string;
      const hash = projectPathToHash(path);
      const candidate = join(claudeDir, hash, jsonlName);
      try {
        await access(candidate);
        return { sessionId, logPath: candidate };
      } catch {
        // Fall through
      }
    }

    try {
      const dirs = await readdir(claudeDir);
      for (const dir of dirs) {
        const candidate = join(claudeDir, dir, jsonlName);
        try {
          await access(candidate);
          return { sessionId, logPath: candidate };
        } catch {
          // Try next
        }
      }
    } catch {
      // Can't read projects dir
    }

    return { sessionId };
  }

  /**
   * Detect the current state of an executor.
   * For app-pty, we check the PID and executor metadata
   * rather than tmux pane capture.
   */
  async detectState(executor: Executor): Promise<ExecutorState> {
    if (!executor.pid) return 'terminated';

    try {
      // Check if process is still running
      process.kill(executor.pid, 0);
      // Process alive — check metadata for finer-grained state
      const metadata = executor.metadata as Record<string, unknown>;
      if (metadata.appPtyState && typeof metadata.appPtyState === 'string') {
        return metadata.appPtyState as ExecutorState;
      }
      return 'running';
    } catch {
      return 'terminated';
    }
  }

  /**
   * Terminate the executor process by killing the PID.
   */
  async terminate(executor: Executor): Promise<void> {
    if (!executor.pid) return;

    try {
      // Graceful: SIGTERM
      process.kill(executor.pid, 'SIGTERM');
      // Brief wait
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // Process already gone
    }

    try {
      // Forceful: SIGKILL if still alive
      process.kill(executor.pid, 0); // Check alive
      process.kill(executor.pid, 'SIGKILL');
    } catch {
      // Process already gone — acceptable
    }
  }

  /** Claude Code supports session resume. */
  canResume(): boolean {
    return true;
  }

  /** Build the command to resume an existing Claude session via PTY. */
  buildResumeCommand(ctx: ResumeContext): LaunchCommand {
    const params = resumeContextToParams(ctx);
    const launch = buildClaudeCommand(params);
    return {
      ...launch,
      env: { ...launch.env, GENIE_APP_PTY: 'true' },
    };
  }

  /** Deliver a message to a running executor via Claude Code's native inbox. */
  async deliverMessage(executorId: string, message: { text: string; traceId: string }): Promise<void> {
    const { getConnection } = await import('../db.js');
    const sql = await getConnection();

    const rows = await sql`
      SELECT a.custom_name, a.team
      FROM executors e
      JOIN agents a ON e.agent_id = a.id
      WHERE e.id = ${executorId}
      LIMIT 1
    `;
    if (rows.length === 0) return;

    const { custom_name: agentName, team: teamName } = rows[0];
    if (!agentName || !teamName) return;

    const { writeNativeInbox } = await import('../claude-native-teams.js');
    await writeNativeInbox(teamName, agentName, {
      from: 'system',
      text: message.text,
      summary: message.text.slice(0, 120),
      timestamp: new Date().toISOString(),
      color: 'red',
      read: false,
    });
  }
}

// ============================================================================
// Context Translators
// ============================================================================

function spawnContextToParams(ctx: SpawnContext): SpawnParams {
  return {
    provider: 'claude',
    team: ctx.team,
    role: ctx.role,
    skill: ctx.skill,
    agentId: ctx.agentId,
    executorId: ctx.executorId,
    extraArgs: ctx.extraArgs,
    model: ctx.model,
    sessionId: ctx.sessionId,
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

function resumeContextToParams(ctx: ResumeContext): SpawnParams {
  return {
    provider: 'claude',
    team: ctx.team,
    role: ctx.role,
    agentId: ctx.agentId,
    executorId: ctx.executorId,
    extraArgs: ctx.extraArgs,
    model: ctx.model,
    resume: ctx.claudeSessionId,
    nativeTeam: ctx.nativeTeam,
    otelPort: ctx.otelPort,
    otelLogPrompts: ctx.otelLogPrompts,
    otelWishSlug: ctx.otelWishSlug,
  };
}
