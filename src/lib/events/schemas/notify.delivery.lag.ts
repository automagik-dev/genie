/**
 * Watcher meta: notify.delivery.lag — round-trip latency of a LISTEN/NOTIFY
 * probe. The emitter fires a marker with a fresh nonce, the consumer echoes
 * it back, and we record how long NOTIFY propagation took.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'notify.delivery.lag' as const;
export const KIND = 'event' as const;

const NonceSchema = tagTier(
  z
    .string()
    .min(1)
    .max(128)
    .transform((v) => hashEntity('notify-probe', v)),
  'A',
);
const LagMillisSchema = tagTier(z.number().min(0).max(300_000), 'C');
const ChannelSchema = tagTier(z.string().min(1).max(128), 'C');

export const schema = z
  .object({
    channel: ChannelSchema,
    probe_id: NonceSchema,
    lag_ms: LagMillisSchema,
    timed_out: tagTier(z.boolean(), 'C'),
  })
  .strict();

export type NotifyDeliveryLagPayload = z.infer<typeof schema>;
