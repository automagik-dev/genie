/**
 * Event: runbook.triggered — a runbook consumer detected its pattern.
 *
 * The mitigation SQL is emitted as a suggestion; consumers never auto-execute.
 * Runbook-R1 (Group 7) is the reference producer; more rules will follow.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'runbook.triggered' as const;
export const KIND = 'event' as const;

const RuleSchema = tagTier(
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^R\d+$/, 'rule id must be R<int>'),
  'C',
);
const EvidenceCountSchema = tagTier(z.number().int().min(1).max(1_000_000), 'C');
const CorrelationIdSchema = tagTier(
  z
    .string()
    .max(128)
    .transform((v) => hashEntity('trace', v))
    .optional(),
  'A',
);
const WindowMinutesSchema = tagTier(z.number().int().min(1).max(1440).optional(), 'C');
const RecommendedSqlSchema = tagTier(
  z
    .string()
    .max(4096)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
  'mitigation SQL — redacted free text',
);
const EvidenceSummarySchema = tagTier(
  z
    .string()
    .max(1024)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
);

export const schema = z
  .object({
    rule: RuleSchema,
    evidence_count: EvidenceCountSchema,
    window_minutes: WindowMinutesSchema,
    correlation_id: CorrelationIdSchema,
    recommended_sql: RecommendedSqlSchema,
    evidence_summary: EvidenceSummarySchema,
  })
  .strict();

export type RunbookTriggeredPayload = z.infer<typeof schema>;
