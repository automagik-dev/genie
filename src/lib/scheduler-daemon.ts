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
 *   - Reboot recovery: reclaim expired leases, reconcile orphaned runs
 *   - Heartbeat collection every 60s: pane liveness + agent state
 *   - Machine snapshot every 60s: workers, teams, tmux sessions, CPU/memory
 *   - Orphan reconciliation every 5m: mark dead runs as failed after 2 missed heartbeats
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent, AgentState } from './agent-registry.js';
import { recordAuditEvent } from './audit.js';
import { computeNextCronDue, parseDuration } from './cron.js';
import { emitEvent } from './emit.js';
import { type EventRouterHandle, startEventRouter } from './event-router.js';
import { getInboxPollIntervalMs, startInboxWatcher, stopInboxWatcher } from './inbox-watcher.js';
import { type MailboxMessage, getRetryable, markEscalated, subscribeDelivery } from './mailbox.js';
import { type RunSpec, resolveRunSpec } from './run-spec.js';
import { getAmbient as getAmbientTraceContext } from './trace-context.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Recipient used when the mailbox retry loop escalates a permanently-failed
 * message. Extracted as a constant so the escalation writer and the guard
 * that prevents re-escalation reference the same literal.
 *
 * NOTE: This is a bare string today; there is no resolver that maps it to an
 * actual worker ID like `team-lead:<session>:<team>`. Delivering to this
 * bare string fails and, without the guards in `processMailboxRetryMessage`,
 * recursively produces more escalation messages. A follow-up wish will
 * replace this with a resolver that locates the real team-lead agent.
 */
export const ESCALATION_RECIPIENT = 'team-lead';

/** Maximum delivery attempts before the mailbox retry loop escalates a message. */
export const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * Env flag gating the turn-session-contract reconciler.
 *
 * Phase A (Group 1): flag read exists; default `false`; logged once at daemon
 * startup; no behavior change. Groups 2/3/4/5/7 wire the new reconciler
 * passes behind this flag.
 *
 * Phase B (Group 8 — this change): default flips to `true`. Migration 044
 * flipped `agents.auto_resume` default and backfilled live/stale rows; the
 * code side follows suit so a fresh daemon boot enables the turn-aware
 * passes by default. Rollback is still supported — set
 * `GENIE_RECONCILER_TURN_AWARE=0` (or `false`) to force the legacy path
 * without a redeploy.
 *
 * Phase C (Group 9, after 7-day soak): flag and legacy path are removed.
 */
export const TURN_AWARE_RECONCILER_FLAG = 'GENIE_RECONCILER_TURN_AWARE';

/**
 * Read the turn-aware reconciler flag from env.
 *
 * Default (unset / empty) is `true` since Phase B (Group 8). Explicit
 * opt-out: `GENIE_RECONCILER_TURN_AWARE=0` (also accepts `false`, `no`,
 * case-insensitive). Truthy values (`1`, `true`) are always accepted.
 */
export function isTurnAwareReconcilerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TURN_AWARE_RECONCILER_FLAG];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === '') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  // Unknown value — be conservative and honor Phase B default ON.
  return true;
}

/** Log the turn-aware reconciler mode once at daemon startup. */
export function logReconcilerMode(deps: Pick<SchedulerDeps, 'log' | 'now'>, daemonId: string): void {
  const enabled = isTurnAwareReconcilerEnabled();
  deps.log({
    timestamp: deps.now().toISOString(),
    level: 'info',
    event: enabled ? 'reconciler_mode_turn_aware' : 'reconciler_mode_legacy',
    daemon_id: daemonId,
    flag: TURN_AWARE_RECONCILER_FLAG,
    enabled,
    message: enabled ? 'turn-aware reconciler enabled' : 'flag off, using legacy reconciler',
  });
}

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
  /** Heartbeat collection interval in ms. Default: 60000 (60s). */
  heartbeatIntervalMs: number;
  /** Orphan reconciliation interval in ms. Default: 300000 (5m). */
  orphanCheckIntervalMs: number;
  /** Number of consecutive dead heartbeats before marking a run as failed. Default: 2. */
  deadHeartbeatThreshold: number;
  /** Lease recovery interval in ms. Default: 60000 (60s). Reclaims triggers stuck in 'executing' with expired leases. */
  leaseRecoveryIntervalMs: number;
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
  cron_expression: string | null;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  event: string;
  [key: string]: unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
type SqlClient = any;

/** Minimal agent shape returned by listWorkers for resume eligibility checks and event emission. */
export type WorkerInfo = Pick<
  Agent,
  | 'id'
  | 'paneId'
  | 'state'
  | 'team'
  | 'wishSlug'
  | 'groupNumber'
  | 'autoResume'
  | 'resumeAttempts'
  | 'maxResumeAttempts'
  | 'lastResumeAttempt'
  | 'claudeSessionId'
> & { repoPath?: string };

/** Dependency injection interface for testing. */
export interface SchedulerDeps {
  getConnection: () => Promise<SqlClient>;
  spawnCommand: (command: string, env: Record<string, string>) => Promise<{ pid: number | undefined }>;
  log: (entry: LogEntry) => void;
  generateId: () => string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  jitter: (maxMs: number) => number;
  /** Check if a tmux pane is still alive. Used for heartbeat collection and orphan detection. */
  isPaneAlive: (paneId: string) => Promise<boolean>;
  /** List registered workers from the agent registry. */
  listWorkers: () => Promise<WorkerInfo[]>;
  /** Count active tmux sessions. */
  countTmuxSessions: () => Promise<number>;
  /** Publish an event to the PG runtime event log. */
  publishEvent: (subject: string, data: unknown, repoPath: string) => Promise<void>;
  /** Resume a single agent by name via `genie resume <name>`. Returns true on success. */
  resumeAgent: (agentId: string) => Promise<boolean>;
  /** Update fields on an agent in the registry. */
  updateAgent: (agentId: string, updates: Partial<Agent>) => Promise<void>;
}

// ============================================================================
// Logging
// ============================================================================

function getLogDir(): string {
  return join(process.env.GENIE_HOME ?? join(homedir(), '.genie'), 'logs');
}

function getLogFile(): string {
  return join(getLogDir(), 'scheduler.log');
}

/** Append a structured JSON log entry to the scheduler log file. */
export function logToFile(entry: LogEntry): void {
  const logDir = getLogDir();
  mkdirSync(logDir, { recursive: true });
  const enriched = entry.trace_id ? entry : withAmbientTraceId(entry);
  appendFileSync(getLogFile(), `${JSON.stringify(enriched)}\n`);
}

/**
 * Merge the ambient trace context (if any) into a log entry so every line the
 * scheduler produces carries `trace_id=<hex>`. Callers that already set
 * `trace_id` explicitly are left alone.
 */
