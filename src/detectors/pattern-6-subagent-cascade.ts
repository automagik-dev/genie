// Cross-ref: no OSS issue yet — Pattern 6 surfaced during wish execution 2026-04-18
/**
 * Pattern 6 — Subagent Cascade Detector.
 *
 * Rot condition:
 *   A parent agent is in `error` state, and at least TWO of its direct
 *   children (agents whose `reports_to` = parent.id) are also in `error`,
 *   with no `agent.lifecycle` recovery event for the parent observed since
 *   the parent first entered error.
 *
 * Why it matters:
 *   Isolated parent-error is recoverable (resume-attempt machinery). A
 *   cascade where the parent's error bled into its team is the distinct
 *   failure mode that needs operator intervention — we want a signal the
 *   moment the second child flips.
 *
 * Query shape:
 *   1. List all agents in error state (bounded — usually <20 at a time).
 *   2. For each parent candidate, join its children via `reports_to`.
 *   3. Filter children in error state.
 *   4. Cross-reference the parent's last `agent.lifecycle` recovery row via
 *      `genie_runtime_events` to confirm no recovery has been observed.
 *
 * Dependency injection:
 *   `makeSubagentCascadeDetector(deps)` accepts a `loadState` function for
 *   tests. Production wires PG. Tests pass a capture closure returning a
 *   fixture.
 *
 * Read-only discipline:
 *   No resume attempts, no state mutation. This V1 observes only.
 */

import { listAgents } from '../lib/agent-registry.js';
import { getConnection } from '../lib/db.js';
import { getCurrentExecutor } from '../lib/executor-registry.js';
import type { DetectorEvent, DetectorModule } from './index.js';
import { registerDetector } from './index.js';

/** One confirmed cascade after cross-referencing recovery events. */
export interface SubagentCascadeRow {
  readonly parent_id: string;
  /** Ordered child ids (insertion order). */
  readonly child_ids: ReadonlyArray<string>;
  readonly parent_errored_at: string;
  readonly children_errored_at: ReadonlyArray<string>;
  /** `null` if we could not confirm a recovery; string ISO timestamp otherwise. */
  readonly last_parent_recovery_at: string | null;
}

export interface SubagentCascadeState {
  readonly cascades: ReadonlyArray<SubagentCascadeRow>;
}

interface SubagentCascadeDeps {
  readonly loadState: () => Promise<SubagentCascadeState>;
}

/**
 * Production loader. The query budget is dominated by:
 *   1. `listAgents({})` — single round-trip.
 *   2. `getCurrentExecutor()` per parent candidate (indexed PK).
 *   3. One `SELECT created_at FROM genie_runtime_events WHERE ... ORDER BY
 *      id DESC LIMIT 1` per parent — bounded by the per-parent index on
 *      `(subject, created_at)`. Budget ~50ms total for <20 parent candidates.
 */
/** Build a parent->children index keyed by reports_to. */
function indexChildrenByParent<T extends { id: string; reportsTo?: string | null }>(
  all: ReadonlyArray<T>,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const a of all) {
    if (!a.reportsTo) continue;
    const bucket = out.get(a.reportsTo) ?? [];
    bucket.push(a);
    out.set(a.reportsTo, bucket);
  }
  return out;
}

/** Find every errored child by querying their executor rows. */
async function collectErroredChildren<T extends { id: string }>(
  children: ReadonlyArray<T>,
): Promise<Array<{ id: string; erroredAt: string }>> {
  const out: Array<{ id: string; erroredAt: string }> = [];
  for (const child of children) {
    const childExec = await getCurrentExecutor(child.id);
    if (childExec?.state !== 'error') continue;
    // `endedAt` is the canonical timestamp for terminal states (emitted by
    // `updateExecutorState`); fall back to `updatedAt` if endedAt is null.
    out.push({ id: child.id, erroredAt: childExec.endedAt ?? childExec.updatedAt });
  }
  return out;
}

