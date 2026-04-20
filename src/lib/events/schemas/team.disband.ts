/**
 * Audit-tier event: team.disband — a team was disbanded.
 *
 * Routed to `genie_runtime_events_audit` (WORM) by the registry.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'team.disband' as const;
export const KIND = 'event' as const;
/** Audit-tier event — routed to `genie_runtime_events_audit` by the registry. */
export const DEFAULT_TIER = 'audit' as const;

const TeamNameSchema = tagTier(z.string().min(1).max(128), 'C');
const ActorSchema = tagTier(
  z
    .string()
    .max(256)
    .transform((v) => hashEntity('actor', v))
    .optional(),
  'A',
);
const RemainingMembersSchema = tagTier(z.number().int().min(0).max(256).optional(), 'C');
const ReasonSchema = tagTier(
  z
    .string()
    .max(512)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
);

export const schema = z
  .object({
    team_name: TeamNameSchema,
    actor: ActorSchema,
    remaining_members: RemainingMembersSchema,
    reason: ReasonSchema,
  })
  .strict();

export type TeamDisbandPayload = z.infer<typeof schema>;
