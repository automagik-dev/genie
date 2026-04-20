/**
 * Watcher meta: emitter.rejected — emitted when a payload fails Zod parse
 * or otherwise gets rejected by emit.ts before reaching the queue.
 *
 * Group 6 watcher-of-watcher metric #1. Also see schema.violation for the
 * per-issue detail; this event is the aggregate count over a time window so
 * dashboards can track the rate without summing individual violations.
 */

import { z } from 'zod';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'emitter.rejected' as const;
export const KIND = 'event' as const;

const OffendingTypeSchema = tagTier(z.string().min(1).max(128), 'C');
const ReasonSchema = tagTier(
  z.enum(['schema_parse', 'unregistered', 'kind_mismatch', 'overflow_cap', 'queue_full']),
  'C',
);
const CountSchema = tagTier(z.number().int().min(1).max(10_000_000), 'C');

export const schema = z
  .object({
    offending_type: OffendingTypeSchema,
    reason: ReasonSchema,
    count: CountSchema,
  })
  .strict();

export type EmitterRejectedPayload = z.infer<typeof schema>;
