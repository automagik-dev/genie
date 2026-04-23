/**
 * Audit-tier event: audit.un_hash — an admin reversed a Tier-B hash.
 *
 * Sentinel H6 "audit the auditors" — every admin un-hash operation must emit
 * this event to the WORM audit table so the operator's action is itself on
 * the immutable chain.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'audit.un_hash' as const;
export const KIND = 'event' as const;
export const DEFAULT_TIER = 'audit' as const;

const AdminActorSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('actor', v)),
  'A',
  'admin who performed the un-hash (Tier-A hashed)',
);

const NamespaceSchema = tagTier(z.string().min(1).max(64), 'C');
const HashedValueSchema = tagTier(z.string().min(1).max(256), 'B', 'tier-a:ns:... source hash requested');
const ResolvedMarkerSchema = tagTier(z.boolean(), 'C', 'true if un-hash succeeded');
const ReasonSchema = tagTier(
  z
    .string()
    .max(512)
    .transform((v) => redactFreeText(v)),
  'B',
  'IR justification for the un-hash',
);
const TicketRefSchema = tagTier(z.string().max(128).optional(), 'C', 'incident ticket reference');

export const schema = z
  .object({
    admin_actor: AdminActorSchema,
    namespace: NamespaceSchema,
    hashed_value: HashedValueSchema,
    resolved: ResolvedMarkerSchema,
    reason: ReasonSchema,
    ticket_ref: TicketRefSchema,
  })
  .strict();

export type AuditUnHashPayload = z.infer<typeof schema>;
