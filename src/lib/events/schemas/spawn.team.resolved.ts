/**
 * Audit-tier event: spawn.team.resolved — records the tier that decided
 * the spawn's team binding. Emitted from `resolveTeamForSpawn` (Wish:
 * spawn-compounding-defects, Group 1, Bug 1).
 *
 * Routed to `genie_runtime_events_audit` (WORM) by the registry so
 * misbinding audits remain queryable post-incident.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'spawn.team.resolved' as const;
export const KIND = 'event' as const;
/** Audit-tier event — routed to `genie_runtime_events_audit` by the registry. */
export const DEFAULT_TIER = 'audit' as const;

const AgentSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('agent', v)),
  'A',
);
const TeamSchema = tagTier(z.string().min(1).max(128), 'C');
const OptionalTeamSchema = tagTier(z.string().min(1).max(128).nullable().optional(), 'C');

const SourceSchema = tagTier(
  z.enum(['explicit_flag', 'entry_team', 'canonical_self_leader', 'env_genie_team', 'caller_context']),
  'C',
  'tier that decided the resolved team — see resolveTeamForSpawn precedence',
);

export const schema = z
  .object({
    agent: AgentSchema,
    resolved_team: TeamSchema,
    source: SourceSchema,
    canonical_team: OptionalTeamSchema,
    misbound: tagTier(z.boolean().optional(), 'C', 'true if resolved !== canonical AND canonical present'),
  })
  .strict();

export type SpawnTeamResolvedPayload = z.infer<typeof schema>;
