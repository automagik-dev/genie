/**
 * Event: permissions.deny — an access check rejected a request. Pen-test
 * (Group 8) consumes this to verify LISTEN bomb scenario.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'permissions.deny' as const;
export const KIND = 'event' as const;

const ActorSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('actor', v)),
  'A',
);
const AttemptedRoleSchema = tagTier(z.string().min(1).max(64), 'C');
const ScopeSchema = tagTier(z.string().min(1).max(128), 'C');
const ReasonSchema = tagTier(
  z.enum([
    'token_expired',
    'token_invalid',
    'signature_invalid',
    'scope_mismatch',
    'tenant_mismatch',
    'rate_limited',
    'revoked',
    'unknown',
  ]),
  'C',
);
const SourceIpSchema = tagTier(
  z
    .string()
    .max(64)
    .transform((v) => hashEntity('ip', v))
    .optional(),
  'A',
);

export const schema = z
  .object({
    actor: ActorSchema,
    attempted_role: AttemptedRoleSchema,
    scope: ScopeSchema,
    reason: ReasonSchema,
    source_ip: SourceIpSchema,
  })
  .strict();

export type PermissionsDenyPayload = z.infer<typeof schema>;
