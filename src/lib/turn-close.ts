/**
 * Turn-close contract — write terminal outcome for the current executor.
 *
 * `genie done` / `genie blocked` / `genie failed` all funnel through this
 * function. It performs a single atomic transaction:
 *   1. Lock + read the executor row.
 *   2. If the executor is already closed (outcome set or terminal state),
 *      the call is a no-op and returns `{ noop: true }`.
 *   3. Otherwise UPDATE executors + UPDATE agents (clear FK) +
 *      INSERT audit_events in one transaction so a failure on any step
 *      rolls all writes back.
 *
 * The executor is resolved from `GENIE_EXECUTOR_ID` unless passed
 * explicitly. Callers that cannot resolve an executor (env unset)
 * receive a loud error.
 */

import { type Sql, getConnection } from './db.js';
import { emitEvent } from './emit.js';
import type { TurnOutcome } from './executor-types.js';

interface TurnCloseOpts {
  outcome: TurnOutcome;
  /** Free-form rationale. Required for 'blocked' and 'failed'. */
  reason?: string;
  /** Override env-resolved executor. Primarily for tests. */
  executorId?: string;
  /** Actor recorded on audit_events. Defaults to GENIE_AGENT_NAME or 'cli'. */
  actor?: string;
  /**
   * Optional audit insert hook. Used by tests to inject a failure and
   * verify transaction rollback. Default writes a real audit row inside
   * the transaction.
   */
  auditInsert?: (tx: Sql, payload: AuditPayload) => Promise<void>;
}

interface AuditPayload {
  executorId: string;
  agentId: string;
  outcome: TurnOutcome;
  reason: string | null;
  actor: string;
}

export interface TurnCloseResult {
  noop: boolean;
  executorId: string;
  outcome: TurnOutcome;
  closedAt: string | null;
}

const TERMINAL_STATES = new Set(['done', 'terminated', 'error']);

function resolveExecutorId(opts: TurnCloseOpts): string {
  const id = opts.executorId ?? process.env.GENIE_EXECUTOR_ID;
  if (!id) {
    throw new Error(
      'turnClose: no executor id — set GENIE_EXECUTOR_ID or pass opts.executorId. ' +
        'This usually means the close verb was invoked outside an agent session.',
    );
  }
  return id;
}

async function defaultAuditInsert(tx: Sql, p: AuditPayload): Promise<void> {
  await tx`
    INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
    VALUES (
      'executor',
      ${p.executorId},
      ${`turn_close.${p.outcome}`},
      ${p.actor},
      ${tx.json({ agent_id: p.agentId, outcome: p.outcome, reason: p.reason })}
    )
  `;
}

/**
 * Close out an agent's rows in the turn-close transaction.
 *
 * Flips the identity row's state to 'done' directly via the executor's
 * agent_id FK (not the reverse-FK sweep used pre-2026-04-21, which missed
 * dual-row legacy pairs and left name-keyed rows in state='spawning' that
 * reconcile then resurrected — see turn-session-contract Review Results
 * Gap #1).
 *
 * Also defensively sweeps any legacy name-keyed row sharing (custom_name, team)
 * so the dual-row pattern on pre-unification instances closes cleanly. Legacy
 * rows have `id = custom_name` and `custom_name IS NULL` (the partial unique
 * index `idx_agents_custom_name_team` blocks two rows from sharing non-null
 * custom_name), so the legacy row is addressable by id=${ident.custom_name}.
 * Becomes a no-op when `agents-runtime-extraction` lands.
 */
async function terminalizeAgentRows(tx: Sql, agentId: string): Promise<void> {
  const identRows = await tx<{ custom_name: string | null; team: string | null }[]>`
    UPDATE agents
    SET state = 'done', current_executor_id = NULL
    WHERE id = ${agentId}
    RETURNING custom_name, team
  `;
  const ident = identRows[0];
  if (!ident?.custom_name || !ident?.team || ident.custom_name === agentId) return;
  await tx`
    UPDATE agents
    SET state = 'done', current_executor_id = NULL
    WHERE id = ${ident.custom_name} AND team = ${ident.team}
  `;
}

type ExecutorRow = { state: string; outcome: string | null; agent_id: string };

async function lockExecutorRow(tx: Sql, executorId: string): Promise<ExecutorRow[]> {
  return tx<ExecutorRow[]>`
    SELECT state, outcome, agent_id FROM executors
    WHERE id = ${executorId}
    FOR UPDATE
  `;
}

