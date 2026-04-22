/**
 * Executor Registry — CRUD for ephemeral executor process records.
 *
 * Executors are the runtime counterpart to agents: one agent can have many
 * executors over its lifetime, but only one is "current" at any time.
 * State lives here; agent identity is in agent-registry.
 */

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from './audit.js';
import { type Sql, getConnection } from './db.js';
import {
  type Executor,
  type ExecutorRow,
  type ExecutorState,
  type TransportType,
  rowToExecutor,
} from './executor-types.js';
import type { ProviderName } from './provider-adapters.js';

// ============================================================================
// Types
// ============================================================================

export interface CreateExecutorOpts {
  /** Pre-generated executor ID. If omitted, a UUID is generated. */
  id?: string;
  pid?: number | null;
  tmuxSession?: string | null;
  tmuxPaneId?: string | null;
  tmuxWindow?: string | null;
  tmuxWindowId?: string | null;
  claudeSessionId?: string | null;
  state?: ExecutorState;
  metadata?: Record<string, unknown>;
  worktree?: string | null;
  repoPath?: string | null;
  paneColor?: string | null;
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Create an executor record and return it.
 * Does NOT set agent.current_executor_id — caller should use
 * agent-registry.setCurrentExecutor() after creation.
 */
export async function createExecutor(
  agentId: string,
  provider: ProviderName,
  transport: TransportType,
  opts: CreateExecutorOpts = {},
): Promise<Executor> {
  const sql = await getConnection();
  const id = opts.id ?? randomUUID();
  const now = new Date().toISOString();

  const rows = await sql<ExecutorRow[]>`
    INSERT INTO executors (
      id, agent_id, provider, transport, pid,
      tmux_session, tmux_pane_id, tmux_window, tmux_window_id,
      claude_session_id, state, metadata, worktree, repo_path, pane_color,
      started_at
    ) VALUES (
      ${id}, ${agentId}, ${provider}, ${transport}, ${opts.pid ?? null},
      ${opts.tmuxSession ?? null}, ${opts.tmuxPaneId ?? null},
      ${opts.tmuxWindow ?? null}, ${opts.tmuxWindowId ?? null},
      ${opts.claudeSessionId ?? null}, ${opts.state ?? 'spawning'},
      ${sql.json(opts.metadata ?? {})}, ${opts.worktree ?? null},
      ${opts.repoPath ?? null}, ${opts.paneColor ?? null},
      ${now}
    ) RETURNING *
  `;

  return rowToExecutor(rows[0]);
}

/**
 * Atomically create an executor and set it as the agent's current executor.
 * Both operations happen in a single SQL transaction to prevent orphaned records.
 */
export async function createAndLinkExecutor(
  agentId: string,
  provider: ProviderName,
  transport: TransportType,
  opts: CreateExecutorOpts = {},
): Promise<Executor> {
  const sql = await getConnection();
  const id = opts.id ?? randomUUID();
  const now = new Date().toISOString();

  return sql.begin(async (tx: Sql) => {
    const rows = await tx<ExecutorRow[]>`
      INSERT INTO executors (
        id, agent_id, provider, transport, pid,
        tmux_session, tmux_pane_id, tmux_window, tmux_window_id,
        claude_session_id, state, metadata, worktree, repo_path, pane_color,
        started_at
      ) VALUES (
        ${id}, ${agentId}, ${provider}, ${transport}, ${opts.pid ?? null},
        ${opts.tmuxSession ?? null}, ${opts.tmuxPaneId ?? null},
        ${opts.tmuxWindow ?? null}, ${opts.tmuxWindowId ?? null},
        ${opts.claudeSessionId ?? null}, ${opts.state ?? 'spawning'},
        ${tx.json((opts.metadata ?? {}) as import('postgres').JSONValue)}, ${opts.worktree ?? null},
        ${opts.repoPath ?? null}, ${opts.paneColor ?? null},
        ${now}
      ) RETURNING *
    `;

    await tx`UPDATE agents SET current_executor_id = ${id} WHERE id = ${agentId}`;

    return rowToExecutor(rows[0]);
  });
}

/** Get an executor by ID. */
export async function getExecutor(id: string): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`SELECT * FROM executors WHERE id = ${id}`;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Get the current executor for an agent (via agents.current_executor_id). */
export async function getCurrentExecutor(agentId: string): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT e.* FROM executors e
    JOIN agents a ON a.current_executor_id = e.id
    WHERE a.id = ${agentId}
  `;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Update executor state with audit trail. */
export async function updateExecutorState(id: string, state: ExecutorState): Promise<void> {
  const sql = await getConnection();
  const updates: Record<string, unknown> = { state };
  if (state === 'terminated' || state === 'done' || state === 'error') {
    updates.ended_at = new Date().toISOString();
  }
  await sql`UPDATE executors SET ${sql(updates)} WHERE id = ${id}`;

  recordAuditEvent('executor', id, 'state_changed', process.env.GENIE_AGENT_NAME ?? 'cli', {
    state,
  }).catch(() => {});

  // Emit a dedicated ready event when executor reaches 'running' state
  if (state === 'running') {
    recordAuditEvent('executor', id, 'executor.ready', process.env.GENIE_AGENT_NAME ?? 'cli', {
      state,
      readiness_source: 'state_transition',
    }).catch(() => {});
  }
}

/** Terminate an executor: set state='terminated', ended_at=now(). */
export async function terminateExecutor(id: string): Promise<void> {
  const sql = await getConnection();
  const now = new Date().toISOString();
  await sql`
    UPDATE executors
    SET state = 'terminated', ended_at = ${now}
    WHERE id = ${id} AND state NOT IN ('terminated', 'done')
  `;

  recordAuditEvent('executor', id, 'terminated', process.env.GENIE_AGENT_NAME ?? 'cli').catch(() => {});
}

/**
 * Terminate the active executor for an agent and null the FK.
 * Used by the concurrent executor guard before spawning a new one.
 */
export async function terminateActiveExecutor(agentId: string): Promise<void> {
  const sql = await getConnection();

  // Get current executor ID
  const agentRows = await sql`SELECT current_executor_id FROM agents WHERE id = ${agentId}`;
  if (agentRows.length === 0 || !agentRows[0].current_executor_id) return;

  const executorId = agentRows[0].current_executor_id;

  // Terminate the executor
  await terminateExecutor(executorId);

  // Atomic null — only if still pointing to the same executor (prevents race with concurrent spawns)
  await sql`UPDATE agents SET current_executor_id = NULL WHERE id = ${agentId} AND current_executor_id = ${executorId}`;
}

/** List executors, optionally filtered by agent ID and/or metadata source. */
export async function listExecutors(agentId?: string, source?: string): Promise<Executor[]> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT * FROM executors
    WHERE true
    ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
    ${source ? sql`AND metadata->>'source' = ${source}` : sql``}
    ORDER BY started_at DESC
  `;
  return rows.map(rowToExecutor);
}

