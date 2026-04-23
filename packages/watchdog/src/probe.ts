/**
 * Probe the genie observability stream for silence.
 *
 * A successful probe means:
 *   - PG was reachable, AND
 *   - the most recent row in `genie_runtime_events` is newer than the
 *     configured staleness threshold (default 300s).
 *
 * Otherwise the result is a failure; `runProbe` returns the structured reason
 * and the caller (`cli.ts`) routes to `dispatchAlert`.
 */

import postgres from 'postgres';

export type { WatchdogConfig } from './config.ts';
import type { WatchdogConfig } from './config.ts';

export interface ProbeResult {
  readonly ok: boolean;
  readonly stale_seconds: number | null;
  readonly reason: 'ok' | 'pg_unreachable' | 'stream_stale' | 'empty_stream';
  readonly detail?: string;
  readonly probed_at: string;
}

export async function runProbe(config: WatchdogConfig): Promise<ProbeResult> {
  const probed_at = new Date().toISOString();
  const sql = postgres(config.pg.dsn, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
  });
  try {
    const rows = await sql<{ stale_seconds: number | null }[]>`
      SELECT extract(epoch from (now() - max(created_at)))::float AS stale_seconds
        FROM genie_runtime_events
    `;
    const stale = rows[0]?.stale_seconds ?? null;
    if (stale === null) {
      return { ok: false, stale_seconds: null, reason: 'empty_stream', probed_at };
    }
    if (stale > config.staleness_seconds) {
      return {
        ok: false,
        stale_seconds: stale,
        reason: 'stream_stale',
        detail: `last event ${Math.round(stale)}s ago (threshold ${config.staleness_seconds}s)`,
        probed_at,
      };
    }
    return { ok: true, stale_seconds: stale, reason: 'ok', probed_at };
  } catch (err) {
    return {
      ok: false,
      stale_seconds: null,
      reason: 'pg_unreachable',
      detail: err instanceof Error ? err.message : String(err),
      probed_at,
    };
  } finally {
    try {
      await sql.end({ timeout: 2 });
    } catch {
      // nothing to clean up
    }
  }
}