function withAmbientTraceId(entry: LogEntry): LogEntry {
  const ctx = getAmbientTraceContext();
  if (!ctx) return entry;
  return { ...entry, trace_id: ctx.trace_id };
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

async function defaultIsPaneAlive(paneId: string): Promise<boolean> {
  const { isPaneAlive } = await import('./tmux.js');
  return isPaneAlive(paneId);
}

async function defaultListWorkers(): Promise<WorkerInfo[]> {
  const { list } = await import('./agent-registry.js');
  const agents = await list();
  return agents.map((a) => ({
    id: a.id,
    paneId: a.paneId,
    repoPath: a.repoPath,
    state: a.state,
    team: a.team,
    wishSlug: a.wishSlug,
    groupNumber: a.groupNumber,
    autoResume: a.autoResume,
    resumeAttempts: a.resumeAttempts,
    maxResumeAttempts: a.maxResumeAttempts,
    lastResumeAttempt: a.lastResumeAttempt,
    claudeSessionId: a.claudeSessionId,
  }));
}

async function defaultPublishEvent(subject: string, data: unknown, repoPath: string): Promise<void> {
  const payload = data as {
    timestamp?: string;
    kind?: 'user' | 'assistant' | 'message' | 'state' | 'tool_call' | 'tool_result' | 'system' | 'qa';
    agent?: string;
    team?: string;
    direction?: 'in' | 'out';
    peer?: string;
    text?: string;
    data?: Record<string, unknown>;
    source?: 'provider' | 'mailbox' | 'chat' | 'registry' | 'hook';
  };

  const { publishSubjectEvent } = await import('./runtime-events.js');
  await publishSubjectEvent(repoPath, subject, {
    timestamp: payload.timestamp,
    kind: payload.kind ?? 'system',
    agent: payload.agent ?? 'scheduler',
    team: payload.team,
    direction: payload.direction,
    peer: payload.peer,
    text: payload.text ?? subject,
    data: payload.data,
    source: payload.source ?? 'registry',
  });
}

async function defaultCountTmuxSessions(): Promise<number> {
  try {
    const { execSync } = await import('node:child_process');
    const { genieTmuxCmd } = await import('./tmux-wrapper.js');
    const output = execSync(`${genieTmuxCmd('list-sessions')} 2>/dev/null`, { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function defaultResumeAgent(agentId: string): Promise<boolean> {
  try {
    const { execSync } = await import('node:child_process');
    // `--no-reset-attempts` prevents the resume handler from wiping
    // `resumeAttempts` — `attemptAgentResume` increments that counter *before*
    // invoking us, and needs the increment to persist so the exhaustion check
    // can eventually fire. Without this flag, the counter was stuck at 0 and
    // dead agents were retried every ~60s forever (fix/auto-resume-counter-persistence).
    execSync(`genie agent resume ${agentId} --no-reset-attempts`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

async function defaultUpdateAgent(agentId: string, updates: Partial<Agent>): Promise<void> {
  const { update } = await import('./agent-registry.js');
  await update(agentId, updates);
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
    isPaneAlive: defaultIsPaneAlive,
    listWorkers: defaultListWorkers,
    countTmuxSessions: defaultCountTmuxSessions,
    publishEvent: defaultPublishEvent,
    resumeAgent: defaultResumeAgent,
    updateAgent: defaultUpdateAgent,
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
    heartbeatIntervalMs: overrides?.heartbeatIntervalMs ?? 60_000,
    orphanCheckIntervalMs: overrides?.orphanCheckIntervalMs ?? 300_000,
    deadHeartbeatThreshold: overrides?.deadHeartbeatThreshold ?? 2,
    leaseRecoveryIntervalMs: overrides?.leaseRecoveryIntervalMs ?? 60_000,
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
 * Compute the next due_at for a recurring schedule and insert a new pending trigger.
 * Returns without inserting if the schedule is one-shot (@once) or has no cron_expression.
 */
async function maybeCreateNextTrigger(
  sql: SqlClient,
  deps: SchedulerDeps,
  schedule: ScheduleRow,
  now: Date,
): Promise<void> {
  if (!schedule.cron_expression || schedule.cron_expression === '@once') return;

  let nextDueAt: Date | null = null;

  if (schedule.cron_expression.startsWith('@every ')) {
    const durationStr = schedule.cron_expression.slice(7).trim();
    try {
      const intervalMs = parseDuration(durationStr);
      nextDueAt = new Date(now.getTime() + intervalMs);
    } catch {
      deps.log({
        timestamp: now.toISOString(),
        level: 'warn',
        event: 'invalid_interval',
        schedule_id: schedule.id,
        cron_expression: schedule.cron_expression,
      });
    }
  } else {
    try {
      nextDueAt = computeNextCronDue(schedule.cron_expression, now);
    } catch {
      deps.log({
        timestamp: now.toISOString(),
        level: 'warn',
        event: 'cron_computation_failed',
        schedule_id: schedule.id,
        cron_expression: schedule.cron_expression,
      });
    }
  }

  if (nextDueAt) {
    const nextTriggerId = deps.generateId();
    await sql`
      INSERT INTO triggers (id, schedule_id, due_at, status)
      VALUES (${nextTriggerId}, ${schedule.id}, ${nextDueAt.toISOString()}, 'pending')
    `;
    deps.log({
      timestamp: now.toISOString(),
      level: 'info',
      event: 'next_trigger_created',
      trigger_id: nextTriggerId,
      schedule_id: schedule.id,
      due_at: nextDueAt.toISOString(),
    });
  }
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
    SELECT id, name, command, run_spec, status, cron_expression FROM schedules WHERE id = ${trigger.schedule_id}
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

    // Advance trigger from 'executing' to 'completed'
    await sql`UPDATE triggers SET status = 'completed', completed_at = ${now} WHERE id = ${trigger.id}`;

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

    // Insert next trigger for recurring schedules
    await maybeCreateNextTrigger(sql, deps, schedule, now);
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
// Reboot recovery
// ============================================================================

/**
 * Reclaim expired leases on startup.
 * After a crash/reboot, triggers stuck in 'executing' with expired leases
 * are reset to 'pending' so they can be re-claimed.
 */
export async function reclaimExpiredLeases(deps: SchedulerDeps, daemonId: string): Promise<number> {
  const sql = await deps.getConnection();
  const now = deps.now();

  const result = await sql`
    UPDATE triggers
    SET status = 'pending', leased_by = NULL, leased_until = NULL, started_at = NULL
    WHERE status = 'executing' AND leased_until < ${now}
    RETURNING id
  `;

  const count = result.length;
  if (count > 0) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'info',
      event: 'expired_leases_reclaimed',
      count,
      ids: result.map((r: { id: string }) => r.id),
      daemon_id: daemonId,
    });
  }

  return count;
}

/**
 * Check if a worker is alive by PID or tmux pane.
 * Returns { alive, isPid } for the given worker_id.
 *
 * Safe today for SDK/non-tmux transports: `runs.worker_id` is only ever
 * populated by the scheduler at {@link handleTrigger} from `result.pid` (a
 * real OS PID) or `daemonId` (a UUID fallback). It never stores a tmux pane
 * id or a synthetic id like 'sdk'/'inline' (see `INSERT INTO runs` +
 * `UPDATE runs SET worker_id` — the only two write sites). SDK-backed agents
 * live in `agents`/`executors`, not `runs`, so no transport dispatch is
 * needed here. If `runs.worker_id` ever starts carrying synthetic ids, add
 * an `isExecutorAlive` branch below.
 */
async function checkWorkerAlive(
  deps: SchedulerDeps,
  workerId: string | null,
): Promise<{ alive: boolean; isPid: boolean }> {
  const isPid = /^\d+$/.test(workerId ?? '');
  if (isPid && workerId) {
    try {
      process.kill(Number(workerId), 0);
      return { alive: true, isPid };
    } catch {
      return { alive: false, isPid };
    }
  }
  const paneId = workerId?.startsWith('%') ? workerId : null;
  if (paneId) {
    const alive = await deps.isPaneAlive(paneId);
    return { alive, isPid };
  }
  return { alive: false, isPid };
}

/**
 * Reconcile orphaned runs on startup.
 * For runs with status='running' or 'leased', check if the worker pane is alive.
 * If pane is dead, mark the run as failed.
 */
export async function reconcileOrphanedRuns(deps: SchedulerDeps, daemonId: string): Promise<number> {
  const sql = await deps.getConnection();
  const now = deps.now();

  const activeRuns = await sql`
    SELECT id, worker_id, status, trigger_id FROM runs
    WHERE status IN ('running', 'leased')
  `;

  let orphanCount = 0;
  for (const run of activeRuns) {
    const { alive } = await checkWorkerAlive(deps, run.worker_id);
    if (!alive) {
      await sql`
        UPDATE runs SET status = 'failed', error = 'orphaned: worker dead on startup recovery', completed_at = ${now}
        WHERE id = ${run.id}
      `;
      await sql`
        UPDATE triggers SET status = 'failed', completed_at = ${now}
        WHERE id = ${run.trigger_id} AND status = 'executing'
      `;
      orphanCount++;
    }
  }

  if (orphanCount > 0) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'info',
      event: 'orphaned_runs_reconciled',
      count: orphanCount,
      daemon_id: daemonId,
    });
  }

  return orphanCount;
}

/**
 * Delay before a one-shot retry of the agent recovery pass when the initial
 * pass had any per-worker failures (e.g. tmux socket not reachable yet).
 */
const RECOVERY_RETRY_DELAY_MS = 60_000;

/**
 * Run full startup recovery: reclaim expired leases, reconcile orphaned runs,
 * then auto-resume agents whose panes died while the daemon was down.
 *
 * Resilience: if the initial agent recovery pass hits any per-worker failure
 * (for example, the tmux socket is not yet ready when the daemon boots after
 * a server reboot), a single retry pass is scheduled {@link RECOVERY_RETRY_DELAY_MS}
 * later. Per-worker failures never abort the outer loop — each worker is
 * isolated so one bad pane does not poison recovery for the rest.
 */
export async function recoverOnStartup(deps: SchedulerDeps, daemonId: string, config?: SchedulerConfig): Promise<void> {
  const now = deps.now();
  deps.log({
    timestamp: now.toISOString(),
    level: 'info',
    event: 'recovery_started',
    daemon_id: daemonId,
  });

  const reclaimed = await reclaimExpiredLeases(deps, daemonId);
  const orphans = await reconcileOrphanedRuns(deps, daemonId);

  const { resumed, failed } = await runAgentRecoveryPass(deps, daemonId, config, 'boot');

  deps.log({
    timestamp: deps.now().toISOString(),
    level: 'info',
    event: 'recovery_completed',
    reclaimed_leases: reclaimed,
    orphaned_runs: orphans,
    resumed_agents: resumed,
    failed_agents: failed,
    daemon_id: daemonId,
  });

  if (failed > 0) {
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'info',
      event: 'recovery_retry_scheduled',
      daemon_id: daemonId,
      failed_agents: failed,
      delay_ms: RECOVERY_RETRY_DELAY_MS,
    });
    scheduleRecoveryRetry(deps, daemonId, config);
  }
}

/**
 * Schedule a single delayed retry pass. Extracted for test injection and to
 * keep the happy-path in {@link recoverOnStartup} readable.
 */
function scheduleRecoveryRetry(deps: SchedulerDeps, daemonId: string, config?: SchedulerConfig): void {
  setTimeout(async () => {
    try {
      const retry = await runAgentRecoveryPass(deps, daemonId, config, 'boot');
      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'info',
        event: 'recovery_retry_completed',
        daemon_id: daemonId,
        resumed_agents: retry.resumed,
        failed_agents: retry.failed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'error',
        event: 'recovery_retry_error',
        daemon_id: daemonId,
        error: message,
      });
    }
  }, RECOVERY_RETRY_DELAY_MS).unref?.();
}

