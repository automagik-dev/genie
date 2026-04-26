/**
 * shouldResume — single-reader chokepoint for every "should this agent resume?" decision.
 *
 * Wish: invincible-genie / Group 1.
 *
 * Eight current consumer sites (`scheduler-daemon`, `protocol-router`,
 * `protocol-router-spawn`, `team-auto-spawn`, `term-commands/agents.ts × 3`,
 * et al.) reinvent the resume decision with subtle JOIN differences. That's
 * how `8b9b674e` overwrote `9623de43` on `d3fdeddd` — divergent reads of the
 * same joined state. The fix is one canonical reader, many displays.
 *
 * The decision itself fans out into three orthogonal axes:
 *   1. Does the agent have a session UUID we can replay?  → `getResumeSessionId`
 *      (DB happy path → JSONL on-disk fallback → null).
 *   2. Is its latest assignment still open?               → `assignments.outcome IS NULL`
 *      (a `done`/`failed` task agent should not be re-invoked even if a
 *      session UUID survives.)
 *   3. Is auto-resume allowed for this row?               → `agents.auto_resume`.
 *
 * Plus one rendering hint for the boot-pass:
 *   - `rehydrate`: 'eager' for permanent agents (team-leads, dir-row
 *     placeholders, root identities) — the boot pass should re-invoke them
 *     immediately. 'lazy' for task-bound agents — load identity, surface in
 *     `genie status` with an actionable verb, but do not auto-spawn.
 *
 * Permanence is read from the `agents.kind` GENERATED column (migration 049,
 * Group 3 of the wish). The schema computes `kind` via the inference rule
 * defined once in the migration; this module reads it directly so consumers
 * don't re-roll their own.
 */

import { recordAuditEvent } from './audit.js';
import { getConnection } from './db.js';
import { getResumeSessionId } from './executor-registry.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Outcome of a `shouldResume(agentId)` call. Every consumer surface (status
 * renderer, scheduler boot pass, manual `genie agent resume`, protocol router
 * spawn) reads from this single result.
 *
 * - `resume: true`  → caller should attempt a resume with `sessionId`.
 * - `resume: false` → caller should NOT re-invoke; see `reason` for the why.
 * - `sessionId`     → present iff a session UUID was located (DB or JSONL).
 *                     Note: `sessionId` may be present even when `resume`
 *                     is false (e.g., the latest assignment is closed but a
 *                     session UUID still exists for forensic display).
 * - `reason`        → machine-readable enum. See {@link ShouldResumeReason}.
 * - `rehydrate`     → boot-pass hint. 'eager' for permanent agents (re-invoke
 *                     immediately), 'lazy' for task-bound agents (surface
 *                     in `genie status` as `genie agent resume <name>`).
 */
export interface ShouldResumeResult {
  resume: boolean;
  reason: ShouldResumeReason;
  sessionId?: string;
  rehydrate: 'eager' | 'lazy';
}

export type ShouldResumeReason =
  /** Happy path: session UUID located and resume is permitted. */
  | 'ok'
  /** Agent row doesn't exist. */
  | 'unknown_agent'
  /** Auto-resume disabled (operator paused or scheduler exhausted retry budget). */
  | 'auto_resume_disabled'
  /** Latest assignment closed (task done/failed/abandoned/reassigned). */
  | 'assignment_closed'
  /** No current executor and no JSONL fallback succeeded. */
  | 'no_session_id';

// ============================================================================
// Implementation
// ============================================================================

interface AgentResumeRow {
  id: string;
  auto_resume: boolean | null;
  /** Schema-derived permanence label (migration 049). */
  kind: 'permanent' | 'task' | null;
  /** Outcome of the most-recent assignment (NULL when still open or no assignment exists). */
  latest_assignment_outcome: string | null;
}

/**
 * Read the canonical resume-decision inputs for a single agent: identity,
 * auto-resume flag, and the most-recent assignment outcome.
 *
 * Returns null for unknown agents so the caller can emit `unknown_agent`
 * without a second round-trip.
 */
