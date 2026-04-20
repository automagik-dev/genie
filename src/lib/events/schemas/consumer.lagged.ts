/**
 * Audit event: consumer.lagged — fired when warn+ severity events have to be
 * spilled to disk because downstream consumers (or PG itself) cannot keep up.
 *
 * Lands in the audit tier so operators have a durable record of every
 * moment the stream went from normal to spill mode, even after retention
 * sweeps the main table.
 */

import { z } from 'zod';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'consumer.lagged' as const;
export const KIND = 'event' as const;
export const DEFAULT_TIER = 'audit' as const;

const CountSchema = tagTier(z.number().int().min(0).max(10_000_000), 'C');
const SpillPathSchema = tagTier(z.string().max(512), 'B');
const SeveritySchema = tagTier(z.enum(['warn', 'error', 'fatal']), 'C');

export const schema = z
  .object({
    severity_class: SeveritySchema,
    spill_path: SpillPathSchema,
    rows_spilled: CountSchema,
    queue_depth: CountSchema,
    queue_cap: CountSchema,
  })
  .strict();

export type ConsumerLaggedPayload = z.infer<typeof schema>;