/**
 * Run a single pass over resumable agents with per-worker fault isolation.
 *
 * Each worker's `isPaneAlive` + `attemptAgentResume` is wrapped in try/catch,
 * so a single failure (for example, an unreachable tmux socket during early
 * boot) does not abort the recovery loop for the remaining workers.
 *
 * Exported so the periodic auto-resume timer can invoke the same pass mid-run
 * (startAgentResumeTimer) — without it, agents that hit `error` while the
 * daemon is up never retry until the next process restart.
 */
/** States where the turn-aware reconciler resumes a dead pane (D3 rule). */
const TURN_AWARE_RESUMABLE_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['working', 'permission', 'question']);

type RecoveryOutcome = 'resumed' | 'terminalized' | 'skipped';
type RecoveryMode = 'boot' | 'sweep';

/**
 * Per-worker recovery decision for a dead pane, extracted so
 * `runAgentRecoveryPass` stays below the cognitive-complexity cap.
 *
 * Legacy (flag off): delegate everything to `attemptAgentResume`.
 * Turn-aware (flag on) in 'sweep' mode:
 *   - D1 idle + dead → `terminalizeCleanExitUnverified`, no resume
 *   - D3 working/permission/question + dead → resume
 *   - other non-terminal states → skipped (prevents post-D1 ghost loop)
 *
 * 'boot' mode deliberately bypasses the D1/D3 gates: when the daemon
 * just restarted, an idle-with-dead-pane row is most likely an agent
 * that was legitimately mid-turn when the daemon itself died (state
 * preserved across reboot). The turn-aware rules exist for periodic
 * sweeps, where "idle + dead" is a ghost-loop precursor.
 */
/**
 * Gap #2 (turn-session-contract): boot-mode reconciler's D1/D3 bypass resurrects
 * properly-closed agents across daemon restart. Returns true when the agent's
 * current executor is already terminal (closed_at set OR outcome set), meaning an
 * explicit close verb OR pane-exit trap already fired. Caller should skip resume.
 *
 * Never throws — a transient PG error returns false so the worker falls back to
 * legacy resume behavior. Errs on the side of attempting resume (mirrors the
 * pre-fix default) rather than silently dropping a legitimate mid-turn crash.
 */
async function isLegitimatelyClosed(deps: SchedulerDeps, worker: WorkerInfo): Promise<boolean> {
  try {
    const sql = await deps.getConnection();
    const agentRows = await sql<{ current_executor_id: string | null }[]>`
      SELECT current_executor_id FROM agents WHERE id = ${worker.id}
    `;
    const executorId = agentRows[0]?.current_executor_id;
    if (!executorId) return false;
    const execRows = await sql<{ closed_at: Date | null; outcome: string | null }[]>`
      SELECT closed_at, outcome FROM executors WHERE id = ${executorId}
    `;
    if (execRows.length === 0) return false;
    return execRows[0].closed_at !== null || execRows[0].outcome !== null;
  } catch {
    return false;
  }
}

async function handleDeadPane(
  deps: SchedulerDeps,
  config: SchedulerConfig,
  daemonId: string,
  worker: WorkerInfo,
  turnAware: boolean,
  mode: RecoveryMode,
): Promise<RecoveryOutcome> {
  if (mode === 'boot') {
    // Gap #2 fix: before resuming, check if the agent's executor is already
    // terminal. Otherwise we resurrect agents that called `genie done` before
    // the daemon restarted (2026-04-21 live regression in turn-session-contract-genie team).
    if (turnAware && (await isLegitimatelyClosed(deps, worker))) {
      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'debug',
        event: 'agent_resume_skipped_boot_terminal',
        daemon_id: daemonId,
        agent_id: worker.id,
        reason: 'executor_already_closed',
      });
      return 'skipped';
    }
    const result = await attemptAgentResume(deps, config, worker);
    return result === 'resumed' ? 'resumed' : 'skipped';
  }
  if (turnAware && worker.state === 'idle') {
    const res = await terminalizeCleanExitUnverified(deps, worker, 'reconciler_idle_dead_pane');
    if (res.terminalized) {
      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'warn',
        event: 'agent_terminalized_clean_exit_unverified',
        daemon_id: daemonId,
        agent_id: worker.id,
        executor_id: res.executorId,
        reason: 'idle_dead_pane',
      });
      return 'terminalized';
    }
    return 'skipped';
  }
  if (turnAware && !TURN_AWARE_RESUMABLE_STATES.has(worker.state as AgentState)) {
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'debug',
      event: 'agent_resume_skipped_turn_aware',
      daemon_id: daemonId,
      agent_id: worker.id,
      state: worker.state,
      reason: 'state_not_in_d3',
    });
    return 'skipped';
  }
  const result = await attemptAgentResume(deps, config, worker);
  return result === 'resumed' ? 'resumed' : 'skipped';
}

/**
 * Distinguish "tmux server is down" from real per-worker probe failures when
 * the recovery pass cannot verify a pane. When tmux is down we cannot do
 * anything productive this tick — the registry reconciler's dead-socket
 * fast-path (`isTmuxServerReachable`) will terminalize these workers once
 * the stale socket is detected, so spamming `recovery_worker_failed` every
 * minute per worker is pure log noise. Returns `true` if the caller should
 * skip this worker silently.
 */
function handleRecoveryProbeError(deps: SchedulerDeps, daemonId: string, workerId: string, err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const tmuxDown =
    message.includes('no server running') || message.includes('server exited') || message.includes('error connecting');
  if (tmuxDown) {
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'debug',
      event: 'recovery_worker_skipped_tmux_down',
      daemon_id: daemonId,
      worker_id: workerId,
    });
    return true;
  }
  deps.log({
    timestamp: deps.now().toISOString(),
    level: 'warn',
    event: 'recovery_worker_failed',
    daemon_id: daemonId,
    worker_id: workerId,
    error: message,
  });
  return false;
}

export async function runAgentRecoveryPass(
  deps: SchedulerDeps,
  daemonId: string,
  config?: SchedulerConfig,
  mode: RecoveryMode = 'sweep',
): Promise<{ resumed: number; failed: number; terminalized: number }> {
  const resolvedConfig = config ?? resolveConfig();
  const workers = await deps.listWorkers();
  // Safe for SDK/non-tmux transports: the `claudeSessionId` filter below
  // excludes them (SDK agents don't own a Claude-CLI JSONL session id).
  // Only tmux-resumable Claude-CLI agents reach `isPaneAlive`, so a plain
  // paneId check is correct here — no transport dispatch needed. If SDK
  // ever gains resume support, gate on paneId shape like countActiveWorkers.
  const resumable = workers.filter((w) => w.state !== 'suspended' && w.state !== 'done' && w.claudeSessionId);
  const turnAware = isTurnAwareReconcilerEnabled();

  let resumed = 0;
  let failed = 0;
  let terminalized = 0;

  for (const worker of resumable) {
    try {
      const alive = await deps.isPaneAlive(worker.paneId);
      if (alive) continue;
      const outcome = await handleDeadPane(deps, resolvedConfig, daemonId, worker, turnAware, mode);
      if (outcome === 'resumed') resumed++;
      else if (outcome === 'terminalized') terminalized++;
    } catch (err) {
      if (handleRecoveryProbeError(deps, daemonId, worker.id, err)) continue;
      failed++;
    }
  }

  return { resumed, failed, terminalized };
}

/**
 * Terminal-boundary write for the turn-aware reconciler's D1 rule.
 *
 * An agent found in `state='idle'` with a dead pane is the classic
 * ghost-loop precursor: the turn finished quietly (no `genie done` /
 * `blocked` / `failed`) and the pane then exited. Resuming such a row
 * replays the already-completed turn (C20 incident, 2026-04-19).
 *
 * Write semantics (single transaction, first-writer-wins with the pane
 * trap and the explicit close verbs):
 *   - look up `agents.current_executor_id`; if absent, only flip the
 *     agent state to `error` (no executor to terminalize)
 *   - if the executor is already closed (`closed_at IS NOT NULL` or
 *     `outcome IS NOT NULL`), the explicit verbs / pane trap already
 *     ran — leave the executor untouched, just clear
 *     `current_executor_id` so the next reconcile pass skips it
 *   - otherwise write `state='error'`, `outcome='clean_exit_unverified'`,
 *     `close_reason=<reason>`, `closed_at=now`, `ended_at=now`, clear
 *     `current_executor_id`, emit a `reconciler.clean_exit_unverified`
 *     audit event
 *
 * Never throws: DB errors are caught so a transient PG blip can't
 * wedge `runAgentRecoveryPass` for every subsequent worker in the pass.
 */
