/**
 * Span: agent.lifecycle — one agent session (spawn → stop/kill).
 *
 * `startSpan('agent.lifecycle', {agent_id, executor})` at spawn,
 * `endSpan(handle, {exit_reason, duration_ms})` on stop/kill/idle-suspend.
 */

import { z } from 'zod';
import { hashEntity, tokenizePath } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'agent.lifecycle' as const;
export const KIND = 'span' as const;

const AgentIdSchema = tagTier(z.string().min(1).max(256), 'B', 'agent name — public');
const TeamSchema = tagTier(z.string().min(1).max(256).optional(), 'B');
const ExecutorSchema = tagTier(z.enum(['claude-code', 'claude-sdk', 'codex', 'shell']), 'C');
const SessionIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(128)
    .transform((v) => hashEntity('session', v)),
  'A',
  'session id hashed',
);
const CwdSchema = tagTier(z.string().max(1024).transform(tokenizePath), 'B');
const ExitReasonSchema = tagTier(z.enum(['stopped', 'killed', 'crashed', 'idle-suspend', 'completed']), 'C');
const DurationSchema = tagTier(z.number().int().min(0), 'C', 'ms');

export const schema = z
  .object({
    agent_id: AgentIdSchema,
    team: TeamSchema,
    executor: ExecutorSchema,
    session_id: SessionIdSchema.optional(),
    cwd: CwdSchema.optional(),
    exit_reason: ExitReasonSchema.optional(),
    duration_ms: DurationSchema.optional(),
  })
  .strict();

export type AgentLifecyclePayload = z.infer<typeof schema>;
