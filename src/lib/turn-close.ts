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
    const rows = await tx<{ state: string; outcome: string | null; agent_id: string }[]>`
      SELECT state, outcome, agent_id FROM executors
      WHERE id = ${executorId}
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new Error(`turnClose: executor ${executorId} not found`);
    }
    const row = rows[0];
    if (row.outcome !== null || TERMINAL_STATES.has(row.state)) {
      return {
        noop: true,
        executorId,
        outcome: (row.outcome as TurnOutcome | null) ?? opts.outcome,
        closedAt: null,
      };
    }

    const now = new Date().toISOString();
    await tx`
      UPDATE executors
      SET outcome = ${opts.outcome},
          closed_at = ${now},
          close_reason = ${reason},
          state = 'done',
          ended_at = ${now}
      WHERE id = ${executorId}
    `;

    await tx`
      UPDATE agents
      SET current_executor_id = NULL
      WHERE current_executor_id = ${executorId}
    `;

    await auditInsert(tx, {
      executorId,
      agentId: row.agent_id,
      outcome: opts.outcome,
      reason,
      actor,
    });

    return { noop: false, executorId, outcome: opts.outcome, closedAt: now };
  });
}
