/**
 * Event: error.raised — any caught exception in a genie subsystem.
 *
 * Recorded at the catch-site nearest the business boundary, never rethrown
 * from within `emit()` itself (schema validation failures surface as
 * `schema.violation` meta events instead).
 */

import { z } from 'zod';
import { redactFreeText, tokenizePath } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'error.raised' as const;
export const KIND = 'event' as const;

const ErrorClassSchema = tagTier(z.string().min(1).max(256), 'C', 'exception class name');
const MessageSchema = tagTier(z.string().max(4096).transform(redactFreeText), 'B');
const StackSchema = tagTier(
  z
    .string()
    .max(16_384)
    .transform((stack) =>
      stack
        .split('\n')
        .map((line) => tokenizePath(redactFreeText(line)))
        .join('\n'),
    ),
  'B',
  'stack paths tokenized',
);
const SubsystemSchema = tagTier(z.string().min(1).max(128), 'C');
const SeveritySchema = tagTier(z.enum(['warn', 'error', 'fatal']), 'C');
const RetryableSchema = tagTier(z.boolean().optional(), 'C');

export const schema = z
  .object({
    error_class: ErrorClassSchema,
    message: MessageSchema,
    stack: StackSchema.optional(),
    subsystem: SubsystemSchema,
    severity: SeveritySchema,
    retryable: RetryableSchema,
  })
  .strict();

export type ErrorRaisedPayload = z.infer<typeof schema>;
