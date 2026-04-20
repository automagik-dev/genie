/**
 * Audit event: emit.backpressure.critical — raised when warn+ spill has been
 * active for longer than the critical threshold (30s). Watchdog subscribes
 * to this event specifically so it can page even if PG itself is recovering.
 */

import { z } from 'zod';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'emit.backpressure.critical' as const;
export const KIND = 'event' as const;
export const DEFAULT_TIER = 'audit' as const;

const SecondsSchema = tagTier(z.number().min(0).max(86_400), 'C');
const CountSchema = tagTier(z.number().int().min(0).max(10_000_000), 'C');

export const schema = z
  .object({
    spill_duration_seconds: SecondsSchema,
    spill_rows_total: CountSchema,
    queue_depth: CountSchema,
    queue_cap: CountSchema,
    recommended_action: tagTier(z.enum(['scale_consumers', 'inspect_pg', 'restart_bridge']).optional(), 'C'),
  })
  .strict();

export type EmitBackpressureCriticalPayload = z.infer<typeof schema>;
