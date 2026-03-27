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
import type { Agent } from './agent-registry.js';
import { computeNextCronDue, parseDuration } from './cron.js';
import { getInboxPollIntervalMs, startInboxWatcher, stopInboxWatcher } from './inbox-watcher.js';
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
  /** Heartbeat collection interval in ms. Default: 60000 (60s). */
  heartbeatIntervalMs: number;
  /** Orphan reconciliation interval in ms. Default: 300000 (5m). */
  orphanCheckIntervalMs: number;
  /** Number of consecutive dead heartbeats before marking a run as failed. Default: 2. */
  deadHeartbeatThreshold: number;
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
>;

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
  /** Publish an event to NATS. Fire-and-forget, no-ops if NATS unavailable. */
  publishEvent: (subject: string, data: unknown) => Promise<void>;
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
  appendFileSync(getLogFile(), `${JSON.stringify(entry)}\n`);
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

async function defaultPublishEvent(subject: string, data: unknown): Promise<void> {
  try {
    const { publish } = await import('./nats-client.js');
    await publish(subject, data);
  } catch {
    // NATS unavailable — silent degradation
  }
}

async function defaultCountTmuxSessions(): Promise<number> {
  try {
    const { execSync } = await import('node:child_process');
    const output = execSync('tmux list-sessions 2>/dev/null', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function defaultResumeAgent(agentId: string): Promise<boolean> {
  try {
    const { execSync } = await import('node:child_process');
    execSync(`genie resume ${agentId}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
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
 * Run full startup recovery: reclaim expired leases, reconcile orphaned runs,
 * then auto-resume agents whose panes died while the daemon was down.
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

  // Auto-resume agents whose panes died while daemon was down
  let resumed = 0;
  const resolvedConfig = config ?? resolveConfig();
  const workers = await deps.listWorkers();
  const resumable = workers.filter((w) => w.state !== 'suspended' && w.state !== 'done' && w.claudeSessionId);

  for (const worker of resumable) {
    const alive = await deps.isPaneAlive(worker.paneId);
    if (!alive) {
      const result = await attemptAgentResume(deps, resolvedConfig, worker);
      if (result === 'resumed') resumed++;
    }
  }

  deps.log({
    timestamp: deps.now().toISOString(),
    level: 'info',
    event: 'recovery_completed',
    reclaimed_leases: reclaimed,
    orphaned_runs: orphans,
    resumed_agents: resumed,
    daemon_id: daemonId,
  });
}

// ============================================================================
// Agent auto-resume
// ============================================================================

/** Default resume cooldown in ms (60s). */
const RESUME_COOLDOWN_MS = 60_000;

/** Default max auto-resume attempts. */
const DEFAULT_MAX_RESUME_ATTEMPTS = 3;

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

  // Retry budget exhausted
  if (attempts >= maxAttempts) {
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

  // Concurrency cap: count active workers
  const workers = await deps.listWorkers();
  const activeCount = workers.filter((w) => !['done', 'error', 'suspended'].includes(w.state)).length;
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

  // Attempt the resume
  const success = await deps.resumeAgent(agentId);

  if (success) {
    deps.log({
      timestamp: now.toISOString(),
      level: 'info',
      event: 'agent_resume_succeeded',
      agent_id: agentId,
      resume_attempts: newAttempts,
    });
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

  // If this was the last attempt, mark exhausted
  if (newAttempts >= maxAttempts) {
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
// NATS Event Emission
// ============================================================================

/** Previous worker snapshot for detecting state changes between heartbeats. */
const previousWorkerStates = new Map<string, WorkerInfo>();

/**
 * Detect and emit NATS events for worker state changes.
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

    if (!prev) {
      // New worker — spawned
      await deps.publishEvent(`genie.agent.${worker.id}.spawned`, {
        timestamp: now,
        kind: 'state',
        agent: worker.id,
        team: worker.team,
        text: `Agent ${worker.id} spawned`,
        data: { state: worker.state },
        source: 'registry',
      });
    } else if (prev.state !== worker.state) {
      // State changed
      await deps.publishEvent(`genie.agent.${worker.id}.state`, {
        timestamp: now,
        kind: 'state',
        agent: worker.id,
        team: worker.team,
        text: `Agent ${worker.id} state: ${prev.state} → ${worker.state}`,
        data: { previousState: prev.state, state: worker.state },
        source: 'registry',
      });

      // Detect group completion: agent transitioned to 'done' and has a wish assignment
      if (worker.state === 'done' && worker.wishSlug && worker.groupNumber != null) {
        await deps.publishEvent(`genie.wish.${worker.wishSlug}.group.${worker.groupNumber}.done`, {
          timestamp: now,
          kind: 'system',
          agent: worker.id,
          team: worker.team,
          text: `Wish ${worker.wishSlug} group ${worker.groupNumber} completed by ${worker.id}`,
          data: { wishSlug: worker.wishSlug, groupNumber: worker.groupNumber },
          source: 'registry',
        });
      }
    }

    // Update snapshot
    previousWorkerStates.set(worker.id, { ...worker });
  }

  // Detect killed workers (in previous snapshot but not in current)
  for (const [id, prev] of previousWorkerStates) {
    if (!currentIds.has(id)) {
      await deps.publishEvent(`genie.agent.${id}.killed`, {
        timestamp: now,
        kind: 'state',
        agent: id,
        team: prev.team,
        text: `Agent ${id} killed`,
        data: { lastState: prev.state },
        source: 'registry',
      });
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
  let inboxWatcherHandle: NodeJS.Timeout | null = null;
  let captureFallbackTimer: ReturnType<typeof setInterval> | null = null;

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
    // Stop session capture layers
    import('./session-filewatch.js').then((m) => m.stopFilewatch()).catch(() => {});
    import('./session-backfill.js').then((m) => m.stopBackfill()).catch(() => {});
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

    // Start heartbeat collection (every 60s) — collects liveness + snapshots + events + retention
    heartbeatTimer = setInterval(async () => {
      if (!running) return;
      try {
        await collectHeartbeats(deps);
        await collectMachineSnapshot(deps);
        await emitWorkerEvents(deps);
        // Session JSONL ingestion moved to filewatch (event-driven, off-heartbeat)
        // Retention cleanup
        try {
          const retSql = await deps.getConnection();
          await retSql`DELETE FROM heartbeats WHERE created_at < now() - interval '7 days'`;
          await retSql`DELETE FROM machine_snapshots WHERE created_at < now() - interval '30 days'`;
          await retSql`DELETE FROM audit_events WHERE entity_type LIKE 'otel_%' AND created_at < now() - interval '30 days'`;
        } catch {
          // Best-effort
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log({
          timestamp: deps.now().toISOString(),
          level: 'error',
          event: 'heartbeat_error',
          error: message,
        });
      }
    }, config.heartbeatIntervalMs);

    // Start orphan reconciliation (every 5m)
    orphanTimer = setInterval(async () => {
      if (!running) return;
      try {
        await reconcileOrphans(deps, config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log({
          timestamp: deps.now().toISOString(),
          level: 'error',
          event: 'orphan_reconciliation_error',
          error: message,
        });
      }
    }, config.orphanCheckIntervalMs);

    // Start inbox watcher (polls native inboxes for unread messages)
    inboxWatcherHandle = startInboxWatcherIfEnabled(deps);

    // Session capture v2: filewatch (event-driven) + backfill (lazy, one-time)
    try {
      const captureSql = await deps.getConnection();
      const { startFilewatch } = await import('./session-filewatch.js');
      const { startBackfill } = await import('./session-backfill.js');
      const filewatchOk = await startFilewatch(captureSql);
      if (!filewatchOk) {
        // Filewatch failed (path missing, recursive unsupported, too many watchers)
        // Fall back to polling ingest every 60s as degraded mode
        const { ingestFileFull, discoverAllJsonlFiles, buildWorkerMap } = await import('./session-capture.js');
        deps.log({ timestamp: deps.now().toISOString(), level: 'warn', event: 'filewatch_failed_fallback_polling' });
        captureFallbackTimer = setInterval(async () => {
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
        }, config.heartbeatIntervalMs);
      }
      // Backfill runs in background — non-blocking, auto-skips if already complete
      startBackfill(captureSql).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        deps.log({ timestamp: deps.now().toISOString(), level: 'error', event: 'backfill_error', error: message });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log({
        timestamp: deps.now().toISOString(),
        level: 'warn',
        event: 'session_capture_init_failed',
        error: message,
      });
    }

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