/** Look up the latest recovery event for a parent since it last errored. */
async function loadLastParentRecovery(
  sql: Awaited<ReturnType<typeof getConnection>>,
  parentId: string,
  parentErroredAt: string,
): Promise<string | null> {
  const rows = await sql<{ created_at: Date | string }[]>`
    SELECT created_at FROM genie_runtime_events
    WHERE subject = ${parentId}
      AND kind = 'state'
      AND data->>'new_state' IN ('running', 'idle', 'done')
      AND created_at > ${parentErroredAt}
    ORDER BY id DESC
    LIMIT 1
  `;
  const raw = rows[0]?.created_at ?? null;
  if (raw === null) return null;
  return raw instanceof Date ? raw.toISOString() : String(raw);
}

/** Probe a single parent for cascade signals. */
async function probeParent<T extends { id: string }>(
  sql: Awaited<ReturnType<typeof getConnection>>,
  parent: T,
  children: ReadonlyArray<T>,
  byId: Map<string, T>,
): Promise<SubagentCascadeRow | null> {
  if (children.length < 2) return null;
  const parentExec = await getCurrentExecutor(parent.id);
  if (parentExec?.state !== 'error') return null;

  const erroredChildren = await collectErroredChildren(children);
  if (erroredChildren.length < 2) return null;

  const parentErroredAt = parentExec.endedAt ?? parentExec.updatedAt;
  const lastRecovery = await loadLastParentRecovery(sql, parent.id, parentErroredAt);
  // A recovery since the error clears the cascade — only fire when the
  // parent has NOT recovered.
  if (lastRecovery !== null) return null;

  // Defence against dangling `reports_to` FK if the child was archived
  // between the listAgents() snapshot and the executor probe.
  const known = erroredChildren.filter((c) => byId.has(c.id));
  if (known.length < 2) return null;

  return {
    parent_id: parent.id,
    child_ids: known.map((c) => c.id),
    parent_errored_at: parentErroredAt,
    children_errored_at: known.map((c) => c.erroredAt),
    last_parent_recovery_at: null,
  };
}

async function defaultLoadState(): Promise<SubagentCascadeState> {
  const all = await listAgents();
  const byId = new Map(all.map((a) => [a.id, a]));
  const childrenByParent = indexChildrenByParent(all);
  const sql = await getConnection();

  const cascades: SubagentCascadeRow[] = [];
  for (const parent of all) {
    const children = childrenByParent.get(parent.id) ?? [];
    const cascade = await probeParent(sql, parent, children, byId);
    if (cascade !== null) cascades.push(cascade);
  }
  return { cascades };
}

/** Build a `DetectorModule` around injected deps. */
export function makeSubagentCascadeDetector(deps: SubagentCascadeDeps): DetectorModule<SubagentCascadeState> {
  return {
    id: 'rot.subagent-cascade',
    version: '1.0.0',
    riskClass: 'high',
    async query(): Promise<SubagentCascadeState> {
      return deps.loadState();
    },
    shouldFire(state: SubagentCascadeState): boolean {
      return state.cascades.length > 0;
    },
    render(state: SubagentCascadeState): DetectorEvent {
      const first = state.cascades[0];
      return {
        type: 'rot.detected',
        subject: first?.parent_id ?? 'unknown',
        payload: {
          pattern_id: 'pattern-6-subagent-cascade',
          entity_id: first?.parent_id ?? 'unknown',
          observed_state_json: {
            parent_id: first?.parent_id ?? 'unknown',
            child_ids: (first?.child_ids ?? []).slice(0, 32) as string[],
            parent_errored_at: first?.parent_errored_at ?? '',
            children_errored_at: (first?.children_errored_at ?? []).slice(0, 32) as string[],
            last_parent_recovery_at: first?.last_parent_recovery_at ?? null,
            cascade_count: state.cascades.length,
            child_count: first?.child_ids.length ?? 0,
          },
        },
      };
    },
  };
}

// Production default — reads from real PG. Module-local on purpose so knip
// does not flag it; only the side-effect registration leaves this file.
const subagentCascadeDetector = makeSubagentCascadeDetector({
  loadState: defaultLoadState,
});

// Self-register at module load — the scheduler picks this up via
// `listDetectors()`.
registerDetector(subagentCascadeDetector);
