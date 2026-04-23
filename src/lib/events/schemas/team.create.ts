/**
 * Audit-tier event: team.create — a team was created (autonomous or manual).
 *
 * Routed to `genie_runtime_events_audit` (WORM) by the registry. Carries the
 * actor so team creation can be audited post-hoc even after disbandment.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'team.create' as const;
export const KIND = 'event' as const;
/** Audit-tier event — routed to `genie_runtime_events_audit` by the registry. */
export const DEFAULT_TIER = 'audit' as const;

const TeamNameSchema = tagTier(z.string().min(1).max(128), 'C', 'team name — public label');
const WishSlugSchema = tagTier(z.string().max(128).optional(), 'C');
const RepoPathHashSchema = tagTier(
  z
    .string()
    .min(1)
    .max(1024)
    .transform((v) => hashEntity('repo', v)),
  'A',
);
const ActorSchema = tagTier(
  z
    .string()
    .max(256)
    .transform((v) => hashEntity('actor', v)),
  'A',
);
const MemberCountSchema = tagTier(z.number().int().min(0).max(256).optional(), 'C');
const AutoSchema = tagTier(z.boolean().optional(), 'C', 'true if created by auto-spawn hook');

export const schema = z
  .object({
    team_name: TeamNameSchema,
    wish_slug: WishSlugSchema,
    repo_path_hash: RepoPathHashSchema,
    actor: ActorSchema,
    member_count: MemberCountSchema,
    auto: AutoSchema,
  })
  .strict();

export type TeamCreatePayload = z.infer<typeof schema>;
