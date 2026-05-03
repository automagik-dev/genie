/**
 * Agent Observability — canonical typed projection over `v_agent_observability`.
 *
 * Wish 3/5 of PR-1607 observability roadmap (agent-observability-snapshot).
 *
 * Every surface that needs to answer "what is this agent doing right now,
 * what's slow, what failed?" reads through this module — never re-joining
 * `agents` × `executors` × `sessions` × `tool_events` × `audit_events` ×
 * `genie_runtime_events` directly.
 *
 * The view (`src/db/migrations/059_agent_observability_view.sql`) computes
 * the join + 24h tool/usage aggregates server-side; this module:
 *
 *   1. Casts row types into a stable TS shape (camelCase, typed).
 *   2. Computes derived health flags (`stale_executor`, `missing_session`,
 *      `missing_attribution`, `recent_failure`, `cost_spike`,
 *      `high_hook_latency`).
 *   3. Provides classifier filters (`agent` vs `harness`).
 *
 * Read-only by contract. Never inserts into `audit_events` (that is the
 * write-amp regression closed by wish 2).
 */

import { getConnection } from './db.js';

// ============================================================================
// Schema version — emitted by JSON consumers as `_source` for debugging.
// ============================================================================

/**
 * Bump when the JSON shape changes in a backward-incompatible way. Surface
 * snapshots include this so an operator can tell which observability layer
 * served the row when comparing CLI / TUI / app outputs.
 */
export const AGENT_OBSERVABILITY_SCHEMA_VERSION = 1;

// ============================================================================
// Types
// ============================================================================

export type AgentClassification = 'agent' | 'harness';

export type HealthFlag =
  | 'stale_executor'
  | 'missing_session'
  | 'missing_attribution'
  | 'high_hook_latency'
  | 'recent_failure'
  | 'cost_spike';

/** One row from `v_agent_observability` after camelCase mapping. */
export interface AgentObservabilityRow {
  agentId: string;
  customName: string | null;
  role: string | null;
  team: string | null;
  kind: 'permanent' | 'task' | null;
  agentState: string | null;
  agentStartedAt: string | null;
  agentUpdatedAt: string | null;
  currentExecutorId: string | null;

  executorId: string | null;
  executorState: string | null;
  executorProvider: string | null;
  executorTransport: string | null;
  executorPid: number | null;
  executorTmuxPane: string | null;
  executorTmuxSession: string | null;
  executorStartedAt: string | null;
  executorUpdatedAt: string | null;
  executorEndedAt: string | null;
  claudeSessionId: string | null;

  sessionId: string | null;
  sessionStatus: string | null;
  sessionStartedAt: string | null;
  sessionTotalTurns: number | null;
  sessionExecutorId: string | null;
  sessionDisplayName: string | null;
  /** Which join path produced the session row (`executor_id` or `claude_session_id`). */
  sessionLinkSource: 'executor_id' | 'claude_session_id' | null;

  recentToolCount: number;
  recentErrorCount: number;
  recentLastToolAt: string | null;
  recentCostUsd: number;
  recentInputTokens: number;
  recentOutputTokens: number;

  classification: AgentClassification;
}

export interface HealthAssessment {
  flags: HealthFlag[];
  /** True iff at least one health flag is set. */
  degraded: boolean;
}

export interface AgentObservabilitySnapshot extends AgentObservabilityRow {
  health: HealthAssessment;
}

export interface ListAgentsOptions {
  /** Include rows whose classification is `harness`. Default: false. */
  includeHarness?: boolean;
  /** Maximum rows to return. Default: 500 (caller may override). */
  limit?: number;
}

// ============================================================================
// Health-flag thresholds — single source of truth for classification.
// ============================================================================

/**
 * An executor is "stale" when it claims to be live (`spawning`, `running`,
 * `working`, `idle`, `permission`, `question`) but its `updated_at` is
 * older than this window. The wish 1 regression closed by PR-1611 was
 * exactly this: executors that never wrote a heartbeat appeared "alive"
 * forever in surfaces.
 */
