/**
 * Spawn-time team resolver — Wish: spawn-compounding-defects, Group 1.
 *
 * Closes Bugs 1+4 from #1710:
 *
 *   Bug 1 — `genie spawn <agent>` (no `--team`) ignored the agent's canonical
 *   team-of-self even when `~/.claude/teams/<agent>/config.json` registered
 *   the agent as its own leader (`leadAgentId === "<agent>@<agent>"`).
 *   Resolution silently fell through to the caller-context heuristic, which
 *   landed master agents in unrelated teams and corrupted PG state.
 *
 *   Bug 4 — when an explicit `--team X` diverged from the canonical
 *   self-leader registration `Y`, nothing surfaced the misbinding. The
 *   originating session burned for hours before the discrepancy was noticed.
 *
 * Resolution order (highest precedence first):
 *
 *   1. `explicit_flag`         — caller's `--team` flag.
 *   2. `entry_team`            — template-pinned team from `agent_templates`
 *                                PG row (preserves the canonical-UUID-per-agent
 *                                invariant established by PR #1133/#1134).
 *   3. `canonical_self_leader` — NEW. `~/.claude/teams/<agent>/config.json`
 *                                exists AND `leadAgentId === "<agent>@<agent>"`
 *                                ⇒ agent runs as the leader of team
 *                                `<agent>` (canonical team-of-self).
 *   4. `env_genie_team`        — `process.env.GENIE_TEAM`, session-scoped.
 *   5. `caller_context`        — `discoverTeamName()` (tmux session name +
 *                                JSONL leadSessionId heuristic).
 *
 * Every spawn emits a `spawn.team.resolved` audit event recording the chosen
 * tier and the canonical-self-leader value (when registered). Callers should
 * inspect `misbound`/`canonicalTeam` on the result to surface the stderr
 * `WARN:` line per Bug 4 fix direction.
 *
 * Pure with respect to its inputs — every dependency (canonical lookup, env,
 * discover) is injected so unit tests can exercise the four cases from the
 * wish's deliverable-5 table without touching the filesystem or env.
 */

import * as nativeTeams from './claude-native-teams.js';

/**
 * Tier label that decided the resolved team. Mirrors the
 * `spawn.team.resolved` schema's `source` enum.
 */
export type ResolveSource =
  | 'explicit_flag'
  | 'entry_team'
  | 'canonical_self_leader'
  | 'env_genie_team'
  | 'caller_context';

/** Outcome of `resolveTeamForSpawn`. */
export interface ResolveTeamOutcome {
  /** The team the spawn should bind to, or null when every tier yielded nothing. */
  team: string | null;
  /** Tier that produced the resolution; null when `team === null`. */
  source: ResolveSource | null;
  /**
   * Canonical self-leader team registered for this agent on disk, when one
   * exists. Independent of the resolved team — callers compare the two to
   * decide whether to surface the misbinding `WARN`.
   */
  canonicalTeam: string | null;
  /**
   * `true` when `team !== canonicalTeam` AND `canonicalTeam !== null`.
   * Convenience flag — callers may also recompute from the two fields.
   */
  misbound: boolean;
}

/** Inputs for `resolveTeamForSpawn`. */
export interface ResolveTeamOptions {
  /** Caller-supplied `--team` flag. */
  explicitTeam?: string | null;
  /** Template-pinned team from the agent_templates PG row. */
  entryTeam?: string | null;
  /** Agent role/name — required to consult the canonical self-leader registration. */
  agentName: string;
  /**
   * Subset of `process.env` — only `GENIE_TEAM` is consulted. Defaults to
   * `process.env` when omitted.
   */
  env?: { GENIE_TEAM?: string };
  /**
   * Caller-context fallback (tmux session name + JSONL heuristic). Defaults
   * to `nativeTeams.discoverTeamName` when omitted.
   */
  discover?: () => Promise<string | null>;
  /**
   * Canonical-self-leader lookup. Returns the team name `<agent>` iff
   * `~/.claude/teams/<agent>/config.json` exists AND its `leadAgentId`
   * equals `"<agent>@<agent>"`. Defaults to `loadCanonicalSelfLeaderTeam`.
   */
  loadCanonical?: (agentName: string) => Promise<string | null>;
}

