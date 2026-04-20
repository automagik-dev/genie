/**
 * Pane-exit trap — safety net for the turn-session contract.
 *
 * When an agent's pane or shell dies without first calling a close verb
 * (`genie done` / `blocked` / `failed`), the executor row is left in a
 * non-terminal state. The legacy reconciler would happily ghost-resume
 * such a row. This module is the layered-defense counterpart to the
 * close verbs: it writes `outcome='clean_exit_unverified'`,
 * `state='error'`, `close_reason=<pane_died|shell_exit>` so the row is
 * unambiguously terminal.
 *
 * Idempotency rule (first writer wins):
 *   • If `closed_at IS NOT NULL` → the trap is a no-op. The explicit
 *     close verb already wrote the ground-truth outcome; we never
 *     overwrite that.
 *   • If `closed_at IS NULL` → trap writes the `clean_exit_unverified`
 *     outcome inside a single transaction.
 *
 * Two install paths are covered here:
 *   • tmux `pane-died` hook, per-pane, installed after spawn.
 *   • Shell `trap ... EXIT` snippet, prepended to inline launch commands.
 *
 * SDK transport remains a known gap (documented in WISH.md Group 5 #5).
 * That surface is addressed separately by `unified-executor-layer`.
 */

import { type Sql, getConnection, isAvailable } from './db.js';
import type { TurnOutcome } from './executor-types.js';

export type TrapReason = 'pane_died' | 'shell_exit';

interface TrapPaneExitOpts {
  /** Prefer this when available — fastest lookup. */
  executorId?: string;
  /** Fallback lookup when only the tmux pane id is known. */
  paneId?: string;
  /** Which trap fired. Written to `close_reason` for forensic clarity. */
  reason?: TrapReason;
  /** Actor recorded on the audit row. */
  actor?: string;
}

interface TrapPaneExitResult {
  noop: boolean;
  executorId: string | null;
  outcome: TurnOutcome | null;
  reason: TrapReason | null;
}

const TRAP_OUTCOME: TurnOutcome = 'clean_exit_unverified';

async function resolveExecutorId(
  sql: Sql,
  opts: TrapPaneExitOpts,
): Promise<{ id: string | null; source: 'executorId' | 'paneId' | 'none' }> {
  if (opts.executorId) return { id: opts.executorId, source: 'executorId' };
  if (opts.paneId) {
    // Prefer the most-recently-started executor bound to this pane:
    // tmux can reuse a pane id across spawns within a server lifetime.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM executors
      WHERE tmux_pane_id = ${opts.paneId}
      ORDER BY started_at DESC
      LIMIT 1
    `;
    if (rows.length > 0) return { id: rows[0].id, source: 'paneId' };
  }
  return { id: null, source: 'none' };
}

/**
 * Write the trap outcome for an executor, idempotently. Returns `noop=true`
 * when the executor is already closed (by an explicit verb or a prior
 * trap firing) so callers can log the distinction without branching.
 *
 * The function NEVER throws: a dying pane is a bad moment to fail. Any
 * DB error is logged to stderr and swallowed.
 */
export async function trapPaneExit(opts: TrapPaneExitOpts): Promise<TrapPaneExitResult> {
  const reason: TrapReason = opts.reason ?? 'pane_died';
  const actor = opts.actor ?? process.env.GENIE_AGENT_NAME ?? 'pane-trap';
  const result: TrapPaneExitResult = { noop: true, executorId: null, outcome: null, reason: null };

  try {
    if (!(await isAvailable())) return result;
    const sql = await getConnection();
    const resolved = await resolveExecutorId(sql, opts);
    if (!resolved.id) return result;
    const executorId = resolved.id;
    result.executorId = executorId;

    return await sql.begin(async (tx: Sql) => {
      const rows = await tx<{ state: string; outcome: string | null; closed_at: Date | null; agent_id: string }[]>`
        SELECT state, outcome, closed_at, agent_id FROM executors
        WHERE id = ${executorId}
        FOR UPDATE
      `;
      if (rows.length === 0) return result;
      const row = rows[0];
      if (row.closed_at !== null || row.outcome !== null) {
        // Explicit close verb already ran, or a prior trap firing already
        // wrote — first writer wins.
        return { noop: true, executorId, outcome: row.outcome as TurnOutcome | null, reason: null };
      }

      const now = new Date().toISOString();
      await tx`
        UPDATE executors
        SET outcome = ${TRAP_OUTCOME},
            closed_at = ${now},
            close_reason = ${reason},
            state = 'error',
            ended_at = ${now}
        WHERE id = ${executorId}
      `;

      await tx`
        UPDATE agents
        SET current_executor_id = NULL
        WHERE current_executor_id = ${executorId}
      `;

      await tx`
        INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
        VALUES (
          'executor',
          ${executorId},
          ${'turn_close.clean_exit_unverified'},
          ${actor},
          ${tx.json({ agent_id: row.agent_id, outcome: TRAP_OUTCOME, reason })}
        )
      `;

      return { noop: false, executorId, outcome: TRAP_OUTCOME, reason };
    });
  } catch (err) {
    // Do not throw — the pane is already dying. Log and return.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pane-trap] swallowed error: ${msg}`);
    return result;
  }
}