export async function terminalizeCleanExitUnverified(
  deps: SchedulerDeps,
  worker: WorkerInfo,
  reason: string,
): Promise<{ terminalized: boolean; executorId: string | null }> {
  const nowIso = deps.now().toISOString();
  try {
    const sql = await deps.getConnection();
    return await sql.begin(async (tx: SqlClient) => {
      const rows = await tx`SELECT current_executor_id FROM agents WHERE id = ${worker.id}`;
      const executorId = (rows[0]?.current_executor_id as string | null | undefined) ?? null;

      if (!executorId) {
        await tx`
          UPDATE agents
          SET state = 'error',
              last_state_change = ${nowIso}
          WHERE id = ${worker.id}
        `;
        return { terminalized: false, executorId: null };
      }

      const execRows = await tx<{ closed_at: Date | null; outcome: string | null }[]>`
        SELECT closed_at, outcome FROM executors
        WHERE id = ${executorId}
        FOR UPDATE
      `;
      const alreadyClosed = execRows.length > 0 && (execRows[0].closed_at !== null || execRows[0].outcome !== null);
      if (alreadyClosed) {
        await tx`
          UPDATE agents
          SET current_executor_id = NULL,
              state = 'error',
              last_state_change = ${nowIso}
          WHERE id = ${worker.id}
        `;
        return { terminalized: false, executorId };
      }

      await tx`
        UPDATE executors
        SET state = 'error',
            outcome = 'clean_exit_unverified',
            close_reason = ${reason},
            closed_at = ${nowIso},
            ended_at = ${nowIso}
        WHERE id = ${executorId}
      `;

      await tx`
        UPDATE agents
        SET current_executor_id = NULL,
            state = 'error',
            last_state_change = ${nowIso}
        WHERE id = ${worker.id}
      `;

      await tx`
        INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
        VALUES (
          'executor',
          ${executorId},
          'reconciler.clean_exit_unverified',
          'scheduler',
          ${tx.json({ agent_id: worker.id, reason, outcome: 'clean_exit_unverified' })}
        )
      `;

      return { terminalized: true, executorId };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'error',
      event: 'terminalize_clean_exit_unverified_failed',
      agent_id: worker.id,
      error: message,
    });
    return { terminalized: false, executorId: null };
  }
}

/**
 * Reconcile agents that can never be auto-resumed.
 *
 * Rows in `state='error'` with `autoResume=true` but no `claudeSessionId` are
 * permanently wedged: the resume filter in {@link runAgentRecoveryPass} drops
 * them (no session id to resume from), so they are never attempted, their
 * counter never advances, and `genie ls` keeps displaying `auto-resume: on`
 * — a lie to the operator since the scheduler cannot possibly try.
 *
 * Observed live on felipe's machine: 9 such rows (8 `genie-docs` directory
 * placeholders + 2 omni workers that died before capturing a Claude session
 * id). Root cause for why those rows end up in `error` state without a
 * session id is tracked as a separate investigation (dir:-row state
 * mutation + omni session capture).
 *
 * The fix here is the terminal-boundary invariant: mark them `auto_resume=false`
 * so subsequent scheduler ticks ignore them and the UI reflects reality.
 * Each flipped row logs `agent_marked_unresumable` for observability.
 *
 * Exported so the periodic timer can invoke it alongside the existing
 * `reconcileDeadPaneZombies` + `runAgentRecoveryPass` pair.
 */
export async function reconcileUnresumable(deps: SchedulerDeps): Promise<number> {
  const workers = await deps.listWorkers();
  let flipped = 0;
  for (const worker of workers) {
    // Terminal boundary condition: error-state, auto-resume on, no session id.
    // `!worker.claudeSessionId` matches both `null` (DB) and `undefined`
    // (listWorkers mapping for missing column).
    if (worker.state !== 'error') continue;
    if (worker.autoResume === false) continue;
    if (worker.claudeSessionId) continue;

    try {
      await deps.updateAgent(worker.id, { autoResume: false });
      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'warn',
        event: 'agent_marked_unresumable',
        agent_id: worker.id,
        reason: 'no_session_id',
        state: worker.state,
      });
      flipped++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'warn',
        event: 'agent_marked_unresumable_failed',
        agent_id: worker.id,
        error: message,
      });
    }
  }
  return flipped;
}

// ============================================================================
// Agent auto-resume
// ============================================================================

/** Default resume cooldown in ms (60s). */
const RESUME_COOLDOWN_MS = 60_000;

/** Default max auto-resume attempts. */
const DEFAULT_MAX_RESUME_ATTEMPTS = 3;

/** States that never consume a concurrency-cap slot (terminal or pre-active). */
const INACTIVE_WORKER_STATES = new Set(['done', 'error', 'suspended', 'spawning']);

/**
 * Count workers genuinely consuming a concurrency-cap slot.
 *
 * Excludes rows that only appear active on paper:
 *   1. `state == null` — identity records created by `findOrCreateAgent`
 *      (see `agent-registry.ts:548-550`). They track liveness via the
 *      `executors` table, not the legacy `state` column.
 *   2. States in INACTIVE_WORKER_STATES (done/error/suspended/spawning).
 *   3. tmux-pane rows whose pane is dead — zombie rows whose pane died
 *      without a state update. Mirrors `term-commands/agents.ts:2475
 *      resolveWorkerLiveness`. Synthetic paneIds (sdk, inline, empty) are
 *      skipped because they have their own non-tmux liveness source.
 *
 * When `isPaneAlive` throws (tmux unreachable) we conservatively count the
 * row — better to briefly over-count than to silently under-count during a
 * tmux blip and over-spawn past the configured cap.
 */
async function countActiveWorkers(
  workers: WorkerInfo[],
  isPaneAlive: (paneId: string) => Promise<boolean>,
): Promise<number> {
  let count = 0;
  for (const w of workers) {
    if (w.state == null || INACTIVE_WORKER_STATES.has(w.state)) continue;
    if (/^%\d+$/.test(w.paneId)) {
      try {
        if (!(await isPaneAlive(w.paneId))) continue;
      } catch {
        // Tmux unreachable — be conservative, count this row
      }
    }
    count++;
  }
  return count;
}

/**
 * Result of an auto-resume attempt.
 *   - 'resumed' — agent was successfully resumed
 *   - 'exhausted' — retry budget depleted, agent marked permanently failed
 *   - 'skipped' — ineligible (autoResume off, cooldown, cap, no session, etc.)
 */
type ResumeResult = 'resumed' | 'exhausted' | 'skipped';

/**
 * Attempt to auto-resume a dead agent.
 *
 * Checks eligibility (autoResume flag, retry budget, cooldown, concurrency cap),
 * then delegates to `deps.resumeAgent` to actually respawn the agent.
 */
/**
 * Known `AgentState` values we expose on the auto-resume telemetry events.
 * Any unrecognized value (e.g., a schema migration landed a new state we
 * haven't registered yet) degrades to `'unknown'` so emission never throws
 * on a Zod enum mismatch. Keep in sync with `src/lib/events/schemas/agent.resume.*.ts`.
 */
const TELEMETRY_STATES = new Set<AgentState>([
  'spawning',
  'working',
  'idle',
  'permission',
  'question',
  'done',
  'error',
  'suspended',
]);

function telemetryState(raw: AgentState | null | undefined): string {
  return raw && TELEMETRY_STATES.has(raw) ? raw : 'unknown';
}

/**
 * Emit the auto-resume telemetry triplet (`agent.resume.attempted|succeeded|failed`)
 * to both sinks:
 *   - `audit_events` (via `recordAuditEvent`) so `genie events list --type
 *      agent.resume.*` surfaces rows immediately. Issue #1304.
 *   - v2 runtime events (via `emitEvent`) for detector consumers.
 *
 * Both calls are best-effort — `recordAuditEvent` swallows DB errors, and
 * `emitEvent` is fire-and-forget. Failure here MUST NOT break the resume path.
 */
function recordResumeTelemetry(
  eventType: 'agent.resume.attempted' | 'agent.resume.succeeded' | 'agent.resume.failed',
  payload: {
    entity_id: string;
    attempt_number: number;
    state_before: string;
    state_after: string;
    last_error?: string;
    trigger: 'scheduler' | 'manual' | 'boot';
    exhausted?: boolean;
  },
  actor: string,
): void {
  // audit_events (default `genie events list` target)
  void recordAuditEvent('agent.resume', payload.entity_id, eventType, actor, payload).catch(() => {
    /* best-effort — swallowed inside recordAuditEvent too */
  });

  // v2 runtime events (detector target)
  try {
    const v2Payload: Record<string, unknown> = {
      entity_id: payload.entity_id,
      attempt_number: payload.attempt_number,
      state_before: payload.state_before,
      state_after: payload.state_after,
      trigger: payload.trigger,
    };
    if (payload.last_error) {
      v2Payload.last_error = payload.last_error.slice(0, 500);
    }
    if (eventType === 'agent.resume.failed') {
      v2Payload.exhausted = payload.exhausted ?? false;
    }
    emitEvent(eventType, v2Payload, {
      severity: eventType === 'agent.resume.failed' ? 'warn' : 'info',
      source_subsystem: 'scheduler.auto-resume',
    });
  } catch {
    /* emit is best-effort — observability must never break the path it observes */
  }
}

