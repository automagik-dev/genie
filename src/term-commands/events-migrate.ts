/**
 * `genie events migrate --audit [--dry-run]` — backfill `audit_events` into
 * `genie_runtime_events` so consumers querying the new substrate see the
 * legacy event history through the same schema.
 *
 * Backfilled rows carry:
 *   - `source = 'audit-migrate'` sentinel
 *   - `source_subsystem = 'events-migrate'`
 *   - `data->>'_trace_id' = NULL` (correlation_id unknown for legacy rows)
 *   - `data->>'_source_migration_version'` = migrate schema-version sentinel
 *
 * Idempotent: a (audit_events.id) already-migrated row is detected via
 * `subject = 'audit.legacy' AND data->>'legacy_audit_id' = <id>`.
 *
 * Wish: genie-serve-structured-observability, Group 4.
 */

import { getConnection } from '../lib/db.js';
import { color } from '../lib/term-format.js';

const BATCH_SIZE = 500;
const MIGRATE_SUBJECT = 'audit.legacy';
const MIGRATE_SOURCE = 'audit-migrate';
const MIGRATE_SUBSYSTEM = 'events-migrate';
const MIGRATE_SCHEMA_VERSION = 1;

export interface MigrateOptions {
  audit?: boolean;
  dryRun?: boolean;
  since?: string;
  limit?: number;
  json?: boolean;
}

interface MigrateStats {
  total_audit_rows: number;
  already_migrated: number;
  to_migrate: number;
  migrated: number;
  skipped: number;
  dry_run: boolean;
}

function parseSince(since: string): string {
  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) return since;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return new Date(Date.now() - amount * ms).toISOString();
}

interface AuditRow {
  legacy_id: number;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor: string | null;
  details: Record<string, unknown> | string | null;
  created_at: string | Date;
}

type Sql = Awaited<ReturnType<typeof getConnection>>;

async function countTotalRows(sql: Sql, sinceTs: string | null): Promise<number> {
  const clause = sinceTs ? 'WHERE ae.created_at >= $1::timestamptz' : '';
  const params = sinceTs ? [sinceTs] : [];
  const [{ total }] = (await sql.unsafe(
    `SELECT COUNT(*)::int AS total FROM audit_events ae ${clause}`,
    params,
  )) as unknown as Array<{ total: number }>;
  return total;
}

async function countAlreadyMigrated(sql: Sql, sinceTs: string | null): Promise<number> {
  const whereTs = sinceTs ? 'AND created_at >= $1::timestamptz' : '';
  const params = sinceTs ? [sinceTs] : [];
  const [{ already }] = (await sql.unsafe(
    `SELECT COUNT(*)::int AS already
       FROM genie_runtime_events
      WHERE subject = '${MIGRATE_SUBJECT}'
        AND source = '${MIGRATE_SOURCE}'
      ${whereTs}`,
    params,
  )) as unknown as Array<{ already: number }>;
  return already;
}

async function fetchBatch(sql: Sql, cursorId: number, sinceTs: string | null): Promise<AuditRow[]> {
  const cursorClause = sinceTs ? 'AND ae.created_at >= $2::timestamptz' : '';
  const params = sinceTs ? [cursorId, sinceTs] : [cursorId];
  return (await sql.unsafe(
    `SELECT
       ae.id           AS legacy_id,
       ae.entity_type  AS entity_type,
       ae.entity_id    AS entity_id,
       ae.event_type   AS event_type,
       ae.actor        AS actor,
       ae.details      AS details,
       ae.created_at   AS created_at
     FROM audit_events ae
     LEFT JOIN genie_runtime_events gre
       ON gre.subject = '${MIGRATE_SUBJECT}'
      AND gre.source = '${MIGRATE_SOURCE}'
      AND gre.data->>'legacy_audit_id' = ae.id::text
    WHERE ae.id > $1 ${cursorClause}
      AND gre.id IS NULL
    ORDER BY ae.id ASC
    LIMIT ${BATCH_SIZE}`,
    params,
  )) as unknown as AuditRow[];
}

