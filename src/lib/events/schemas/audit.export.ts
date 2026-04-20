/**
 * Audit-tier event: audit.export — a signed audit bundle was produced.
 *
 * Sentinel H6 "audit the auditors" — every `genie events export-audit --signed`
 * operation must emit this event so the export itself is recorded in the
 * WORM chain and cannot be performed invisibly.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'audit.export' as const;
export const KIND = 'event' as const;
export const DEFAULT_TIER = 'audit' as const;

const ExporterActorSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('actor', v)),
  'A',
);

const SinceIdSchema = tagTier(z.number().int().min(0), 'C');
const RowCountSchema = tagTier(z.number().int().min(0), 'C');
const BreakCountSchema = tagTier(z.number().int().min(0), 'C', 'chain breaks detected in the exported range');
const BundleSignaturePrefixSchema = tagTier(
  z.string().min(1).max(16),
  'C',
  'first 16 hex of the bundle HMAC signature (full is on disk)',
);
const TenantIdSchema = tagTier(z.string().min(1).max(128), 'C');
const ReasonSchema = tagTier(
  z
    .string()
    .max(512)
    .transform((v) => redactFreeText(v)),
  'B',
  'IR justification for the export',
);

export const schema = z
  .object({
    exporter_actor: ExporterActorSchema,
    since_id: SinceIdSchema,
    row_count: RowCountSchema,
    break_count: BreakCountSchema,
    bundle_signature_prefix: BundleSignaturePrefixSchema,
    tenant_id: TenantIdSchema,
    reason: ReasonSchema,
  })
  .strict();

export type AuditExportPayload = z.infer<typeof schema>;