export async function attemptAgentResume(
  deps: SchedulerDeps,
  config: SchedulerConfig,
  agent: WorkerInfo,
): Promise<ResumeResult> {
  const now = deps.now();
  const agentId = agent.id;

  // autoResume defaults to true when undefined
  if (agent.autoResume === false) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'debug',
      event: 'agent_resume_skipped',
      agent_id: agentId,
      reason: 'auto_resume_disabled',
    });
    return 'skipped';
  }

  // Must have a Claude session ID to resume
  if (!agent.claudeSessionId) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'debug',
      event: 'agent_resume_skipped',
      agent_id: agentId,
      reason: 'no_session_id',
    });
    return 'skipped';
  }

  const maxAttempts = agent.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS;
  const attempts = agent.resumeAttempts ?? 0;

  // Retry budget exhausted — mark terminal so the scheduler filter excludes
  // the agent next cycle. Prior to this write, `attempts >= maxAttempts` rows
  // kept passing the resumable filter, so `agent_resume_exhausted` fired on
  // every tick (60s) for the same agent without any new delivery attempt. The
  // log-once invariant requires `auto_resume=false` to persist at the terminal
  // boundary (mirrors the Bug A unresumable reconciler below). We only reach
  // this branch when `autoResume !== false` (the earlier early-skip handles
  // the disabled case), so the write is unconditional here.
  if (attempts >= maxAttempts) {
    await deps.updateAgent(agentId, { autoResume: false });
    deps.log({
      timestamp: now.toISOString(),
      level: 'warn',
      event: 'agent_resume_exhausted',
      agent_id: agentId,
      resume_attempts: attempts,
      max_resume_attempts: maxAttempts,
    });
    return 'exhausted';
  }

  // Cooldown: lastResumeAttempt + 60s must be in the past
  if (agent.lastResumeAttempt) {
    const lastAttempt = new Date(agent.lastResumeAttempt).getTime();
    if (now.getTime() - lastAttempt < RESUME_COOLDOWN_MS) {
      deps.log({
        timestamp: now.toISOString(),
        level: 'debug',
        event: 'agent_resume_skipped',
        agent_id: agentId,
        reason: 'cooldown',
        last_attempt: agent.lastResumeAttempt,
      });
      return 'skipped';
    }
  }

  // Concurrency cap: count active workers (see `countActiveWorkers` above).
  // Without NULL-filter + dead-pane filter, accumulated identity rows and
  // dead-pane zombies inflated activeCount to 142 on one observed machine,
  // permanently blocking every auto-resume attempt (`active=142, max=5`).
  const workers = await deps.listWorkers();
  const activeCount = await countActiveWorkers(workers, deps.isPaneAlive);
  if (activeCount >= config.maxConcurrent) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'debug',
      event: 'agent_resume_skipped',
      agent_id: agentId,
      reason: 'concurrency_cap',
      active: activeCount,
      max: config.maxConcurrent,
    });
    return 'skipped';
  }

  // Increment attempts and set lastResumeAttempt before spawning
  const newAttempts = attempts + 1;
  await deps.updateAgent(agentId, {
    resumeAttempts: newAttempts,
    lastResumeAttempt: now.toISOString(),
  });

  deps.log({
    timestamp: now.toISOString(),
    level: 'info',
    event: 'agent_resume_attempted',
    agent_id: agentId,
    resume_attempts: newAttempts,
    max_resume_attempts: maxAttempts,
  });

  const stateBefore = telemetryState(agent.state);
  recordResumeTelemetry(
    'agent.resume.attempted',
    {
      entity_id: agentId,
      attempt_number: newAttempts,
      state_before: stateBefore,
      state_after: stateBefore,
      trigger: 'scheduler',
    },
    'scheduler',
  );

  // Attempt the resume
  const success = await deps.resumeAgent(agentId);

  if (success) {
    // Reset the counter on success so a healthy agent doesn't carry stale
    // "2/3 resumes" state into the next failure. We own the counter now that
    // `defaultResumeAgent` passes `--no-reset-attempts` to the CLI.
    await deps.updateAgent(agentId, { resumeAttempts: 0 });
    deps.log({
      timestamp: now.toISOString(),
      level: 'info',
      event: 'agent_resume_succeeded',
      agent_id: agentId,
      resume_attempts: newAttempts,
    });
    recordResumeTelemetry(
      'agent.resume.succeeded',
      {
        entity_id: agentId,
        attempt_number: newAttempts,
        state_before: stateBefore,
        // A successful resume re-spawns the agent; the registry row is about
        // to transition to 'spawning' as `defaultSpawnCommand` fires. Emitting
        // 'spawning' here gives detectors the state_before != state_after
        // signal they need to distinguish thrashing (where state never moves)
        // from healthy resumes (where it does).
        state_after: 'spawning',
        trigger: 'scheduler',
      },
      'scheduler',
    );
    return 'resumed';
  }

  deps.log({
    timestamp: now.toISOString(),
    level: 'warn',
    event: 'agent_resume_failed',
    agent_id: agentId,
    resume_attempts: newAttempts,
    max_resume_attempts: maxAttempts,
  });

  const willExhaust = newAttempts >= maxAttempts;
  recordResumeTelemetry(
    'agent.resume.failed',
    {
      entity_id: agentId,
      attempt_number: newAttempts,
      state_before: stateBefore,
      // On failure the state does NOT move (this is the thrash signal). When
      // exhaustion trips immediately after, the reconciler flips the row to
      // `error` — captured on the next scheduler tick, not here.
      state_after: stateBefore,
      trigger: 'scheduler',
      exhausted: willExhaust,
    },
    'scheduler',
  );

  // If this was the last attempt, mark exhausted AND persist
  // `auto_resume=false` so the next scheduler tick's resumable filter excludes
  // this agent. Without the flip, subsequent cycles would hit the early-exit
  // `attempts >= maxAttempts` branch and re-log `agent_resume_exhausted` every
  // 60s forever.
  if (newAttempts >= maxAttempts) {
    await deps.updateAgent(agentId, { autoResume: false });
    deps.log({
      timestamp: now.toISOString(),
      level: 'warn',
      event: 'agent_resume_exhausted',
      agent_id: agentId,
      resume_attempts: newAttempts,
      max_resume_attempts: maxAttempts,
    });
    return 'exhausted';
  }

  return 'skipped';
}

// ============================================================================
// Heartbeat collection
// ============================================================================

interface RunRow {
  id: string;
  worker_id: string;
  status: string;
  trigger_id: string;
}

/**
 * Collect heartbeats for all active runs.
 * For each run with status='running': check if pane is alive, detect state,
 * and insert a heartbeat record.
 */
export async function collectHeartbeats(deps: SchedulerDeps): Promise<number> {
  const sql = await deps.getConnection();
  const now = deps.now();

  const activeRuns: RunRow[] = await sql`
    SELECT id, worker_id, status, trigger_id FROM runs WHERE status = 'running'
  `;

  // Build worker lookup for enriched heartbeat context
  const workers = await deps.listWorkers();
  const workerById = new Map(workers.map((w) => [w.id, w]));

  let collected = 0;
  for (const run of activeRuns) {
    const { alive, isPid } = await checkWorkerAlive(deps, run.worker_id);
    const heartbeatStatus = alive ? (isPid ? 'busy' : 'alive') : 'dead';

    const worker = workerById.get(run.worker_id);
    const context = {
      alive,
      pid_check: isPid,
      worker_id: run.worker_id,
      team: worker?.team ?? null,
      wish_slug: worker?.wishSlug ?? null,
      group_number: worker?.groupNumber ?? null,
      state: worker?.state ?? null,
    };

    const heartbeatId = deps.generateId();
    await sql`
      INSERT INTO heartbeats (id, worker_id, run_id, status, context, last_seen_at, created_at)
      VALUES (${heartbeatId}, ${run.worker_id}, ${run.id}, ${heartbeatStatus}, ${JSON.stringify(context)}, ${now}, ${now})
    `;
    collected++;
  }

  if (collected > 0) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'debug',
      event: 'heartbeats_collected',
      count: collected,
    });
  }

  return collected;
}

// ============================================================================
// Orphan reconciliation
// ============================================================================

/** Check if a run has N consecutive dead heartbeats. */
async function isRunDead(sql: SqlClient, runId: string, threshold: number): Promise<boolean> {
  const recentHeartbeats = await sql`
    SELECT status FROM heartbeats
    WHERE run_id = ${runId}
    ORDER BY created_at DESC
    LIMIT ${threshold}
  `;
  if (recentHeartbeats.length < threshold) return false;
  return recentHeartbeats.every((h: { status: string }) => h.status === 'dead');
}

