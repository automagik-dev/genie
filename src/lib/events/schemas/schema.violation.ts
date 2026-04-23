/**
 * Meta event: schema.violation — a payload failed Zod parse inside emit().
 *
 * Never thrown out of a business transaction; emitted in-band so consumers
 * can detect producers that are drifting from the registry.
 */

import { z } from 'zod';
import { redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'schema.violation' as const;
export const KIND = 'event' as const;

const OffendingTypeSchema = tagTier(z.string().min(1).max(128), 'C');
const RejectedBytesSchema = tagTier(z.number().int().min(0).max(1_048_576), 'C');
const IssueSchema = tagTier(
  z.object({
    path: z.string().max(256),
    code: z.string().max(64),
    message: z.string().max(512).transform(redactFreeText),
  }),
  'B',
);

export const schema = z
  .object({
    offending_type: OffendingTypeSchema,
    issues: tagTier(z.array(IssueSchema).max(32), 'B'),
    rejected_bytes: RejectedBytesSchema,
    source_subsystem: tagTier(z.string().max(128).optional(), 'C'),
  })
  .strict();

export type SchemaViolationPayload = z.infer<typeof schema>;
