/**
 * Feature flag scaffold for genie-serve-structured-observability (Group 1).
 *
 * `GENIE_WIDE_EMIT` gates the dual-write path introduced by Group 3:
 *   - OFF (default): legacy writers (`publishRuntimeEvent`, `recordAuditEvent`)
 *     run alone. Zero behavioral change.
 *   - ON: legacy writers keep running AND the new `src/lib/emit.ts` primitive
 *     emits enriched rows. Phase 2+ of the rollout (see
 *     docs/observability-rollout.md).
 *
 * Phase 0 (this wish) wires only the flag read + documentation. Wave 3 flips
 * the default after 14 days of green watcher-of-watcher metrics.
 */

export type ObservabilityFlagState = 'off' | 'on';

/**
 * Returns the current dual-write flag state. Accepts `1`, `true`, `on`, `yes`
 * (case-insensitive) as truthy; anything else (including unset) is 'off'.
 */
export function readWideEmitFlag(env: NodeJS.ProcessEnv = process.env): ObservabilityFlagState {
  const raw = env.GENIE_WIDE_EMIT;
  if (raw === undefined || raw === null) return 'off';
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') {
    return 'on';
  }
  return 'off';
}

/**
 * Boolean shortcut for the hot path. Computed fresh on each call so operators
 * can flip the flag without restarting long-running daemons.
 */
export function isWideEmitEnabled(env?: NodeJS.ProcessEnv): boolean {
  return readWideEmitFlag(env) === 'on';
}
