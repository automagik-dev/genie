import { getConnection } from './db.js';

// ---------------------------------------------------------------------------
// Circuit breaker for PG event writes (Group 2 — #857)
// ---------------------------------------------------------------------------
class EventCircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private loggedOpen = false;
  private readonly threshold = 5;
  private readonly cooldown = 30_000;

  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.lastFailure > this.cooldown) {
      this.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    if (this.failures >= this.threshold) {
      console.warn('[runtime-events] circuit breaker closed — PG writes resumed');
    }
    this.failures = 0;
    this.loggedOpen = false;
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold && !this.loggedOpen) {
      console.warn(
        `[runtime-events] circuit breaker open — skipping PG writes for ${this.cooldown / 1000}s after ${this.threshold} consecutive failures`,
      );
      this.loggedOpen = true;
    }
  }

  get state(): string {
    if (this.failures < this.threshold) return 'closed';
    if (Date.now() - this.lastFailure > this.cooldown) return 'half-open';
    return 'open';
  }
}

const circuitBreaker = new EventCircuitBreaker();

export type RuntimeEventKind =
  | 'user'
  | 'assistant'
  | 'message'
  | 'state'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'qa';
export type RuntimeEventSource = 'provider' | 'mailbox' | 'chat' | 'registry' | 'hook' | 'sdk';
export type RuntimeEventDirection = 'in' | 'out';

export interface RuntimeEvent {
  id: number;
  repoPath: string;
  timestamp: string;
  kind: RuntimeEventKind;
  agent: string;
  team?: string;
  direction?: RuntimeEventDirection;
  peer?: string;
  text: string;
  data?: Record<string, unknown>;
  source: RuntimeEventSource;
  subject?: string;
  threadId?: string;
  traceId?: string;
  parentEventId?: number;
}

export interface RuntimeEventInput {
  repoPath: string;
  kind: RuntimeEventKind;
  agent: string;
  text: string;
  source: RuntimeEventSource;
  timestamp?: string;
  team?: string;
  direction?: RuntimeEventDirection;
  peer?: string;
  data?: Record<string, unknown>;
  subject?: string;
  threadId?: string;
  traceId?: string;
  parentEventId?: number;
}

interface RuntimeEventQuery {
  afterId?: number;
  repoPath?: string;
  agentIds?: string[];
  team?: string;
  teamPrefix?: string;
  subject?: string;
  threadId?: string;
  traceId?: string;
  kinds?: RuntimeEventKind[];
  since?: string;
  limit?: number;
  scopeMode?: 'all' | 'any';
}

interface FollowRuntimeEventsHandle {
  mode: 'pg';
  stop: () => Promise<void>;
}

