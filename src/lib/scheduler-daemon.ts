/**
 * Scheduler Daemon — Core loop that claims and fires triggers from pgserve.
 *
 * Architecture:
 *   - LISTEN on `genie_trigger_due` for real-time notifications
 *   - 30s poll fallback as safety net (if NOTIFY is missed)
 *   - SELECT FOR UPDATE SKIP LOCKED for lease-based claiming
 *   - Idempotency keys prevent double-fire
 *   - Global concurrency cap via GENIE_MAX_CONCURRENT
 *   - Jitter on batch catch-up (>3 triggers at once) to prevent thundering herd
 *   - Structured JSON logging to ~/.genie/logs/scheduler.log
 *   - trace_id propagation into spawned agent environment
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type RunSpec, resolveRunSpec } from './run-spec.js';

// ============================================================================
// Types
// ============================================================================

export interface SchedulerConfig {
  /** Maximum concurrent runs. Default: 5. Overridden by GENIE_MAX_CONCURRENT. */
  maxConcurrent: number;
  /** Poll interval in ms. Default: 30000 (30s). */
  pollIntervalMs: number;
  /** Maximum jitter in ms for batch catch-up. Default: 30000 (30s). */
  maxJitterMs: number;
  /** Batch trigger threshold — jitter is applied when more than this many fire at once. */
  jitterThreshold: number;
}

interface TriggerRow {
  id: string;
  schedule_id: string;
  due_at: Date;
  status: string;
  idempotency_key: string | null;
  leased_by: string | null;
  leased_until: Date | null;
}

interface ScheduleRow {
  id: string;
  name: string;
  command: string | null;
  run_spec: RunSpec | Record<string, never>;
  status: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  event: string;
  [key: string]: unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
type SqlClient = any;

/** Dependency injection interface for testing. */
export interface SchedulerDeps {
  getConnection: () => Promise<SqlClient>;
  spawnCommand: (command: string, env: Record<string, string>) => Promise<{ pid: number | undefined }>;
  log: (entry: LogEntry) => void;
  generateId: () => string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  jitter: (maxMs: number) => number;
}

// ============================================================================
// Logging
// ============================================================================

const LOG_DIR = join(process.env.GENIE_HOME ?? join(homedir(), '.genie'), 'logs');
const LOG_FILE = join(LOG_DIR, 'scheduler.log');

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
}

/** Append a structured JSON log entry to the scheduler log file. */
export function logToFile(entry: LogEntry): void {
  ensureLogDir();
  appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
}

// ============================================================================
// Default dependencies (production)
// ============================================================================

async function defaultSpawnCommand(command: string, env: Record<string, string>): Promise<{ pid: number | undefined }> {
  const proc = Bun.spawn(['sh', '-c', command], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return { pid: proc.pid };
}

function defaultJitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDefaultDeps(): SchedulerDeps {
  return {
    getConnection: async () => {
      const { getConnection } = await import('./db.js');
      return getConnection();
    },
    spawnCommand: defaultSpawnCommand,
    log: logToFile,
    generateId: randomUUID,
    now: () => new Date(),
    sleep: defaultSleep,
    jitter: defaultJitter,
  };
}

// ============================================================================
// Default config
// ============================================================================

function resolveConfig(overrides?: Partial<SchedulerConfig>): SchedulerConfig {
  const envMax = process.env.GENIE_MAX_CONCURRENT;
  const maxConcurrent = envMax ? Number.parseInt(envMax, 10) : 5;

  return {
    maxConcurrent: overrides?.maxConcurrent ?? (Number.isNaN(maxConcurrent) ? 5 : maxConcurrent),
    pollIntervalMs: overrides?.pollIntervalMs ?? 30_000,
    maxJitterMs: overrides?.maxJitterMs ?? 30_000,
    jitterThreshold: overrides?.jitterThreshold ?? 3,
  };
}

// ============================================================================
// Core: claim and fire triggers
// ============================================================================

/**
 * Claim due triggers using SELECT FOR UPDATE SKIP LOCKED.
 * Returns claimed trigger rows (already marked as 'executing' in a transaction).
 */
export async function claimDueTriggers(
  deps: SchedulerDeps,
  config: SchedulerConfig,
  daemonId: string,
): Promise<TriggerRow[]> {
  const sql = await deps.getConnection();
  const now = deps.now();
  const leaseUntil = new Date(now.getTime() + 300_000); // 5m default lease

  // Check current running count against global cap
  const runningResult = await sql`
    SELECT count(*)::int AS cnt FROM runs
    WHERE status IN ('leased', 'running')
  `;
  const runningCount = runningResult[0]?.cnt ?? 0;
  const available = Math.max(0, config.maxConcurrent - runningCount);

  if (available === 0) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'debug',
      event: 'concurrency_cap_reached',
      running: runningCount,
      max: config.maxConcurrent,
    });
    return [];
  }

  const limit = Math.min(available, 5);

  // Atomic claim: select + update in one transaction
  const claimed = await sql.begin(async (tx: SqlClient) => {
    const rows: TriggerRow[] = await tx`
      SELECT id, schedule_id, due_at, status, idempotency_key, leased_by, leased_until
      FROM triggers
      WHERE status = 'pending' AND due_at <= ${now}
      ORDER BY due_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `;

    if (rows.length === 0) return [];

    const ids = rows.map((r: TriggerRow) => r.id);
    await tx`
      UPDATE triggers
      SET status = 'executing',
          leased_by = ${daemonId},
          leased_until = ${leaseUntil},
          started_at = ${now}
      WHERE id = ANY(${ids})
    `;

    return rows;
  });

  if (claimed.length > 0) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'info',
      event: 'triggers_claimed',
      count: claimed.length,
      ids: claimed.map((t: TriggerRow) => t.id),
      daemon_id: daemonId,
    });
  }

  return claimed;
}

