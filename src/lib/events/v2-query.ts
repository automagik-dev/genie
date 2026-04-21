/**
 * Enriched (v2) query surface for `genie_runtime_events`.
 *
 * After Group 1 migrations the table carries top-level OTEL columns
 * (`span_id`, `parent_span_id`, `severity`, `duration_ms`, `source_subsystem`,
 * `schema_version`, `dedup_key`) — but the current emit.ts writer stuffs
 * those values into the `data` JSONB under `_trace_id`, `_span_id`,
 * `_parent_span_id`, `_severity`, etc. prefixes (see emit.ts writeBatch).
 *
 * This helper resolves the "which surface" concern by COALESCE-ing both
 * paths: consumers can query enriched fields without caring whether a given
 * row was written by the emit.ts scaffold or by a fully-migrated Group 3
 * writer.
 *
 * Wish: genie-serve-structured-observability, Group 4 — Consumer CLI + Transport.
 */

import { getConnection } from '../db.js';

export interface V2EventRow {
  id: number;
  repo_path: string;
  subject: string | null;
  kind: string;
  source: string;
  agent: string;
  team: string | null;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  severity: string | null;
  schema_version: number | null;
  duration_ms: number | null;
  source_subsystem: string | null;
  text: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

/** Column list used by every v2 query — keeps the COALESCE logic in one place. */
export const V2_SELECT = `
  id,
  repo_path,
  subject,
  kind,
  source,
  agent,
  team,
  COALESCE(trace_id::text, data->>'_trace_id') AS trace_id,
  COALESCE(span_id::text, data->>'_span_id') AS span_id,
  COALESCE(parent_span_id::text, data->>'_parent_span_id') AS parent_span_id,
  COALESCE(severity, data->>'_severity') AS severity,
  COALESCE(schema_version, NULLIF(data->>'_schema_version', '')::int) AS schema_version,
  COALESCE(duration_ms, NULLIF(data->>'_duration_ms', '')::int) AS duration_ms,
  COALESCE(source_subsystem, data->>'_source_subsystem') AS source_subsystem,
  text,
  data,
  created_at::text AS created_at
`;

/**
 * Translate a user-supplied kind filter into a SQL LIKE pattern.
 *
 * Preserved as a thin alias over `kindFilterToLikePatterns(...)[0]` for
 * callers that only need the headline prefix pattern (e.g. `mailbox` →
 * `mailbox%`). New call sites should prefer the `Patterns` variant so bare
 * words also hit namespace-prefixed segments (`agent` → `genie.agent.*`).
 *
 * SQL wildcards (`%`, `_`) inside the input are escaped so they cannot
 * leak into the predicate.
 */
export function kindFilterToLike(input: string): string {
  return kindFilterToLikePatterns(input)[0];
}

/**
 * Translate a user-supplied kind filter into one or more SQL LIKE patterns.
 * The caller OR-combines them against `subject`/`kind`.
 *
 * Historical contract (prefix LIKE) is a strict subset of the output:
 *   - Bare word `mailbox`      -> `['mailbox%', '%.mailbox.%', '%.mailbox']`
 *   - Dotted    `agent.lifecycle` -> `['agent.lifecycle%']` (unchanged)
 *   - Glob      `detector.*`   -> `['detector.%']` (unchanged)
 *
 * Why bare words get the wider pattern set: subjects emitted by v2 follow
 * a `<namespace>.<kind>.<...>` shape (`genie.agent.dir:Y.spawned`,
 * `rot.team-ls-drift.detected`). Users arriving from the audit_events surface
 * type `--kind agent` expecting to hit `genie.agent.*`; under the old prefix
 * rule this returned `[]` because the namespace (`genie.`) sat in front.
 * Widening bare words to also match `%.<word>.%` / `%.<word>` fixes the
 * intuitive case without changing what already-correct queries (dotted or
 * globbed) return. Closes #1259 bug 2.
 *
 * Any `%` or `_` in the input is still escaped.
 */
export function kindFilterToLikePatterns(input: string): string[] {
  const escaped = input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  if (escaped.includes('*')) return [escaped.replace(/\*/g, '%')];
  if (escaped.includes('.')) return [`${escaped}%`];
  // Bare word: historic prefix plus namespace-segment matches.
  return [`${escaped}%`, `%.${escaped}.%`, `%.${escaped}`];
}

/**
 * Human-friendly duration like "1h", "30m", "2d" → ISO timestamp. Falls
 * through unchanged if the input is already an ISO string.
 */
export function parseSince(since: string): string {
  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) return since;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return new Date(Date.now() - amount * ms).toISOString();
}

export interface V2StreamFilter {
  afterId?: number;
  kindPrefix?: string;
  severity?: string;
  since?: string;
  limit?: number;
}

/**
 * Pull a batch of enriched rows ordered by id ASC. Used by `events stream
 * --follow` to drain after a NOTIFY wake.
 */
export async function queryV2Batch(filter: V2StreamFilter): Promise<V2EventRow[]> {
  const sql = await getConnection();
  const clauses: string[] = [];
  const values: unknown[] = [];
  const param = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filter.afterId != null) clauses.push(`id > ${param(filter.afterId)}`);
  if (filter.kindPrefix) {
    // Bare words expand to multiple patterns (prefix + namespace-segment)
    // per `kindFilterToLikePatterns`. OR them all against both `subject`
    // and `kind` so `--kind agent` hits `genie.agent.*` subjects too.
    const patterns = kindFilterToLikePatterns(filter.kindPrefix);
    const ors = patterns.flatMap((p) => {
      const placeholder = param(p);
      return [`subject LIKE ${placeholder} ESCAPE '\\'`, `kind LIKE ${placeholder} ESCAPE '\\'`];
    });
    clauses.push(`(${ors.join(' OR ')})`);
  }
  if (filter.severity) {
    clauses.push(`(COALESCE(severity, data->>'_severity') = ${param(filter.severity)})`);
  }
  if (filter.since) {
    clauses.push(`created_at >= ${param(parseSince(filter.since))}::timestamptz`);
  }

  const limit = filter.limit ?? 500;
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = (await sql.unsafe(
    `SELECT ${V2_SELECT}
       FROM genie_runtime_events
       ${where}
      ORDER BY id ASC
      LIMIT $${values.length + 1}`,
    [...values, limit],
  )) as unknown as V2EventRow[];
  // `id` comes back from PG bigint as a string under postgres.js default.
  // Normalize so downstream consumers see a consistent numeric type.
  for (const row of rows) {
    row.id = Number(row.id);
    if (row.duration_ms != null) row.duration_ms = Number(row.duration_ms);
    if (row.schema_version != null) row.schema_version = Number(row.schema_version);
  }
  return rows;
}

/** Return the latest id in the table — used to seed fresh consumers. */
export async function getLatestEventId(): Promise<number> {
  const sql = await getConnection();
  const rows = (await sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM genie_runtime_events
  `) as unknown as Array<{ max_id: number }>;
  return Number(rows[0]?.max_id ?? 0);
}

/** The 8 closed event-type prefixes that map to LISTEN channels. */
export const DEFAULT_CHANNEL_PREFIXES = [
  'cli',
  'agent',
  'wish',
  'hook',
  'resume',
  'executor',
  'mailbox',
  'error',
  'state_transition',
  'schema',
  'session',
  'tmux',
  'cache',
  'runbook',
  'consumer',
  'permissions',
  'team',
] as const;
