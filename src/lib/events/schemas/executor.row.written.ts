/**
 * Event: executor.row.written — one PG row was inserted/updated by an
 * executor-mediated write. Carries the before/after scalar diff so retroactive
 * reconstruction queries (docs/observability-acid-tests.sql) can replay state
 * without touching the source tables.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'executor.row.written' as const;
export const KIND = 'event' as const;

const TableSchema = tagTier(z.string().min(1).max(128), 'C', 'PG table name — public');
const RowIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('row', v)),
  'A',
);
const OperationSchema = tagTier(z.enum(['insert', 'update', 'delete', 'upsert']), 'C');
const ExecutorSchema = tagTier(z.string().max(128).optional(), 'C');

const DiffSchema = tagTier(
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  'B',
  'shallow scalar diff only — payloads never stored here',
);

export const schema = z
  .object({
    table: TableSchema,
    row_id: RowIdSchema,
    operation: OperationSchema,
    executor: ExecutorSchema,
    before: DiffSchema,
    after: DiffSchema,
  })
  .strict();

export type ExecutorRowWrittenPayload = z.infer<typeof schema>;
