/**
 * Detector: rot.team-ls-drift — observes divergence between the data source
 * read by `genie team ls` and the data source touched by `genie team disband`.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3b / Pattern 2).
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │  Why this detector exists                                              │
 * ├────────────────────────────────────────────────────────────────────────┤
 * │  Two different code paths read two different things when the user      │
 * │  touches a team:                                                       │
 * │                                                                        │
 * │    `genie team ls`                                                     │
 * │      → src/term-commands/team.ts:printTeams                            │
 * │      → src/lib/team-manager.ts:listTeams(includeArchived=false)        │
 * │      → PostgreSQL: SELECT * FROM teams WHERE status != 'archived'      │
 * │                                                                        │
 * │    `genie team disband <name>`                                         │
 * │      → src/term-commands/team.ts:disbandTeam action                    │
 * │      → src/lib/team-manager.ts:disbandTeam                             │
 * │          ├─ getTeam(name)          -- reads PG teams table             │
 * │          ├─ deleteNativeTeam(name) -- removes ~/.claude/teams/<san>/   │
 * │          └─ pruneStaleWorktrees    -- DELETEs rows whose worktree_path │
 * │                                      no longer exists on disk         │
 * │                                                                        │
 * │  `.claude/teams/<sanitized>/` uses `sanitizeTeamName()` (non-alnum →   │
 * │  `-`, lowercased); PG uses the raw branch name. So the two "sources   │
 * │  of truth" — PG `teams` table and `~/.claude/teams/` dir listing —    │
 * │  routinely drift and `team ls` + `team disband` disagree.              │
 * │                                                                        │
 * │  Ghost teams Felipe observed live (in-progress in `ls`, "not found"    │
 * │  in `disband`) are instances of this drift.                            │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * This detector is READ-ONLY. It never mutates either source. Unifying the
 * two paths is out of scope — a follow-up wish (likely B2 graduation) will
 * decide whether to make `.claude/teams/` the canonical source or fold it
 * into PG. For now we just observe.
 */

import { sanitizeTeamName } from '../lib/claude-native-teams.js';
import {
  listNativeTeamDirs as defaultListNativeTeamDirs,
  listTeamsFromPg as defaultListTeamsFromPg,
  pgWorktreeExistsOnDisk as defaultPgWorktreeExistsOnDisk,
} from '../lib/team-drift-sources.js';
import type { DetectorEvent, DetectorModule } from './index.js';
import { registerDetector } from './index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal shape of a PG teams row the detector needs to reason about drift. */
export interface LsSnapshotEntry {
  readonly name: string;
  readonly status: string;
  /** Absolute path to the team's shared-clone / worktree on disk. */
  readonly worktreePath: string;
}

/**
 * Sanitized directory name observed under `~/.claude/teams/`. We keep the raw
 * dir entry (post-sanitization) here because that's literally what `disband`
 * would `rm -rf` if invoked.
 */
export type DisbandSnapshotEntry = string;

/**
 * Divergence kinds the detector reports. Closed set mirroring the event
 * schema enum in `rot.team-ls-drift.detected.ts`.
 */
type DivergenceKind = 'missing_in_disband' | 'missing_in_ls' | 'status_mismatch';

interface DivergentTeam {
  readonly team_id: string;
  readonly kind: DivergenceKind;
  /** Human-readable reason — helps the triage runbook in Group 5. */
  readonly reason: string;
}

/** Result of a single detector tick — both snapshots plus the delta. */
interface TeamLsDriftState {
  readonly ls_snapshot: ReadonlyArray<LsSnapshotEntry>;
  readonly disband_snapshot: ReadonlyArray<DisbandSnapshotEntry>;
  readonly divergent: ReadonlyArray<DivergentTeam>;
}

