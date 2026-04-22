/**
 * Event: agent.resume.failed — fired when a resume attempt exits without
 * succeeding (spawn returned false, pane refused to take over, or the CLI
 * handler threw). `state_after` typically equals `state_before` — the thrash
 * detector signal — unless the scheduler moved the row to `error` after the
 * retry budget is exhausted.
 *
 * `last_error` carries a truncated (<=500 chars) operator-readable excerpt of
 * the failure reason so a forensic query can surface the root cause without
 * chasing log files.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'agent.resume.failed' as const;
export const KIND = 'event' as const;

const AGENT_STATES = [
  'spawning',
  'working',
  'idle',
  'permission',
  'question',
  'done',
  'error',
  'suspended',
  'unknown',
] as const;

const EntityIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('agent', v)),
  'A',
  'agent id hashed',
);
const AttemptNumberSchema = tagTier(z.number().int().min(1).max(64), 'C');
const StateSchema = tagTier(z.enum(AGENT_STATES), 'C');
const LastErrorSchema = tagTier(
  z
    .string()
    .max(500)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
  'truncated to 500 chars',
);
const TriggerSchema = tagTier(z.enum(['scheduler', 'manual', 'boot']), 'C');
const ExhaustedSchema = tagTier(z.boolean(), 'C');

export const schema = z
  .object({
    entity_id: EntityIdSchema,
    attempt_number: AttemptNumberSchema,
    state_before: StateSchema,
    state_after: StateSchema,
    last_error: LastErrorSchema,
    trigger: TriggerSchema,
    exhausted: ExhaustedSchema,
  })
  .strict();

export type AgentResumeFailedPayload = z.infer<typeof schema>;
