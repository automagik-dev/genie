// Cross-ref: OSS issue #1214 (anchor orphan / ghost agent drift)
/**
 * Pattern 3 — Anchor Orphan Detector.
 *
 * Rot condition:
 *   An `agents` row whose current executor claims an alive-ish state
 *   (`spawning` | `running`) but whose tmux pane is no longer alive AND no
 *   transcript file is present on disk. `genie ls` surfaces the row as
 *   `working`, but there is nothing to attach to — the user sees a ghost.
 *
 * Why it matters:
 *   Catches the "alive in PG, dead in tmux" drift. Root causes vary (tmux
 *   crash, kill -9, resume-attempt mis-accounting). V1 is measurement only;
 *   V2 graduates to an auto-reconcile runbook once evidence accumulates.
 *
 * Query shape:
 *   Joins `agents` against `executors` (current executor FK) and, per row,
 *   probes `isPaneAlive()` + checks for a transcript file. Any agent whose
 *   executor row claims alive but whose pane AND transcript are both missing
 *   is flagged.
 *
 * Dependency injection:
 *   The exported factory `makeAnchorOrphanDetector(deps)` accepts a `loadState`
 *   function for tests. The production default wires PG + tmux probes.
 *   Tests pass a capture closure producing a fixture — no `mock.module`.
 *
 * Read-only discipline:
 *   The detector never mutates genie state. Fixing the underlying drift
 *   belongs in a future B2 wish (per the self-healing roadmap).
 */

import { existsSync } from 'node:fs';
import { listAgents } from '../lib/agent-registry.js';
import { getConnection } from '../lib/db.js';
import { getCurrentExecutor } from '../lib/executor-registry.js';
import { isPaneAlive } from '../lib/tmux.js';
import type { DetectorEvent, DetectorModule } from './index.js';
import { registerDetector } from './index.js';

/** Shape of a single orphan candidate after probing tmux/transcript. */
export interface AnchorOrphanRow {
  /** Agent identity (PG id). Subject of the emitted event — hashed at parse. */
  readonly agent_id: string;
  /** Human-readable custom name (or role fallback). */
  readonly custom_name: string;
  /** Team the agent belonged to. */
  readonly team: string;
  /**
   * Most recent `executors.updated_at` / `agents.last_state_change` we could
   * observe. ISO-8601.
   */
  readonly last_seen_at: string;
  /** Tmux session the row expects to attach to. */
  readonly expected_session_id: string;
  /** Tmux pane id the row points at. */
  readonly expected_pane_id: string;
  /** Live probe: `false` means the pane was missing/dead at tick time. */
  readonly tmux_present: boolean;
  /**
   * Disk probe: whether the transcript file exists. `false` means the on-disk
   * record vanished — typically a stale worktree cleanup or tmux-history
   * rotation.
   */
  readonly transcript_present: boolean;
}

export interface AnchorOrphanState {
  readonly orphans: ReadonlyArray<AnchorOrphanRow>;
}

/** Deps surface — injected so tests can skip the DB + tmux layer entirely. */
interface AnchorOrphanDeps {
  /**
   * Resolve all orphan candidates. In production wires through agent-registry
   * + executor-registry + tmux + fs. Tests inject fixtures.
   */
  readonly loadState: () => Promise<AnchorOrphanState>;
}

/**
 * Production loader. Keeps the query budget under 500ms by:
 *   1. A single SQL round-trip for `listAgents({})`.
 *   2. A per-agent `getCurrentExecutor()` hit (indexed PK lookup).
 *   3. Bounded tmux probes — tmux `display-message` is microsecond-scale.
 *
 * The total round-trip scales linearly in the active-agent count (usually
 * <100 in production).
 */
/** Active executor states worth probing — everything else already reports done. */
function isProbeableExecutorState(state: string): boolean {
  return state === 'running' || state === 'spawning';
}

/** Resolve the freshest last-seen timestamp from PG, falling back to startedAt. */
async function resolveLastSeen(
  sql: Awaited<ReturnType<typeof getConnection>>,
  executorId: string,
  fallback: string,
): Promise<string> {
  const rows = await sql<{ updated_at: Date | string }[]>`
    SELECT updated_at FROM executors WHERE id = ${executorId}
  `;
  const lastSeen = rows[0]?.updated_at ?? fallback;
  return typeof lastSeen === 'string' ? lastSeen : new Date(lastSeen).toISOString();
}