/** Injectable source functions — tests supply deterministic replacements. */
export interface TeamLsDriftSources {
  readonly listTeamsFromPg: () => Promise<LsSnapshotEntry[]>;
  readonly listNativeTeamDirs: () => Promise<string[]>;
  readonly pgWorktreeExistsOnDisk: (worktreePath: string) => boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DETECTOR_ID = 'rot.team-ls-drift';
const DETECTOR_VERSION = '0.1.0';
/** Hard cap so pathological drift (thousands of ghosts) can't balloon the event. */
const MAX_DIVERGENT_IN_EVENT = 100;
/** Hard cap on snapshot length emitted — detector trims before serialization. */
const MAX_SNAPSHOT_IN_EVENT = 200;
/**
 * Mirror of the schema's `observed_state_json.max(16_384)` — the detector
 * self-enforces *before* emit so a pathological input falls back to a
 * compact summary instead of tripping Zod validation and dumping the event
 * into `schema.violation`. Bug #1291: the per-entry caps above don't
 * compound-cap, so 100 × (180-char reason) + 200 × {name,status} + 200 × dir
 * routinely overflows 16 KiB even though each individual slice looks small.
 */
const MAX_OBSERVED_STATE_JSON_CHARS = 16_384;
/** Ids kept in the summary fallback — large enough to triage, small enough to fit. */
const SUMMARY_DIVERGENT_ID_CAP = 20;

// ---------------------------------------------------------------------------
// Query + comparison logic
// ---------------------------------------------------------------------------

/**
 * Build the tick state by reading both sources and computing the divergence.
 * The computation is intentionally pure given the source callbacks — callers
 * supply deterministic stubs in tests.
 */
async function buildState(sources: TeamLsDriftSources): Promise<TeamLsDriftState> {
  const [lsRows, disbandDirs] = await Promise.all([sources.listTeamsFromPg(), sources.listNativeTeamDirs()]);

  // Build a set of sanitized dir names for O(1) lookup.
  const disbandSet = new Set(disbandDirs);
  // Build a map from sanitized PG name → PG row so we can map back.
  const lsSanitizedMap = new Map<string, LsSnapshotEntry>();
  for (const row of lsRows) {
    lsSanitizedMap.set(sanitizeTeamName(row.name), row);
  }

  const divergent: DivergentTeam[] = [];

  // (a) PG rows whose sanitized name has no matching `.claude/teams/` dir
  // AND (b) PG rows whose worktree path no longer exists on disk — two
  // flavours of "ls shows it but disband will no-op / crash".
  for (const row of lsRows) {
    const san = sanitizeTeamName(row.name);
    if (!disbandSet.has(san)) {
      divergent.push({
        team_id: row.name,
        kind: 'missing_in_disband',
        reason: `PG row visible in ls but no ~/.claude/teams/${san}/ dir`,
      });
      continue;
    }
    if (!sources.pgWorktreeExistsOnDisk(row.worktreePath)) {
      divergent.push({
        team_id: row.name,
        kind: 'status_mismatch',
        reason: `PG row status='${row.status}' but worktree path missing on disk — pruneStaleWorktrees will silently delete on next disband`,
      });
    }
  }

  // (c) filesystem dirs without a matching PG row — `ls` hides them but
  // Claude Code IPC still uses the `.claude/teams/<dir>/` contents.
  for (const dir of disbandDirs) {
    if (!lsSanitizedMap.has(dir)) {
      divergent.push({
        team_id: dir,
        kind: 'missing_in_ls',
        reason: `~/.claude/teams/${dir}/ exists but no PG row (status!='archived')`,
      });
    }
  }

  return {
    ls_snapshot: lsRows,
    disband_snapshot: disbandDirs,
    divergent,
  };
}

/**
 * Choose the event's `divergence_kind` when multiple kinds are present in
 * one tick. Priority reflects operator severity: `missing_in_ls` leaks
 * native-team state; `missing_in_disband` means ls lies; `status_mismatch`
 * is the silent prune-on-next-disband trap.
 */
function primaryDivergenceKind(divergent: ReadonlyArray<DivergentTeam>): DivergenceKind {
  const order: DivergenceKind[] = ['missing_in_ls', 'missing_in_disband', 'status_mismatch'];
  for (const kind of order) {
    if (divergent.some((d) => d.kind === kind)) return kind;
  }
  // Unreachable because shouldFire() guards on divergent.length > 0.
  return 'status_mismatch';
}

/**
 * Build the event payload. The per-list caps above trim individual slices,
 * but their product can still overflow 16 KiB — so after serializing we
 * measure and, if we're over, fall back to a compact summary that carries
 * only totals + the top-N divergent ids. Downstream consumers see
 * `observed_state_json_truncated: true` and know detail was dropped.
 */
function renderPayload(state: TeamLsDriftState): Record<string, unknown> {
  const primary = primaryDivergenceKind(state.divergent);
  const lsTrimmed = state.ls_snapshot.slice(0, MAX_SNAPSHOT_IN_EVENT).map((r) => ({
    name: r.name,
    status: r.status,
  }));
  const disbandTrimmed = state.disband_snapshot.slice(0, MAX_SNAPSHOT_IN_EVENT);
  const divergentTrimmed = state.divergent.slice(0, MAX_DIVERGENT_IN_EVENT);

  const observed = {
    ls_snapshot: lsTrimmed,
    disband_snapshot: disbandTrimmed,
    divergent_ids: divergentTrimmed.map((d) => d.team_id),
    divergence_kind: primary,
    divergent_detail: divergentTrimmed,
    ls_total: state.ls_snapshot.length,
    disband_total: state.disband_snapshot.length,
    divergent_total: state.divergent.length,
  };

  let observedJson = JSON.stringify(observed);
  let truncated = false;

  if (observedJson.length > MAX_OBSERVED_STATE_JSON_CHARS) {
    truncated = true;
    const summary = {
      divergence_kind: primary,
      divergent_ids: divergentTrimmed.slice(0, SUMMARY_DIVERGENT_ID_CAP).map((d) => d.team_id),
      ls_total: state.ls_snapshot.length,
      disband_total: state.disband_snapshot.length,
      divergent_total: state.divergent.length,
      truncation_reason: 'detail payload exceeded observed_state_json cap',
    };
    observedJson = JSON.stringify(summary);
    if (observedJson.length > MAX_OBSERVED_STATE_JSON_CHARS) {
      observedJson = observedJson.slice(0, MAX_OBSERVED_STATE_JSON_CHARS);
    }
  }

  return {
    divergence_kind: primary,
    divergent_count: state.divergent.length,
    observed_state_json: observedJson,
    ...(truncated ? { observed_state_json_truncated: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// DetectorModule factory
// ---------------------------------------------------------------------------

/**
 * Build a detector module. In production the caller passes nothing and the
 * production source functions are wired up; in tests, the caller injects a
 * `TeamLsDriftSources` object so we never touch PG or the real filesystem.
 */
export function makeTeamLsDriftDetector(overrides?: Partial<TeamLsDriftSources>): DetectorModule<TeamLsDriftState> {
  const sources: TeamLsDriftSources = {
    listTeamsFromPg: overrides?.listTeamsFromPg ?? defaultListTeamsFromPg,
    listNativeTeamDirs: overrides?.listNativeTeamDirs ?? defaultListNativeTeamDirs,
    pgWorktreeExistsOnDisk: overrides?.pgWorktreeExistsOnDisk ?? defaultPgWorktreeExistsOnDisk,
  };

  return {
    id: DETECTOR_ID,
    version: DETECTOR_VERSION,
    riskClass: 'medium',
    query(): Promise<TeamLsDriftState> {
      return buildState(sources);
    },
    shouldFire(state: TeamLsDriftState): boolean {
      return state.divergent.length > 0;
    },
    render(state: TeamLsDriftState): DetectorEvent {
      return {
        type: 'rot.team-ls-drift.detected',
        subject: DETECTOR_ID,
        payload: renderPayload(state),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Self-registration on module load (production wiring)
// ---------------------------------------------------------------------------

registerDetector(makeTeamLsDriftDetector());
