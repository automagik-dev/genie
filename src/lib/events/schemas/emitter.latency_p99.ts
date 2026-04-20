/**
 * Watcher meta: emitter.latency_p99 — rolling p99 of emit-site latency over
 * the last 1000 emit calls. Fired whenever the window rolls over (every 1000
 * emits) so dashboards have a regular cadence without periodic probes.
 */

import { z } from 'zod';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'emitter.latency_p99' as const;
export const KIND = 'event' as const;

const MillisSchema = tagTier(z.number().min(0).max(600_000), 'C');
const SampleCountSchema = tagTier(z.number().int().min(1).max(1_000_000), 'C');

export const schema = z
  .object({
    window_samples: SampleCountSchema,
    p50_ms: MillisSchema,
    p95_ms: MillisSchema,
    p99_ms: MillisSchema,
    max_ms: MillisSchema,
  })
  .strict();

export type EmitterLatencyP99Payload = z.infer<typeof schema>;