function logFollowDrainError(context: 'notify' | 'poll', error: unknown, active: boolean): void {
  if (!active) return;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[runtime-events] ${context} drain failed: ${message}`);
}

interface RuntimeEventRow {
  id: number;
  repo_path: string;
  subject: string | null;
  kind: RuntimeEventKind;
  source: RuntimeEventSource;
  agent: string;
  team: string | null;
  direction: RuntimeEventDirection | null;
  peer: string | null;
  text: string;
  data: Record<string, unknown> | null;
  thread_id: string | null;
  trace_id: string | null;
  parent_event_id: number | null;
  created_at: Date | string;
}

function rowToRuntimeEvent(row: RuntimeEventRow): RuntimeEvent {
  return {
    id: Number(row.id),
    repoPath: row.repo_path,
    timestamp: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    kind: row.kind,
    agent: row.agent,
    team: row.team ?? undefined,
    direction: row.direction ?? undefined,
    peer: row.peer ?? undefined,
    text: row.text,
    data: row.data ?? undefined,
    source: row.source,
    subject: row.subject ?? undefined,
    threadId: row.thread_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    parentEventId: row.parent_event_id != null ? Number(row.parent_event_id) : undefined,
  };
}

function nextParam(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

function buildScopeClause(query: RuntimeEventQuery, values: unknown[]): string | null {
  const scopeClauses: string[] = [];

  if (query.agentIds && query.agentIds.length > 0) {
    scopeClauses.push(`agent = ANY(${nextParam(values, query.agentIds)})`);
  }
  if (query.team) {
    scopeClauses.push(`team = ${nextParam(values, query.team)}`);
  }
  if (query.teamPrefix) {
    scopeClauses.push(`team LIKE ${nextParam(values, `${query.teamPrefix}%`)}`);
  }

  if (scopeClauses.length === 0) return null;
  if (scopeClauses.length === 1) return scopeClauses[0];
  if (query.scopeMode === 'any') return `(${scopeClauses.join(' OR ')})`;
  return `(${scopeClauses.join(' AND ')})`;
}

function buildWhere(query: RuntimeEventQuery): { clause: string; values: unknown[] } {
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (query.afterId != null) {
    clauses.push(`id > ${nextParam(values, query.afterId)}`);
  }
  if (query.repoPath) {
    clauses.push(`repo_path = ${nextParam(values, query.repoPath)}`);
  }
  if (query.subject) {
    clauses.push(`subject = ${nextParam(values, query.subject)}`);
  }
  if (query.kinds && query.kinds.length > 0) {
    clauses.push(`kind = ANY(${nextParam(values, query.kinds)})`);
  }
  if (query.since) {
    clauses.push(`created_at >= ${nextParam(values, query.since)}`);
  }
  if (query.threadId) {
    clauses.push(`thread_id = ${nextParam(values, query.threadId)}`);
  }
  if (query.traceId) {
    clauses.push(`trace_id = ${nextParam(values, query.traceId)}`);
  }

  const scopeClause = buildScopeClause(query, values);
  if (scopeClause) clauses.push(scopeClause);

  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
  };
}

export async function publishRuntimeEvent(input: RuntimeEventInput): Promise<RuntimeEvent> {
  if (circuitBreaker.isOpen()) {
    throw new Error('circuit breaker open — PG event write skipped');
  }

  try {
    const sql = await getConnection();
    const threadId = input.threadId ?? `agent:${input.agent}`;
    const rows = await sql<RuntimeEventRow[]>`
      INSERT INTO genie_runtime_events (
        repo_path, subject, kind, source, agent, team, direction, peer, text, data, thread_id, trace_id, parent_event_id, created_at
      )
      VALUES (
        ${input.repoPath},
        ${input.subject ?? null},
        ${input.kind},
        ${input.source},
        ${input.agent},
        ${input.team ?? null},
        ${input.direction ?? null},
        ${input.peer ?? null},
        ${input.text},
        ${sql.json(input.data ?? {})},
        ${threadId},
        ${input.traceId ?? null},
        ${input.parentEventId ?? null},
        ${input.timestamp ?? new Date().toISOString()}
      )
      RETURNING id, repo_path, subject, kind, source, agent, team, direction, peer, text, data, thread_id, trace_id, parent_event_id, created_at
    `;

    circuitBreaker.recordSuccess();
    return rowToRuntimeEvent(rows[0]);
  } catch (error) {
    circuitBreaker.recordFailure();
    throw error;
  }
}

export async function publishSubjectEvent(
  repoPath: string,
  subject: string,
  event: Omit<RuntimeEventInput, 'repoPath' | 'subject'>,
): Promise<RuntimeEvent> {
  return publishRuntimeEvent({ ...event, repoPath, subject });
}

/**
 * Count runtime events emitted within the last `windowSeconds`. Backs
 * `genie metrics` — a CLI-visible alternative to in-process counters, which
 * are useless in a short-lived observer process.
 */
export async function queryRuntimeEventThroughput(windowSeconds = 60): Promise<{ emitted: number }> {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error(`windowSeconds must be a positive number, got ${windowSeconds}`);
  }
  const sql = await getConnection();
  const rows = await sql<{ emitted: number }[]>`
    SELECT COUNT(*)::int AS emitted
    FROM genie_runtime_events
    WHERE created_at > NOW() - make_interval(secs => ${windowSeconds})
  `;
  return { emitted: rows[0]?.emitted ?? 0 };
}

export async function listRuntimeEvents(query: RuntimeEventQuery = {}): Promise<RuntimeEvent[]> {
  const sql = await getConnection();
  const { clause, values } = buildWhere(query);
  const limit = query.limit ?? 500;
  const rows = (await sql.unsafe(
    `
      SELECT id, repo_path, subject, kind, source, agent, team, direction, peer, text, data, thread_id, trace_id, parent_event_id, created_at
      FROM genie_runtime_events
      ${clause}
      ORDER BY id ASC
      LIMIT $${values.length + 1}
    `,
    [...values, limit],
  )) as RuntimeEventRow[];

  return rows.map(rowToRuntimeEvent);
}

export async function getLatestRuntimeEventId(): Promise<number> {
  const sql = await getConnection();
  const rows = await sql<{ max_id: number | null }[]>`
    SELECT COALESCE(MAX(id), 0) AS max_id FROM genie_runtime_events
  `;
  return Number(rows[0]?.max_id ?? 0);
}

export async function followRuntimeEvents(
  query: RuntimeEventQuery,
  onEvent: (event: RuntimeEvent) => void,
  options?: { pollIntervalMs?: number },
): Promise<FollowRuntimeEventsHandle> {
  const sql = await getConnection();
  let active = true;
  let lastSeenId = query.afterId ?? (await getLatestRuntimeEventId());
  let drainChain = Promise.resolve();

  const drain = async () => {
    if (!active) return;
    const events = await listRuntimeEvents({ ...query, afterId: lastSeenId });
    for (const event of events) {
      lastSeenId = event.id;
      onEvent(event);
    }
  };

  const queueDrain = (context: 'notify' | 'poll') => {
    drainChain = drainChain.then(drain).catch((error) => {
      logFollowDrainError(context, error, active);
    });
  };

  const listener = await sql.listen('genie_runtime_event', () => {
    queueDrain('notify');
  });

  await drain();

  const pollIntervalMs = options?.pollIntervalMs ?? 1000;
  const pollTimer = setInterval(() => {
    queueDrain('poll');
  }, pollIntervalMs);

  return {
    mode: 'pg',
    stop: async () => {
      active = false;
      clearInterval(pollTimer);
      try {
        await drainChain;
      } catch {
        /* swallow — connection may already be torn down */
      }
      try {
        await listener.unlisten();
      } catch {
        /* swallow — connection may already be torn down */
      }
    },
  };
}

export async function waitForRuntimeEvent(
  query: RuntimeEventQuery,
  timeoutMs: number,
  predicate?: (event: RuntimeEvent) => boolean,
): Promise<RuntimeEvent | null> {
  const afterId = query.afterId ?? 0;

  return new Promise<RuntimeEvent | null>((resolve, reject) => {
    let settled = false;
    let handle: FollowRuntimeEventsHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = async (event: RuntimeEvent | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (handle) await handle.stop();
      } catch {
        /* swallow — connection may already be torn down */
      }
      resolve(event);
    };

    void (async () => {
      try {
        handle = await followRuntimeEvents(
          { ...query, afterId },
          (event) => {
            if (predicate && !predicate(event)) return;
            void finish(event);
          },
          { pollIntervalMs: 250 },
        );
        if (settled) {
          // initial drain already resolved us — stop the late-arriving handle
          try {
            await handle.stop();
          } catch {
            /* swallow — connection may already be torn down */
          }
          return;
        }
        timer = setTimeout(() => {
          void finish(null);
        }, timeoutMs);
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    })();
  });
}
