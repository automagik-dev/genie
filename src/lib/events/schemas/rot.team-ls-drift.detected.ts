/**
 * Event: rot.team-ls-drift.detected — the `rot.team-ls-drift` detector observed
 * a divergence between the data source read by `genie team ls` (PostgreSQL
 * `teams` table, status != 'archived') and the data source touched by
 * `genie team disband` (the same PG row PLUS the filesystem directory at
 * `~/.claude/teams/<sanitized-name>/`).
 *
 * Ghost teams observed in production:
 *   - PG row present, filesystem dir absent → `team ls` lists it but `team
 *     disband` silently skips the native-team cleanup step because
 *     `deleteNativeTeam` is a best-effort no-op on missing dirs. This is the
 *     "in-progress in ls, not found in disband" pattern Felipe caught live.
 *   - Filesystem dir present, PG row absent → `team ls` hides it entirely,
 *     but `.claude/teams/<name>/` still participates in Claude Code's native
 *     IPC until someone runs `ensureTeamRow` or `deleteNativeTeam`.
 *   - Both present but `worktree_path` on the PG row no longer exists on
 *     disk → `pruneStaleWorktrees` (called at the end of `disbandTeam`) will
 *     delete the row the next time any OTHER team is disbanded, so the
 *     current `ls` snapshot is already stale.
 *
 * The detector is read-only: it observes the divergence, emits this event
 * with both source snapshots for triage, and never mutates state. Unifying
 * the two data sources is a follow-up wish — see PR body for scope note.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3b).
 */

import { z } from 'zod';
import { redactFreeText } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'rot.team-ls-drift.detected' as const;
export const KIND = 'event' as const;

/**
 * Classifies what the detector observed so consumers / runbooks can branch
 * without re-parsing `observed_state_json`. Closed enum — adding a new kind
 * is an explicit schema bump.
 *   - `missing_in_disband`: team row in PG (visible to `team ls`) but no
 *     corresponding `~/.claude/teams/<sanitized-name>/` dir on disk.
 *   - `missing_in_ls`:     filesystem dir present but no PG row (or PG row
 *     is `status = 'archived'` so `team ls` hides it without --all).
 *   - `status_mismatch`:   PG row visible to `ls` with `status = 'in_progress'`
 *     but `worktree_path` no longer exists on disk, so the next disband
 *     call will prune it silently via `pruneStaleWorktrees`.
 */
const DivergenceKindSchema = tagTier(z.enum(['missing_in_disband', 'missing_in_ls', 'status_mismatch']), 'C');

/** Count of divergent team identifiers in this tick. */
const DivergentCountSchema = tagTier(z.number().int().min(1).max(10_000), 'C');

/**
 * Serialized JSON blob containing `{ ls_snapshot, disband_snapshot,
 * divergent_ids, divergence_kind }`. Team names are tokenized identifiers
 * (no PII) but we still route through `redactFreeText` as belt-and-braces in
 * case a future caller slips a path or token into a snapshot field.
 *
 * Capped at 16 KiB so a pathological drift (thousands of ghost teams) can't
 * balloon the events table — the detector itself caps the per-event payload
 * before serialization, but we enforce the limit here too.
 */
const ObservedStateJsonSchema = tagTier(
  z
    .string()
    .min(2)
    .max(16_384)
    .transform((v) => redactFreeText(v)),
  'B',
  'JSON-encoded snapshot of both data sources for triage',
);

/**
 * Flag set by the detector when the natural payload would exceed
 * `observed_state_json`'s 16 KiB cap, so it falls back to a compact summary.
 * Absent when full detail fits. Literal-true shape (no `false` value) so
 * consumers can use `if (payload.observed_state_json_truncated)` without
 * a tri-state check.
 */
const ObservedStateJsonTruncatedSchema = tagTier(
  z.literal(true).optional(),
  'C',
  'set when detail was dropped to honor the observed_state_json cap',
);

export const schema = z
  .object({
    divergence_kind: DivergenceKindSchema,
    divergent_count: DivergentCountSchema,
    observed_state_json: ObservedStateJsonSchema,
    observed_state_json_truncated: ObservedStateJsonTruncatedSchema,
  })
  .strict();

export type RotTeamLsDriftDetectedPayload = z.infer<typeof schema>;
