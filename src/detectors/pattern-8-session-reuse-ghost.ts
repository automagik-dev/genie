// Cross-ref: OSS issue #1215 (session reuse ghost / cross-team name collision)
/**
 * Pattern 8 — Session Reuse Ghost Detector.
 *
 * Rot condition:
 *   A fresh agent is spawned with `custom_name=X` in team A, while another
 *   agent with `custom_name=X` previously existed in team B — and team B is
 *   now archived (`teams.status='archived'`). The topic seed for the new
 *   agent (its first user prompt) does NOT share its first N=8 tokens with
 *   the archived agent's first assistant/user transcript entry.
 *
 * User-visible symptom:
 *   Felipe spawns "engineer" in team `wish-42`; claude-code re-attaches to
 *   an old `engineer` transcript from disbanded team `wish-17`. The worker
 *   starts executing `wish-17`'s goals against `wish-42`'s branch. OSS
 *   issue #1215 tracks the substrate bug; this detector surfaces the
 *   manifestation operationally.
 *
 * Heuristic rationale (documented here because Group 5's runbook reads it):
 *   "Topic seed doesn't match archived transcript" is inherently fuzzy. V1
 *   uses the cheapest-signal-that-is-usually-right rule:
 *     1. Normalize both strings to lowercase, strip punctuation, split on
 *        whitespace.
 *     2. Take the first 8 tokens from each side.
 *     3. If the Jaccard similarity (|A ∩ B| / |A ∪ B|) is < 0.25, fire.
 *
 *   Why 8 tokens: operators tend to start prompts with a noun-phrase subject
 *   ("fix bug 1215 in router") — 8 tokens capture enough specificity to
 *   distinguish topic domains while staying short enough to survive cap-
 *   at-first-N truncation when transcripts are multi-megabyte.
 *
 *   Why Jaccard 0.25: empirically chosen against the two manually-curated
 *   cases in the wish handoff (OSS #1215 + one lookalike from team
 *   `wish-42`). Re-tune after B2 evidence accumulation (the runbook SHOULD
 *   gate any remediation on a manual operator review, not on this threshold
 *   alone).
 *
 *   What this heuristic misses:
 *     - A new prompt that happens to share a subject noun with an unrelated
 *       old topic (rare — captured as a DONE_WITH_CONCERNS in the PR body).
 *     - A new prompt whose first 8 tokens are intentionally generic
 *       ("continue where we left off"). We cap the false-positive blast
 *       radius via the hourly fire_budget in the scheduler.
 *
 * Dependency injection:
 *   `makeSessionReuseGhostDetector(deps)` accepts `loadState` for tests.
 *   Production wires PG reads.
 */

import { listAgents } from '../lib/agent-registry.js';
import { getConnection } from '../lib/db.js';
import type { DetectorEvent, DetectorModule } from './index.js';
import { registerDetector } from './index.js';

/** How far back we look for fresh spawns. */
const SPAWN_LOOKBACK_MS = 10 * 60_000;
/** Token count cap for topic-seed comparison. */
export const TOPIC_SEED_TOKEN_CAP = 8;
/** Jaccard similarity threshold below which we fire. */
export const TOPIC_MISMATCH_THRESHOLD = 0.25;
/** Maximum transcript chars to scan for the first user/assistant turn. */
const TRANSCRIPT_PREVIEW_CAP = 2048;

export interface SessionReuseGhostRow {
  readonly new_agent_id: string;
  readonly new_team: string;
  readonly new_topic_seed: string;
  readonly conflicting_archived_agent_id: string;
  readonly conflicting_archived_team: string;
  readonly conflicting_archived_last_transcript_preview: string;
  readonly jaccard_similarity: number;
}

export interface SessionReuseGhostState {
  readonly ghosts: ReadonlyArray<SessionReuseGhostRow>;
}

interface SessionReuseGhostDeps {
  readonly loadState: () => Promise<SessionReuseGhostState>;
}

/** Normalize a free-form message into comparable tokens. */
export function topicTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, TOPIC_SEED_TOKEN_CAP);
}

/** Jaccard similarity over the token sets; returns 0 when both empty. */
export function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Production loader. Query budget:
 *   - 1 SELECT on `agents` joining `teams` by team name to find archived
 *     peers with same custom_name.
 *   - 1 SELECT per candidate on `genie_runtime_events` for the first-turn
 *     transcript preview.
 *   - 1 SELECT per candidate on `genie_runtime_events` for the new agent's
 *     first prompt text.
 *
 * Worst case ~30 candidates per tick — well under 500ms.
 */
/** Minimum fields we need from the fresh spawn for the ghost match logic. */
interface FreshCandidate {
  readonly id: string;
  readonly customName: string;
  readonly team: string;
}

/** Narrow a raw `AgentIdentity` into a `FreshCandidate`, or null if required fields are missing. */
function toFreshCandidate(
  a: { id: string; customName?: string; team?: string; startedAt: string },
  cutoff: string,
): FreshCandidate | null {
  if (a.startedAt < cutoff) return null;
  if (!a.customName || !a.team) return null;
  return { id: a.id, customName: a.customName, team: a.team };
}

