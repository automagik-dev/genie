/**
 * Span: hook.delivery — one git/shell hook dispatch.
 *
 * Opened when the hook dispatcher receives a trigger and closed after the
 * handler returns (or the 15s hard timeout trips).
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'hook.delivery' as const;
export const KIND = 'span' as const;

const HookNameSchema = tagTier(z.string().min(1).max(128), 'C', 'hook name — public');
const AgentIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('agent', v)),
  'A',
);
const ToolSchema = tagTier(z.string().max(128).optional(), 'C');
const StatusSchema = tagTier(z.enum(['ok', 'timeout', 'rejected', 'error']).optional(), 'C');
const DurationSchema = tagTier(z.number().int().min(0).max(60_000).optional(), 'C', 'ms (<=15s timeout)');
const ExitCodeSchema = tagTier(z.number().int().min(-1).max(255).optional(), 'C');
const StderrExcerptSchema = tagTier(
  z
    .string()
    .max(4096)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
  'redacted stderr excerpt',
);

export const schema = z
  .object({
    hook_name: HookNameSchema,
    agent_id: AgentIdSchema,
    tool: ToolSchema,
    status: StatusSchema,
    duration_ms: DurationSchema,
    exit_code: ExitCodeSchema,
    stderr_excerpt: StderrExcerptSchema,
  })
  .strict();

export type HookDeliveryPayload = z.infer<typeof schema>;
