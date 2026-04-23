/**
 * Span: mailbox.delivery — persistence + pane-injection of one mailbox message.
 *
 * Opened when `mailbox.send(from, to, body)` kicks off a write, closed after
 * the tmux pane injection resolves (or fails). Runbook-R1 reads `from`/`to`
 * distribution of this span to detect scheduler→team-lead recursion.
 */

import { z } from 'zod';
import { hashEntity, redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'mailbox.delivery' as const;
export const KIND = 'span' as const;

const AgentIdSchema = (ns: string) =>
  tagTier(
    z
      .string()
      .min(1)
      .max(256)
      .transform((v) => hashEntity(ns, v)),
    'A',
  );

const FromSchema = tagTier(z.string().max(128), 'C', 'sender role — public');
const ToSchema = tagTier(z.string().max(128), 'C', 'recipient role — public');
const ChannelSchema = tagTier(z.enum(['tmux', 'native-inbox', 'file', 'broadcast']), 'C');
const OutcomeSchema = tagTier(z.enum(['delivered', 'queued', 'pane_dead', 'rejected', 'timeout']).optional(), 'C');
const MessageIdSchema = AgentIdSchema('msg').optional();
const BodyExcerptSchema = tagTier(
  z
    .string()
    .max(512)
    .transform((v) => redactFreeText(v))
    .optional(),
  'B',
  'first 512 chars, redacted',
);
const DurationSchema = tagTier(z.number().int().min(0).max(60_000).optional(), 'C', 'ms');

export const schema = z
  .object({
    from: FromSchema,
    to: ToSchema,
    channel: ChannelSchema,
    outcome: OutcomeSchema,
    message_id: MessageIdSchema,
    body_excerpt: BodyExcerptSchema,
    duration_ms: DurationSchema,
  })
  .strict();

export type MailboxDeliveryPayload = z.infer<typeof schema>;
