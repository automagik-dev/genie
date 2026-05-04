/**
 * v1-migration auto-detection + prompt (runs at every fresh DB connect).
 *
 * Drops into `src/lib/v1-migration-prompt.ts`. Wired into `runPostConnectSetup`
 * in `src/lib/db.ts` (see patch). One probe per process.
 *
 * Flow:
 *   1. Process-local cache: `promptedThisProcess` — never prompt twice
 *      in the same genie invocation.
 *   2. Target DB has `_genie_migration_state` table with a row for the
 *      source DB → migration already completed → silent.
 *   3. No row → probe pg_database via admin TCP for any v1-shaped DB.
 *      Cheap (single query, sub-ms).
 *   4. v1 found → print one-line offer (TTY) or silent notice (non-TTY).
 *
 * Suppressors (any of):
 *   - GENIE_NO_V1_PROMPT=1
 *   - GENIE_QUIET=1
 *   - non-interactive stderr (no TTY)
 *   - migration already recorded in _genie_migration_state
 */

import postgres from 'postgres';

const V1_DB_NAME = 'genie';
const PG_USER = 'postgres';
const PG_PASS = 'postgres';
const PG_HOST = '127.0.0.1';

let promptedThisProcess = false;

interface DetectionResult {
  v1Exists: boolean;
  v1Counts?: { tasks: number; wishes: number; teams: number; sessions: number };
  alreadyMigrated: boolean;
}

/**
 * Best-effort: probe the target DB's migration-state table + the v1 source.
 * Never throws — failures degrade silently.
 */
export async function maybePromptV1Migration(target: postgres.Sql): Promise<void> {
  if (promptedThisProcess) return;
  promptedThisProcess = true;

  if (process.env.GENIE_NO_V1_PROMPT === '1') return;
  if (process.env.GENIE_QUIET === '1') return;
  if (process.env.GENIE_TEST_DB_NAME) return; // tests must stay quiet
  if (process.env.GENIE_NO_BANNER === '1') return;

  let detection: DetectionResult;
  try {
    detection = await detectV1State(target);
  } catch {
    return;
  }
  if (!detection.v1Exists) return;
  if (detection.alreadyMigrated) return;

  const { tasks = 0, wishes = 0, teams = 0, sessions = 0 } = detection.v1Counts ?? {};

  // v1 DB exists but is empty (e.g. pristine install whose schema was
  // initialized but never written to). There is nothing to migrate, so
  // suppress the banner — the operator has no actionable choice to make.
  if (tasks === 0 && wishes === 0 && teams === 0 && sessions === 0) return;

  const tty = Boolean(process.stderr.isTTY);

  if (!tty) {
    process.stderr.write(
      `[genie] ⓘ Legacy v1 data detected (${tasks} tasks, ${wishes} wishes, ${teams} teams, ${sessions} sessions).\n        Run \`genie db migrate-v1\` to import. Suppress with GENIE_NO_V1_PROMPT=1.\n`,
    );
    return;
  }

  // Interactive: print a single-line offer. Don't block the user's command —
  // they invoked `genie status` (or whatever); migration is interactive +
  // long-running, must be its own command.
  process.stderr.write(
    `[genie] ⚠ Legacy v1 data detected (${tasks} tasks, ${wishes} wishes, ${teams} teams, ${sessions} sessions, last 30d).\n        Run \`genie db migrate-v1\` to import.\n        (one-time offer — silent after first migration; or set GENIE_NO_V1_PROMPT=1)\n`,
  );
}

async function detectV1State(target: postgres.Sql): Promise<DetectionResult> {
  // Step 1: ensure migration-state table + check it
  await ensureMigrationStateTable(target);
  const completedRows = await target<{ source_db: string }[]>`
    SELECT source_db FROM _genie_migration_state WHERE source_db = ${V1_DB_NAME}
  `;
  if (completedRows.length > 0) {
    return { v1Exists: false, alreadyMigrated: true };
  }

  // Step 2: probe v1 via admin TCP. Use the same port the runtime is
  // already on (postgres SHOW port returns the per-backend port, but
  // we know the daemon port from current_setting('port') — works for
  // both socket-routed and direct connections).
  const portRows = await target<{ port: string }[]>`SHOW port`;
  const port = Number(portRows[0]?.port);
  if (!Number.isFinite(port) || port <= 0) return { v1Exists: false, alreadyMigrated: false };

  const v1 = postgres({
    host: PG_HOST,
    port,
    username: PG_USER,
    password: PG_PASS,
    database: V1_DB_NAME,
    max: 1,
    onnotice: () => {},
    connect_timeout: 3,
    idle_timeout: 1,
  });
  try {
    // If the DB doesn't exist, postgres-js throws 3D000.
    const probe = await v1<{ relname: string; n_live_tup: bigint }[]>`
      SELECT relname, n_live_tup FROM pg_stat_user_tables
      WHERE schemaname='public'
        AND relname IN ('tasks','wishes','teams','sessions')
    `;
    if (probe.length === 0) return { v1Exists: false, alreadyMigrated: false };
    const counts = { tasks: 0, wishes: 0, teams: 0, sessions: 0 };
    for (const r of probe) {
      const n = Number(r.n_live_tup);
      if (r.relname === 'tasks') counts.tasks = n;
      else if (r.relname === 'wishes') counts.wishes = n;
      else if (r.relname === 'teams') counts.teams = n;
      else if (r.relname === 'sessions') counts.sessions = n;
    }
    return { v1Exists: true, v1Counts: counts, alreadyMigrated: false };
  } catch (_err) {
    // 3D000 = database does not exist. Any other error: degrade silently.
    return { v1Exists: false, alreadyMigrated: false };
  } finally {
    try {
      await v1.end({ timeout: 1 });
    } catch {
      /* swallow */
    }
  }
}

/**
 * Schema for the prompt-once + migration-completed marker. Idempotent.
 *
 * One row per source DB that has been migrated. The migrate-v1 command
 * INSERTs a row on success. The startup detector checks for the row's
 * presence to suppress the offer.
 */
async function ensureMigrationStateTable(target: postgres.Sql): Promise<void> {
  await target.unsafe(`
    CREATE TABLE IF NOT EXISTS _genie_migration_state (
      source_db    TEXT PRIMARY KEY,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      rows_copied  JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes        TEXT
    )
  `);
}

/**
 * Called by the migrate-v1 command on success to suppress future prompts.
 *
 * @param target — the v2 fingerprinted DB the data was migrated INTO
 * @param sourceDb — the v1 DB name (default 'genie')
 * @param rowsCopied — per-table counts for the operator audit
 */
export async function recordMigrationComplete(
  target: postgres.Sql,
  sourceDb: string,
  rowsCopied: Record<string, number>,
): Promise<void> {
  await ensureMigrationStateTable(target);
  await target.unsafe(
    `INSERT INTO _genie_migration_state (source_db, rows_copied)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (source_db) DO UPDATE SET completed_at = now(), rows_copied = EXCLUDED.rows_copied`,
    [sourceDb, JSON.stringify(rowsCopied)],
  );
}
