/**
 * Event: cache.hit — a cache lookup completed (hit or miss).
 *
 * `key_hint` is a tokenized/redacted preview only; never the raw key.
 */

import { z } from 'zod';
import { redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'cache.hit' as const;
export const KIND = 'event' as const;

const CacheSchema = tagTier(z.string().min(1).max(128), 'C');
const HitSchema = tagTier(z.boolean(), 'C');
const KeyHintSchema = tagTier(
  z
    .string()
    .max(128)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
);
const LatencyUsSchema = tagTier(z.number().int().min(0).max(10_000_000).optional(), 'C', 'microseconds');

export const schema = z
  .object({
    cache: CacheSchema,
    hit: HitSchema,
    key_hint: KeyHintSchema,
    latency_us: LatencyUsSchema,
  })
  .strict();

export type CacheHitPayload = z.infer<typeof schema>;
