/**
 * `genie events stream --follow` — consumer CLI transport (v2).
 *
 * Opens per-prefix LISTEN channels (`genie_events.<prefix>`) for an id-cursor
 * read against `genie_runtime_events`. Wakes on NOTIFY, drains via
 * `WHERE id > last_seen_id ORDER BY id LIMIT 500`, emits:
 *   - `stream.gap.detected` when the incoming id skips more than 1
 *   - `consumer.heartbeat` every 30s while active
 *
 * Idle cost is one PG backend + one cheap SELECT per wake (no polling).
 *
 * Wish: genie-serve-structured-observability, Group 4.
 */

import { emitEvent } from '../lib/emit.js';
import { generateConsumerId, loadConsumerState, saveConsumerState } from '../lib/events/consumer-state.js';
import { TokenError, type TokenPayload, verifyToken } from '../lib/events/tokens.js';
import { DEFAULT_CHANNEL_PREFIXES, type V2EventRow, getLatestEventId, queryV2Batch } from '../lib/events/v2-query.js';
import { color } from '../lib/term-format.js';

export interface StreamFollowOptions {
  follow?: boolean;
  kind?: string;
  severity?: string;
  since?: string;
  consumerId?: string;
  json?: boolean;
  heartbeatIntervalMs?: number;
  /** Primarily for tests: stop after receiving N events. */
  maxEvents?: number;
  /** Primarily for tests: exit after idle for this long (no new NOTIFYs). */
  idleExitMs?: number;
  /** Subscription token override; falls back to GENIE_EVENTS_TOKEN env. */
  token?: string;
  /** Skip token enforcement (tests + operator-owner local debug). */
  skipTokenCheck?: boolean;
}

export interface StreamFollowHandle {
  stop: () => Promise<void>;
  /** Exposed for tests. */
  getLastSeenId: () => number;
  getEventsDelivered: () => number;
}

async function resolveTokenPayload(options: StreamFollowOptions): Promise<TokenPayload | null> {
  const tokenStr = options.token ?? process.env.GENIE_EVENTS_TOKEN;
  if (tokenStr && !options.skipTokenCheck) {
    try {
      return await verifyToken(tokenStr);
    } catch (err) {
      if (err instanceof TokenError) {
        console.error(color('red', `token rejected: ${err.code} — ${err.message}`));
        process.exit(2);
      }
      throw err;
    }
  }
  if (process.env.GENIE_EVENTS_TOKEN_REQUIRED === '1' && !options.skipTokenCheck) {
    console.error(color('red', 'GENIE_EVENTS_TOKEN required but not provided'));
    process.exit(2);
  }
  return null;
}

function resolvePrefixes(options: StreamFollowOptions, tokenPayload: TokenPayload | null): string[] {
  const baseprefixes = options.kind ? [options.kind] : [...DEFAULT_CHANNEL_PREFIXES];
  const tokenPrefixes = tokenPayload
    ? tokenPayload.allowed_channels.map((c) => c.replace(/^genie_events\./, ''))
    : null;
  const prefixesToListen = tokenPrefixes ? baseprefixes.filter((p) => tokenPrefixes.includes(p)) : baseprefixes;
  if (tokenPrefixes && prefixesToListen.length === 0) {
    console.error(
      color(
        'red',
        `token allow-list ${JSON.stringify(tokenPrefixes)} does not intersect requested prefix(es) ${JSON.stringify(baseprefixes)}`,
      ),
    );
    process.exit(2);
  }
  return prefixesToListen;
}

function emitGapEvent(consumerId: string, fromId: number, toId: number): void {
  try {
    emitEvent(
      'stream.gap.detected',
      {
        consumer_id: consumerId,
        from_id: fromId,
        to_id: toId,
        missing_count: toId - fromId + 1,
      },
      { severity: 'warn', source_subsystem: 'consumer-stream' },
    );
  } catch {
    // Best-effort — never block stream on emit failure.
  }
}

function isTypeAllowed(tokenPayload: TokenPayload | null, subject: string | null | undefined): boolean {
  if (!tokenPayload) return true;
  const allowed = tokenPayload.allowed_types;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.includes(subject ?? '');
}

function persistCursor(consumerId: string, lastSeenId: number, options: StreamFollowOptions): void {
  try {
    saveConsumerState({
      consumer_id: consumerId,
      last_seen_id: lastSeenId,
      updated_at: new Date().toISOString(),
      filters: { kind: options.kind, severity: options.severity, since: options.since },
    });
  } catch {
    // Best-effort cursor persistence.
  }
}

interface DrainContext {
  options: StreamFollowOptions;
  consumerId: string;
  tokenPayload: TokenPayload | null;
  onEvent: (row: V2EventRow) => void;
  getLastSeenId: () => number;
  setLastSeenId: (id: number) => void;
  incrementDelivered: () => number;
  isActive: () => boolean;
  deactivate: () => void;
}

async function drainOnce(ctx: DrainContext): Promise<void> {
  if (!ctx.isActive()) return;
  const startId = ctx.getLastSeenId();
  const batch = await queryV2Batch({
    afterId: startId,
    kindPrefix: ctx.options.kind,
    severity: ctx.options.severity,
    since: ctx.options.since,
    limit: 500,
  });
  for (const row of batch) {
    const prev = ctx.getLastSeenId();
    if (row.id > prev + 1 && prev > 0) {
      emitGapEvent(ctx.consumerId, prev + 1, row.id - 1);
    }
    ctx.setLastSeenId(row.id);

    if (!isTypeAllowed(ctx.tokenPayload, row.subject)) continue;

    try {
      ctx.onEvent(row);
      const delivered = ctx.incrementDelivered();
      if (ctx.options.maxEvents && delivered >= ctx.options.maxEvents) {
        ctx.deactivate();
        break;
      }
    } catch {
      // Consumer handlers must not tear down the stream.
    }
  }
  if (batch.length > 0) persistCursor(ctx.consumerId, ctx.getLastSeenId(), ctx.options);
}

