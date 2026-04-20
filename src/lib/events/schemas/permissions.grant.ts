/**
 * Event: permissions.grant — a role grant (subscription token minted or
 * database role GRANT) was applied successfully.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'permissions.grant' as const;
export const KIND = 'event' as const;

const ActorSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('actor', v)),
  'A',
);
const RoleSchema = tagTier(z.enum(['admin', 'operator', 'subscriber', 'audit']), 'C');
const ScopeSchema = tagTier(z.string().min(1).max(128), 'C', 'e.g. "genie_events.agent.*" — public');
const ExpiresAtSchema = tagTier(z.string().datetime().optional(), 'C');
const GrantedBySchema = tagTier(
  z
    .string()
    .max(256)
    .transform((v) => hashEntity('actor', v))
    .optional(),
  'A',
);

export const schema = z
  .object({
    actor: ActorSchema,
    role: RoleSchema,
    scope: ScopeSchema,
    expires_at: ExpiresAtSchema,
    granted_by: GrantedBySchema,
  })
  .strict();

export type PermissionsGrantPayload = z.infer<typeof schema>;