// ============================================================================
// Install helpers — pure builders so tests can assert on the resulting strings
// without talking to a real tmux server.
// ============================================================================

/**
 * Build the `tmux set-hook` arguments that wire `pane-died` to a
 * shell command which invokes `genie pane-trap --pane-id=#{hook_pane}`.
 *
 * Hooks are installed per-pane (`set-hook -p -t <paneId>`) so other
 * panes in the same window are unaffected. The `#{hook_pane}` format
 * is expanded by tmux at fire time to the dying pane's id, which is
 * how we correlate back to the executor in PG.
 */
export function buildPaneDiedHookCmd(paneId: string, genieBin = 'genie'): string {
  // `run-shell` spawns a short-lived shell; we intentionally background
  // the trap writer so tmux isn't blocked on a PG round-trip while
  // tearing the pane down.
  const inner = `${genieBin} pane-trap --pane-id=#{hook_pane} --reason=pane_died &`;
  const escaped = inner.replace(/"/g, '\\"');
  return `set-hook -p -t '${paneId}' pane-died "run-shell \\"${escaped}\\""`;
}

/**
 * Install the pane-died hook on a specific tmux pane. Best-effort: if
 * tmux is unavailable or the pane is already dead, the failure is
 * swallowed so spawn itself never breaks.
 */
export async function installTmuxPaneDiedHook(paneId: string, genieBin = 'genie'): Promise<void> {
  if (!paneId || paneId === 'inline' || !/^%\d+$/.test(paneId)) return;
  try {
    const { executeTmux } = await import('./tmux-wrapper.js');
    await executeTmux(buildPaneDiedHookCmd(paneId, genieBin));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pane-trap] failed to install pane-died hook on ${paneId}: ${msg}`);
  }
}

/**
 * Build a shell `trap ... EXIT` snippet that fires the trap on clean
 * shell exit. Intended to be prepended to the inline launch command,
 * e.g. via `prependEnvVars`-style splicing.
 *
 * The snippet calls the genie CLI synchronously so the DB write
 * completes before the shell fully exits — unlike the tmux path, there
 * is no supervisor to outlive us here.
 *
 * Relies on $GENIE_EXECUTOR_ID being exported into the shell's
 * environment by the spawn path (Group 3 contract).
 */
export function shellExitTrapSnippet(genieBin = 'genie'): string {
  // Single-quoted body so it evaluates at trap fire time, not at registration.
  // `|| true` prevents the trap from changing the shell's exit code.
  return `trap '${genieBin} pane-trap --executor-id="$GENIE_EXECUTOR_ID" --reason=shell_exit >/dev/null 2>&1 || true' EXIT`;
}