/**
 * Fire a single claimed trigger: resolve RunSpec, spawn command, record run.
 */
export async function fireTrigger(deps: SchedulerDeps, trigger: TriggerRow, daemonId: string): Promise<void> {
  const sql = await deps.getConnection();
  const now = deps.now();
  const traceId = deps.generateId();
  const runId = deps.generateId();

  // Check idempotency
  if (trigger.idempotency_key) {
    // Query for OTHER triggers with the same key that already fired
    const dupeResult = await sql`
      SELECT 1 FROM triggers
      WHERE idempotency_key = ${trigger.idempotency_key}
        AND id != ${trigger.id}
        AND status IN ('executing', 'completed')
      LIMIT 1
    `;
    if (dupeResult.length > 0) {
      deps.log({
        timestamp: now.toISOString(),
        level: 'warn',
        event: 'idempotency_skip',
        trigger_id: trigger.id,
        idempotency_key: trigger.idempotency_key,
      });
      await sql`UPDATE triggers SET status = 'skipped', completed_at = ${now} WHERE id = ${trigger.id}`;
      return;
    }
  }

  // Load schedule to get command + run_spec
  const scheduleRows = await sql<ScheduleRow[]>`
    SELECT id, name, command, run_spec, status FROM schedules WHERE id = ${trigger.schedule_id}
  `;

  if (scheduleRows.length === 0) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'error',
      event: 'schedule_not_found',
      trigger_id: trigger.id,
      schedule_id: trigger.schedule_id,
    });
    await sql`UPDATE triggers SET status = 'failed', completed_at = ${now} WHERE id = ${trigger.id}`;
    return;
  }

  const schedule = scheduleRows[0];
  const command = schedule.command ?? (schedule.run_spec as RunSpec)?.command;

  if (!command) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'error',
      event: 'no_command',
      trigger_id: trigger.id,
      schedule_id: trigger.schedule_id,
    });
    await sql`UPDATE triggers SET status = 'failed', completed_at = ${now} WHERE id = ${trigger.id}`;
    return;
  }

  // Resolve RunSpec (merge schedule.run_spec defaults with command)
  const rawSpec = typeof schedule.run_spec === 'object' && schedule.run_spec !== null ? schedule.run_spec : {};
  const runSpec = resolveRunSpec({ ...rawSpec, command } as RunSpec);

  // Create run record
  await sql`
    INSERT INTO runs (id, trigger_id, worker_id, status, trace_id, lease_timeout_ms, started_at, created_at)
    VALUES (${runId}, ${trigger.id}, ${daemonId}, 'leased', ${traceId}, ${runSpec.lease_timeout_ms}, ${now}, ${now})
  `;

  // Spawn the command with trace_id in environment
  const env: Record<string, string> = {
    GENIE_TRACE_ID: traceId,
    GENIE_RUN_ID: runId,
    GENIE_TRIGGER_ID: trigger.id,
    GENIE_SCHEDULE_ID: trigger.schedule_id,
  };

  try {
    const result = await deps.spawnCommand(runSpec.command, env);

    // Update run to running
    await sql`
      UPDATE runs SET status = 'running', worker_id = ${String(result.pid ?? daemonId)}
      WHERE id = ${runId}
    `;

    deps.log({
      timestamp: now.toISOString(),
      level: 'info',
      event: 'trigger_fired',
      trigger_id: trigger.id,
      run_id: runId,
      trace_id: traceId,
      command: runSpec.command,
      pid: result.pid,
      schedule_name: schedule.name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await sql`UPDATE runs SET status = 'failed', error = ${message}, completed_at = ${deps.now()} WHERE id = ${runId}`;
    await sql`UPDATE triggers SET status = 'failed', completed_at = ${deps.now()} WHERE id = ${trigger.id}`;

    deps.log({
      timestamp: now.toISOString(),
      level: 'error',
      event: 'spawn_failed',
      trigger_id: trigger.id,
      run_id: runId,
      command: runSpec.command,
      error: message,
    });
  }
}

// ============================================================================
// Daemon loop
// ============================================================================

export interface DaemonHandle {
  /** Stop the daemon gracefully. */
  stop: () => void;
  /** Promise that resolves when the daemon exits. */
  done: Promise<void>;
  /** The unique daemon ID for this instance. */
  daemonId: string;
}

/**
 * Start the scheduler daemon.
 *
 * Flow:
 *   1. LISTEN on genie_trigger_due for real-time notifications
 *   2. Poll every 30s as fallback
 *   3. On each cycle: claim due triggers, apply jitter if batch, fire each
 *   4. Loop until stopped
 */
export function startDaemon(
  configOverrides?: Partial<SchedulerConfig>,
  depsOverrides?: Partial<SchedulerDeps>,
): DaemonHandle {
  const config = resolveConfig(configOverrides);
  const baseDeps = createDefaultDeps();
  const deps: SchedulerDeps = { ...baseDeps, ...depsOverrides };
  const daemonId = deps.generateId();

  let running = true;
  let pollTimeout: ReturnType<typeof setTimeout> | null = null;
  let listenConnection: SqlClient | null = null;

  const stop = () => {
    running = false;
    if (pollTimeout) {
      clearTimeout(pollTimeout);
      pollTimeout = null;
    }
    if (listenConnection) {
      listenConnection.end().catch(() => {});
      listenConnection = null;
    }
  };

  const processTriggers = async () => {
    try {
      const claimed = await claimDueTriggers(deps, config, daemonId);

      if (claimed.length === 0) return;

      // Apply jitter on batch catch-up
      if (claimed.length > config.jitterThreshold) {
        const jitterMs = deps.jitter(config.maxJitterMs);
        deps.log({
          timestamp: deps.now().toISOString(),
          level: 'info',
          event: 'jitter_applied',
          count: claimed.length,
          jitter_ms: jitterMs,
        });
        await deps.sleep(jitterMs);
      }

      // Fire each claimed trigger
      for (const trigger of claimed) {
        if (!running) break;
        await fireTrigger(deps, trigger, daemonId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'error',
        event: 'process_cycle_error',
        error: message,
      });
    }
  };

  const done = (async () => {
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'info',
      event: 'daemon_started',
      daemon_id: daemonId,
      max_concurrent: config.maxConcurrent,
      poll_interval_ms: config.pollIntervalMs,
    });

    // Set up LISTEN/NOTIFY for real-time trigger notifications
    try {
      const sql = await deps.getConnection();
      listenConnection = sql;

      await sql.listen('genie_trigger_due', async () => {
        if (!running) return;
        await processTriggers();
      });

      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'info',
        event: 'listen_started',
        channel: 'genie_trigger_due',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'warn',
        event: 'listen_failed',
        error: message,
      });
      // Continue with poll-only mode
    }

    // Initial trigger check
    await processTriggers();

    // Poll loop as fallback safety net
    while (running) {
      await new Promise<void>((resolve) => {
        pollTimeout = setTimeout(resolve, config.pollIntervalMs);
      });

      if (!running) break;
      await processTriggers();
    }

    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'info',
      event: 'daemon_stopped',
      daemon_id: daemonId,
    });
  })();

  return { stop, done, daemonId };
}
