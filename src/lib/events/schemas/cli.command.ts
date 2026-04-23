/**
 * Span: cli.command — one top-level `genie <cmd>` invocation.
 *
 * Emitted at CLI entry by `startSpan('cli.command', {...})` and closed by
 * `endSpan(handle, {exit_code, duration_ms, ...})` in the top-level try/finally.
 */

import { z } from 'zod';
import { redactFreeText, tokenizePath } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'cli.command' as const;
export const KIND = 'span' as const;

const CommandSchema = tagTier(z.string().max(256), 'C', 'subcommand name only');
const ArgsSchema = tagTier(
  z
    .array(z.string())
    .max(32)
    .transform((args) => args.map((a) => redactFreeText(a))),
  'B',
  'argv — secrets stripped, paths kept',
);
const CwdSchema = tagTier(z.string().max(1024).transform(tokenizePath), 'B', 'working directory tokenized');
const ExitCodeSchema = tagTier(z.number().int().min(-1).max(255), 'C');
const DurationSchema = tagTier(z.number().int().min(0).max(3_600_000), 'C', 'milliseconds');
const UserAgentSchema = tagTier(z.string().max(256).optional(), 'C');

export const schema = z
  .object({
    command: CommandSchema,
    args: ArgsSchema,
    cwd: CwdSchema,
    exit_code: ExitCodeSchema.optional(),
    duration_ms: DurationSchema.optional(),
    user_agent: UserAgentSchema,
  })
  .strict()
  .transform((v) => ({ ...v }));

export type CliCommandPayload = z.infer<typeof schema>;
