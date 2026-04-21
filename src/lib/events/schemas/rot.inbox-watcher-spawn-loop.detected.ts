/**
 * Event: rot.inbox-watcher-spawn-loop.detected — the inbox-watcher daemon
 * observed that a team-lead spawn has failed `MAX_SPAWN_FAILURES` (3)
 * consecutive times and will silently skip future polls for this session
 * key until the daemon restarts or `resetSpawnFailures()` is called.
 *
 * Root cause family:
 *   - Team-lead spawn throws (tmux failure, missing workingDir validation at
 *     deeper layer, stale team row, etc.) and the watcher increments an
 *     in-memory failure counter.
 *   - At `failures === MAX_SPAWN_FAILURES`, the watcher flips into silent-
 *     skip mode. No PG event was emitted prior to this schema (canonical
 *     blind spot). Messages addressed to the team keep arriving on disk
 *     but are never picked up, so they are effectively lost until manual
 *     intervention.
 *
 * Blast radius (observed 2026-04-20, `reference_pattern9_inbox_watcher_spawn_loop.md`):
 *   215+ messages silently dropped across two ghost teams
 *   (`wish-state-invalidation`, `omni-channels-pivot`) before the behavior
 *   was noticed manually via a `/trace` pass.
 *
 * Emit site:
 *   `src/lib/inbox-watcher.ts::attemptSpawn()` — fired exactly once on the
 *   transition from `failures === MAX_SPAWN_FAILURES - 1` to `failures ===
 *   MAX_SPAWN_FAILURES`. Subsequent skips are NOT re-emitted (prevents
 *   polling-cadence flooding of the event substrate). A follow-up
 *   `rot.inbox-watcher-spawn-loop.resolved` is a stretch event (not in
 *   this schema) for when the team recovers and the counter resets.
 *
 * Consumer guidance:
 *   - Runbook `rot.inbox-watcher-spawn-loop` (future B detector) can
 *     archive the inbox dir, delete the team row (if truly dead), or
 *     re-home the orphan tasks blocking spawn.
 *   - False-positive check: confirm the team is NOT in mid-teardown via
 *     `genie team ls --json` before any mutating action.
 *
 * Wish: genie-bugless-self-healing (sub-project B, brainstorm in flight).
 * Pattern: Pattern 9 in the BUGLESS-GENIE 11-pathology roster.
 */

import { z } from 'zod';
import { redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'rot.inbox-watcher-spawn-loop.detected' as const;
export const KIND = 'event' as const;

/**
 * The team name whose inbox watcher is now in silent-skip mode.
 * Tokenized identifier — no PII expected, but belt-and-braces redaction
 * via `redactFreeText` guards against a future team-naming scheme leaking
 * raw paths or user handles.
 */
const TeamNameSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => redactFreeText(v)),
  'C',
);

/**
 * The session key derived from the first unread message's routing header
 * (or equal to `team_name` when the header is absent). Present so consumers
 * can disambiguate when a single team has multiple session scopes spawning
 * in parallel.
 */
const SessionKeySchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => redactFreeText(v)),
  'C',
);

/**
 * The failure count at emit time. Always equals `MAX_SPAWN_FAILURES` (3) by
 * design — this event only fires on the transition. Encoded as int rather
 * than hard-coded so a future config bump to `MAX_SPAWN_FAILURES` surfaces
 * in the event payload without a schema bump.
 */
const FailureCountSchema = tagTier(z.number().int().min(1).max(100), 'C');

/**
 * The most recent spawn-error message, redacted. Bounded at 2 KiB so a
 * pathological stack trace can't balloon the events table — the emit site
 * trims before serialization.
 */
const LastErrorMessageSchema = tagTier(
  z
    .string()
    .min(1)
    .max(2048)
    .transform((v) => redactFreeText(v)),
  'B',
  'redacted error message from the final failed ensureTeamLead() call',
);

export const schema = z
  .object({
    team_name: TeamNameSchema,
    session_key: SessionKeySchema,
    failure_count: FailureCountSchema,
    last_error_message: LastErrorMessageSchema,
  })
  .strict();

export type RotInboxWatcherSpawnLoopDetectedPayload = z.infer<typeof schema>;