async function findArchivedPeers(
  sql: Awaited<ReturnType<typeof getConnection>>,
  fresh: FreshCandidate,
): Promise<Array<{ agent_id: string; team: string }>> {
  return sql<Array<{ agent_id: string; team: string }>>`
    SELECT a.id AS agent_id, a.team
    FROM agents a
    JOIN teams t ON t.name = a.team
    WHERE a.custom_name = ${fresh.customName}
      AND a.id != ${fresh.id}
      AND a.team != ${fresh.team}
      AND t.status = 'archived'
    LIMIT 5
  `;
}

async function loadFreshSeed(sql: Awaited<ReturnType<typeof getConnection>>, fresh: FreshCandidate): Promise<string> {
  const freshSubject = `genie.user.${fresh.customName}.prompt`;
  const rows = await sql<Array<{ text: string }>>`
    SELECT text FROM genie_runtime_events
    WHERE subject = ${freshSubject}
      AND team = ${fresh.team}
    ORDER BY id ASC
    LIMIT 1
  `;
  return rows[0]?.text?.slice(0, TRANSCRIPT_PREVIEW_CAP) ?? '';
}

async function loadArchivedPreview(sql: Awaited<ReturnType<typeof getConnection>>, peerTeam: string): Promise<string> {
  const rows = await sql<Array<{ text: string }>>`
    SELECT text FROM genie_runtime_events
    WHERE team = ${peerTeam}
      AND kind IN ('user', 'assistant', 'message')
    ORDER BY id ASC
    LIMIT 1
  `;
  return rows[0]?.text?.slice(0, TRANSCRIPT_PREVIEW_CAP) ?? '';
}

async function matchFreshAgainstPeers(
  sql: Awaited<ReturnType<typeof getConnection>>,
  fresh: FreshCandidate,
  peers: ReadonlyArray<{ agent_id: string; team: string }>,
  freshSeed: string,
  freshTokens: ReadonlyArray<string>,
): Promise<SessionReuseGhostRow | null> {
  for (const peer of peers) {
    const peerPreview = await loadArchivedPreview(sql, peer.team);
    const peerTokens = topicTokens(peerPreview);
    const similarity = jaccard(freshTokens, peerTokens);
    if (similarity >= TOPIC_MISMATCH_THRESHOLD) continue;
    return {
      new_agent_id: fresh.id,
      new_team: fresh.team,
      new_topic_seed: freshSeed.slice(0, 256),
      conflicting_archived_agent_id: peer.agent_id,
      conflicting_archived_team: peer.team,
      conflicting_archived_last_transcript_preview: peerPreview.slice(0, 256),
      jaccard_similarity: similarity,
    };
  }
  return null;
}

async function defaultLoadState(): Promise<SessionReuseGhostState> {
  const sql = await getConnection();
  const cutoff = new Date(Date.now() - SPAWN_LOOKBACK_MS).toISOString();

  const recent = (await listAgents())
    .map((a) => toFreshCandidate(a, cutoff))
    .filter((c): c is FreshCandidate => c !== null);
  if (recent.length === 0) return { ghosts: [] };

  const ghosts: SessionReuseGhostRow[] = [];
  for (const fresh of recent) {
    const peers = await findArchivedPeers(sql, fresh);
    if (peers.length === 0) continue;
    const freshSeed = await loadFreshSeed(sql, fresh);
    if (freshSeed.length === 0) continue;
    const freshTokens = topicTokens(freshSeed);
    const match = await matchFreshAgainstPeers(sql, fresh, peers, freshSeed, freshTokens);
    if (match !== null) ghosts.push(match);
  }

  return { ghosts };
}

export function makeSessionReuseGhostDetector(deps: SessionReuseGhostDeps): DetectorModule<SessionReuseGhostState> {
  return {
    id: 'rot.session-reuse-ghost',
    version: '1.0.0',
    riskClass: 'high',
    async query(): Promise<SessionReuseGhostState> {
      return deps.loadState();
    },
    shouldFire(state: SessionReuseGhostState): boolean {
      return state.ghosts.length > 0;
    },
    render(state: SessionReuseGhostState): DetectorEvent {
      const first = state.ghosts[0];
      return {
        type: 'rot.detected',
        subject: first?.new_agent_id ?? 'unknown',
        payload: {
          pattern_id: 'pattern-8-session-reuse-ghost',
          entity_id: first?.new_agent_id ?? 'unknown',
          observed_state_json: {
            new_agent_id: first?.new_agent_id ?? 'unknown',
            new_team: first?.new_team ?? 'unknown',
            new_topic_seed: first?.new_topic_seed ?? '',
            conflicting_archived_agent_id: first?.conflicting_archived_agent_id ?? 'unknown',
            conflicting_archived_team: first?.conflicting_archived_team ?? 'unknown',
            conflicting_archived_last_transcript_preview: first?.conflicting_archived_last_transcript_preview ?? '',
            jaccard_similarity: first?.jaccard_similarity ?? 0,
            ghost_count: state.ghosts.length,
          },
        },
      };
    },
  };
}

// Module-local default: side-effect registration below is the only thing
// that leaves this file in production; tests use `makeSessionReuseGhostDetector`.
const sessionReuseGhostDetector = makeSessionReuseGhostDetector({
  loadState: defaultLoadState,
});

// Self-register at module load.
registerDetector(sessionReuseGhostDetector);
