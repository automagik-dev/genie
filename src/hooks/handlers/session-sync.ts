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
 * from every hook invocation, and emits a `session.reconciled` audit event
 * whenever the stored UUID actually changes (loop 2 Gap 2).
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

/** Exposed for tests — clear the in-memory cache between assertions. */
export function _resetSyncedSessions(): void {
  syncedSessions.clear();
}

type GetAgentByNameFn = (name: string, team: string) => Promise<{ currentExecutorId?: string | null } | null>;
type GetExecutorFn = (id: string) => Promise<{ claudeSessionId?: string | null } | null>;
type UpdateClaudeSessionIdFn = (executorId: string, sessionId: string) => Promise<void>;
type EmitAuditEventFn = (
  entityType: string,
  entityId: string,
  eventType: string,
  actor: string | null,
  details: Record<string, unknown>,
) => Promise<void>;

/**
 * Overridable deps for testing. When left null, the handler lazy-imports the
 * real modules at call time. Tests that want to assert on emitted audit
 * events install a mock `emitAuditEvent` (and peers) via these fields and
 * reset them in `afterEach`.
 */
export const _deps: {
  getAgentByName: GetAgentByNameFn | null;
  getExecutor: GetExecutorFn | null;
  updateClaudeSessionId: UpdateClaudeSessionIdFn | null;
  emitAuditEvent: EmitAuditEventFn | null;
} = {
  getAgentByName: null,
  getExecutor: null,
  updateClaudeSessionId: null,
  emitAuditEvent: null,
};

async function resolveDeps() {
  const [agentMod, execMod, audit] = await Promise.all([
    _deps.getAgentByName ? null : import('../../lib/agent-registry.js'),
    _deps.getExecutor && _deps.updateClaudeSessionId ? null : import('../../lib/executor-registry.js'),
    _deps.emitAuditEvent ? null : import('../../lib/audit.js'),
  ]);
  return {
    getAgentByName: _deps.getAgentByName ?? (agentMod as typeof import('../../lib/agent-registry.js')).getAgentByName,
    getExecutor: _deps.getExecutor ?? (execMod as typeof import('../../lib/executor-registry.js')).getExecutor,
    updateClaudeSessionId:
      _deps.updateClaudeSessionId ?? (execMod as typeof import('../../lib/executor-registry.js')).updateClaudeSessionId,
    emitAuditEvent: _deps.emitAuditEvent ?? (audit as typeof import('../../lib/audit.js')).recordAuditEvent,
  };
}

function shouldSkipSync(payload: HookPayload): { sessionId: string; agentName: string; teamName: string } | null {
  const sessionId = payload.session_id;
  if (!sessionId || typeof sessionId !== 'string') return null;

  const hasOverrides = Object.values(_deps).some((v) => v !== null);
  if (!hasOverrides && (process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test')) return null;

  const agentName = process.env.GENIE_AGENT_NAME ?? (payload.teammate_name as string | undefined);
  const teamName = process.env.GENIE_TEAM ?? (payload.team_name as string | undefined);
  if (!agentName || !teamName) return null;

  return { sessionId, agentName, teamName };
}

export async function sessionSync(payload: HookPayload): Promise<HandlerResult> {
  try {
    const ctx = shouldSkipSync(payload);
    if (!ctx) return;

    const deps = await resolveDeps();
    const agent = await deps.getAgentByName(ctx.agentName, ctx.teamName);
    const executorId = agent?.currentExecutorId;
    if (!executorId) return;
    if (syncedSessions.get(executorId) === ctx.sessionId) return;

    const executor = await deps.getExecutor(executorId);
    if (!executor) return;

    const oldSessionId = executor.claudeSessionId ?? null;
    if (oldSessionId !== ctx.sessionId) {
      await deps.updateClaudeSessionId(executorId, ctx.sessionId);
      await deps.emitAuditEvent('executor', executorId, 'session.reconciled', ctx.agentName, {
        old_session_id: oldSessionId,
        new_session_id: ctx.sessionId,
        team: ctx.teamName,
      });
    }
    syncedSessions.set(executorId, ctx.sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[session-sync] ${msg}`);
  }
  return;
}
