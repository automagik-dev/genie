/**
 * Span: resume.attempt — one attempt to resume a suspended/idle-killed agent.
 *
 * Opened by the resume orchestrator and closed after the strategy completes,
 * carrying the session resolution outcome for forensic replay.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'resume.attempt' as const;
export const KIND = 'span' as const;

const AgentIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('agent', v)),
  'A',
);
const AttemptNumberSchema = tagTier(z.number().int().min(1).max(16), 'C');
const StrategySchema = tagTier(z.enum(['tmux-attach', 'claude-resume-session', 'cold-start', 'session-backfill']), 'C');
const SessionIdSchema = tagTier(
  z
    .string()
    .max(128)
    .transform((v) => hashEntity('session', v))
    .optional(),
  'A',
);
const SucceededSchema = tagTier(z.boolean().optional(), 'C');
const FailureReasonSchema = tagTier(
  z
    .string()
    .max(512)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
);
const DurationSchema = tagTier(z.number().int().min(0).max(300_000).optional(), 'C', 'ms');

export const schema = z
  .object({
    agent_id: AgentIdSchema,
    attempt_number: AttemptNumberSchema,
    strategy: StrategySchema,
    session_id: SessionIdSchema,
    succeeded: SucceededSchema,
    failure_reason: FailureReasonSchema,
    duration_ms: DurationSchema,
  })
  .strict();

export type ResumeAttemptPayload = z.infer<typeof schema>;