async function readAgentResumeRow(agentId: string): Promise<AgentResumeRow | null> {
  const sql = await getConnection();
  const rows = await sql<AgentResumeRow[]>`
    SELECT
      a.id,
      a.auto_resume,
      a.kind,
      (
        SELECT asg.outcome
        FROM assignments asg
        JOIN executors e2 ON e2.id = asg.executor_id
        WHERE e2.agent_id = a.id
        -- id DESC is the tiebreaker: BIGSERIAL guarantees newer rows
        -- have larger ids, so when two assignments share a started_at
        -- (CI shared-pgserve frequently hits sub-millisecond collisions),
        -- insertion order still wins. Without this, ORDER BY started_at
        -- DESC alone is non-deterministic on the equality case and the
        -- test "most-recent assignment is the one consulted" flakes.
        ORDER BY asg.started_at DESC, asg.id DESC
        LIMIT 1
      ) AS latest_assignment_outcome
    FROM agents a
    WHERE a.id = ${agentId}
  `;
  return rows[0] ?? null;
}

/**
 * Schema-derived permanence (migration 049). The `kind` column is GENERATED
 * by the schema from the structural inference rule defined once in the
 * migration; this reader simply asks "is `kind = 'permanent'`?".
 *
 * Defaults to `false` (task) for the diagnostic case where `kind` is null —
 * that should never happen in production (the column is GENERATED ALWAYS),
 * but defaulting to task means a degraded row gets the safer "lazy" path.
 */
function isPermanent(row: Pick<AgentResumeRow, 'kind'>): boolean {
  return row.kind === 'permanent';
}

/**
 * Single-reader chokepoint for every resume decision.
 *
 * Joins the four signals (existence, auto-resume, latest-assignment-outcome,
 * session UUID lookup) and returns one structured result. Consumers (boot
 * pass, manual resume, protocol-router, status renderer) read from this and
 * never recompute the decision.
 *
 * Always returns — never throws. Errors looking up the session degrade to
 * `no_session_id` so the caller can decide how loud to be.
 */
export async function shouldResume(agentId: string): Promise<ShouldResumeResult> {
  const row = await readAgentResumeRow(agentId);

  if (!row) {
    // Unknown rows render as task-bound by default (we cannot prove
    // permanence without the row itself); the reason field is what the
    // caller actually keys off of.
    return { resume: false, reason: 'unknown_agent', rehydrate: 'lazy' };
  }

  const permanent = isPermanent(row);
  const rehydrate: 'eager' | 'lazy' = permanent ? 'eager' : 'lazy';

  // Auto-resume disabled trumps every other check — operator paused this row
  // or the scheduler exhausted its retry budget. Surface a session UUID if we
  // have one (status renderer wants it for display) but never resume=true.
  if (row.auto_resume === false) {
    const sessionId = await getResumeSessionId(agentId).catch(() => null);
    const result: ShouldResumeResult = {
      resume: false,
      reason: 'auto_resume_disabled',
      rehydrate,
    };
    if (sessionId) result.sessionId = sessionId;
    return result;
  }

  // Latest assignment closed → task agent is done. Permanent agents have no
  // (or always-open) assignments, so the closed-outcome filter naturally
  // skips them.
  if (row.latest_assignment_outcome !== null) {
    const sessionId = await getResumeSessionId(agentId).catch(() => null);
    const result: ShouldResumeResult = {
      resume: false,
      reason: 'assignment_closed',
      rehydrate,
    };
    if (sessionId) result.sessionId = sessionId;
    return result;
  }

  // Session-UUID lookup: DB happy path → JSONL fallback → null. This is the
  // existing canonical reader; we wrap it so callers never bypass it.
  const sessionId = await getResumeSessionId(agentId).catch(() => null);
  if (!sessionId) {
    return { resume: false, reason: 'no_session_id', rehydrate };
  }

  return { resume: true, reason: 'ok', sessionId, rehydrate };
}

// ============================================================================
// Boot-pass orchestration
// ============================================================================

/**
 * Per-agent boot-pass decision returned to the scheduler. The scheduler
 * already owns the side-effects (re-invoke / surface verb / log); this
 * function's job is to make the decision deterministic and observable.
 */
export interface BootPassDecision {
  agentId: string;
  decision: ShouldResumeResult;
  /** 'eager' = re-invoke now (permanent agents); 'lazy' = surface verb (task agents). */
  action: 'eager_invoke' | 'lazy_surface' | 'skip';
}