/**
 * Default canonical-self-leader lookup.
 *
 * Reads `~/.claude/teams/<sanitizedAgentName>/config.json`. Returns the
 * sanitized team name iff `leadAgentId === "<sanitizedAgentName>@<sanitizedAgentName>"`.
 * Returns null on missing file, parse error, or any mismatch.
 *
 * Agent names are sanitized with `nativeTeams.sanitizeTeamName` before path
 * construction so the lookup matches the path layout that `claude-native-teams`
 * writes (it sanitizes team names during create — same rules apply here).
 */
export async function loadCanonicalSelfLeaderTeam(agentName: string): Promise<string | null> {
  const sanitized = nativeTeams.sanitizeTeamName(agentName);
  const config = await nativeTeams.loadConfig(sanitized).catch(() => null);
  if (!config) return null;
  // Self-leader registration shape: leadAgentId === "<agent>@<agent>".
  if (config.leadAgentId === `${sanitized}@${sanitized}`) {
    return sanitized;
  }
  return null;
}

/**
 * Resolve the team for a spawn, recording which tier decided.
 *
 * Pure with respect to the four injected dependencies (`env`, `discover`,
 * `loadCanonical`, `agentName`) — callers can stub any of them in tests
 * without touching real disk / env / tmux state.
 */
export async function resolveTeamForSpawn(opts: ResolveTeamOptions): Promise<ResolveTeamOutcome> {
  const env = opts.env ?? process.env;
  const discover = opts.discover ?? nativeTeams.discoverTeamName;
  const loadCanonical = opts.loadCanonical ?? loadCanonicalSelfLeaderTeam;

  // Compute canonical self-leader up-front. We need it for tier 3 evaluation
  // AND to surface misbinding on every other tier — a single lookup serves
  // both purposes.
  const canonicalTeam = await loadCanonical(opts.agentName);

  let team: string | null = null;
  let source: ResolveSource | null = null;

  if (opts.explicitTeam) {
    team = opts.explicitTeam;
    source = 'explicit_flag';
  } else if (opts.entryTeam) {
    team = opts.entryTeam;
    source = 'entry_team';
  } else if (canonicalTeam) {
    team = canonicalTeam;
    source = 'canonical_self_leader';
  } else if (env.GENIE_TEAM) {
    team = env.GENIE_TEAM;
    source = 'env_genie_team';
  } else {
    const discovered = await discover();
    if (discovered) {
      team = discovered;
      source = 'caller_context';
    }
  }

  const misbound = canonicalTeam !== null && team !== null && team !== canonicalTeam;
  return { team, source, canonicalTeam, misbound };
}

/**
 * Build the misbinding stderr line per Bug 4 fix direction. Exported so the
 * spawn handler and tests can assert on the exact wording — see the wish's
 * acceptance-criteria block for the canonical phrasing.
 */
export function formatMisbindingWarning(agent: string, canonical: string, actual: string): string {
  return `WARN: ${agent} is registered as leader of team:${canonical} but spawning into team:${actual} — pass --team ${canonical} to fix or --team ${actual} to suppress this warning`;
}

// ============================================================================
// Test seam — `_deps` is patched by unit tests to swap defaults without
// going through every call site. Same pattern as
// `src/lib/protocol-router-spawn.ts` (`_deps` injection).
// ============================================================================

export const _deps = {
  loadCanonical: loadCanonicalSelfLeaderTeam,
};

/**
 * Wrapper used by callers that don't want to thread `loadCanonical` through.
 * Hits `_deps.loadCanonical` so test suites can patch the dependency.
 */
export async function resolveTeamForSpawnWithDeps(
  opts: Omit<ResolveTeamOptions, 'loadCanonical'>,
): Promise<ResolveTeamOutcome> {
  return resolveTeamForSpawn({ ...opts, loadCanonical: _deps.loadCanonical });
}
