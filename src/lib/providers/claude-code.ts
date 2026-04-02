/**
 * ClaudeCodeProvider — Full ExecutorProvider for Claude Code.
 *
 * Transport: tmux (pane per executor)
 * State detection: capture-pane + orchestrator patterns
 * Session extraction: JSONL discovery by claude_session_id
 * Resume: supported via `claude --resume <sessionId>`
 * Termination: C-c → kill-pane fallback
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

export class ClaudeCodeProvider implements ExecutorProvider {
  readonly name = 'claude-code';
  readonly transport: TransportType = 'tmux';

  /**
   * Build the shell command to spawn a new Claude Code executor.
   *
   * Translates SpawnContext to the existing SpawnParams format and delegates
   * to buildClaudeCommand(), preserving identical output.
   */
  buildSpawnCommand(ctx: SpawnContext): LaunchCommand {
    const params = spawnContextToParams(ctx);
    return buildClaudeCommand(params);
  }

  /**
   * Extract session metadata from a running executor.
   *
   * Discovers the JSONL log file by the executor's claude_session_id,
   * looking in the standard Claude projects directory.
   */
  async extractSession(executor: Executor): Promise<{ sessionId: string; logPath?: string } | null> {
    const sessionId = executor.claudeSessionId;
    if (!sessionId) return null;

    const logPath = await findSessionLogPath(sessionId, executor.repoPath ?? executor.worktree);
    return { sessionId, logPath: logPath ?? undefined };
  }

  /**
   * Detect the current state of an executor via tmux pane capture.
   *
   * Uses the orchestrator's pattern-based state detection on the last 50 lines
   * of pane output. Maps the detection result to ExecutorState.
   */
  async detectState(executor: Executor): Promise<ExecutorState> {
    const paneId = executor.tmuxPaneId;
    if (!paneId) return 'terminated';

    try {
      const { capturePaneContent } = await import('../tmux.js');
      const content = await capturePaneContent(paneId, 50);
      if (!content || !content.trim()) return 'idle';

      const { detectState: detect } = await import('../orchestrator/state-detector.js');
      const result = detect(content);

      return mapDetectedState(result.type);
    } catch {
      // Pane gone or tmux not running — executor is terminated
      return 'terminated';
    }
  }

  /**
   * Terminate the executor process.
   *
   * Strategy: send C-c (graceful) then kill the pane (forceful).
   * Falls back to process kill if PID is available and pane is gone.
   */
  async terminate(executor: Executor): Promise<void> {
    const { executeTmux } = await import('../tmux.js');
    const paneId = executor.tmuxPaneId;

    if (paneId) {
      try {
        // Graceful: send Ctrl-C
        await executeTmux(`send-keys -t '${paneId}' C-c`);
        // Brief wait for graceful shutdown
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        // Pane may already be gone
      }

      try {
        // Forceful: kill the pane
        await executeTmux(`kill-pane -t '${paneId}'`);
      } catch {
        // Pane already dead — acceptable
      }
    }

    // Belt-and-suspenders: kill PID if still alive
    if (executor.pid) {
      try {
        process.kill(executor.pid, 'SIGTERM');
      } catch {
        // Process already gone
      }
    }
  }

  /** Claude Code supports session resume. */
  canResume(): boolean {
    return true;
  }

  /**
   * Build the command to resume an existing Claude session.
   *
   * Translates ResumeContext to SpawnParams with the `resume` field set,
   * producing `claude --resume <sessionId>`.
   */
  buildResumeCommand(ctx: ResumeContext): LaunchCommand {
    const params = resumeContextToParams(ctx);
    return buildClaudeCommand(params);
  }

  /**
   * Deliver a message to a running executor via Claude Code's native inbox.
   *
   * Looks up the executor's team and agent name, then writes to
   * ~/.claude/teams/<team>/inboxes/<agent>.json.
   */
  async deliverMessage(executorId: string, message: { text: string; traceId: string }): Promise<void> {
    const { getConnection } = await import('../db.js');
    const sql = await getConnection();

    // Look up executor's agent team + name
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

/** Translate SpawnContext to the existing SpawnParams format. */
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

/** Translate ResumeContext to SpawnParams with `resume` set. */
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

// ============================================================================
// Session Discovery
// ============================================================================

/**
 * Find the JSONL log file for a given Claude session ID.
 *
 * Searches through Claude's project directories for a matching
 * `<sessionId>.jsonl` file, optionally scoping by project path.
 */
async function findSessionLogPath(sessionId: string, projectPath?: string | null): Promise<string | null> {
  const { access, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const claudeDir = join(process.env.HOME || '', '.claude', 'projects');

  try {
    await access(claudeDir);
  } catch {
    return null;
  }

  const jsonlName = `${sessionId}.jsonl`;

  // If we have a project path, check there first
  if (projectPath) {
    const { projectPathToHash } = await import('../claude-logs.js');
    const hash = projectPathToHash(projectPath);
    const candidate = join(claudeDir, hash, jsonlName);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Fall through to scan
    }
  }

  // Scan all project directories
  try {
    const dirs = await readdir(claudeDir);
    for (const dir of dirs) {
      const candidate = join(claudeDir, dir, jsonlName);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // File not found in this dir — try next
      }
    }
  } catch {
    // Can't read projects dir
  }

  return null;
}

// ============================================================================
// State Mapping
// ============================================================================

/**
 * Map orchestrator detection types to ExecutorState.
 *
 * The orchestrator returns a broader set of states including 'complete',
 * 'tool_use', and 'unknown' which need mapping to the executor model's
 * state enum.
 */
function mapDetectedState(
  detectedType: 'idle' | 'working' | 'permission' | 'question' | 'error' | 'complete' | 'tool_use' | 'unknown',
): ExecutorState {
  switch (detectedType) {
    case 'idle':
      return 'idle';
    case 'working':
    case 'tool_use':
      return 'working';
    case 'permission':
      return 'permission';
    case 'question':
      return 'question';
    case 'error':
      return 'error';
    case 'complete':
      return 'done';
    case 'unknown':
      return 'running';
  }
}