/**
 * Translate a `ShouldResumeResult` into a boot-pass action. Permanent agents
 * (`rehydrate: 'eager'`) with `resume: true` get re-invoked immediately;
 * task-bound agents get surfaced in `genie status` with an actionable verb
 * (`genie agent resume <name>`); unresumable rows are skipped (no-op for
 * the daemon, but emit the audit event so the operator can see why).
 */
export function classifyBootPass(agentId: string, decision: ShouldResumeResult): BootPassDecision {
  if (!decision.resume) return { agentId, decision, action: 'skip' };
  if (decision.rehydrate === 'eager') return { agentId, decision, action: 'eager_invoke' };
  return { agentId, decision, action: 'lazy_surface' };
}

/**
 * Map a `ShouldResumeResult` to the audit event type for the boot-pass.
 *
 * Per Measurer's methodology rule (no new event without a defined consumer +
 * action threshold), each event has a documented purpose:
 *
 *   - `agent.boot_pass.rehydrated`     — every agent the boot pass touched
 *     (info-only, consumed by `genie status` and metrics dashboards).
 *   - `agent.boot_pass.skipped_task_done` — task agent whose latest
 *     assignment is closed; revealed only via `genie status --all`.
 *   - `agent.boot_pass.eager_invoked`  — permanent agent re-invoked.
 *     `genie status` lights up RED if pending > 5 min for this agent
 *     after the event fired.
 *   - `agent.boot_pass.lazy_pending`   — task agent surfaced in `genie status`
 *     with `genie agent resume <name>` verb. No alert; this is steady state
 *     until the operator acts.
 */
export function bootPassEventType(action: BootPassDecision['action'], decision: ShouldResumeResult): string {
  if (action === 'eager_invoke') return 'agent.boot_pass.eager_invoked';
  if (action === 'lazy_surface') return 'agent.boot_pass.lazy_pending';
  if (decision.reason === 'assignment_closed') return 'agent.boot_pass.skipped_task_done';
  return 'agent.boot_pass.rehydrated';
}

/**
 * Concurrency cap on parallel `shouldResume()` calls during the boot pass.
 * 32 is the same cap used elsewhere in the codebase (executor-registry
 * `STAT_CONCURRENCY_CAP`) — small enough not to swamp PG, large enough that
 * 100 agents finish in well under the 30s 3am-runbook budget.
 */
export const BOOT_PASS_CONCURRENCY_CAP = 32;

/**
 * Run `shouldResume` over a list of agent IDs with bounded concurrency.
 * Failures degrade to `no_session_id` so a single PG hiccup can't wedge the
 * boot pass for the rest of the agents.
 */
export async function bootPassDecisions(agentIds: string[]): Promise<BootPassDecision[]> {
  const cap = Math.min(BOOT_PASS_CONCURRENCY_CAP, Math.max(1, agentIds.length));
  const results: BootPassDecision[] = new Array(agentIds.length);
  let cursor = 0;

  const workers = Array.from({ length: cap }, async () => {
    while (cursor < agentIds.length) {
      const i = cursor++;
      if (i >= agentIds.length) return;
      const agentId = agentIds[i];
      try {
        const decision = await shouldResume(agentId);
        results[i] = classifyBootPass(agentId, decision);
      } catch {
        const decision: ShouldResumeResult = { resume: false, reason: 'no_session_id', rehydrate: 'lazy' };
        results[i] = classifyBootPass(agentId, decision);
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Emit the boot-pass audit event for one decision. Best-effort: never blocks
 * the scheduler on an audit-write failure.
 */
export async function emitBootPassEvent(
  decision: BootPassDecision,
  actor: string = process.env.GENIE_AGENT_NAME ?? 'scheduler',
): Promise<void> {
  const eventType = bootPassEventType(decision.action, decision.decision);
  const details: Record<string, unknown> = {
    action: decision.action,
    reason: decision.decision.reason,
    rehydrate: decision.decision.rehydrate,
  };
  if (decision.decision.sessionId) details.sessionId = decision.decision.sessionId;
  await recordAuditEvent('agent', decision.agentId, eventType, actor, details);
}