/**
 * Try to auto-resume a dead run's agent. Returns:
 *   'resumed' — agent was resumed, don't mark run failed
 *   'deferred' — temporarily skipped (cooldown/cap), retry next cycle
 *   'failed' — permanently ineligible or exhausted, mark run failed
 */
async function tryResumeOrFail(
  deps: SchedulerDeps,
  config: SchedulerConfig,
  run: RunRow,
  workerById: Map<string, WorkerInfo>,
  now: Date,
): Promise<'resumed' | 'deferred' | 'failed'> {
  const agent = workerById.get(run.worker_id);
  if (!agent) return 'failed';

  const result = await attemptAgentResume(deps, config, agent);
  if (result === 'resumed') {
    deps.log({
      timestamp: now.toISOString(),
      level: 'info',
      event: 'orphan_run_resumed',
      run_id: run.id,
      agent_id: agent.id,
    });
    return 'resumed';
  }
  if (result === 'skipped') {
    const isPermanent = agent.autoResume === false || !agent.claudeSessionId;
    return isPermanent ? 'failed' : 'deferred';
  }
  return 'failed'; // exhausted
}

/**
 * Reconcile orphaned runs by checking heartbeat history.
 * If a run has N consecutive 'dead' heartbeats (default 2), attempt auto-resume
 * before marking the run as failed. This runs every 5 minutes as a safety net.
 */
export async function reconcileOrphans(deps: SchedulerDeps, config: SchedulerConfig): Promise<number> {
  const sql = await deps.getConnection();
  const now = deps.now();
  const threshold = config.deadHeartbeatThreshold;

  const activeRuns: RunRow[] = await sql`
    SELECT id, worker_id, status, trigger_id FROM runs WHERE status = 'running'
  `;

  const allWorkers = await deps.listWorkers();
  const workerById = new Map(allWorkers.map((w) => [w.id, w]));

  let failedCount = 0;
  for (const run of activeRuns) {
    if (!(await isRunDead(sql, run.id, threshold))) continue;

    const action = await tryResumeOrFail(deps, config, run, workerById, now);
    if (action === 'resumed' || action === 'deferred') continue;

    await sql`
      UPDATE runs SET status = 'failed', error = 'orphaned: ${threshold} consecutive dead heartbeats', completed_at = ${now}
      WHERE id = ${run.id}
    `;
    await sql`
      UPDATE triggers SET status = 'failed', completed_at = ${now}
      WHERE id = ${run.trigger_id} AND status = 'executing'
    `;
    failedCount++;

    deps.log({
      timestamp: now.toISOString(),
      level: 'warn',
      event: 'orphan_run_failed',
      run_id: run.id,
      worker_id: run.worker_id,
      dead_heartbeats: threshold,
    });
  }

  if (failedCount > 0) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'info',
      event: 'orphan_reconciliation_completed',
      failed_count: failedCount,
    });
  }

  return failedCount;
}

// ============================================================================
// Machine snapshot
// ============================================================================

/**
 * Collect a machine snapshot: active workers, teams, tmux sessions, CPU/memory.
 */
