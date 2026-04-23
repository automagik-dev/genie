/**
 * Watcher meta: correlation.orphan.rate — percentage of emitted events whose
 * parent_span_id fails to match a parent span within a 60s look-back window.
 *
 * Computed over a rolling window of the last 1000 events by the emitter.
 * A sustained orphan rate >1% is the canary that trace propagation is broken.
 */

import { z } from 'zod';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'correlation.orphan.rate' as const;
export const KIND = 'event' as const;

const RateSchema = tagTier(z.number().min(0).max(1), 'C');
const CountSchema = tagTier(z.number().int().min(0).max(10_000_000), 'C');

export const schema = z
  .object({
    window_samples: CountSchema,
    orphans: CountSchema,
    rate: RateSchema,
  })
  .strict();

export type CorrelationOrphanRatePayload = z.infer<typeof schema>;
