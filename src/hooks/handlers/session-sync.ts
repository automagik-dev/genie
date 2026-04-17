/**
 * Session Sync Handler — PreToolUse (all tools) + UserPromptSubmit
 *
 * PTY-backed Claude sessions rotate their session_id whenever Claude Code
 * decides (resume, compaction, internal fork). The executor row created at
 * spawn keeps the ORIGINAL session_id, which means `genie resume` replays a
 * stale transcript against whatever `--resume <id>` Claude Code still
 * recognizes — the trace in task #6 showed this as the primary cause of
 * stale-resume bugs.
 *
 * This handler keeps `executors.claude_session_id` in sync with whatever
 * Claude Code is currently using by reading the live `payload.session_id`
 * from every hook invocation.
 *
 * Priority: 35 (runs after runtime-emit so event-log still sees the old ID
 * if anyone later wants to reconstruct the rotation timeline).
 *
 * Must never throw — PreToolUse is a blocking event, so a crash would
 * deny the tool use.
 */

import type { HandlerResult, HookPayload } from '../types.js';

/**
 * Process-local cache: executorId → last session_id we've written.
 * Avoids redundant DB round-trips on every tool call once we've already
 * reconciled the current session.
 */
const syncedSessions = new Map<string, string>();

export async function sessionSync(payload: HookPayload): Promise<HandlerResult> {
  try {
    const sessionId = payload.session_id;
    if (!sessionId || typeof sessionId !== 'string') return;

    if (process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test') return;

    const agentName = process.env.GENIE_AGENT_NAME ?? (payload.teammate_name as string | undefined);
    const teamName = process.env.GENIE_TEAM ?? (payload.team_name as string | undefined);
    if (!agentName || !teamName) return;

    const agentMod = await import('../../lib/agent-registry.js');
    const agent = await agentMod.getAgentByName(agentName, teamName);
    const executorId = agent?.currentExecutorId;
    if (!executorId) return;

    if (syncedSessions.get(executorId) === sessionId) return;

    const execMod = await import('../../lib/executor-registry.js');
    const executor = await execMod.getExecutor(executorId);
    if (!executor) return;

    if (executor.claudeSessionId !== sessionId) {
      await execMod.updateClaudeSessionId(executorId, sessionId);
    }
    syncedSessions.set(executorId, sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[session-sync] ${msg}`);
  }
  return;
}
