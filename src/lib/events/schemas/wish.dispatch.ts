/**
 * Span: wish.dispatch — one wave-dispatch of a wish group.
 *
 * Opened by `startSpan('wish.dispatch', {...})` when `genie work <slug>#<group>`
 * starts a group, closed on completion/failure with `outcome` and `duration_ms`.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'wish.dispatch' as const;
export const KIND = 'span' as const;

const WishSlugSchema = tagTier(z.string().min(1).max(128), 'C', 'wish slug — public');
const WaveSchema = tagTier(z.number().int().min(0).max(32), 'C');
const GroupIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(128)
    .transform((v) => hashEntity('group', v)),
  'A',
  'group id hashed',
);
const GroupNameSchema = tagTier(z.string().max(128), 'C');
const ActorSchema = tagTier(
  z
    .string()
    .max(128)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
);
const OutcomeSchema = tagTier(z.enum(['started', 'completed', 'failed', 'blocked']).optional(), 'C');
const DurationSchema = tagTier(z.number().int().min(0).max(86_400_000).optional(), 'C', 'ms');
const DryRunSchema = tagTier(z.boolean().optional(), 'C');

export const schema = z
  .object({
    wish_slug: WishSlugSchema,
    wave: WaveSchema.optional(),
    group_id: GroupIdSchema.optional(),
    group_name: GroupNameSchema.optional(),
    actor: ActorSchema,
    outcome: OutcomeSchema,
    duration_ms: DurationSchema,
    dry_run: DryRunSchema,
  })
  .strict();

export type WishDispatchPayload = z.infer<typeof schema>;
