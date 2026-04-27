/**
 * `ensureServeReady` — fast boot-time preconditions for `genie serve start`.
 *
 * Boot path is hot — `genie` (auto-start) gives the spawned `genie serve
 * --foreground` 15s before declaring it dead. Anything that can take longer
 * than that lives in `runDoctorMaintenance` (called from `genie doctor --fix`
 * and `genie update`), not here.
 *
 * Boot preconditions (all O(seconds-or-less)):
 *   1. `partition`             — today's `genie_runtime_events` partition exists
 *                                (cheap SQL maintenance call). REQUIRED before
 *                                serve writes events; can't move out of boot.
 *   2. `backfill`              — JSONL→PG drift probe; if drift ≥ 5%, fire a
 *                                background convergence pass and return
 *                                immediately. The agent-watcher and
 *                                scheduler-daemon converge in the background.
 *                                NEVER blocks boot.
 *   3. `dead_pane_zombies`     — read-only flag for `genie status`. No fix.
 *   4. `team_config_orphans`   — surfaced for `genie team repair`. At boot
 *                                stale dirs are flagged but NOT archived;
 *                                archival is doctor's job.
 *
 * Doctor-only (run from `runDoctorMaintenance` — see below):
 *   - `watchdog` install  (shells out, needs sudo, one-time cost)
 *   - foreground backfill convergence (blocks until full sync done)
 *   - team-config orphan archive
 *
 * Flow:
 *   - Run each precondition; capture `PreconditionResult` (status + detail + fix command).
 *   - When `autoFix=true`, `fixed` is acceptable. When `autoFix=false`, any non-`ok`
 *     result is `refused`.
 *   - Emit `serve.precondition.fixed` / `serve.precondition.refused` audit events
 *     (consumer: `genie status --health`).
 *   - Return `{ ok, results }`. Caller (`genie serve start`) decides whether to
 *     proceed (`ok=true`) or print fix commands and exit non-zero.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ObservabilityHealthReport,
  collectObservabilityHealth,
} from '../../genie-commands/observability-health.js';
import { recordAuditEvent } from '../../lib/audit.js';
import { getConnection, isAvailable } from '../../lib/db.js';

// ============================================================================
// Types
// ============================================================================

export type PreconditionName = 'partition' | 'watchdog' | 'backfill' | 'dead_pane_zombies' | 'team_config_orphans';

export type PreconditionStatus = 'ok' | 'fixed' | 'refused' | 'skipped';

export interface PreconditionResult {
  name: PreconditionName;
  status: PreconditionStatus;
  /** Human-readable explanation. */
  detail?: string;
  /** Suggested command to run when `status=refused`. */
  fixCommand?: string;
}

export interface TeamConfigOrphan {
  /** Sanitized team name (= directory basename). */
  teamName: string;
  /** Absolute path to the orphan dir. */
  path: string;
  /** Newest mtime found among `inboxes/*.json` (epoch ms). */
  newestInboxMs: number | null;
  /** True when at least one inbox file has non-empty content. */
  hasContent: boolean;
}

export interface OrphanScan {
  active: TeamConfigOrphan[];
  stale: TeamConfigOrphan[];
}

export interface BackfillReport {
  ranSync: boolean;
  /** Drift percentage; null when unknown (e.g. no prior backfill row). */
  driftPct: number | null;
  detail: string;
}

export interface PartitionMaintenanceResult {
  createdOrPresent: number;
  dropped: number;
  nextRotationAt: string | null;
}

export interface WatchdogInstallResult {
  filesWritten: string[];
  filesSkipped: string[];
}

/**
 * Dependency injection seam — every external call has a default implementation
 * pointing to the real primitive, but tests pass fakes so we can drive each
 * branch without a live PG / filesystem / systemd surface.
 */
