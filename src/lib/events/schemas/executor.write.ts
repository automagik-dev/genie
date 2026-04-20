/**
 * Span: executor.write — one executor-mediated PG write boundary.
 *
 * Opened at each SQL INSERT/UPDATE/DELETE performed by an executor and closed
 * after the statement resolves. Narrower than `executor.row.written`, which is
 * a point event per row; this span measures batched statement latency.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'executor.write' as const;
export const KIND = 'span' as const;

const ExecutorSchema = tagTier(z.enum(['claude-code', 'claude-sdk', 'codex', 'shell']), 'C');
const TargetSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('executor_target', v)),
  'A',
  'target entity hashed',
);
const TableSchema = tagTier(z.string().max(128).optional(), 'C', 'PG table name — public');
const OperationSchema = tagTier(z.enum(['insert', 'update', 'delete', 'upsert', 'copy', 'truncate']), 'C');
const RowsAffectedSchema = tagTier(z.number().int().min(0).max(10_000_000).optional(), 'C');
const DurationSchema = tagTier(z.number().int().min(0).max(60_000).optional(), 'C', 'ms');
const OutcomeSchema = tagTier(z.enum(['ok', 'constraint_violation', 'timeout', 'error']).optional(), 'C');
const ErrorHintSchema = tagTier(
  z
    .string()
    .max(512)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
);

export const schema = z
  .object({
    executor: ExecutorSchema,
    target: TargetSchema,
    table: TableSchema,
    operation: OperationSchema,
    rows_affected: RowsAffectedSchema,
    duration_ms: DurationSchema,
    outcome: OutcomeSchema,
    error_hint: ErrorHintSchema,
  })
  .strict();

export type ExecutorWritePayload = z.infer<typeof schema>;
