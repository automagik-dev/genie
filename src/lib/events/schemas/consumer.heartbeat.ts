/**
 * Event: consumer.heartbeat — emitted every 30s by each active consumer.
 *
 * Watchdog + Group 6 `stream.gap.detected` watcher use the heartbeat to tell
 * a silent consumer apart from one with a stuck listener.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'consumer.heartbeat' as const;
export const KIND = 'event' as const;

const ConsumerIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('consumer', v)),
  'A',
);
const LastEventIdSchema = tagTier(z.number().int().min(0).max(9_007_199_254_740_991), 'C');
const BacklogDepthSchema = tagTier(z.number().int().min(0).max(10_000_000), 'C');
const RoleSchema = tagTier(z.enum(['admin', 'operator', 'subscriber', 'audit']).optional(), 'C');
const UptimeSecondsSchema = tagTier(z.number().int().min(0).max(31_536_000).optional(), 'C');

export const schema = z
  .object({
    consumer_id: ConsumerIdSchema,
    last_event_id_processed: LastEventIdSchema,
    backlog_depth: BacklogDepthSchema,
    role: RoleSchema,
    uptime_seconds: UptimeSecondsSchema,
  })
  .strict();

export type ConsumerHeartbeatPayload = z.infer<typeof schema>;