export const STALE_EXECUTOR_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Cost spike threshold (USD per 24h window). Tunable; chosen at the same
 * order of magnitude as a single long Opus run so a true outlier surfaces
 * without flagging routine work. Kept high to avoid alert fatigue while
 * the full per-agent baseline lands in a future wish.
 */
export const COST_SPIKE_USD_24H = 50;

/**
 * Live executor states — anything in this set is expected to keep
 * heartbeating, so missing recent updates count as `stale_executor`.
 */
const LIVE_EXECUTOR_STATES = new Set(['spawning', 'running', 'idle', 'working', 'permission', 'question']);

// ============================================================================
// Health flag computation
// ============================================================================

/**
 * Compute derived health flags from a row.
 * Pure function — no IO; safe to call inside list iterators.
 */
export function assessHealth(row: AgentObservabilityRow, now: number = Date.now()): HealthAssessment {
  const flags: HealthFlag[] = [];

  // stale_executor: live state but no heartbeat in the staleness window.
  if (row.executorId && row.executorState && LIVE_EXECUTOR_STATES.has(row.executorState)) {
    const updated = row.executorUpdatedAt ? Date.parse(row.executorUpdatedAt) : Number.NaN;
    if (Number.isFinite(updated) && now - updated > STALE_EXECUTOR_WINDOW_MS) {
      flags.push('stale_executor');
    }
  }

  // missing_session: agent has a current executor but no session linkage.
  if (row.currentExecutorId && !row.sessionId) {
    flags.push('missing_session');
  }

  // missing_attribution: agent row missing all naming/attribution context
  // (no custom name, no role) — typically a stale shadow row.
  if (!row.customName && !row.role) {
    flags.push('missing_attribution');
  }

  // recent_failure: any tool error in the last 24h.
  if (row.recentErrorCount > 0) {
    flags.push('recent_failure');
  }

  // cost_spike: 24h spend exceeds the configured threshold.
  if (row.recentCostUsd >= COST_SPIKE_USD_24H) {
    flags.push('cost_spike');
  }

  // NOTE: high_hook_latency is reserved for a follow-up wish that wires
  // the `hook_perf_baseline` view (migration 056/057) per-agent. Today
  // baseline rows aren't keyed on agent_id, so we expose the flag in the
  // type but never emit it. Surfacing this explicitly avoids breaking
  // consumers that iterate the union when the flag does land.

  return { flags, degraded: flags.length > 0 };
}

// ============================================================================
// Row mapping
// ============================================================================

function mapRow(row: Record<string, unknown>): AgentObservabilityRow {
  const cls = String(row.classification ?? 'agent') as AgentClassification;
  return {
    agentId: String(row.agent_id),
    customName: nullable(row.custom_name),
    role: nullable(row.role),
    team: nullable(row.team),
    kind: (nullable(row.kind) as 'permanent' | 'task' | null) ?? null,
    agentState: nullable(row.agent_state),
    agentStartedAt: tsString(row.agent_started_at),
    agentUpdatedAt: tsString(row.agent_updated_at),
    currentExecutorId: nullable(row.current_executor_id),

    executorId: nullable(row.executor_id),
    executorState: nullable(row.executor_state),
    executorProvider: nullable(row.executor_provider),
    executorTransport: nullable(row.executor_transport),
    executorPid: numericOrNull(row.executor_pid),
    executorTmuxPane: nullable(row.executor_tmux_pane),
    executorTmuxSession: nullable(row.executor_tmux_session),
    executorStartedAt: tsString(row.executor_started_at),
    executorUpdatedAt: tsString(row.executor_updated_at),
    executorEndedAt: tsString(row.executor_ended_at),
    claudeSessionId: nullable(row.claude_session_id),

    sessionId: nullable(row.session_id),
    sessionStatus: nullable(row.session_status),
    sessionStartedAt: tsString(row.session_started_at),
    sessionTotalTurns: numericOrNull(row.session_total_turns),
    sessionExecutorId: nullable(row.session_executor_id),
    sessionDisplayName: nullable(row.session_display_name),
    sessionLinkSource: nullable(row.session_link_source) as 'executor_id' | 'claude_session_id' | null,

    recentToolCount: numericOrZero(row.recent_tool_count),
    recentErrorCount: numericOrZero(row.recent_error_count),
    recentLastToolAt: tsString(row.recent_last_tool_at),
    recentCostUsd: numericOrZero(row.recent_cost_usd),
    recentInputTokens: numericOrZero(row.recent_input_tokens),
    recentOutputTokens: numericOrZero(row.recent_output_tokens),

    classification: cls === 'harness' ? 'harness' : 'agent',
  };
}

