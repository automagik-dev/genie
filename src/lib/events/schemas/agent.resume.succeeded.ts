/**
 * Event: agent.resume.succeeded — fired after `deps.resumeAgent` returns true
 * (a successful respawn + pane takeover) and the `resumeAttempts` counter
 * has been reset.
 *
 * Carries the same shape as `agent.resume.attempted` so consumers can join
 * attempts to outcomes without branching on event type.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'agent.resume.succeeded' as const;
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

export const schema = z
  .object({
    entity_id: EntityIdSchema,
    attempt_number: AttemptNumberSchema,
    state_before: StateSchema,
    state_after: StateSchema,
    last_error: LastErrorSchema,
    trigger: TriggerSchema,
  })
  .strict();

export type AgentResumeSucceededPayload = z.infer<typeof schema>;