/** Find executor by tmux pane ID. */
export async function findExecutorByPane(paneId: string): Promise<Executor | null> {
  const sql = await getConnection();
  const normalized = paneId.startsWith('%') ? paneId : `%${paneId}`;
  const rows = await sql<ExecutorRow[]>`SELECT * FROM executors WHERE tmux_pane_id = ${normalized}`;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Find executor by Claude session ID. */
export async function findExecutorBySession(claudeSessionId: string): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT * FROM executors WHERE claude_session_id = ${claudeSessionId} LIMIT 1
  `;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/**
 * Find the latest live executor matching omni metadata.
 * Used for lazy resume: on bridge restart, look up an existing executor
 * for this agent + chat combination so we can reuse its Claude session.
 * Uses the `executors_omni_lookup` partial index (migration 026).
 */
export async function findLatestByMetadata(filter: {
  agentId: string;
  source: string;
  chatId: string;
}): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT * FROM executors
    WHERE agent_id = ${filter.agentId}
      AND metadata->>'source' = ${filter.source}
      AND metadata->>'chat_id' = ${filter.chatId}
      AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Relink an existing executor to an agent (set current_executor_id FK). */
export async function relinkExecutorToAgent(executorId: string, agentId: string): Promise<void> {
  const sql = await getConnection();
  await sql`UPDATE agents SET current_executor_id = ${executorId} WHERE id = ${agentId}`;
}

/** Update the Claude session ID on an executor row. */
export async function updateClaudeSessionId(executorId: string, sessionId: string): Promise<void> {
  const sql = await getConnection();
  await sql`UPDATE executors SET claude_session_id = ${sessionId} WHERE id = ${executorId}`;
}

/**
 * Single-reader chokepoint for every resume decision.
 *
 * Joins `agents.current_executor_id → executors.claude_session_id` and emits
 * one of two audit events:
 *   - `resume.found` when a session UUID is available for reuse.
 *   - `resume.missing_session` when there is no current executor, or the
 *     current executor has no captured session yet (with `reason` tagged
 *     so operators can tell `no_executor` from `null_session`).
 *
 * Returning `null` is load-bearing: callers that did NOT explicitly request a
 * resume (e.g., fresh spawns) treat `null` as "no prior session → start
 * clean". Callers that DID request a resume should throw a
 * `MissingResumeSessionError` on `null` (see Group 6).
 */
export async function getResumeSessionId(agentId: string): Promise<string | null> {
  const sql = await getConnection();
  const rows = await sql<{ executor_id: string | null; claude_session_id: string | null }[]>`
    SELECT a.current_executor_id AS executor_id, e.claude_session_id
    FROM agents a
    LEFT JOIN executors e ON e.id = a.current_executor_id
    WHERE a.id = ${agentId}
  `;

  if (rows.length === 0 || rows[0].executor_id === null) {
    await recordAuditEvent('agent', agentId, 'resume.missing_session', process.env.GENIE_AGENT_NAME ?? 'cli', {
      reason: 'no_executor',
    });
    return null;
  }

  const sessionId = rows[0].claude_session_id;
  const executorId = rows[0].executor_id;

  if (!sessionId) {
    await recordAuditEvent('agent', agentId, 'resume.missing_session', process.env.GENIE_AGENT_NAME ?? 'cli', {
      reason: 'null_session',
      executorId,
    });
    return null;
  }

  await recordAuditEvent('agent', agentId, 'resume.found', process.env.GENIE_AGENT_NAME ?? 'cli', {
    executorId,
    sessionId,
  });
  return sessionId;
}

/**
 * Record that the provider rejected a resume attempt for a session we believed
 * was live (e.g., Claude CLI refuses the `--resume <uuid>`). Callers invoke
 * this after a failed resume so operators can see the rejection in the audit
 * stream and correlate it with the originating `resume.found` event.
 */
export async function recordResumeProviderRejected(agentId: string, sessionId: string, reason: string): Promise<void> {
  await recordAuditEvent('agent', agentId, 'resume.provider_rejected', process.env.GENIE_AGENT_NAME ?? 'cli', {
    sessionId,
    reason,
  });
}

/**
 * Return an agent's current executor state iff it is live, else null.
 *
 * Used by `genie ls` to determine liveness for non-tmux transports (SDK, omni,
 * process) where `isPaneAlive` cannot apply — these agents carry synthetic pane
 * IDs like 'sdk' or '' that do not match tmux's `%N` format. The `executors.state`
 * column is the authoritative signal, updated by each transport's own heartbeat
 * (e.g., claude-sdk updates it on every message). Returning the state — not just
 * a boolean — lets the caller display it directly without a second query; the
 * cached `agents.state` column is stale for non-tmux transports.
 *
 * Treats `spawning|running|working|idle|permission|question` as live;
 * `done|error|terminated` and missing rows return null.
 */
export async function getLiveExecutorState(agentId: string): Promise<ExecutorState | null> {
  const sql = await getConnection();
  const rows = await sql<{ state: ExecutorState }[]>`
    SELECT e.state FROM executors e
    JOIN agents a ON a.current_executor_id = e.id
    WHERE a.id = ${agentId}
      AND e.state IN ('spawning', 'running', 'working', 'idle', 'permission', 'question')
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0].state : null;
}