/**
 * Bug E — executor row is a ghost (e.g. env UUID survived a pgserve reset
 * that wiped the row). Attempt fallback: resolve by the worker's
 * GENIE_AGENT_NAME env var, taking the most-recent live executor for that
 * agent. Emits `rot.executor-ghost.detected` on successful fallback so
 * operators can watch ghost-rate trends.
 *
 * Use GENIE_AGENT_NAME (not opts.actor) — the env var is set by the spawn
 * path and is the canonical agent identity for fallback resolution.
 * `opts.actor` can override just the audit actor.
 */
async function resolveGhostExecutor(
  tx: Sql,
  envExecutorId: string,
): Promise<{ effectiveId: string; rows: ExecutorRow[] } | null> {
  const agentName = process.env.GENIE_AGENT_NAME;
  if (!agentName) return null;
  // Tiebreaker: when two executors land in the same `started_at` microsecond
  // (real on Blacksmith / fast CI hardware), `ctid DESC` picks the
  // physically-last-inserted row, preserving insertion order deterministically.
  // ctid is stable for any row that has not been touched by VACUUM FULL — fine
  // for the ghost-recovery scenario where the rows of interest are seconds old
  // at most.
  const fallback = await tx<{ id: string }[]>`
    SELECT id FROM executors
    WHERE agent_id = ${agentName}
    ORDER BY started_at DESC, ctid DESC
    LIMIT 1
    FOR UPDATE
  `;
  if (fallback.length === 0) return null;
  const effectiveId = fallback[0].id;
  const rows = await lockExecutorRow(tx, effectiveId);
  console.warn(
    `[turn-close] executor ${envExecutorId} not found, falling back to agent_id='${agentName}' → ${effectiveId}`,
  );
  try {
    emitEvent(
      'rot.executor-ghost.detected',
      {
        resolution_source: 'resolver',
        env_id: envExecutorId,
        resolved_id: effectiveId,
        agent_name: agentName,
        recovered: true,
      },
      { severity: 'warn', source_subsystem: 'turn-close' },
    );
  } catch {
    // emit is best-effort — never block turn-close on observability.
  }
  return { effectiveId, rows };
}

async function loadExecutorOrRecover(tx: Sql, executorId: string): Promise<{ effectiveId: string; row: ExecutorRow }> {
  const rows = await lockExecutorRow(tx, executorId);
  if (rows.length > 0) return { effectiveId: executorId, row: rows[0] };

  const recovered = await resolveGhostExecutor(tx, executorId);
  if (recovered && recovered.rows.length > 0) {
    return { effectiveId: recovered.effectiveId, row: recovered.rows[0] };
  }

  const agentName = process.env.GENIE_AGENT_NAME;
  throw new Error(`turnClose: executor ${executorId} not found (no fallback by agent_id='${agentName ?? ''}')`);
}

async function commitTurnClose(
  tx: Sql,
  effectiveId: string,
  row: ExecutorRow,
  opts: TurnCloseOpts,
  reason: string | null,
  actor: string,
  auditInsert: NonNullable<TurnCloseOpts['auditInsert']>,
): Promise<TurnCloseResult> {
  const now = new Date().toISOString();
  await tx`
    UPDATE executors
    SET outcome = ${opts.outcome},
        closed_at = ${now},
        close_reason = ${reason},
        state = 'done',
        ended_at = ${now}
    WHERE id = ${effectiveId}
  `;
  await terminalizeAgentRows(tx, row.agent_id);
  await auditInsert(tx, {
    executorId: effectiveId,
    agentId: row.agent_id,
    outcome: opts.outcome,
    reason,
    actor,
  });
  return { noop: false, executorId: effectiveId, outcome: opts.outcome, closedAt: now };
}

export async function turnClose(opts: TurnCloseOpts): Promise<TurnCloseResult> {
  if ((opts.outcome === 'blocked' || opts.outcome === 'failed') && !opts.reason?.trim()) {
    throw new Error(`turnClose: --reason is required for outcome '${opts.outcome}'`);
  }

  const executorId = resolveExecutorId(opts);
  const actor = opts.actor ?? process.env.GENIE_AGENT_NAME ?? 'cli';
  const reason = opts.reason?.trim() || null;
  const auditInsert = opts.auditInsert ?? defaultAuditInsert;
  const sql = await getConnection();

  return sql.begin(async (tx: Sql) => {
    const { effectiveId, row } = await loadExecutorOrRecover(tx, executorId);
    if (row.outcome !== null || TERMINAL_STATES.has(row.state)) {
      return {
        noop: true,
        executorId: effectiveId,
        outcome: (row.outcome as TurnOutcome | null) ?? opts.outcome,
        closedAt: null,
      };
    }
    return commitTurnClose(tx, effectiveId, row, opts, reason, actor, auditInsert);
  });
}
