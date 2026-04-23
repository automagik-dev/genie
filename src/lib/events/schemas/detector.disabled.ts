/**
 * Event: detector.disabled — a detector exceeded its hourly fire_budget and
 * self-disabled for the remainder of the bucket.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 2 / Phase 0).
 *
 * Emitted by `src/serve/detector-scheduler.ts` when a detector's fire count
 * in the current hour bucket meets or exceeds its configured budget. The
 * detector is silenced for the rest of the bucket; the next hour bucket
 * resets the counter. No permanent disable.
 */

import { z } from 'zod';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'detector.disabled' as const;
export const KIND = 'event' as const;

const DetectorIdSchema = tagTier(z.string().min(1).max(128), 'C');
const CauseSchema = tagTier(z.literal('fire_budget_exceeded'), 'C');
const BudgetSchema = tagTier(z.number().int().min(1).max(1_000_000), 'C', 'events per hour bucket');
const FireCountSchema = tagTier(z.number().int().min(0).max(1_000_000), 'C', 'fires observed in this bucket');
const BucketEndTsSchema = tagTier(
  z.string().datetime({ offset: true }),
  'C',
  'ISO-8601 timestamp when the current hour bucket expires',
);

export const schema = z
  .object({
    detector_id: DetectorIdSchema,
    cause: CauseSchema,
    budget: BudgetSchema,
    fire_count: FireCountSchema,
    bucket_end_ts: BucketEndTsSchema,
  })
  .strict();

export type DetectorDisabledPayload = z.infer<typeof schema>;
