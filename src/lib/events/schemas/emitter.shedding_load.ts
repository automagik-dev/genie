/**
 * Back-pressure meta: emitter.shedding_load — aggregate count of events
 * dropped or spilled in the last minute. Summary is 1/min cadence regardless
 * of drop volume so this never amplifies load when the queue is saturated.
 */

import { z } from 'zod';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'emitter.shedding_load' as const;
export const KIND = 'event' as const;

const CountSchema = tagTier(z.number().int().min(0).max(10_000_000), 'C');

export const schema = z
  .object({
    dropped_debug: CountSchema,
    dropped_info: CountSchema,
    spilled_warn_plus: CountSchema,
    window_seconds: tagTier(z.number().int().min(1).max(3_600), 'C'),
  })
  .strict();

export type EmitterSheddingLoadPayload = z.infer<typeof schema>;
