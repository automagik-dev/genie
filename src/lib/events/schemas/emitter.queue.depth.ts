/**
 * Watcher meta: emitter.queue.depth — periodic (every 10s) snapshot of the
 * in-process emit queue depth + capacity. Exposes bounded-queue pressure so
 * dashboards can alert before the cap is hit.
 */

import { z } from 'zod';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'emitter.queue.depth' as const;
export const KIND = 'event' as const;

const DepthSchema = tagTier(z.number().int().min(0).max(10_000_000), 'C');
const CapSchema = tagTier(z.number().int().min(1).max(10_000_000), 'C');
const UtilizationSchema = tagTier(z.number().min(0).max(1), 'C');

export const schema = z
  .object({
    depth: DepthSchema,
    cap: CapSchema,
    utilization: UtilizationSchema,
    enqueued_total: tagTier(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), 'C'),
    flushed_total: tagTier(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), 'C'),
  })
  .strict();

export type EmitterQueueDepthPayload = z.infer<typeof schema>;
