/**
 * Watcher meta: stream.gap.detected — a consumer observed an id skip of >1
 * between fetched events. Originally emitted from the consumer loop in
 * events-stream.ts (Group 4); registered here so the registry is authoritative
 * and the CI lint can enforce tier tagging.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'stream.gap.detected' as const;
export const KIND = 'event' as const;

const ConsumerIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('consumer', v)),
  'A',
);
const IdSchema = tagTier(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), 'C');
const CountSchema = tagTier(z.number().int().min(1).max(10_000_000), 'C');

export const schema = z
  .object({
    consumer_id: ConsumerIdSchema,
    from_id: IdSchema,
    to_id: IdSchema,
    missing_count: CountSchema,
  })
  .strict();

export type StreamGapDetectedPayload = z.infer<typeof schema>;