/**
 * Run the follow-stream loop. Returns a handle the caller can stop; a CLI
 * wrapper attaches SIGINT/SIGTERM to it.
 */
export async function runEventsStreamFollow(
  options: StreamFollowOptions,
  onEvent: (row: V2EventRow) => void,
): Promise<StreamFollowHandle> {
  const { getConnection } = await import('../lib/db.js');
  const sql = await getConnection();

  const tokenPayload = await resolveTokenPayload(options);
  const consumerId = options.consumerId ?? tokenPayload?.subscriber_id ?? generateConsumerId('stream');
  const restored = loadConsumerState(consumerId);
  let lastSeenId = restored?.last_seen_id ?? (await getLatestEventId());
  let eventsDelivered = 0;
  let active = true;
  let drainChain: Promise<void> = Promise.resolve();

  const prefixesToListen = resolvePrefixes(options, tokenPayload);

  const ctx: DrainContext = {
    options,
    consumerId,
    tokenPayload,
    onEvent,
    getLastSeenId: () => lastSeenId,
    setLastSeenId: (id) => {
      lastSeenId = id;
    },
    incrementDelivered: () => ++eventsDelivered,
    isActive: () => active,
    deactivate: () => {
      active = false;
    },
  };

  const queueDrain = () => {
    drainChain = drainChain.then(() => drainOnce(ctx)).catch(() => {});
  };

  const listeners: Array<{ unlisten: () => Promise<void> }> = [];
  for (const prefix of prefixesToListen) {
    const channel = `genie_events.${prefix}`;
    try {
      const listener = await sql.listen(channel, () => {
        queueDrain();
      });
      listeners.push(listener);
    } catch {
      // Some channels may not exist yet — best-effort registration.
    }
  }

  const pollTimer = setInterval(queueDrain, 2000);

  const heartbeatMs = options.heartbeatIntervalMs ?? 30_000;
  const heartbeatTimer = setInterval(() => {
    try {
      emitEvent(
        'consumer.heartbeat',
        {
          consumer_id: consumerId,
          last_event_id_processed: lastSeenId,
          backlog_depth: 0,
        },
        { severity: 'debug', source_subsystem: 'consumer-stream' },
      );
    } catch {}
  }, heartbeatMs);

  queueDrain();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  if (options.idleExitMs) {
    idleTimer = setTimeout(() => {
      active = false;
    }, options.idleExitMs);
  }

  return {
    stop: async () => {
      active = false;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      if (idleTimer) clearTimeout(idleTimer);
      try {
        await drainChain;
      } catch {}
      for (const l of listeners) {
        try {
          await l.unlisten();
        } catch {}
      }
      persistCursor(consumerId, lastSeenId, options);
    },
    getLastSeenId: () => lastSeenId,
    getEventsDelivered: () => eventsDelivered,
  };
}

// ---------------------------------------------------------------------------
// CLI formatting
// ---------------------------------------------------------------------------

function formatRowPretty(row: V2EventRow): string {
  const ts = new Date(row.created_at).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const subject = row.subject ?? row.text ?? 'unknown';
  const severity = row.severity ?? '-';
  const sevColor =
    severity === 'error' || severity === 'fatal'
      ? color('red', severity)
      : severity === 'warn'
        ? color('yellow', severity)
        : severity === 'debug'
          ? color('dim', severity)
          : color('cyan', severity);
  const trace = row.trace_id ? color('dim', ` trace=${row.trace_id.slice(0, 8)}`) : '';
  const duration = row.duration_ms != null ? ` ${color('dim', `${row.duration_ms}ms`)}` : '';
  return `${color('dim', ts)}  ${sevColor.padEnd(5)}  ${color('brightCyan', subject)}${duration}${trace}`;
}

function printRow(row: V2EventRow, json: boolean | undefined): void {
  console.log(json ? JSON.stringify(row) : formatRowPretty(row));
}

async function runStreamOnce(options: StreamFollowOptions): Promise<void> {
  const latest = await getLatestEventId();
  const batch = await queryV2Batch({
    afterId: Math.max(0, latest - 100),
    kindPrefix: options.kind,
    severity: options.severity,
    since: options.since,
    limit: 500,
  });
  for (const row of batch) printRow(row, options.json);
}

function printStreamHeader(options: StreamFollowOptions): void {
  if (options.json) return;
  const filterDesc: string[] = [];
  if (options.kind) filterDesc.push(`kind=${options.kind}`);
  if (options.severity) filterDesc.push(`severity=${options.severity}`);
  if (options.since) filterDesc.push(`since=${options.since}`);
  const suffix = filterDesc.length > 0 ? ` [${filterDesc.join(', ')}]` : '';
  console.log(color('dim', `Streaming genie_runtime_events${suffix} (Ctrl+C to stop)...`));
}

/**
 * Run the stream command as invoked from the CLI — wires stdout + signal
 * handling around `runEventsStreamFollow`.
 */
export async function streamCommand(options: StreamFollowOptions): Promise<void> {
  if (!options.follow) {
    // Without --follow: single drain, exit — no long-running process.
    await runStreamOnce(options);
    return;
  }

  printStreamHeader(options);

  const handle = await runEventsStreamFollow(options, (row) => printRow(row, options.json));

  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Keep the process alive indefinitely; the handle pumps events until stopped.
  await new Promise(() => {});
}
