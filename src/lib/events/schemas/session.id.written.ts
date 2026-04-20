/**
 * Event: session.id.written — an agent wrote a fresh session id to PG.
 *
 * Fires inside the PG write wrapper. `before`/`after` carry the session-id
 * diff, enabling reconstruction of every session reassignment from the log.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'session.id.written' as const;
export const KIND = 'event' as const;

const AgentIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('agent', v)),
  'A',
);
const SessionIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('session', v)),
  'A',
);
const ExecutorSchema = tagTier(z.enum(['claude-code', 'claude-sdk', 'codex', 'shell']), 'C');
const OriginSchema = tagTier(z.enum(['spawn', 'resume', 'backfill', 'reconcile']), 'C');

const DiffSchema = tagTier(
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  'B',
  'shallow scalar diff — session_id hashed before arriving here',
);

export const schema = z
  .object({
    agent_id: AgentIdSchema,
    session_id: SessionIdSchema,
    executor: ExecutorSchema,
    origin: OriginSchema,
    before: DiffSchema,
    after: DiffSchema,
  })
  .strict();

export type SessionIdWrittenPayload = z.infer<typeof schema>;
