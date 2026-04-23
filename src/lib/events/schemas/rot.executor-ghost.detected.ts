/**
 * Event: rot.executor-ghost.detected — the turn-close resolver or the boot
 * reconciler observed a worker session whose `GENIE_EXECUTOR_ID` env var
 * points to a row that does not exist in the `executors` table.
 *
 * Root cause: pgserve reset / reinstall / schema reboot wipes the
 * `executors` table, but live worker panes retain the env var they were
 * spawned with. The CLI-side has no on-disk source to rehydrate executors
 * from (unlike teams; see `rot.team-ls-drift.detected` and PR #1249), so
 * recovery happens either lazily (resolver fallback at turn-close) or
 * eagerly (boot reconciler). Both paths emit this event with
 * `resolution_source` set so operators can tell them apart.
 *
 * Behavior on a well-formed env pair (`GENIE_EXECUTOR_ID` + `GENIE_AGENT_NAME`):
 *   - Resolver finds no row by id, looks up by agent_id, updates the session
 *     to use the latest executor for that agent, and emits this event.
 *   - Boot reconciler finds no row by id, checks whether an `agents` row
 *     exists for the name, and either resurrects the executor row or marks
 *     it unrecoverable — emitting this event either way.
 *
 * Wish: `fix-executor-ghost-on-reinstall` (planning PR #1252, merged).
 */

import { z } from 'zod';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'rot.executor-ghost.detected' as const;
export const KIND = 'event' as const;

/**
 * Which code path discovered the ghost. Closed enum — adding a new source
 * is an explicit schema bump.
 *   - `resolver`:   lazy fallback inside `turnClose` when the env UUID
 *                   returns 0 rows; a matching `agent_id` row rescued the
 *                   close.
 *   - `reconciler`: eager boot-time pass in `genie serve` start that
 *                   resurrects (or flags) executor rows for live panes.
 */
const ResolutionSourceSchema = tagTier(z.enum(['resolver', 'reconciler']), 'C');

/** The env UUID that failed to resolve. Tokenized — no PII risk. */
const EnvIdSchema = tagTier(z.string().uuid(), 'C');

/**
 * The executor id that was substituted (resolver) or INSERTed (reconciler).
 * May equal `env_id` in the reconciler case when we resurrect with the same
 * id; otherwise a freshly-looked-up UUID from the agents' most-recent row.
 */
const ResolvedIdSchema = tagTier(z.string().uuid(), 'C');

/**
 * Agent name used for the fallback lookup (`GENIE_AGENT_NAME`). A
 * tokenized identifier (role/custom-name) — redaction belt-and-braces is
 * unnecessary here as the name space is closed.
 */
const AgentNameSchema = tagTier(z.string().min(1).max(256), 'C');

/**
 * Whether the ghost was recoverable. For the reconciler, this is false when
 * no matching `agents.id` row exists (the worker is orphaned at BOTH levels).
 * For the resolver, this is always true — the event only fires on successful
 * fallback.
 */
const RecoveredSchema = tagTier(z.boolean(), 'C');

export const schema = z
  .object({
    resolution_source: ResolutionSourceSchema,
    env_id: EnvIdSchema,
    resolved_id: ResolvedIdSchema,
    agent_name: AgentNameSchema,
    recovered: RecoveredSchema,
  })
  .strict();

export type RotExecutorGhostDetectedPayload = z.infer<typeof schema>;