function buildEnrichedData(row: AuditRow): Record<string, unknown> {
  const details = normalizeDetails(row.details);
  return {
    ...details,
    _trace_id: null,
    _span_id: null,
    _parent_span_id: null,
    _severity: details.error ? 'error' : 'info',
    _schema_version: MIGRATE_SCHEMA_VERSION,
    _duration_ms: null,
    _source_subsystem: MIGRATE_SUBSYSTEM,
    _tier: 'default',
    _kind: 'event',
    legacy_audit_id: String(row.legacy_id),
    legacy_entity_type: row.entity_type,
    legacy_entity_id: row.entity_id,
    legacy_event_type: row.event_type,
  };
}

async function insertMigratedRow(sql: Sql, row: AuditRow): Promise<void> {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  await sql.unsafe(
    `INSERT INTO genie_runtime_events (
       repo_path, subject, kind, source, agent, team, direction, peer,
       text, data, thread_id, trace_id, parent_event_id, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, NULL, NULL, $7, $8::jsonb, NULL, NULL, NULL, $9::timestamptz
     )`,
    [
      process.env.GENIE_REPO_PATH ?? process.cwd(),
      MIGRATE_SUBJECT,
      'system',
      MIGRATE_SOURCE,
      row.actor ?? 'legacy',
      null,
      row.event_type,
      JSON.stringify(buildEnrichedData(row)),
      createdAt,
    ],
  );
}

async function applyBatch(sql: Sql, batch: AuditRow[], stats: MigrateStats, limit: number): Promise<number> {
  let cursorId = 0;
  for (const row of batch) {
    if (stats.migrated >= limit) break;
    try {
      await insertMigratedRow(sql, row);
      stats.migrated += 1;
    } catch {
      stats.skipped += 1;
    }
    cursorId = row.legacy_id;
  }
  return cursorId;
}

export async function runAuditMigration(options: MigrateOptions): Promise<MigrateStats> {
  const sql = await getConnection();
  const sinceTs = options.since ? parseSince(options.since) : null;

  const total = await countTotalRows(sql, sinceTs);
  const already = await countAlreadyMigrated(sql, sinceTs);
  const toMigrate = total - already;

  const stats: MigrateStats = {
    total_audit_rows: total,
    already_migrated: already,
    to_migrate: Math.max(0, toMigrate),
    migrated: 0,
    skipped: 0,
    dry_run: Boolean(options.dryRun),
  };

  if (options.dryRun || toMigrate <= 0) return stats;

  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let cursorId = 0;

  while (stats.migrated < limit) {
    const batch = await fetchBatch(sql, cursorId, sinceTs);
    if (batch.length === 0) break;
    cursorId = await applyBatch(sql, batch, stats, limit);
    if (batch.length < BATCH_SIZE) break;
  }

  return stats;
}

function normalizeDetails(raw: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { _raw: raw };
    } catch {
      return { _raw: raw };
    }
  }
  return raw;
}

export async function migrateCommand(options: MigrateOptions): Promise<void> {
  if (!options.audit) {
    console.error('Usage: genie events migrate --audit [--dry-run] [--since <dur>] [--limit <n>]');
    process.exit(1);
  }

  try {
    const stats = await runAuditMigration(options);

    if (options.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    console.log(color('brightCyan', `Audit Migration${options.dryRun ? ' (dry-run)' : ''}`));
    console.log(color('dim', '─────────────────────'));
    console.log(`Total audit_events:     ${stats.total_audit_rows}`);
    console.log(`Already migrated:       ${stats.already_migrated}`);
    console.log(`To migrate:             ${stats.to_migrate}`);
    if (!options.dryRun) {
      console.log(`Migrated:               ${stats.migrated}`);
      if (stats.skipped > 0) console.log(color('yellow', `Skipped (errors):       ${stats.skipped}`));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Migration failed: ${msg}`);
    process.exit(1);
  }
}
