/**
 * Event: state_transition — one entity moved from `from` to `to`.
 *
 * Applies uniformly to tasks, wishes, workers, team-leads. `before`/`after`
 * carry the diff only, never the full object (keep payload bounded).
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'state_transition' as const;
export const KIND = 'event' as const;

const EntityKindSchema = tagTier(
  z.enum(['task', 'wish', 'worker', 'team', 'team_lead', 'group', 'mailbox_message']),
  'C',
);
const EntityIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('entity', v)),
  'A',
  'entity id hashed',
);
const FromSchema = tagTier(z.string().min(1).max(64), 'C');
const ToSchema = tagTier(z.string().min(1).max(64), 'C');
const ReasonSchema = tagTier(
  z
    .string()
    .max(512)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
  'redacted free-text',
);
const ActorSchema = tagTier(
  z
    .string()
    .max(128)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
);

const DiffSchema = tagTier(
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  'B',
  'shallow scalar diff only',
);

export const schema = z
  .object({
    entity_kind: EntityKindSchema,
    entity_id: EntityIdSchema,
    from: FromSchema,
    to: ToSchema,
    reason: ReasonSchema,
    actor: ActorSchema,
    before: DiffSchema,
    after: DiffSchema,
  })
  .strict();

export type StateTransitionPayload = z.infer<typeof schema>;