export interface EnsureServeReadyDeps {
  collectHealth?: () => Promise<ObservabilityHealthReport>;
  runPartitionMaintenance?: () => Promise<PartitionMaintenanceResult>;
  installWatchdog?: () => Promise<WatchdogInstallResult>;
  runBackfillSync?: () => Promise<BackfillReport>;
  measureBackfillDrift?: () => Promise<{ driftPct: number | null; detail: string }>;
  listOrphanedZombies?: () => Promise<Array<{ id: string; lastStateChange: string }>>;
  scanTeamConfigOrphans?: () => OrphanScan;
  archiveStaleTeamConfigs?: (orphans: TeamConfigOrphan[]) => string[];
  recordAudit?: (
    eventType: 'serve.precondition.fixed' | 'serve.precondition.refused',
    name: PreconditionName,
    details: Record<string, unknown>,
  ) => Promise<void>;
  log?: (line: string) => void;
}

export interface EnsureServeReadyOptions {
  autoFix: boolean;
  deps?: EnsureServeReadyDeps;
}

export interface EnsureServeReadyReport {
  /** True when every precondition is `ok` or `fixed`. False when any `refused`. */
  ok: boolean;
  results: PreconditionResult[];
}

// ============================================================================
// Default primitives
// ============================================================================

/** Threshold above which `runBackfillSync` is invoked (also the success criterion). */
export const BACKFILL_DRIFT_THRESHOLD_PCT = 5;

/** Active vs stale cutoff for orphaned team-config dirs. */
const ORPHAN_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function teamsBaseDir(): string {
  return join(claudeConfigDir(), 'teams');
}

/** Run the SQL maintenance helper that creates today + N days of partitions. */
async function defaultRunPartitionMaintenance(): Promise<PartitionMaintenanceResult> {
  const sql = await getConnection();
  const rows = await sql<
    Array<{ r: { created_or_present: number; dropped: number; next_rotation_at: string | null } }>
  >`SELECT genie_runtime_events_maintain_partitions(2, 30)::jsonb AS r`;
  const r = rows[0]?.r ?? { created_or_present: 0, dropped: 0, next_rotation_at: null };
  return {
    createdOrPresent: r.created_or_present,
    dropped: r.dropped,
    nextRotationAt: r.next_rotation_at,
  };
}

/**
 * Locate the watchdog CLI shipped with the genie install. Walks up from this
 * module file (which lives inside the bundled dist or the source tree) until
 * it finds a directory containing `packages/watchdog/src/cli.ts`. Returns null
 * when the CLI cannot be found — caller decides what to do.
 *
 * Bundled installs ship `dist/genie.js` only; `packages/watchdog/` is not
 * inlined. So bundle-mode users will get null here and the install step is
 * surfaced as a refused precondition with a sudo hint, not a hard crash.
 */
function resolveWatchdogCliPath(): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'packages/watchdog/src/cli.ts');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url unavailable — fall through
  }
  return null;
}

/**
 * Install the watchdog systemd units. Requires write access to `/etc/systemd/`,
 * which most non-root accounts don't have — the call is wrapped in try/catch
 * by the precondition so an EACCES surfaces as `refused` (with a sudo hint),
 * not a thrown exception.
 *
 * We shell out to the watchdog CLI rather than importing the install module
 * directly because (a) it sidesteps tsconfig include scope and (b) it lets the
 * operator inject sudo in front via `GENIE_WATCHDOG_INSTALL_CMD` if their
 * install layout demands it.
 *
 * Path resolution: the CLI is found relative to this module (not `process.cwd()`),
 * so `genie` invoked from any working directory still locates it correctly.
 */