/** Boolean convenience wrapper around {@link getLiveExecutorState}. */
export async function isExecutorAlive(agentId: string): Promise<boolean> {
  return (await getLiveExecutorState(agentId)) !== null;
}

/**
 * Transport-aware liveness check for a worker row.
 *
 * Dispatches on paneId shape:
 *   - tmux pane (`%N`) → `isPaneAliveFn(paneId)` (authoritative for tmux)
 *   - synthetic id (`sdk`, `inline`, `''`, etc.) → `isExecutorAliveFn(agentId)`
 *     which consults `executors.state` — the live signal for non-tmux transports.
 *
 * Unifies the five parallel call-sites that previously called `isPaneAlive`
 * blindly (PR #1167 + this sweep). Mirrors the `%\d+` regex-guard pattern from
 * `scheduler-daemon.ts:countActiveWorkers` and
 * `term-commands/agents.ts:resolveWorkerLiveness`.
 *
 * Test injection: both `isPaneAliveFn` and `isExecutorAliveFn` are overridable
 * so unit tests can exercise the branch logic without real tmux or PG.
 */
export async function resolveWorkerLivenessByTransport(
  worker: { id: string; paneId: string },
  opts?: {
    isPaneAliveFn?: (paneId: string) => Promise<boolean>;
    isExecutorAliveFn?: (agentId: string) => Promise<boolean>;
  },
): Promise<boolean> {
  if (/^%\d+$/.test(worker.paneId)) {
    const fn =
      opts?.isPaneAliveFn ??
      (async (pane: string) => {
        const { isPaneAlive } = await import('./tmux.js');
        return isPaneAlive(pane);
      });
    return fn(worker.paneId);
  }
  const fn = opts?.isExecutorAliveFn ?? isExecutorAlive;
  return fn(worker.id);
}
