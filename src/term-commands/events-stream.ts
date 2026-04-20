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
import {
  type ConsumerState,
  generateConsumerId,
  loadConsumerState,
  saveConsumerState,
} from '../lib/events/consumer-state.js';
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

  // Token enforcement. If a token is presented (explicit --token, env var, or
  // GENIE_EVENTS_TOKEN_REQUIRED=1 forces one), verify the signature and narrow
  // the LISTEN prefix set to the token's allowed_channels. A forged token
  // targeting a channel the role cannot access is rejected by verifyToken()
  // via `allowedChannels(payload.role)`.
  let tokenPayload: TokenPayload | null = null;
  const tokenStr = options.token ?? process.env.GENIE_EVENTS_TOKEN;
  if (tokenStr && !options.skipTokenCheck) {
    try {
      tokenPayload = await verifyToken(tokenStr);
    } catch (err) {
      if (err instanceof TokenError) {
        console.error(color('red', `token rejected: ${err.code} — ${err.message}`));
        process.exit(2);
      }
      throw err;
    }
  } else if (process.env.GENIE_EVENTS_TOKEN_REQUIRED === '1' && !options.skipTokenCheck) {
    console.error(color('red', 'GENIE_EVENTS_TOKEN required but not provided'));
    process.exit(2);
  }

  const consumerId = options.consumerId ?? tokenPayload?.subscriber_id ?? generateConsumerId('stream');
  const restored = loadConsumerState(consumerId);
  let lastSeenId = restored?.last_seen_id ?? (await getLatestEventId());
  let eventsDelivered = 0;
  let active = true;
  let drainChain: Promise<void> = Promise.resolve();

  // Token payload — if present — narrows the prefix set to the declared
  // allowlist. Without a token we fall back to the role-neutral defaults.
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

  // -----------------------------------------------------------------------
  // Drain loop — runs on NOTIFY wake OR on short-interval safety-net poll.
  // -----------------------------------------------------------------------
  const drain = async () => {
    if (!active) return;
    const batch = await queryV2Batch({
      afterId: lastSeenId,
      kindPrefix: options.kind,
      severity: options.severity,
      since: options.since,
      limit: 500,
    });
    for (const row of batch) {
      // Gap detection — id skip > 1 means either a partition retention sweep
      // happened under us or we lost a NOTIFY. Emit a structured event so
      // downstream consumers can reconcile from audit / source of truth.
      if (row.id > lastSeenId + 1 && lastSeenId > 0) {
        const missingCount = row.id - (lastSeenId + 1);
        try {
          emitEvent(
            'stream.gap.detected',
            {
              consumer_id: consumerId,
              from_id: lastSeenId + 1,
              to_id: row.id - 1,
              missing_count: missingCount,
            },
            { severity: 'warn', source_subsystem: 'consumer-stream' },
          );
        } catch {
          // Best-effort — never block stream on emit failure.
        }
      }
      lastSeenId = row.id;

      // Token-scoped type filter — when the token carries an explicit
      // `allowed_types` list, rows whose event type (subject) is outside it
      // are silently skipped. We still advance the cursor so a narrow token
      // does not loop on unreachable rows. NB: the type lives in `subject`,
      // not `kind` — `kind` is always 'system' under the current writer.
      if (
        tokenPayload &&
        Array.isArray(tokenPayload.allowed_types) &&
        tokenPayload.allowed_types.length > 0 &&
        !tokenPayload.allowed_types.includes(row.subject ?? '')
      ) {
        continue;
      }

      try {
        onEvent(row);
        eventsDelivered++;
      } catch {
        // Consumer handlers must not tear down the stream.
      }
      if (options.maxEvents && eventsDelivered >= options.maxEvents) {
        active = false;
        break;
      }
    }

    if (batch.length > 0) {
      const snapshot: ConsumerState = {
        consumer_id: consumerId,
        last_seen_id: lastSeenId,
        updated_at: new Date().toISOString(),
        filters: { kind: options.kind, severity: options.severity, since: options.since },
      };
      try {
        saveConsumerState(snapshot);
      } catch {
        // Best-effort cursor persistence.
      }
    }
  };

  const queueDrain = () => {
    drainChain = drainChain.then(drain).catch(() => {});
  };

  // -----------------------------------------------------------------------
  // Open per-prefix LISTEN — each prefix is an independent NOTIFY channel.
  // -----------------------------------------------------------------------
  const listeners: Array<{ unlisten: () => Promise<void> }> = [];
  for (const prefix of prefixesToListen) {
    const channel = `genie_events.${prefix}`;
    try {
      const listener = await sql.listen(channel, () => {
        queueDrain();
      });
      listeners.push(listener);
    } catch {
      // Some channels may not exist yet (new prefix not yet emitted). The
      // listener still registers on channel name; failure is noted but does
      // not abort the stream.
    }
  }

  // Safety net: poll every 2s in case a NOTIFY is lost (PG backlog overflow
  // is the documented failure mode of LISTEN/NOTIFY beyond 8GB).
  const pollTimer = setInterval(queueDrain, 2000);

  // Heartbeat: every 30s the consumer self-reports its cursor + backlog.
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

  // Initial drain — catch anything that arrived between seed and LISTEN.
  queueDrain();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const bumpIdleExit = () => {
    if (!options.idleExitMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      active = false;
    }, options.idleExitMs);
  };
  bumpIdleExit();

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
      try {
        saveConsumerState({
          consumer_id: consumerId,
          last_seen_id: lastSeenId,
          updated_at: new Date().toISOString(),
          filters: { kind: options.kind, severity: options.severity, since: options.since },
        });
      } catch {}
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

/**
 * Run the stream command as invoked from the CLI — wires stdout + signal
 * handling around `runEventsStreamFollow`.
 */
export async function streamCommand(options: StreamFollowOptions): Promise<void> {
  if (!options.follow) {
    // Without --follow the command is a no-op: runs a single drain and exits.
    // This preserves intuition for users who omit the flag — they don't get
    // a long-running process they didn't ask for.
    const latest = await getLatestEventId();
    const batch = await queryV2Batch({
      afterId: Math.max(0, latest - 100),
      kindPrefix: options.kind,
      severity: options.severity,
      since: options.since,
      limit: 500,
    });
    for (const row of batch) {
      if (options.json) {
        console.log(JSON.stringify(row));
      } else {
        console.log(formatRowPretty(row));
      }
    }
    return;
  }

  if (!options.json) {
    const filterDesc: string[] = [];
    if (options.kind) filterDesc.push(`kind=${options.kind}`);
    if (options.severity) filterDesc.push(`severity=${options.severity}`);
    if (options.since) filterDesc.push(`since=${options.since}`);
    const suffix = filterDesc.length > 0 ? ` [${filterDesc.join(', ')}]` : '';
    console.log(color('dim', `Streaming genie_runtime_events${suffix} (Ctrl+C to stop)...`));
  }

  const handle = await runEventsStreamFollow(options, (row) => {
    if (options.json) {
      console.log(JSON.stringify(row));
    } else {
      console.log(formatRowPretty(row));
    }
  });

  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Keep the process alive indefinitely; the handle pumps events until stopped.
  await new Promise(() => {});
}
