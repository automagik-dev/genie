/**
 * `src/lib/emit.ts` — the single emission primitive for genie's structured
 * event substrate.
 *
 * Three primitives:
 *   - `startSpan(type, attrs, ctx?)` — opens a span, returns a handle.
 *   - `endSpan(handle, attrs?)` — closes a span, computes duration_ms.
 *   - `emitEvent(type, payload, ctx?)` — records a point event.
 *
 * All three are fire-and-forget. They enqueue to a bounded in-memory queue
 * and return before any PG I/O happens. A background flusher drains the
 * queue every 100ms (or earlier when ≥500 rows are buffered) using a
 * parametrized multi-row INSERT — postgres.js doesn't expose COPY FROM STDIN
 * cleanly, and parametrized batched INSERT measures comparably at 100 ev/s.
 *
 * Design invariants (from `.genie/wishes/genie-serve-structured-observability/WISH.md`):
 *   - p99 emit-site latency <1ms (enforced by `test/observability/emit-bench.ts`).
 *   - p99 end-to-end latency <50ms at 100 ev/s sustained.
 *   - Schema violations surface as `schema.violation` meta events — they
 *     NEVER throw out of a business transaction.
 *   - Every INSERT into `genie_runtime_events*` in the codebase must come
 *     through this file (enforced by `scripts/lint-emit-discipline.ts`).
 *   - Redaction happens at Zod-parse time via field-level `.transform()` so
 *     raw bytes never land in JSONB.
 *
 * Group 6 tiered back-pressure:
 *   - debug overflow  → drop silently + shedding_load counter + 1/min summary
 *   - info  overflow  → bounded 50ms wait, then drop + shedding summary
 *   - warn+ overflow  → bounded 50ms wait, then spill to disk journal +
 *                        emit `consumer.lagged` audit event +
 *                        raise `emit.backpressure.critical` if sustained.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getConnection } from './db.js';
import { capPayload } from './events/redactors.js';
import { getEntry, isRegistered } from './events/registry.js';
import * as schemaViolation from './events/schemas/schema.violation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface TraceContext {
  trace_id: string;
  span_id?: string;
  parent_span_id?: string;
  tenant_id?: string;
}

export interface SpanHandle {
  readonly type: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id?: string;
  readonly started_at: number;
  readonly start_attrs: Record<string, unknown>;
  readonly severity: Severity;
  readonly source_subsystem?: string;
}

export interface EmitOptions {
  severity?: Severity;
  source_subsystem?: string;
  ctx?: TraceContext;
  repo_path?: string;
  agent?: string;
  team?: string;
  entity_id?: string;
  /**
   * Detector release identifier (semver). Populated by the detector scheduler
   * (`src/serve/detector-scheduler.ts`) on every emit so downstream queries
   * can pivot on "which detector version produced this row". Surfaced as a
   * first-class column on `genie_runtime_events*` (migration 043); stays NULL
   * for non-detector events.
   */
  detector_version?: string;
}

// ---------------------------------------------------------------------------
// Internal queued row
// ---------------------------------------------------------------------------