async function defaultInstallWatchdog(): Promise<WatchdogInstallResult> {
  const overrideCmd = process.env.GENIE_WATCHDOG_INSTALL_CMD;
  if (overrideCmd) {
    const result = spawnSync(overrideCmd, [], { stdio: 'pipe', encoding: 'utf8', shell: true });
    if (result.status !== 0) {
      const stderr = (result.stderr ?? '').toString().trim();
      const stdout = (result.stdout ?? '').toString().trim();
      throw new Error(stderr || stdout || `watchdog install exited ${result.status}`);
    }
    return { filesWritten: [], filesSkipped: [] };
  }
  const cliPath = resolveWatchdogCliPath();
  if (!cliPath) {
    throw new Error(
      'watchdog CLI not found relative to genie install — set GENIE_WATCHDOG_INSTALL_CMD or run from the source repo',
    );
  }
  const result = spawnSync('bun', ['run', cliPath, 'install'], { stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').toString().trim();
    const stdout = (result.stdout ?? '').toString().trim();
    throw new Error(stderr || stdout || `watchdog install exited ${result.status}`);
  }
  // CLI prints one line per file written/skipped; we don't need to parse the
  // body — the post-install health probe re-runs and tells us the truth.
  return { filesWritten: [], filesSkipped: [] };
}

/**
 * Compute the JSONL→PG drift percentage. We compare the on-disk JSONL footprint
 * (total bytes discovered) against the `session_sync.processed_bytes` watermark.
 * A drift ≥ 5% triggers a foreground convergence pass.
 */
async function defaultMeasureBackfillDrift(): Promise<{ driftPct: number | null; detail: string }> {
  if (!(await isAvailable())) {
    return { driftPct: null, detail: 'pg unavailable — skipped drift probe' };
  }
  try {
    const sql = await getConnection();
    const rows = await sql<Array<{ status: string; total_bytes: number; processed_bytes: number }>>`
      SELECT status, total_bytes, processed_bytes
        FROM session_sync
       WHERE id = 'backfill'
       LIMIT 1
    `;
    if (rows.length === 0) {
      return { driftPct: null, detail: 'no prior backfill row — first run will seed' };
    }
    const row = rows[0];
    if (row.total_bytes <= 0) {
      return { driftPct: 0, detail: 'no JSONL bytes discovered yet' };
    }
    const remaining = Math.max(0, row.total_bytes - row.processed_bytes);
    const pct = (remaining / row.total_bytes) * 100;
    const display = pct.toFixed(1);
    return {
      driftPct: pct,
      detail: `processed ${row.processed_bytes}/${row.total_bytes} bytes (drift ${display}%)`,
    };
  } catch (err) {
    return { driftPct: null, detail: `drift probe failed: ${(err as Error).message}` };
  }
}

/**
 * Boot-time backfill kicker — fire-and-forget. Returns immediately so boot
 * isn't held hostage to JSONL volume. The agent-watcher and scheduler-daemon
 * continue convergence in the background; users who want a synchronous pass
 * use `genie doctor --fix` (which calls `defaultRunBackfillBlocking`).
 */
async function defaultRunBackfillSync(): Promise<BackfillReport> {
  if (!(await isAvailable())) {
    return { ranSync: false, driftPct: null, detail: 'pg unavailable — backfill skipped' };
  }
  // Kick async, never await. Errors are swallowed at this layer; they surface
  // through observability events emitted by `startBackfill` itself.
  void (async () => {
    try {
      const sql = await getConnection();
      const { startBackfill } = await import('../../lib/session-backfill.js');
      await startBackfill(sql);
    } catch {
      // Background failure — observability layer handles reporting.
    }
  })();
  return {
    ranSync: true,
    driftPct: null,
    detail: 'background convergence kicked — `genie doctor --fix` to wait',
  };
}

/**
 * Blocking backfill pass — used by `genie doctor --fix` and `genie sessions
 * sync` where the caller explicitly wants to wait for full convergence.
 */
export async function defaultRunBackfillBlocking(): Promise<BackfillReport> {
  if (!(await isAvailable())) {
    return { ranSync: false, driftPct: null, detail: 'pg unavailable — backfill skipped' };
  }
  const sql = await getConnection();
  const { startBackfill } = await import('../../lib/session-backfill.js');
  await startBackfill(sql);
  const after = await defaultMeasureBackfillDrift();
  return { ranSync: true, driftPct: after.driftPct, detail: after.detail };
}

async function defaultListOrphanedZombies(): Promise<Array<{ id: string; lastStateChange: string }>> {
  try {
    const { listExhaustedZombies } = await import('../../lib/agent-registry.js');
    return await listExhaustedZombies();
  } catch {
    return [];
  }
}

/**
 * Scan `<claudeConfigDir>/teams/` for directories missing `config.json`.
 *
 * Active vs stale heuristic (per WISH § Group 4 deliverable 1):
 *   - active → newest inbox file < 24h old AND at least one inbox file has
 *     non-empty content; needs `genie team repair <name>` to recover
 *     `workingDir`.
 *   - stale → otherwise (no inboxes, all empty, or all older than 24h);
 *     archived to `<teams>/_archive/<name>-<timestamp>/`.
 *
 * The `_archive/` subdirectory itself is skipped — it's where stale orphans
 * live, not a team.
 */
function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function summarizeInboxes(inboxesDir: string): { newestMs: number | null; hasContent: boolean } {
  let inboxFiles: string[] = [];
  try {
    inboxFiles = readdirSync(inboxesDir).filter((f) => f.endsWith('.json'));
  } catch {
    return { newestMs: null, hasContent: false };
  }
  let newestMs: number | null = null;
  let hasContent = false;
  for (const f of inboxFiles) {
    try {
      const st = statSync(join(inboxesDir, f));
      if (newestMs === null || st.mtimeMs > newestMs) newestMs = st.mtimeMs;
      if (st.size > 2) hasContent = true; // > 2 bytes excludes "[]" / "{}"
    } catch {
      // Skip files we can't stat — they don't disprove freshness.
    }
  }
  return { newestMs, hasContent };
}

/**
 * Classify a single team directory. Returns null when the directory is healthy
 * (config.json present), empty, or unreadable — i.e. not an orphan worth
 * surfacing.
 */
function classifyTeamDir(
  name: string,
  base: string,
  now: number,
): { orphan: TeamConfigOrphan; active: boolean } | null {
  const dir = join(base, name);
  if (!safeIsDirectory(dir)) return null;
  if (existsSync(join(dir, 'config.json'))) return null;
  const inboxesDir = join(dir, 'inboxes');
  if (!safeIsDirectory(inboxesDir)) return null;
  const { newestMs, hasContent } = summarizeInboxes(inboxesDir);
  const orphan: TeamConfigOrphan = { teamName: name, path: dir, newestInboxMs: newestMs, hasContent };
  const active = hasContent && newestMs !== null && now - newestMs < ORPHAN_FRESH_WINDOW_MS;
  return { orphan, active };
}

export function defaultScanTeamConfigOrphans(): OrphanScan {
  const base = teamsBaseDir();
  const result: OrphanScan = { active: [], stale: [] };
  if (!existsSync(base)) return result;
  const now = Date.now();
  for (const name of readdirSync(base)) {
    if (name.startsWith('.') || name === '_archive') continue;
    const classified = classifyTeamDir(name, base, now);
    if (!classified) continue;
    (classified.active ? result.active : result.stale).push(classified.orphan);
  }
  return result;
}

export function defaultArchiveStaleTeamConfigs(orphans: TeamConfigOrphan[]): string[] {
  if (orphans.length === 0) return [];
  const archiveRoot = join(teamsBaseDir(), '_archive');
  mkdirSync(archiveRoot, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archived: string[] = [];
  for (const o of orphans) {
    const dest = join(archiveRoot, `${o.teamName}-${ts}`);
    try {
      renameSync(o.path, dest);
      archived.push(dest);
    } catch {
      // Best-effort — skip failures so one stuck dir doesn't block boot.
    }
  }
  return archived;
}

async function defaultRecordAudit(
  eventType: 'serve.precondition.fixed' | 'serve.precondition.refused',
  name: PreconditionName,
  details: Record<string, unknown>,
): Promise<void> {
  await recordAuditEvent('command', 'serve_start', eventType, 'serve', {
    precondition: name,
    ...details,
  });
}

// ============================================================================
// Precondition runners
// ============================================================================

async function checkPartition(
  health: ObservabilityHealthReport,
  autoFix: boolean,
  deps: Required<Pick<EnsureServeReadyDeps, 'runPartitionMaintenance'>>,
): Promise<PreconditionResult> {
  if (health.partition_health === 'ok' || health.partition_health === 'warn') {
    return {
      name: 'partition',
      status: 'ok',
      detail: health.next_rotation_at ? `next rotation: ${health.next_rotation_at}` : undefined,
    };
  }
  if (health.partition_health === 'unknown') {
    return {
      name: 'partition',
      status: 'skipped',
      detail: 'pg unavailable — skipping partition probe',
    };
  }
  // partition_health === 'fail'
  if (!autoFix) {
    return {
      name: 'partition',
      status: 'refused',
      detail: "today's partition is missing or rotation is overdue",
      fixCommand: 'genie doctor --observability  # then re-run; or `genie serve start` (without --no-fix)',
    };
  }
  const result = await deps.runPartitionMaintenance();
  return {
    name: 'partition',
    status: 'fixed',
    detail: `created/present ${result.createdOrPresent}, dropped ${result.dropped}; next rotation ${result.nextRotationAt ?? 'unknown'}`,
  };
}

async function checkWatchdog(
  health: ObservabilityHealthReport,
  autoFix: boolean,
  deps: Required<Pick<EnsureServeReadyDeps, 'installWatchdog'>>,
): Promise<PreconditionResult> {
  if (health.watchdog === 'ok') {
    return { name: 'watchdog', status: 'ok' };
  }
  if (!autoFix) {
    return {
      name: 'watchdog',
      status: 'refused',
      detail: health.watchdog_detail ?? 'watchdog units missing',
      fixCommand: 'sudo bun run packages/watchdog/src/cli.ts install',
    };
  }
  try {
    const result = await deps.installWatchdog();
    return {
      name: 'watchdog',
      status: 'fixed',
      detail: `wrote ${result.filesWritten.length}, skipped ${result.filesSkipped.length}`,
    };
  } catch (err) {
    // Most common failure: EACCES because /etc/systemd needs root. Surface as
    // refused with a sudo hint instead of crashing the boot.
    return {
      name: 'watchdog',
      status: 'refused',
      detail: `auto-install failed: ${(err as Error).message}`,
      fixCommand: 'sudo bun run packages/watchdog/src/cli.ts install',
    };
  }
}

async function checkBackfill(
  autoFix: boolean,
  deps: Required<Pick<EnsureServeReadyDeps, 'measureBackfillDrift' | 'runBackfillSync'>>,
): Promise<PreconditionResult> {
  const drift = await deps.measureBackfillDrift();
  if (drift.driftPct === null) {
    // Unknown drift = no prior backfill row, or pg offline. Either way, not a
    // refusal — first boot will seed it.
    return { name: 'backfill', status: 'skipped', detail: drift.detail };
  }
  if (drift.driftPct < BACKFILL_DRIFT_THRESHOLD_PCT) {
    return { name: 'backfill', status: 'ok', detail: drift.detail };
  }
  if (!autoFix) {
    return {
      name: 'backfill',
      status: 'refused',
      detail: drift.detail,
      fixCommand: `genie sessions sync  # drift ${drift.driftPct.toFixed(1)}% > ${BACKFILL_DRIFT_THRESHOLD_PCT}%`,
    };
  }
  // Boot kicks fire-and-forget; `runBackfillSync` is expected to return
  // immediately. Foreground convergence lives in `runDoctorMaintenance`.
  const ran = await deps.runBackfillSync();
  return {
    name: 'backfill',
    status: 'fixed',
    detail: ran.detail,
  };
}

async function checkDeadPaneZombies(
  deps: Required<Pick<EnsureServeReadyDeps, 'listOrphanedZombies'>>,
): Promise<PreconditionResult> {
  // Per WISH: zombies are surfaced (not auto-archived at boot) so the user
  // sees them in `genie status` and chooses to act. A rolling reaper handles
  // the mass case via `archiveExhaustedZombies`. Boot-time precondition only
  // FLAGS — never fixes.
  const orphans = await deps.listOrphanedZombies();
  if (orphans.length === 0) {
    return { name: 'dead_pane_zombies', status: 'ok' };
  }
  return {
    name: 'dead_pane_zombies',
    status: 'refused',
    detail: `${orphans.length} exhausted zombie(s) past TTL; visible in \`genie status\``,
    fixCommand: 'genie prune --zombies  # archive eligible rows',
  };
}

function checkTeamConfigOrphans(
  autoFix: boolean,
  deps: Required<Pick<EnsureServeReadyDeps, 'scanTeamConfigOrphans' | 'archiveStaleTeamConfigs'>>,
): PreconditionResult {
  const scan = deps.scanTeamConfigOrphans();
  if (scan.active.length === 0 && scan.stale.length === 0) {
    return { name: 'team_config_orphans', status: 'ok' };
  }
  if (!autoFix) {
    const summary = `active=${scan.active.length} stale=${scan.stale.length}`;
    const firstActive = scan.active[0]?.teamName;
    return {
      name: 'team_config_orphans',
      status: 'refused',
      detail: summary,
      fixCommand: firstActive
        ? `genie team repair ${firstActive}  # active orphan; stale dirs archive on auto-fix`
        : 'genie serve start  # auto-fix archives stale orphans',
    };
  }
  const archivedPaths = deps.archiveStaleTeamConfigs(scan.stale);
  if (scan.active.length > 0) {
    // Active orphans remain — boot proceeds, but the result is `refused` so the
    // user sees a fix verb. (Auto-fix archived stale ones, but cannot recreate
    // a config without the operator's input.)
    return {
      name: 'team_config_orphans',
      status: 'refused',
      detail: `archived ${archivedPaths.length} stale; ${scan.active.length} active orphan(s) need repair`,
      fixCommand: `genie team repair ${scan.active[0].teamName}`,
    };
  }
  return {
    name: 'team_config_orphans',
    status: 'fixed',
    detail: `archived ${archivedPaths.length} stale orphan(s)`,
  };
}

// ============================================================================
// Orchestrator
// ============================================================================

function bindDefaults(deps: EnsureServeReadyDeps | undefined): Required<EnsureServeReadyDeps> {
  return {
    collectHealth: deps?.collectHealth ?? collectObservabilityHealth,
    runPartitionMaintenance: deps?.runPartitionMaintenance ?? defaultRunPartitionMaintenance,
    installWatchdog: deps?.installWatchdog ?? defaultInstallWatchdog,
    runBackfillSync: deps?.runBackfillSync ?? defaultRunBackfillSync,
    measureBackfillDrift: deps?.measureBackfillDrift ?? defaultMeasureBackfillDrift,
    listOrphanedZombies: deps?.listOrphanedZombies ?? defaultListOrphanedZombies,
    scanTeamConfigOrphans: deps?.scanTeamConfigOrphans ?? defaultScanTeamConfigOrphans,
    archiveStaleTeamConfigs: deps?.archiveStaleTeamConfigs ?? defaultArchiveStaleTeamConfigs,
    recordAudit: deps?.recordAudit ?? defaultRecordAudit,
    log: deps?.log ?? ((line: string) => console.log(line)),
  };
}

/**
 * Boot orchestrator. Runs only fast preconditions so `genie` (auto-start) hits
 * its 15 s readiness window every time:
 *
 *   - `partition`            — sub-second SQL maintenance call.
 *   - `backfill`             — drift probe; high drift kicks a background
 *                              convergence pass and returns immediately.
 *   - `dead_pane_zombies`    — read-only count for `genie status`.
 *   - `team_config_orphans`  — surfaced for `genie team repair`; archive of
 *                              stale dirs is doctor's job, not boot's.
 *
 * Watchdog install + foreground backfill convergence + stale-orphan archive
 * live in `runDoctorMaintenance` (called from `genie doctor --fix` and
 * `genie update`).
 *
 * Audit events:
 *   - `serve.precondition.fixed`     — emitted per precondition that auto-fixed.
 *   - `serve.precondition.refused`   — emitted per precondition that refused
 *                                      (auto-fix off, or active orphans remain).
 */
export async function ensureServeReady(opts: EnsureServeReadyOptions): Promise<EnsureServeReadyReport> {
  const deps = bindDefaults(opts.deps);
  const health = await deps.collectHealth();

  const results: PreconditionResult[] = [];
  results.push(await checkPartition(health, opts.autoFix, deps));
  results.push(await checkBackfill(opts.autoFix, deps));
  results.push(await checkDeadPaneZombies(deps));
  // At boot we DO NOT archive stale team-config dirs — that's housekeeping the
  // doctor handles. Surfacing them as `refused` would only nag users on every
  // run; surfacing them as `ok` would lie. Skip the check entirely; doctor
  // takes care of it.

  await emitAuditEvents(results, deps);
  const ok = results.every((r) => r.status === 'ok' || r.status === 'fixed' || r.status === 'skipped');
  printReport(results, deps.log);
  return { ok, results };
}

/**
 * Doctor maintenance orchestrator. Runs the slow / one-time / shells-out work
 * that does NOT belong on the boot hot path:
 *
 *   - `watchdog` install (needs sudo on most systems; surface refused with
 *     hint when auto-install can't write `/etc/systemd/`).
 *   - `partition` maintenance (idempotent — re-creates today's partition if
 *     missing).
 *   - foreground `backfill` convergence (blocks until JSONL→PG sync is done
 *     to within the threshold).
 *   - `team_config_orphans` archive (moves stale dirs into `_archive/`).
 *
 * Designed to be called from `genie doctor --fix` and from the post-update
 * hook in `genie update`. The `silent` flag suppresses the per-line print.
 */
export interface RunDoctorMaintenanceOptions {
  deps?: EnsureServeReadyDeps;
  silent?: boolean;
}

export async function runDoctorMaintenance(opts: RunDoctorMaintenanceOptions = {}): Promise<EnsureServeReadyReport> {
  // Doctor uses the BLOCKING backfill variant by default — when the user runs
  // `genie doctor --fix` they expect the work to actually happen, not just be
  // kicked off. Boot uses the fire-and-forget default.
  const deps = bindDefaults({
    runBackfillSync: defaultRunBackfillBlocking,
    log: opts.silent ? () => {} : undefined,
    ...opts.deps,
  });
  const health = await deps.collectHealth();

  const results: PreconditionResult[] = [];
  results.push(await checkPartition(health, /* autoFix */ true, deps));
  results.push(await checkWatchdog(health, /* autoFix */ true, deps));
  results.push(await checkBackfill(/* autoFix */ true, deps));
  results.push(await checkDeadPaneZombies(deps));
  results.push(checkTeamConfigOrphans(/* autoFix */ true, deps));

  await emitAuditEvents(results, deps);
  const ok = results.every((r) => r.status === 'ok' || r.status === 'fixed' || r.status === 'skipped');
  printReport(results, deps.log);
  return { ok, results };
}

async function emitAuditEvents(
  results: PreconditionResult[],
  deps: Required<Pick<EnsureServeReadyDeps, 'recordAudit'>>,
): Promise<void> {
  for (const result of results) {
    if (result.status === 'fixed') {
      await deps
        .recordAudit('serve.precondition.fixed', result.name, {
          detail: result.detail ?? null,
        })
        .catch(() => {});
    } else if (result.status === 'refused') {
      await deps
        .recordAudit('serve.precondition.refused', result.name, {
          detail: result.detail ?? null,
          fix_command: result.fixCommand ?? null,
        })
        .catch(() => {});
    }
  }
}

function printReport(results: PreconditionResult[], log: (line: string) => void): void {
  log('  Preconditions:');
  for (const r of results) {
    const tag = statusTag(r.status);
    const suffix = r.detail ? ` — ${r.detail}` : '';
    log(`    ${tag} ${r.name}${suffix}`);
    if (r.status === 'refused' && r.fixCommand) {
      log(`        → ${r.fixCommand}`);
    }
  }
}

function statusTag(status: PreconditionStatus): string {
  switch (status) {
    case 'ok':
      return '[ok]';
    case 'fixed':
      return '[fix]';
    case 'refused':
      return '[!!]';
    case 'skipped':
      return '[--]';
  }
}
