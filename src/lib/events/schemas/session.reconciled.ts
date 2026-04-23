/**
 * Event: session.reconciled — an agent's session mapping was reconciled
 * against on-disk transcripts (Claude/Codex log discovery).
 *
 * `before`/`after` carry the session-id diff. Enables #1192-style recursion
 * detection by matching old vs new session id churn per agent.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'session.reconciled' as const;
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
    .max(256)
    .transform((v) => hashEntity('session', v)),
  'A',
);
const ReasonSchema = tagTier(
  z.enum(['transcript-discovered', 'stale-pg-session', 'idle-timeout', 'manual', 'backfill']),
  'C',
);
const DiffSchema = tagTier(
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  'B',
);

export const schema = z
  .object({
    agent_id: AgentIdSchema,
    old_session_id: SessionIdSchema.optional(),
    new_session_id: SessionIdSchema,
    reason: ReasonSchema,
    before: DiffSchema,
    after: DiffSchema,
  })
  .strict();

export type SessionReconciledPayload = z.infer<typeof schema>;