interface QueuedRow {
  type: string;
  kind: 'span' | 'event';
  schema_version: number;
  tier_defaults: 'default' | 'debug' | 'audit';
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  severity: Severity;
  source_subsystem: string | null;
  dedup_key: string;
  duration_ms: number | null;
  repo_path: string;
  agent: string;
  team: string | null;
  detector_version: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Queue + flusher state
// ---------------------------------------------------------------------------

const QUEUE_CAP = 10_000;
const BATCH_SIZE = 500;
const FLUSH_INTERVAL_MS = 100;
/** Max time we block warn+ emits waiting for queue headroom before spilling. */
const BACKPRESSURE_WAIT_MS = 50;
/** Cadence for queue depth watcher emission. */
const QUEUE_DEPTH_TICK_MS = 10_000;
/** Window size for rolling p99 latency watcher. */
const LATENCY_WINDOW = 1_000;
/** Cadence for shedding_load 1/min summary. */
const SHEDDING_SUMMARY_MS = 60_000;
/** Sustained-spill threshold that raises emit.backpressure.critical. */
const BACKPRESSURE_CRITICAL_MS = 30_000;

const queue: QueuedRow[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushInFlight: Promise<void> | null = null;
let shuttingDown = false;

// Periodic watcher state.
let queueDepthTimer: ReturnType<typeof setInterval> | null = null;
let sheddingTimer: ReturnType<typeof setInterval> | null = null;
let correlationTimer: ReturnType<typeof setInterval> | null = null;
let watchersStartedAt = 0;
let firstSpillAt: number | null = null;
let lastCriticalAt = 0;

// Rolling latency sample (ring buffer).
const latencySamples: number[] = new Array(LATENCY_WINDOW).fill(0);
let latencyIdx = 0;
let latencyFilled = 0;

// Rolling correlation orphan window: each entry [hadParent, matched].
interface CorrEntry {
  parent_span_id: string | null;
  matched: boolean;
}
const corrWindow: CorrEntry[] = [];
const knownSpanIds = new Set<string>();
const KNOWN_SPAN_CAP = 10_000;

/** Stats observable by tests / Group 6 watcher metrics. */
export interface EmitStats {
  enqueued: number;
  flushed: number;
  dropped_debug: number;
  dropped_info: number;
  dropped_overflow: number;
  spilled_warn_plus: number;
  schema_violations: number;
  queue_depth: number;
  last_flush_ms: number;
  last_flush_rows: number;
  backpressure_active: boolean;
  spill_rows_pending: number;
}
const stats: EmitStats = {
  enqueued: 0,
  flushed: 0,
  dropped_debug: 0,
  dropped_info: 0,
  dropped_overflow: 0,
  spilled_warn_plus: 0,
  schema_violations: 0,
  queue_depth: 0,
  last_flush_ms: 0,
  last_flush_rows: 0,
  backpressure_active: false,
  spill_rows_pending: 0,
};
export function getEmitStats(): EmitStats {
  return { ...stats, queue_depth: queue.length };
}

// ---------------------------------------------------------------------------
// Spill journal
// ---------------------------------------------------------------------------

/** Disk spill journal for warn+ events that couldn't enqueue. */
function defaultSpillPath(): string {
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(home, 'data', 'emit-spill.jsonl');
}

let spillPathOverride: string | null = null;
export function __setSpillPathForTests(path: string | null): void {
  spillPathOverride = path;
}
function spillPath(): string {
  return spillPathOverride ?? defaultSpillPath();
}

function ensureSpillDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Append one row to the spill journal with fsync. */
function writeSpillRow(row: QueuedRow): void {
  const path = spillPath();
  ensureSpillDir(path);
  const line = `${JSON.stringify(row)}\n`;
  // Open/append/fsync explicitly so we never lose warn+ events to page cache.
  const fd = openSync(path, 'a');
  try {
    appendFileSync(fd, line);
    try {
      fsyncSync(fd);
    } catch {
      // fsync may be unsupported on tmpfs; tolerate to keep fire-and-forget.
    }
  } finally {
    closeSync(fd);
  }
  stats.spilled_warn_plus++;
  if (firstSpillAt === null) firstSpillAt = Date.now();
}

function countSpillRows(): number {
  const path = spillPath();
  if (!existsSync(path)) return 0;
  try {
    const contents = readFileSync(path, 'utf8');
    if (!contents) return 0;
    return contents.split('\n').filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

export function isSpillJournalEmpty(): boolean {
  return countSpillRows() === 0;
}

function readStagingRows(staging: string): QueuedRow[] {
  let contents: string;
  try {
    contents = readFileSync(staging, 'utf8');
  } catch {
    return [];
  }
  const lines = contents.split('\n').filter((l) => l.length > 0);
  const rows: QueuedRow[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as QueuedRow);
    } catch {
      // Malformed line — skip but keep draining.
    }
  }
  return rows;
}

function reappendRowsToJournal(path: string, rows: QueuedRow[]): void {
  const fd = openSync(path, 'a');
  try {
    for (const row of rows) appendFileSync(fd, `${JSON.stringify(row)}\n`);
    try {
      fsyncSync(fd);
    } catch {}
  } finally {
    closeSync(fd);
  }
}

function stageSpillJournal(path: string): string | null {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size === 0) return null;
  const staging = `${path}.draining-${process.pid}`;
  try {
    renameSync(path, staging);
  } catch {
    return null;
  }
  return staging;
}

/** Drain the spill journal: replay rows oldest-first, preserving timestamps. */
async function drainSpillJournal(): Promise<number> {
  const path = spillPath();
  if (!existsSync(path)) return 0;
  const staging = stageSpillJournal(path);
  if (!staging) return 0;

  const rows = readStagingRows(staging);
  if (rows.length === 0) {
    try {
      unlinkSync(staging);
    } catch {}
    return 0;
  }

  try {
    await writeBatch(rows);
    stats.flushed += rows.length;
  } catch (err) {
    reappendRowsToJournal(path, rows);
    process.stderr.write(`[emit] spill drain retry pending: ${err instanceof Error ? err.message : String(err)}\n`);
    return 0;
  }

  try {
    unlinkSync(staging);
  } catch {}

  firstSpillAt = null;
  stats.backpressure_active = false;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Public primitives
// ---------------------------------------------------------------------------

/** Open a span. Returns a handle that must be passed to `endSpan`. */
export function startSpan(type: string, attrs: Record<string, unknown> = {}, opts: EmitOptions = {}): SpanHandle {
  const entry = getEntry(type);
  const kind = entry?.kind ?? 'span';
  if (entry && kind !== 'span') {
    emitSchemaViolation(type, `startSpan called on '${kind}' type`);
  }
  const ctx: Partial<TraceContext> = opts.ctx ?? {};
  const span_id = newId();
  return {
    type,
    trace_id: ctx.trace_id ?? newTraceId(),
    span_id,
    parent_span_id: ctx.span_id ?? ctx.parent_span_id,
    started_at: Date.now(),
    start_attrs: attrs,
    severity: opts.severity ?? 'info',
    source_subsystem: opts.source_subsystem,
  };
}

/** Close a span. Computes duration_ms and enqueues the row. */
export function endSpan(handle: SpanHandle, attrs: Record<string, unknown> = {}, opts: EmitOptions = {}): void {
  const now = Date.now();
  const duration_ms = now - handle.started_at;
  const merged = { ...handle.start_attrs, ...attrs, duration_ms };
  enqueueTyped(
    handle.type,
    merged,
    {
      severity: opts.severity ?? handle.severity,
      source_subsystem: opts.source_subsystem ?? handle.source_subsystem,
      ctx: {
        trace_id: handle.trace_id,
        span_id: handle.span_id,
        parent_span_id: handle.parent_span_id,
      },
      repo_path: opts.repo_path,
      agent: opts.agent,
      team: opts.team,
      entity_id: opts.entity_id,
    },
    duration_ms,
  );
}

/** Emit a point event. */
export function emitEvent(type: string, payload: Record<string, unknown>, opts: EmitOptions = {}): void {
  const entry = getEntry(type);
  if (entry && entry.kind === 'span') {
    emitSchemaViolation(type, "emitEvent called on 'span' type — use start/endSpan");
    return;
  }
  enqueueTyped(type, payload, opts, null);
}

// ---------------------------------------------------------------------------
// Core enqueue path
// ---------------------------------------------------------------------------

function parsePayload(
  entry: ReturnType<typeof getEntry>,
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!entry) return null;
  try {
    const result = entry.schema.safeParse(payload);
    if (!result.success) {
      stats.schema_violations++;
      emitSchemaViolation(type, 'zod parse failure', result.error.issues);
      return null;
    }
    return result.data as Record<string, unknown>;
  } catch (err) {
    stats.schema_violations++;
    emitSchemaViolation(type, `zod throw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Back-pressure policy by severity. Returns `admit` when the row should enter
 * the queue, `spill` when the caller should divert to disk, `drop` otherwise.
 */
type AdmissionResult =
  | { action: 'admit' }
  | { action: 'drop'; reason: 'debug' | 'info' | 'overflow' }
  | { action: 'spill' };

function classifyAdmission(severity: Severity): AdmissionResult {
  if (queue.length < QUEUE_CAP) return { action: 'admit' };
  if (severity === 'debug') {
    stats.dropped_debug++;
    return { action: 'drop', reason: 'debug' };
  }
  if (severity === 'info') {
    // bounded wait + drop is semantically "drop" at the hot path; the wait is
    // observed by the caller via deferred enqueue when capacity returns before
    // timeout. We represent wait via the queued-bypass loop in enqueueTyped.
    return { action: 'drop', reason: 'info' };
  }
  return { action: 'spill' };
}

function buildRow(
  type: string,
  entry: NonNullable<ReturnType<typeof getEntry>>,
  payload: Record<string, unknown>,
  severity: Severity,
  duration_ms: number | null,
  opts: EmitOptions,
): QueuedRow {
  const ctx: Partial<TraceContext> = opts.ctx ?? {};
  return {
    type,
    kind: entry.kind,
    schema_version: entry.schema_version,
    tier_defaults: entry.tier_defaults,
    trace_id: ctx.trace_id ?? newTraceId(),
    span_id: ctx.span_id ?? newId(),
    parent_span_id: ctx.parent_span_id ?? null,
    severity,
    source_subsystem: opts.source_subsystem ?? null,
    dedup_key: computeDedupKey(type, opts.entity_id ?? '', payload),
    duration_ms,
    repo_path: opts.repo_path ?? process.env.GENIE_REPO_PATH ?? process.cwd(),
    agent: opts.agent ?? process.env.GENIE_AGENT_NAME ?? 'system',
    team: opts.team ?? process.env.GENIE_TEAM ?? null,
    detector_version: opts.detector_version ?? null,
    payload,
    created_at: new Date().toISOString(),
  };
}

function preparePayload(
  type: string,
  payload: Record<string, unknown>,
): { entry: NonNullable<ReturnType<typeof getEntry>>; effectivePayload: Record<string, unknown> } | null {
  const entry = getEntry(type);
  if (!entry) return null;
  const parsed = parsePayload(entry, type, payload);
  if (!parsed) return null;
  const capped = capPayload(parsed);
  if (capped.overflow) stats.dropped_overflow++;
  return { entry, effectivePayload: capped.body as Record<string, unknown> };
}

function handleInfoBackpressure(row: QueuedRow, t0: number): void {
  stats.dropped_info++;
  // Bounded wait — if the flusher pulled something out in the last 50ms we
  // can still admit. This is a hot path so we only probe once, not a tight
  // spin loop.
  if (Date.now() - t0 < BACKPRESSURE_WAIT_MS && queue.length < QUEUE_CAP) {
    admitToQueue(row);
  }
}

function handleSpillPath(row: QueuedRow, severity: Severity): void {
  if (queue.length < QUEUE_CAP) {
    admitToQueue(row);
    return;
  }
  try {
    writeSpillRow(row);
    stats.backpressure_active = true;
    raiseLaggedIfNeeded(severity, row);
    maybeRaiseBackpressureCritical();
  } catch (err) {
    // Even spill failed — last resort, keep it in stderr so the host logs it.
    process.stderr.write(
      `[emit] spill write failed (event lost): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    stats.dropped_overflow++;
  }
}

function dispatchDecision(row: QueuedRow, severity: Severity, decision: AdmissionResult, t0: number): void {
  if (decision.action === 'admit') {
    admitToQueue(row);
    return;
  }
  if (decision.action === 'drop') {
    if (decision.reason === 'info') handleInfoBackpressure(row, t0);
    // debug: silent drop — schema.violation would amplify load under saturation.
    return;
  }
  handleSpillPath(row, severity);
}

function enqueueTyped(
  type: string,
  payload: Record<string, unknown>,
  opts: EmitOptions,
  duration_ms: number | null,
): void {
  const t0 = Date.now();
  if (shuttingDown) {
    stats.dropped_overflow++;
    return;
  }
  if (!isRegistered(type)) {
    emitSchemaViolation(type, 'unregistered event type');
    recordLatency(Date.now() - t0);
    return;
  }
  const prepared = preparePayload(type, payload);
  if (!prepared) {
    recordLatency(Date.now() - t0);
    return;
  }
  const severity = opts.severity ?? 'info';
  const row = buildRow(type, prepared.entry, prepared.effectivePayload, severity, duration_ms, opts);
  dispatchDecision(row, severity, classifyAdmission(severity), t0);
  recordLatency(Date.now() - t0);
}

function admitToQueue(row: QueuedRow): void {
  // Drop admits while the test harness is swapping DBs. `enqueueTyped()` has
  // a top-level shuttingDown check, but backpressure paths
  // (`handleInfoBackpressure`, `handleSpillPath`) re-invoke `admitToQueue`
  // after a bounded wait — this guard ensures those deferred paths also
  // no-op during the quiesce window.
  if (shuttingDown) return;
  queue.push(row);
  stats.enqueued++;
  stats.queue_depth = queue.length;
  trackCorrelationSample(row);
  ensureFlusher();
  ensureWatchers();
  if (queue.length >= BATCH_SIZE) {
    void triggerFlush();
  }
}

function recordLatency(ms: number): void {
  latencySamples[latencyIdx] = ms;
  latencyIdx = (latencyIdx + 1) % LATENCY_WINDOW;
  if (latencyFilled < LATENCY_WINDOW) latencyFilled++;
  if (latencyFilled === LATENCY_WINDOW && latencyIdx === 0) {
    // Window just rolled over — emit a p99 summary.
    const p = computePercentiles();
    enqueueMetaEvent('emitter.latency_p99', {
      window_samples: latencyFilled,
      p50_ms: p.p50,
      p95_ms: p.p95,
      p99_ms: p.p99,
      max_ms: p.max,
    });
  }
}

function computePercentiles(): { p50: number; p95: number; p99: number; max: number } {
  const copy = latencySamples
    .slice(0, latencyFilled)
    .slice()
    .sort((a, b) => a - b);
  const pick = (pct: number) =>
    copy.length === 0 ? 0 : copy[Math.min(copy.length - 1, Math.floor(copy.length * pct))];
  return {
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: copy.length === 0 ? 0 : copy[copy.length - 1],
  };
}

function trackCorrelationSample(row: QueuedRow): void {
  // Remember this span as a possible parent for future lookups.
  if (knownSpanIds.size >= KNOWN_SPAN_CAP) {
    const firstKey = knownSpanIds.values().next().value as string | undefined;
    if (firstKey) knownSpanIds.delete(firstKey);
  }
  knownSpanIds.add(row.span_id);

  const matched = row.parent_span_id ? knownSpanIds.has(row.parent_span_id) : true;
  corrWindow.push({ parent_span_id: row.parent_span_id, matched });
  if (corrWindow.length > LATENCY_WINDOW) corrWindow.shift();
}

function emitSchemaViolation(offendingType: string, reason: string, issues?: unknown): void {
  // Guard: never recurse through the registry if the violation type itself
  // fails parse (would loop forever on a malformed `schema.violation`).
  if (offendingType === schemaViolation.TYPE) return;

  const issueArray = Array.isArray(issues)
    ? (issues as Array<{ path: (string | number)[]; code: string; message: string }>).slice(0, 32).map((i) => ({
        path: i.path.join('.') || '<root>',
        code: String(i.code ?? 'unknown'),
        message: String(i.message ?? reason).slice(0, 512),
      }))
    : [{ path: '<root>', code: 'emit_rejected', message: reason.slice(0, 512) }];

  enqueueTyped(
    schemaViolation.TYPE,
    {
      offending_type: offendingType.slice(0, 128),
      issues: issueArray,
      rejected_bytes: 0,
    },
    { severity: 'warn', source_subsystem: 'emit.ts' },
    null,
  );

  // Also bump the rate counter so consumers get both the detail and the rate.
  enqueueMetaEvent('emitter.rejected', {
    offending_type: offendingType.slice(0, 128),
    reason: 'schema_parse',
    count: 1,
  });
}

/**
 * Bypass the normal admission policy for internally-generated meta events.
 * Meta events are subject to the same queue cap but we tolerate losing them
 * rather than recursing into spill logic — that would itself be a source of
 * load amplification when the queue is saturated.
 */
function enqueueMetaEvent(type: string, payload: Record<string, unknown>): void {
  if (!isRegistered(type)) return;
  const entry = getEntry(type);
  if (!entry) return;
  const parsed = entry.schema.safeParse(payload);
  if (!parsed.success) return;
  if (queue.length >= QUEUE_CAP) return;
  const row = buildRow(type, entry, parsed.data as Record<string, unknown>, 'info', null, {
    source_subsystem: 'emit.ts',
  });
  queue.push(row);
  stats.enqueued++;
  stats.queue_depth = queue.length;
}

function raiseLaggedIfNeeded(severity: Severity, _row: QueuedRow): void {
  if (severity !== 'warn' && severity !== 'error' && severity !== 'fatal') return;
  enqueueMetaEvent('consumer.lagged', {
    severity_class: severity,
    spill_path: spillPath(),
    rows_spilled: 1,
    queue_depth: queue.length,
    queue_cap: QUEUE_CAP,
  });
}

function maybeRaiseBackpressureCritical(): void {
  if (firstSpillAt === null) return;
  const duration = Date.now() - firstSpillAt;
  if (duration < BACKPRESSURE_CRITICAL_MS) return;
  // De-duplicate — only raise once per 60s of sustained spill.
  if (Date.now() - lastCriticalAt < 60_000) return;
  lastCriticalAt = Date.now();
  enqueueMetaEvent('emit.backpressure.critical', {
    spill_duration_seconds: Math.round(duration / 1000),
    spill_rows_total: stats.spilled_warn_plus,
    queue_depth: queue.length,
    queue_cap: QUEUE_CAP,
    recommended_action: 'inspect_pg',
  });
}

// ---------------------------------------------------------------------------
// Dedup key — SHA256 of (type, entity_id, payload_digest, minute_bucket)
// ---------------------------------------------------------------------------

function computeDedupKey(type: string, entityId: string, payload: Record<string, unknown>): string {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  let digest = '';
  try {
    digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  } catch {
    digest = 'nohash';
  }
  return createHash('sha256').update(`${type}|${entityId}|${digest}|${minuteBucket}`).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

function newTraceId(): string {
  return randomUUID().replace(/-/g, '');
}
function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Background flusher
// ---------------------------------------------------------------------------

function ensureFlusher(): void {
  // Also gate on `shuttingDown` so leaked background pollers from prior test
  // files can't re-arm the timer during the quiesce window while
  // `setupTestDatabase()` is swapping DBs between `resetConnection()` and
  // `createTestDatabase()`.
  if (flushTimer || shuttingDown) return;
  flushTimer = setInterval(() => {
    void triggerFlush();
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function ensureWatchers(): void {
  if (watchersStartedAt !== 0) return;
  watchersStartedAt = Date.now();

  queueDepthTimer = setInterval(() => {
    stats.spill_rows_pending = countSpillRows();
    enqueueMetaEvent('emitter.queue.depth', {
      depth: queue.length,
      cap: QUEUE_CAP,
      utilization: queue.length / QUEUE_CAP,
      enqueued_total: stats.enqueued,
      flushed_total: stats.flushed,
    });
  }, QUEUE_DEPTH_TICK_MS);
  if (typeof queueDepthTimer.unref === 'function') queueDepthTimer.unref();

  sheddingTimer = setInterval(() => {
    if (stats.dropped_debug === 0 && stats.dropped_info === 0 && stats.spilled_warn_plus === 0) return;
    enqueueMetaEvent('emitter.shedding_load', {
      dropped_debug: stats.dropped_debug,
      dropped_info: stats.dropped_info,
      spilled_warn_plus: stats.spilled_warn_plus,
      window_seconds: Math.round(SHEDDING_SUMMARY_MS / 1000),
    });
  }, SHEDDING_SUMMARY_MS);
  if (typeof sheddingTimer.unref === 'function') sheddingTimer.unref();

  correlationTimer = setInterval(() => {
    if (corrWindow.length < 100) return;
    const orphans = corrWindow.reduce((acc, e) => acc + (e.parent_span_id && !e.matched ? 1 : 0), 0);
    const rate = orphans / corrWindow.length;
    enqueueMetaEvent('correlation.orphan.rate', {
      window_samples: corrWindow.length,
      orphans,
      rate,
    });
  }, QUEUE_DEPTH_TICK_MS);
  if (typeof correlationTimer.unref === 'function') correlationTimer.unref();
}

function triggerFlush(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  if (queue.length === 0) return Promise.resolve();
  flushInFlight = doFlush().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

async function doFlush(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.splice(0, BATCH_SIZE);
  const t0 = Date.now();
  try {
    await writeBatch(batch);
    stats.flushed += batch.length;
    stats.last_flush_rows = batch.length;
    stats.last_flush_ms = Date.now() - t0;
    // Opportunistic spill drain — only attempts if journal has rows.
    if (!isSpillJournalEmpty()) {
      void drainSpillJournal();
    }
  } catch (err) {
    // If the test harness is quiescing, drop the batch rather than requeue
    // against a sqlClient that's about to be reset. Requeueing here would
    // repopulate the queue that shutdownEmitter() just cleared, and the next
    // flush tick would hit the about-to-be-dropped DB and cascade into
    // CONNECTION_ENDED on the next test's first await.
    if (shuttingDown) {
      stats.queue_depth = queue.length;
      return;
    }
    // Push back to the head so we don't lose events when PG blips. Cap the
    // re-inject so a permanently-broken PG can't pathologically grow memory.
    const reinjectCap = Math.max(0, QUEUE_CAP - queue.length);
    if (reinjectCap > 0) queue.unshift(...batch.slice(0, reinjectCap));
    // Surface the symptom once per flush attempt; process.stderr is the only
    // fallback we have because emit() itself cannot recurse into PG writes.
    process.stderr.write(
      `[emit] flush failed: ${err instanceof Error ? err.message : String(err)} (requeued ${Math.min(batch.length, reinjectCap)}/${batch.length})\n`,
    );
  }
  stats.queue_depth = queue.length;
}

/** Exposed for tests — flushes synchronously. */
export async function flushNow(): Promise<void> {
  await triggerFlush();
  // If splicing the first batch left more rows, keep draining.
  while (queue.length > 0 && !shuttingDown) {
    await triggerFlush();
  }
}

/** Exposed for tests — force a spill journal drain. */
export async function drainSpillJournalNow(): Promise<number> {
  return drainSpillJournal();
}

/**
 * Quiesce the emitter.
 *
 * Used by tests between `setupTestDatabase()` cycles so the background flusher
 * doesn't hold a stale reference to a pool whose DB is about to be dropped.
 * Callers MUST await this before `resetConnection()` / `dropTestDatabase()`.
 *
 * Order matters:
 *   1. Set `shuttingDown` so new emits are dropped (no more queue growth).
 *   2. Await any in-flight `writeBatch` promise — otherwise clearing the timer
 *      leaves a half-done write racing against the DB drop.
 *   3. Clear the flush + watcher intervals (next `ensureFlusher()` rearms).
 *   4. Attempt ONE bounded final drain. If it fails, we do NOT loop — a dead
 *      PG would otherwise requeue forever. The queue is then reset explicitly
 *      so the test's next cycle starts from a clean slate.
 *
 * IMPORTANT: On return, `shuttingDown` STAYS LATCHED TRUE. Admits remain
 * blocked until the caller explicitly invokes `resumeEmitter()`. This prevents
 * leaked background pollers from prior test files (e.g. `audit.ts` setInterval,
 * `runtime-events.ts` subscribe+poll) from re-arming the flusher against a
 * stale `sqlClient` mid-swap while `setupTestDatabase()` is between
 * `resetConnection()` and `createTestDatabase()`. If such a poller fires an
 * `emitEvent()` in the quiesce window, it would hit `admitToQueue()` →
 * `ensureFlusher()` → rearm the flush timer → flush against the about-to-be-
 * dropped DB → `pg_terminate_backend` kills the backend mid-query →
 * `CONNECTION_ENDED` propagates to the next test's first await.
 */
export async function shutdownEmitter(): Promise<void> {
  shuttingDown = true;
  // Step 1: wait for any flush currently writing to PG. Clearing timers while
  // writeBatch is in flight would leave the Promise dangling against a pool
  // that tests are about to dispose.
  if (flushInFlight) {
    try {
      await flushInFlight;
    } catch {
      /* best-effort — the in-flight flush may fail if PG is unreachable */
    }
  }

  // Step 2: tear down all timers. The flusher's re-arm check (`if (flushTimer
  // || shuttingDown) return`) guarantees ensureFlusher() stays quiesced until
  // resumeEmitter() is called.
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (queueDepthTimer) {
    clearInterval(queueDepthTimer);
    queueDepthTimer = null;
  }
  if (sheddingTimer) {
    clearInterval(sheddingTimer);
    sheddingTimer = null;
  }
  if (correlationTimer) {
    clearInterval(correlationTimer);
    correlationTimer = null;
  }
  watchersStartedAt = 0;

  // Step 3: best-effort final drain. Bounded to a single attempt — failures
  // during teardown must not block the caller's DB drop.
  try {
    if (queue.length > 0) await triggerFlush();
  } catch {
    /* ignore — we're tearing down */
  }

  // Step 4: reset queue + transient state so the next ensureFlusher() starts
  // clean. Dropping the in-memory tail is intentional: tests that need durable
  // flushes use `flushNow()` before calling shutdown.
  queue.length = 0;
  stats.queue_depth = 0;
  // Intentional: `shuttingDown` stays true until `resumeEmitter()` is called.
  // See block comment above for the CONNECTION_ENDED race this prevents.
  // `flushTimer` is already null — `ensureFlusher()` gates re-arm on both
  // `flushTimer` and `shuttingDown`, so the quiesce window is honoured.
}

/**
 * Re-open admits after a `shutdownEmitter()` quiesce.
 *
 * Must be called by the test harness AFTER `resetConnection()` +
 * `createTestDatabase()` succeed, so fresh emits land in the new DB's pool
 * rather than racing the swap.
 */
export function resumeEmitter(): void {
  shuttingDown = false;
}

// ---------------------------------------------------------------------------
// Writer — parametrized multi-row INSERT into `genie_runtime_events`.
//
// Group 1 adds OTEL columns (`trace_id`, `span_id`, `parent_span_id`,
// `severity`, `schema_version`, `duration_ms`, `dedup_key`,
// `source_subsystem`). Until that migration lands we embed them inside the
// existing `data` JSONB so emit.ts works against current schema and against
// the enriched schema identically.
// ---------------------------------------------------------------------------

/** Target table for a row based on tier + severity + dedup sample. */
function routeTable(row: QueuedRow): 'main' | 'debug' | 'audit' {
  if (row.tier_defaults === 'audit') return 'audit';
  if (row.tier_defaults === 'debug') return 'debug';
  if (row.severity === 'debug') {
    // 1/100 sample retained in main; remainder demoted to debug sibling.
    const sampleByte = Number.parseInt(row.dedup_key.slice(-2), 16);
    if (!Number.isNaN(sampleByte) && sampleByte % 100 === 0) return 'main';
    return 'debug';
  }
  return 'main';
}

function rowRecord(row: QueuedRow): Record<string, unknown> {
  const enrichedData = {
    ...row.payload,
    _trace_id: row.trace_id,
    _span_id: row.span_id,
    _parent_span_id: row.parent_span_id,
    _severity: row.severity,
    _schema_version: row.schema_version,
    _duration_ms: row.duration_ms,
    _dedup_key: row.dedup_key,
    _source_subsystem: row.source_subsystem,
    _tier: row.tier_defaults,
    _kind: row.kind,
  };
  return {
    repo_path: row.repo_path,
    subject: row.type,
    kind: 'system',
    source: 'sdk',
    agent: row.agent,
    team: row.team,
    direction: null,
    peer: null,
    text: row.type,
    // Serialize to a JSON string — the writeBucket SQL casts this placeholder
    // to ::jsonb so postgres parses it as structured JSON (not a string scalar).
    data: enrichedData,
    detector_version: row.detector_version,
    created_at: row.created_at,
  };
}

type SqlConn = Awaited<ReturnType<typeof getConnection>>;

async function insertIntoMain(sql: SqlConn, rec: Record<string, unknown>): Promise<void> {
  const data = rec.data as Record<string, unknown>;
  await sql`
    INSERT INTO genie_runtime_events
      (repo_path, subject, kind, source, agent, team, direction, peer, text, data, detector_version, created_at)
    VALUES (
      ${rec.repo_path as string},
      ${rec.subject as string},
      ${rec.kind as string},
      ${rec.source as string},
      ${rec.agent as string},
      ${(rec.team ?? null) as string | null},
      ${(rec.direction ?? null) as string | null},
      ${(rec.peer ?? null) as string | null},
      ${rec.text as string},
      ${sql.json(data)},
      ${(rec.detector_version ?? null) as string | null},
      ${rec.created_at as string}
    )
  `;
}

async function insertIntoDebug(sql: SqlConn, rec: Record<string, unknown>): Promise<void> {
  const data = rec.data as Record<string, unknown>;
  await sql`
    INSERT INTO genie_runtime_events_debug
      (repo_path, subject, kind, source, agent, team, direction, peer, text, data, detector_version, created_at)
    VALUES (
      ${rec.repo_path as string},
      ${rec.subject as string},
      ${rec.kind as string},
      ${rec.source as string},
      ${rec.agent as string},
      ${(rec.team ?? null) as string | null},
      ${(rec.direction ?? null) as string | null},
      ${(rec.peer ?? null) as string | null},
      ${rec.text as string},
      ${sql.json(data)},
      ${(rec.detector_version ?? null) as string | null},
      ${rec.created_at as string}
    )
  `;
}

async function insertIntoAudit(sql: SqlConn, rec: Record<string, unknown>): Promise<void> {
  const data = rec.data as Record<string, unknown>;
  await sql`
    INSERT INTO genie_runtime_events_audit
      (repo_path, subject, kind, source, agent, team, direction, peer, text, data, detector_version, created_at)
    VALUES (
      ${rec.repo_path as string},
      ${rec.subject as string},
      ${rec.kind as string},
      ${rec.source as string},
      ${rec.agent as string},
      ${(rec.team ?? null) as string | null},
      ${(rec.direction ?? null) as string | null},
      ${(rec.peer ?? null) as string | null},
      ${rec.text as string},
      ${sql.json(data)},
      ${(rec.detector_version ?? null) as string | null},
      ${rec.created_at as string}
    )
  `;
}

// One tagged-template INSERT per row binds `data` as JSONB via `sql.json()` —
// crucial because `sql.unsafe(stmt, params)` would bind the payload as text,
// storing it as a JSON string scalar and breaking structural queries like
// `data->>'_trace_id'`. postgres.js doesn't accept a dynamic table name in a
// tagged template; we dispatch to one of three fixed-target inserters.
async function writeBucket(
  sql: SqlConn,
  inserter: (sql: SqlConn, rec: Record<string, unknown>) => Promise<void>,
  rows: QueuedRow[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const row of rows) {
    await inserter(sql, rowRecord(row));
  }
}

async function writeBucketWithFallback(
  sql: SqlConn,
  inserter: (sql: SqlConn, rec: Record<string, unknown>) => Promise<void>,
  rows: QueuedRow[],
): Promise<void> {
  try {
    await writeBucket(sql, inserter, rows);
  } catch {
    // Sibling table missing (migration 039 not yet applied) — fall back to main.
    if (rows.length > 0) await writeBucket(sql, insertIntoMain, rows);
  }
}

async function writeBatch(batch: QueuedRow[]): Promise<void> {
  const sql = await getConnection();
  const buckets: Record<'main' | 'debug' | 'audit', QueuedRow[]> = { main: [], debug: [], audit: [] };
  for (const row of batch) {
    buckets[routeTable(row)].push(row);
  }

  await writeBucket(sql, insertIntoMain, buckets.main);
  await writeBucketWithFallback(sql, insertIntoDebug, buckets.debug);
  await writeBucketWithFallback(sql, insertIntoAudit, buckets.audit);
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** Clear in-memory queue + reset stats. Tests only. */
export function __resetEmitForTests(): void {
  queue.length = 0;
  stats.enqueued = 0;
  stats.flushed = 0;
  stats.dropped_debug = 0;
  stats.dropped_info = 0;
  stats.dropped_overflow = 0;
  stats.spilled_warn_plus = 0;
  stats.schema_violations = 0;
  stats.queue_depth = 0;
  stats.last_flush_ms = 0;
  stats.last_flush_rows = 0;
  stats.backpressure_active = false;
  stats.spill_rows_pending = 0;
  shuttingDown = false;
  firstSpillAt = null;
  lastCriticalAt = 0;
  corrWindow.length = 0;
  knownSpanIds.clear();
  latencyIdx = 0;
  latencyFilled = 0;
  for (let i = 0; i < latencySamples.length; i++) latencySamples[i] = 0;
}

/** Expose queue constants for tests that want to saturate. */
export const __TEST_QUEUE_CAP = QUEUE_CAP;
export const __TEST_BACKPRESSURE_WAIT_MS = BACKPRESSURE_WAIT_MS;