export async function collectMachineSnapshot(deps: SchedulerDeps): Promise<void> {
  const sql = await deps.getConnection();
  const now = deps.now();
  const snapshotId = deps.generateId();

  const workers = await deps.listWorkers();
  const activeWorkers = workers.filter((w) => !['done', 'error', 'suspended'].includes(w.state)).length;
  const teams = new Set(workers.filter((w) => w.team).map((w) => w.team));
  const tmuxSessions = await deps.countTmuxSessions();

  // Best-effort CPU and memory
  let cpuPercent: number | null = null;
  let memoryMb: number | null = null;
  try {
    const mem = process.memoryUsage();
    memoryMb = Math.round(mem.rss / 1024 / 1024);
  } catch {
    // ignore
  }

  try {
    const os = await import('node:os');
    const cpus = os.cpus();
    if (cpus.length > 0) {
      const total = cpus.reduce((acc, cpu) => {
        const t = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        return acc + t - cpu.times.idle;
      }, 0);
      const totalAll = cpus.reduce((acc, cpu) => acc + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
      cpuPercent = totalAll > 0 ? Math.round((total / totalAll) * 100) : null;
    }
  } catch {
    // ignore
  }

  await sql`
    INSERT INTO machine_snapshots (id, active_workers, active_teams, tmux_sessions, cpu_percent, memory_mb, created_at)
    VALUES (${snapshotId}, ${activeWorkers}, ${teams.size}, ${tmuxSessions}, ${cpuPercent}, ${memoryMb}, ${now})
  `;

  deps.log({
    timestamp: now.toISOString(),
    level: 'debug',
    event: 'machine_snapshot',
    active_workers: activeWorkers,
    active_teams: teams.size,
    tmux_sessions: tmuxSessions,
    cpu_percent: cpuPercent,
    memory_mb: memoryMb,
  });
}

// ============================================================================
// Runtime Event Emission
// ============================================================================

/** Previous worker snapshot for detecting state changes between heartbeats. */
const previousWorkerStates = new Map<string, WorkerInfo>();

/**
 * Detect and emit runtime events for worker state changes.
 * Compares current workers against the previous snapshot to detect:
 *   - State changes → genie.agent.{id}.state
 *   - New agents (spawned) → genie.agent.{id}.spawned
 *   - Removed agents (killed) → genie.agent.{id}.killed
 *   - Group completion (agent done with wishSlug) → genie.wish.{slug}.group.{n}.done
 */
export async function emitWorkerEvents(deps: SchedulerDeps): Promise<void> {
  const workers = await deps.listWorkers();
  const now = deps.now().toISOString();
  const currentIds = new Set<string>();

  for (const worker of workers) {
    currentIds.add(worker.id);
    const prev = previousWorkerStates.get(worker.id);
    const repoPath = worker.repoPath ?? process.cwd();

    if (!prev) {
      // New worker — spawned
      await deps.publishEvent(
        `genie.agent.${worker.id}.spawned`,
        {
          timestamp: now,
          kind: 'state',
          agent: worker.id,
          team: worker.team,
          text: `Agent ${worker.id} spawned`,
          data: { state: worker.state },
          source: 'registry',
        },
        repoPath,
      );
    } else if (prev.state !== worker.state) {
      // State changed
      await deps.publishEvent(
        `genie.agent.${worker.id}.state`,
        {
          timestamp: now,
          kind: 'state',
          agent: worker.id,
          team: worker.team,
          text: `Agent ${worker.id} state: ${prev.state} → ${worker.state}`,
          data: { previousState: prev.state, state: worker.state },
          source: 'registry',
        },
        repoPath,
      );

      // Detect group completion: agent transitioned to 'done' and has a wish assignment
      if (worker.state === 'done' && worker.wishSlug && worker.groupNumber != null) {
        await deps.publishEvent(
          `genie.wish.${worker.wishSlug}.group.${worker.groupNumber}.done`,
          {
            timestamp: now,
            kind: 'system',
            agent: worker.id,
            team: worker.team,
            text: `Wish ${worker.wishSlug} group ${worker.groupNumber} completed by ${worker.id}`,
            data: { wishSlug: worker.wishSlug, groupNumber: worker.groupNumber },
            source: 'registry',
          },
          repoPath,
        );
      }
    }

    // Update snapshot
    previousWorkerStates.set(worker.id, { ...worker });
  }

  // Detect killed workers (in previous snapshot but not in current)
  for (const [id, prev] of previousWorkerStates) {
    if (!currentIds.has(id)) {
      await deps.publishEvent(
        `genie.agent.${id}.killed`,
        {
          timestamp: now,
          kind: 'state',
          agent: id,
          team: prev.team,
          text: `Agent ${id} killed`,
          data: { lastState: prev.state },
          source: 'registry',
        },
        prev.repoPath ?? process.cwd(),
      );
      previousWorkerStates.delete(id);
    }
  }
}

/**
 * Reset the worker state snapshot. Intended for testing only.
 */
export function _resetWorkerStatesForTesting(): void {
  previousWorkerStates.clear();
}

// ============================================================================
// Inbox watcher integration
// ============================================================================

/** Start inbox watcher if not disabled via env. Returns handle or null. */
function startInboxWatcherIfEnabled(deps: SchedulerDeps): NodeJS.Timeout | null {
  const pollMs = getInboxPollIntervalMs();
  if (pollMs === 0) {
    deps.log({ timestamp: deps.now().toISOString(), level: 'info', event: 'inbox_watcher_disabled' });
    return null;
  }
  deps.log({
    timestamp: deps.now().toISOString(),
    level: 'info',
    event: 'inbox_watcher_started',
    poll_interval_ms: pollMs,
  });
  return startInboxWatcher();
}

// ============================================================================
// Daemon loop
// ============================================================================

interface DaemonHandle {
  /** Stop the daemon gracefully. */
  stop: () => void;
  /** Promise that resolves when the daemon exits. */
  done: Promise<void>;
  /** The unique daemon ID for this instance. */
  daemonId: string;
}

/**
 * Dependency overrides for `processMailboxRetryMessage`. The retry loop uses
 * dynamic imports for `deliverToPane` and `send` to avoid circular-import
 * risk; tests can inject mocks here instead of going through the real
 * protocol-router / mailbox modules.
 */
interface MailboxRetryOverrides {
  /** Pane delivery function. Defaults to `protocol-router.deliverToPane`. */
  deliverFn?: (toWorker: string, messageId: string) => Promise<boolean>;
  /** Mailbox writer used to post the escalation row. Defaults to `mailbox.send`. */
  sendFn?: (repoPath: string, from: string, to: string, body: string) => Promise<unknown>;
}

/**
 * Process a single retryable mailbox message. Extracted from the scheduler
 * daemon's 60s retry loop so guards and edge cases can be unit-tested.
 *
 * Attempts instant pane delivery via `deliverFn`. If delivery fails and the
 * message has now hit `MAX_DELIVERY_ATTEMPTS`, escalate it — BUT only if
 * none of the three recursion guards match. The guards exist because the
 * escalation row (`from=scheduler`, `to=ESCALATION_RECIPIENT`) is itself
 * subject to the same retry+escalate cycle; without them, a single
 * unresolvable escalation spawns an infinite chain (observed: 181K rows
 * over 8 days before the guards shipped).
 *
 * Guards (in order, any match short-circuits before `sendFn` is called):
 *   1. `msg.from === 'scheduler'` — message was ALREADY authored by the
 *      escalation path. Re-escalating it would grow the chain by one each
 *      retry cycle. Mandatory guard.
 *   2. `msg.body.startsWith('[escalation] ')` — body-prefix defense for any
 *      escalation message that somehow lost the scheduler authorship (e.g.
 *      manual replay, future sender rename).
 *   3. `msg.to === ESCALATION_RECIPIENT` — same-recipient defense. The bare
 *      `'team-lead'` recipient is unresolvable; escalating to it cannot
 *      ever succeed, so re-escalating it only amplifies the problem.
 *
 * All three guards log `mailbox_delivery_escalation_dropped` with a
 * `reason` field so ops can distinguish dropped-by-guard from
 * delivered-successfully in the scheduler log.
 */
export async function processMailboxRetryMessage(
  deps: SchedulerDeps,
  msg: MailboxMessage,
  overrides: MailboxRetryOverrides = {},
): Promise<void> {
  const deliverFn =
    overrides.deliverFn ??
    (async (toWorker: string, messageId: string) => {
      const { deliverToPane } = await import('./protocol-router.js');
      return deliverToPane(toWorker, messageId);
    });
  const sendFn =
    overrides.sendFn ??
    (async (repoPath: string, from: string, to: string, body: string) => {
      const { send } = await import('./mailbox.js');
      return send(repoPath, from, to, body);
    });

  const delivered = await deliverFn(msg.to, msg.id);
  if (delivered) {
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'info',
      event: 'mailbox_delivery_retried',
      messageId: msg.id,
      to: msg.to,
    });
    return;
  }

  // deliverToPane already called markFailed — check if max attempts reached.
  const sql = await deps.getConnection();
  const rows = await sql`SELECT delivery_attempts, repo_path FROM mailbox WHERE id = ${msg.id} LIMIT 1`;
  const attempts = rows[0]?.delivery_attempts ?? 0;
  if (attempts < MAX_DELIVERY_ATTEMPTS) return;

  await markEscalated(msg.id);

  // Guard 1 (MANDATORY): message already authored by the scheduler means it
  // IS an escalation; re-escalating it is the exact loop we saw in prod.
  if (msg.from === 'scheduler') {
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'warn',
      event: 'mailbox_delivery_escalation_dropped',
      reason: 'already_escalated_by_scheduler',
      messageId: msg.id,
      to: msg.to,
      attempts,
    });
    return;
  }

  // Guard 2 (defense-in-depth): body-prefix check catches any escalation row
  // that arrives without scheduler authorship (manual replay, sender rename).
  if (msg.body.startsWith('[escalation] ')) {
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'warn',
      event: 'mailbox_delivery_escalation_dropped',
      reason: 'body_prefix',
      messageId: msg.id,
      to: msg.to,
      attempts,
    });
    return;
  }

  // Guard 3 (defense-in-depth): the bare escalation recipient is
  // unresolvable today, so escalating to it can never succeed. Drop and
  // log rather than append another doomed row.
  if (msg.to === ESCALATION_RECIPIENT) {
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'warn',
      event: 'mailbox_delivery_escalation_dropped',
      reason: 'same_recipient',
      messageId: msg.id,
      to: msg.to,
      attempts,
    });
    return;
  }

  const repoPath = rows[0]?.repo_path;
  if (repoPath) {
    await sendFn(
      repoPath,
      'scheduler',
      ESCALATION_RECIPIENT,
      `[escalation] Message ${msg.id} from "${msg.from}" to "${msg.to}" failed delivery after ${MAX_DELIVERY_ATTEMPTS} attempts. Body: "${msg.body.slice(0, 200)}"`,
    );
  }
  deps.log({
    timestamp: deps.now().toISOString(),
    level: 'warn',
    event: 'mailbox_delivery_escalated',
    messageId: msg.id,
    to: msg.to,
    attempts,
  });
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
  let pollResolve: (() => void) | null = null;
  let listenConnection: SqlClient | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let orphanTimer: ReturnType<typeof setInterval> | null = null;
  let leaseRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  let agentResumeTimer: ReturnType<typeof setInterval> | null = null;
  let inboxWatcherHandle: NodeJS.Timeout | null = null;
  let captureFallbackTimer: ReturnType<typeof setInterval> | null = null;
  let eventRouterHandle: EventRouterHandle | null = null;
  let deliveryUnsub: (() => Promise<void>) | null = null;
  let deliveryRetryTimer: ReturnType<typeof setInterval> | null = null;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: stop() is a flat cleanup sequence for all daemon resources
  const stop = () => {
    running = false;
    if (pollTimeout) {
      clearTimeout(pollTimeout);
      pollTimeout = null;
    }
    // Resolve the pending poll promise so the loop exits
    if (pollResolve) {
      pollResolve();
      pollResolve = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (orphanTimer) {
      clearInterval(orphanTimer);
      orphanTimer = null;
    }
    if (leaseRecoveryTimer) {
      clearInterval(leaseRecoveryTimer);
      leaseRecoveryTimer = null;
    }
    if (agentResumeTimer) {
      clearInterval(agentResumeTimer);
      agentResumeTimer = null;
    }
    if (inboxWatcherHandle) {
      stopInboxWatcher(inboxWatcherHandle);
      inboxWatcherHandle = null;
    }
    if (listenConnection) {
      listenConnection.end().catch(() => {});
      listenConnection = null;
    }
    if (captureFallbackTimer) {
      clearInterval(captureFallbackTimer);
      captureFallbackTimer = null;
    }
    eventRouterHandle?.stop().catch(() => {});
    eventRouterHandle = null;
    if (deliveryRetryTimer) {
      clearInterval(deliveryRetryTimer);
      deliveryRetryTimer = null;
    }
    if (deliveryUnsub) {
      deliveryUnsub().catch(() => {});
      deliveryUnsub = null;
    }
    // Stop session capture layers
    import('./session-filewatch.js').then((m) => m.stopFilewatch()).catch(() => {});
    import('./session-backfill.js').then((m) => m.stopBackfill()).catch(() => {});
    // Remove port file — daemon no longer owns PG
    import('./db.js')
      .then(({ getLockfilePath }) => {
        try {
          require('node:fs').unlinkSync(getLockfilePath());
        } catch {
          /* already gone */
        }
      })
      .catch(() => {});
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

  async function setupListenNotify(d: SchedulerDeps, onTrigger: () => Promise<void>): Promise<SqlClient | null> {
    try {
      const sql = await d.getConnection();
      await sql.listen('genie_trigger_due', async () => {
        if (!running) return;
        await onTrigger();
      });
      d.log({ timestamp: d.now().toISOString(), level: 'info', event: 'listen_started', channel: 'genie_trigger_due' });
      return sql;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      d.log({ timestamp: d.now().toISOString(), level: 'warn', event: 'listen_failed', error: message });
      return null;
    }
  }

  function startLeaseRecoveryTimer(
    d: SchedulerDeps,
    cfg: SchedulerConfig,
    dId: string,
  ): ReturnType<typeof setInterval> {
    return setInterval(async () => {
      if (!running) return;
      try {
        await reclaimExpiredLeases(d, dId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        d.log({
          timestamp: d.now().toISOString(),
          level: 'error',
          event: 'lease_recovery_error',
          error: message,
        });
      }
    }, cfg.leaseRecoveryIntervalMs);
  }

  function startOrphanTimer(d: SchedulerDeps, cfg: SchedulerConfig): ReturnType<typeof setInterval> {
    return setInterval(async () => {
      if (!running) return;
      try {
        await reconcileOrphans(d, cfg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        d.log({
          timestamp: d.now().toISOString(),
          level: 'error',
          event: 'orphan_reconciliation_error',
          error: message,
        });
      }
    }, cfg.orphanCheckIntervalMs);
  }

  /**
   * GC dead-pane zombies via `reconcileStaleSpawns`. Runs before the resume
   * pass each tick so the concurrency cap sees an accurate active set.
   */
  async function reconcileDeadPaneZombies(d: SchedulerDeps): Promise<void> {
    try {
      const { reconcileStaleSpawns } = await import('./agent-registry.js');
      await reconcileStaleSpawns();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      d.log({
        timestamp: d.now().toISOString(),
        level: 'warn',
        event: 'reconcile_stale_spawns_error',
        error: message,
      });
    }
  }

  /**
   * Periodic auto-resume sweep for error-state agents.
   *
   * Before this timer existed, `runAgentRecoveryPass` only ran at daemon
   * startup (`recoverOnStartup`) plus one delayed retry. Agents that hit
   * `error` state mid-run — the very failure mode auto-resume is designed
   * to handle — never retried until the daemon process restarted.
   *
   * Interval reuses `leaseRecoveryIntervalMs` (60s default): same cadence as
   * lease recovery, gentle enough not to thrash tmux on large worker sets,
   * tight enough that a user sees the 1/3, 2/3, 3/3 resume progression
   * within a few minutes rather than waiting for a daemon restart.
   *
   * Each tick first reconciles dead-pane zombies (idle/working/permission/
   * question rows whose tmux pane is dead → error) via
   * `reconcileDeadPaneZombies`, so the subsequent resume pass sees an
   * accurate activeCount instead of the inflated zombie count.
   */
  function startAgentResumeTimer(d: SchedulerDeps, cfg: SchedulerConfig, dId: string): ReturnType<typeof setInterval> {
    return setInterval(async () => {
      if (!running) return;
      try {
        // Order matters: (1) GC dead-pane zombies so activeCount is accurate;
        // (2) flip unresumable rows to `auto_resume=false` so they are
        // excluded from the resumable filter in this same tick; (3) run the
        // resume pass. Step 2 is the Bug A fix — without it, error rows with
        // null session ids stayed in `auto_resume=true` forever, misleading
        // `genie ls` and cluttering the worker list.
        await reconcileDeadPaneZombies(d);
        await reconcileUnresumable(d);
        await runAgentRecoveryPass(d, dId, cfg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        d.log({
          timestamp: d.now().toISOString(),
          level: 'error',
          event: 'agent_resume_timer_error',
          error: message,
        });
      }
    }, cfg.leaseRecoveryIntervalMs);
  }

  async function startEventRouterSafe(d: SchedulerDeps): Promise<ReturnType<typeof startEventRouter> | null> {
    try {
      const handle = await startEventRouter();
      d.log({ timestamp: d.now().toISOString(), level: 'info', event: 'event_router_started' });
      return handle;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      d.log({ timestamp: d.now().toISOString(), level: 'warn', event: 'event_router_start_failed', error: message });
      return null;
    }
  }

  async function initSessionCapture(
    d: SchedulerDeps,
    cfg: SchedulerConfig,
  ): Promise<ReturnType<typeof setInterval> | null> {
    try {
      const captureSql = await d.getConnection();
      const { startFilewatch } = await import('./session-filewatch.js');
      const { startBackfill } = await import('./session-backfill.js');
      const { reconcileSubagentParents } = await import('./session-capture.js');

      // Retroactive reconcile — runs once per daemon start, independent of
      // backfill. The backfill-tail reconcile only fires when backfill
      // actually runs (i.e., `session_sync.status != 'complete'`). Post-
      // v1 deployments leave backfill done, so subagents captured by
      // filewatch BEFORE their parent session row was enriched (async
      // worker-map lookup miss, filewatch ordering race, or parent
      // inserted from a later jsonl batch) stay metadata-free forever.
      //
      // Running the same idempotent UPDATEs here catches those rows on
      // the next restart. Zero rows is the happy case; a non-zero count
      // is diagnostic gold — it says "the filewatch ordering skipped
      // metadata for N subagents and we just fixed them."
      reconcileSubagentParents(captureSql)
        .then(({ linked, metadataFilled }) => {
          if (linked > 0 || metadataFilled > 0) {
            d.log({
              timestamp: d.now().toISOString(),
              level: 'info',
              event: 'subagent_reconcile_on_start',
              linked,
              metadata_filled: metadataFilled,
            });
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          d.log({
            timestamp: d.now().toISOString(),
            level: 'warn',
            event: 'subagent_reconcile_on_start_failed',
            error: msg,
          });
        });

      const filewatchOk = await startFilewatch(captureSql);
      if (!filewatchOk) {
        const { ingestFileFull, discoverAllJsonlFiles, buildWorkerMap } = await import('./session-capture.js');
        d.log({ timestamp: d.now().toISOString(), level: 'warn', event: 'filewatch_failed_fallback_polling' });
        const timer = setInterval(async () => {
          if (!running) return;
          try {
            const files = await discoverAllJsonlFiles();
            const workerMap = await buildWorkerMap(captureSql);
            for (const f of files) {
              await ingestFileFull(captureSql, f.sessionId, f.jsonlPath, f.projectPath, 0, {
                parentSessionId: f.parentSessionId,
                isSubagent: f.isSubagent,
                workerMap,
              });
            }
          } catch {
            /* best-effort fallback */
          }
        }, cfg.heartbeatIntervalMs);
        startBackfill(captureSql).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          d.log({ timestamp: d.now().toISOString(), level: 'error', event: 'backfill_error', error: msg });
        });
        return timer;
      }
      startBackfill(captureSql).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        d.log({ timestamp: d.now().toISOString(), level: 'error', event: 'backfill_error', error: msg });
      });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      d.log({ timestamp: d.now().toISOString(), level: 'warn', event: 'session_capture_init_failed', error: message });
      return null;
    }
  }

  async function runHeartbeat(d: SchedulerDeps): Promise<void> {
    if (!running) return;
    try {
      await collectHeartbeats(d);
      await collectMachineSnapshot(d);
      await emitWorkerEvents(d);
      try {
        const retSql = await d.getConnection();
        await retSql`DELETE FROM heartbeats WHERE created_at < now() - interval '7 days'`;
        await retSql`DELETE FROM machine_snapshots WHERE created_at < now() - interval '30 days'`;
        await retSql`DELETE FROM audit_events WHERE entity_type LIKE 'otel_%' AND created_at < now() - interval '30 days'`;
      } catch {
        // Best-effort
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      d.log({
        timestamp: d.now().toISOString(),
        level: 'error',
        event: 'heartbeat_error',
        error: message,
      });
    }
  }

  const done = (async () => {
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'info',
      event: 'daemon_started',
      daemon_id: daemonId,
      max_concurrent: config.maxConcurrent,
      poll_interval_ms: config.pollIntervalMs,
    });

    logReconcilerMode(deps, daemonId);

    // Startup recovery: reclaim expired leases + reconcile orphans
    try {
      await recoverOnStartup(deps, daemonId, config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'error',
        event: 'recovery_error',
        error: message,
      });
    }

    listenConnection = await setupListenNotify(deps, processTriggers);
    heartbeatTimer = setInterval(() => runHeartbeat(deps), config.heartbeatIntervalMs);
    orphanTimer = startOrphanTimer(deps, config);
    leaseRecoveryTimer = startLeaseRecoveryTimer(deps, config, daemonId);
    agentResumeTimer = startAgentResumeTimer(deps, config, daemonId);
    inboxWatcherHandle = startInboxWatcherIfEnabled(deps);
    eventRouterHandle = await startEventRouterSafe(deps);

    // Subscribe to PG LISTEN/NOTIFY for instant message delivery
    try {
      deliveryUnsub = await subscribeDelivery(async (toWorker, messageId) => {
        try {
          const { deliverToPane } = await import('./protocol-router.js');
          await deliverToPane(toWorker, messageId);
        } catch {
          // Fallback: inbox-watcher will pick it up on next poll cycle
        }
      });
      deps.log({ timestamp: deps.now().toISOString(), level: 'info', event: 'mailbox_delivery_listen_started' });
    } catch {
      // PG LISTEN not available — inbox-watcher polling remains the fallback
    }

    // Mailbox delivery retry loop: retry failed deliveries every 60s.
    // Per-message logic lives in `processMailboxRetryMessage` so guards
    // against escalation recursion are unit-testable.
    deliveryRetryTimer = setInterval(async () => {
      try {
        const retryable = await getRetryable(MAX_DELIVERY_ATTEMPTS);
        for (const msg of retryable) {
          try {
            await processMailboxRetryMessage(deps, msg);
          } catch {
            // Individual message retry failed — will be retried next cycle
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log({ timestamp: deps.now().toISOString(), level: 'error', event: 'mailbox_retry_error', error: message });
      }
    }, 60_000);

    captureFallbackTimer = await initSessionCapture(deps, config);

    // Initial trigger check
    await processTriggers();

    // Poll loop as fallback safety net
    while (running) {
      await new Promise<void>((resolve) => {
        pollResolve = resolve;
        pollTimeout = setTimeout(resolve, config.pollIntervalMs);
      });
      pollResolve = null;

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