/**
 * Probe a single agent for orphan signals. Returns null if the agent is
 * alive, not probeable, or lacks an executor row; returns an orphan row
 * when both tmux AND worktree are gone.
 */
async function probeAgent(
  sql: Awaited<ReturnType<typeof getConnection>>,
  agent: { id: string; customName?: string; role?: string; team?: string },
): Promise<AnchorOrphanRow | null> {
  const executor = await getCurrentExecutor(agent.id);
  if (executor === null) return null;
  if (!isProbeableExecutorState(executor.state)) return null;

  const paneId = executor.tmuxPaneId ?? '';
  const tmuxPresent = await isPaneAliveSafe(paneId);
  if (tmuxPresent) return null;

  // Transcript presence heuristic — see class docstring. A vanished worktree
  // plus a dead pane is the "clear orphan" signal; a still-present worktree
  // means we need more evidence and we do not fire.
  const transcriptPresent = executor.worktree ? existsSync(executor.worktree) : false;
  if (transcriptPresent) return null;

  const lastSeenAt = await resolveLastSeen(sql, executor.id, executor.startedAt);

  return {
    agent_id: agent.id,
    custom_name: agent.customName ?? agent.role ?? agent.id,
    team: agent.team ?? 'unknown',
    last_seen_at: lastSeenAt,
    expected_session_id: executor.tmuxSession ?? '',
    expected_pane_id: paneId,
    tmux_present: false,
    transcript_present: false,
  };
}

async function defaultLoadState(): Promise<AnchorOrphanState> {
  const agents = await listAgents();
  const sql = await getConnection();
  const orphans: AnchorOrphanRow[] = [];
  for (const agent of agents) {
    const orphan = await probeAgent(sql, agent);
    if (orphan !== null) orphans.push(orphan);
  }
  return { orphans };
}

/** Wrap `isPaneAlive` so tmux-unreachable errors do not crash the tick. */
async function isPaneAliveSafe(paneId: string): Promise<boolean> {
  try {
    return await isPaneAlive(paneId);
  } catch {
    // TmuxUnreachableError or any other infra blip — treat as "we don't know"
    // and bail to the safe side: report pane present so we do NOT false-fire.
    return true;
  }
}

/** Build a `DetectorModule` around an injected deps object. */
export function makeAnchorOrphanDetector(deps: AnchorOrphanDeps): DetectorModule<AnchorOrphanState> {
  return {
    id: 'rot.anchor-orphan',
    version: '1.0.0',
    riskClass: 'high',
    async query(): Promise<AnchorOrphanState> {
      return deps.loadState();
    },
    shouldFire(state: AnchorOrphanState): boolean {
      return state.orphans.length > 0;
    },
    render(state: AnchorOrphanState): DetectorEvent {
      // Emit ONE event per tick carrying a compact summary; downstream
      // consumers can page through the full list via the evidence keys.
      const first = state.orphans[0];
      const agentIds = state.orphans.map((o) => o.agent_id).slice(0, 32);
      const customNames = state.orphans.map((o) => o.custom_name).slice(0, 32);
      const lastSeen = state.orphans.map((o) => o.last_seen_at).slice(0, 32);

      return {
        type: 'rot.detected',
        subject: first?.agent_id ?? 'unknown',
        payload: {
          pattern_id: 'pattern-3-anchor-orphan',
          entity_id: first?.agent_id ?? 'unknown',
          observed_state_json: {
            agent_id: first?.agent_id ?? 'unknown',
            custom_name: first?.custom_name ?? 'unknown',
            team: first?.team ?? 'unknown',
            last_seen_at: first?.last_seen_at ?? '',
            expected_session_id: first?.expected_session_id ?? '',
            expected_pane_id: first?.expected_pane_id ?? '',
            tmux_present: false,
            transcript_present: false,
            orphan_count: state.orphans.length,
            all_agent_ids: agentIds,
            all_custom_names: customNames,
            all_last_seen_at: lastSeen,
          },
        },
      };
    },
  };
}

// Production default — reads from real PG + tmux + fs. Kept module-local
// (not exported) so knip does not flag it: only the side-effect registration
// matters outside this file; tests use the `makeAnchorOrphanDetector` factory.
const anchorOrphanDetector = makeAnchorOrphanDetector({
  loadState: defaultLoadState,
});

// Self-register at module load so `src/detectors/index.ts` imports pull the
// default into the global registry for the scheduler to pick up.
registerDetector(anchorOrphanDetector);
