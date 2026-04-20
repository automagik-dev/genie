/**
 * Event: cache.invalidate — a named cache was cleared or bucket-evicted.
 */

import { z } from 'zod';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'cache.invalidate' as const;
export const KIND = 'event' as const;

const CacheSchema = tagTier(z.string().min(1).max(128), 'C', 'cache name — public');
const KeysInvalidatedSchema = tagTier(z.number().int().min(0).max(10_000_000), 'C');
const ReasonSchema = tagTier(z.enum(['ttl', 'manual', 'capacity', 'rotation', 'upstream_change']).optional(), 'C');
const ScopeSchema = tagTier(z.enum(['key', 'bucket', 'all']).optional(), 'C');

export const schema = z
  .object({
    cache: CacheSchema,
    keys_invalidated: KeysInvalidatedSchema,
    reason: ReasonSchema,
    scope: ScopeSchema,
  })
  .strict();

export type CacheInvalidatePayload = z.infer<typeof schema>;