function nullable(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

function tsString(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function numericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numericOrZero(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ============================================================================
// Queries
// ============================================================================

/**
 * True when the postgres error matches a known environment-specific defect
 * that affects `v_claude_usage_events` aggregation rather than the
 * canonical view itself. Surfaces the full data when production-pgserve is
 * healthy; degrades cost/usage to zero (via `v_agent_observability_core`)
 * when the local install is broken.
 *
 * Errors recognised:
 *   - "could not open directory ... timezonesets" — pgserve install missing
 *     timezone metadata. Recurring on per-worktree pgserves; documented in
 *     wish 2 REPORT.md and wish 3 REPORT.md.
 *   - `could not access file "plpgsql"` — sibling worktree-pgserve issue.
 */
function isCostAggregateEnvDefect(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('timezonesets') || msg.includes('"plpgsql"');
}

/** Cost columns defaulted to zero when reading via `v_agent_observability_core`. */
const ZERO_COST_COLUMNS =
  ', 0::numeric AS recent_cost_usd, 0::bigint AS recent_input_tokens, 0::bigint AS recent_output_tokens';

/**
 * Fetch the observability snapshot for one agent by id, custom name, or role.
 * Returns null when no agent matches.
 *
 * Resolution order mirrors `genie agent show`:
 *   1. exact id match
 *   2. exact custom_name match (preferring current `GENIE_TEAM`)
 *   3. exact role match (preferring current `GENIE_TEAM`)
 */
export async function getAgentObservability(identifier: string): Promise<AgentObservabilitySnapshot | null> {
  const sql = await getConnection();
  const preferTeam = process.env.GENIE_TEAM ?? null;

  let queryResult: unknown;
  try {
    queryResult = await sql<Record<string, unknown>[]>`
      SELECT * FROM v_agent_observability
      WHERE agent_id = ${identifier}
         OR custom_name = ${identifier}
         OR role = ${identifier}
    `;
  } catch (err) {
    if (!isCostAggregateEnvDefect(err)) throw err;
    queryResult = await sql.unsafe(
      `SELECT *${ZERO_COST_COLUMNS} FROM v_agent_observability_core
       WHERE agent_id = $1 OR custom_name = $1 OR role = $1`,
      [identifier],
    );
  }
  const rows = queryResult as unknown as Record<string, unknown>[];

  if (rows.length === 0) return null;

  let row: Record<string, unknown>;
  if (rows.length === 1) {
    row = rows[0];
  } else {
    // Resolution order:
    //   1. UUID id match — caller passed the canonical UUID (and it isn't a
    //      bare-name identifier that also matches a `dir:` shadow row).
    //   2. row with a live executor — beats `dir:` shadow rows that share
    //      the same role/name but never carry runtime state.
    //   3. preferred-team match (when GENIE_TEAM is set).
    //   4. first row (preserves the view's freshest-first ordering).
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}/.test(identifier);
    row =
      (looksLikeUuid ? rows.find((r) => r.agent_id === identifier) : undefined) ??
      rows.find((r) => r.current_executor_id != null) ??
      (preferTeam ? rows.find((r) => r.team === preferTeam) : undefined) ??
      rows.find((r) => r.agent_id === identifier) ??
      rows[0];
  }

  return withHealth(mapRow(row));
}

/**
 * List agents with their observability snapshot.
 *
 * Default behavior:
 *   - excludes `classification = 'harness'` rows
 *   - returns up to 500 rows
 *   - sorted by most recent executor activity (NULLs last)
 */
export async function listAgentObservability(opts: ListAgentsOptions = {}): Promise<AgentObservabilitySnapshot[]> {
  const sql = await getConnection();
  const includeHarness = opts.includeHarness === true;
  const limit = opts.limit ?? 500;

  let queryResult: unknown;
  try {
    queryResult = includeHarness
      ? await sql<Record<string, unknown>[]>`
          SELECT * FROM v_agent_observability
          ORDER BY COALESCE(executor_updated_at, agent_updated_at, agent_started_at) DESC NULLS LAST
          LIMIT ${limit}
        `
      : await sql<Record<string, unknown>[]>`
          SELECT * FROM v_agent_observability
          WHERE classification = 'agent'
          ORDER BY COALESCE(executor_updated_at, agent_updated_at, agent_started_at) DESC NULLS LAST
          LIMIT ${limit}
        `;
  } catch (err) {
    if (!isCostAggregateEnvDefect(err)) throw err;
    const where = includeHarness ? '' : "WHERE classification = 'agent'";
    queryResult = await sql.unsafe(
      `SELECT *${ZERO_COST_COLUMNS} FROM v_agent_observability_core
       ${where}
       ORDER BY COALESCE(executor_updated_at, agent_updated_at, agent_started_at) DESC NULLS LAST
       LIMIT $1`,
      [limit],
    );
  }
  const rows = queryResult as unknown as Record<string, unknown>[];

  // Dedup bare-name shadow rows (the `dir:<name>` pattern from migration 049
  // pre-UUID identity model). When two rows share the same display name and
  // exactly one carries executor state, the runtime row wins. See
  // src/lib/agent-registry.ts dedupeShadowRows for the canonical rule.
  return dedupeSnapshots(rows.map((r) => withHealth(mapRow(r))));
}

function dedupeSnapshots(snaps: AgentObservabilitySnapshot[]): AgentObservabilitySnapshot[] {
  // Two-pass collapse keyed on `<team>|<displayName>`:
  //   pass 1 — index every snapshot by its display name (custom_name → role
  //            → agent_id) so we can look up the canonical peer in O(1).
  //   pass 2 — drop bare-name shadow rows (`dir:<name>` PK pre-UUID model)
  //            ONLY when a non-shadow peer with the same display name is
  //            also present. Two distinct task agents that happen to share
  //            a `role` (e.g. two `engineer` rows) are NEVER collapsed —
  //            each carries a unique UUID and its own runtime state.
  const indexByDisplay = new Map<string, AgentObservabilitySnapshot[]>();
  for (const snap of snaps) {
    const display = snap.customName ?? snap.role ?? snap.agentId;
    const key = `${snap.team ?? ''}|${display}`;
    const bucket = indexByDisplay.get(key);
    if (bucket) bucket.push(snap);
    else indexByDisplay.set(key, [snap]);
  }

  const out: AgentObservabilitySnapshot[] = [];
  for (const snap of snaps) {
    if (!snap.agentId.startsWith('dir:')) {
      out.push(snap);
      continue;
    }
    const display = snap.customName ?? snap.role ?? snap.agentId;
    const peers = indexByDisplay.get(`${snap.team ?? ''}|${display}`) ?? [];
    const hasNonShadowPeer = peers.some((p) => p !== snap && !p.agentId.startsWith('dir:'));
    if (!hasNonShadowPeer) out.push(snap);
  }
  return out;
}

/**
 * Same as `listAgentObservability` but keyed by canonical display name
 * (`custom_name` ?? `role`). Used by the TUI work-state badge so it can
 * look up by node label without re-joining.
 */
export async function loadAgentObservabilityMap(
  opts: ListAgentsOptions = {},
): Promise<Map<string, AgentObservabilitySnapshot>> {
  const rows = await listAgentObservability(opts);
  const out = new Map<string, AgentObservabilitySnapshot>();
  for (const r of rows) {
    const key = r.customName ?? r.role ?? r.agentId;
    // First write wins — the ORDER BY in listAgentObservability puts the
    // freshest row first, so we keep that one as the canonical snapshot.
    if (!out.has(key)) out.set(key, r);
  }
  return out;
}

function withHealth(row: AgentObservabilityRow): AgentObservabilitySnapshot {
  return { ...row, health: assessHealth(row) };
}
