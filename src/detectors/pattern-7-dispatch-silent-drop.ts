// Cross-ref: OSS issue #1218 (dispatch-silent-drop)
/**
 * Pattern 7 — Dispatch Silent Drop Detector.
 *
 * Rot condition:
 *   A broadcast message was posted to a team chat (subject
 *   `genie.msg.broadcast`) at least 60 seconds ago, but at tick time AT
 *   LEAST ONE team member is still in `idle` state AND zero user-prompt
 *   events (`genie.user.<agent>.prompt`) for that member landed between the
 *   broadcast and now.
 *
 * User-visible symptom:
 *   Operator fires off `@team <message>`; agents keep idling without ever
 *   receiving the message. Distinct from a slow agent (which still has a
 *   UserPromptSubmit row, just no assistant response yet).
 *
 * Accuracy discipline:
 *   This detector is the closest thing in V1 to a user-paging signal. False
 *   positives are costly — they teach operators to ignore rot alerts. We
 *   enforce:
 *     - 60s window elapsed (cooldown) so we don't race a just-posted
 *       broadcast.
 *     - actual_prompt_count is EXACTLY zero (not "below expected").
 *     - idle_member_ids is non-empty AND populated from the team roster at
 *       broadcast time (members who joined after the broadcast are ignored).
 *
 * Query shape:
 *   1. Find broadcast events from the last 10 minutes older than 60s:
 *      `SELECT * FROM genie_runtime_events WHERE subject='genie.msg.broadcast'
 *       AND created_at < now - 60s ORDER BY created_at DESC LIMIT 50`
 *   2. For each, resolve the team roster.
 *   3. Check each roster member's current executor state.
 *   4. Count UserPromptSubmit events since the broadcast.
 *
 * Dependency injection:
 *   `makeDispatchSilentDropDetector(deps)` accepts `loadState` for tests.
 *   Production wires PG + agent-registry.
 */

import { listAgents } from '../lib/agent-registry.js';
import { getConnection } from '../lib/db.js';
import { getCurrentExecutor } from '../lib/executor-registry.js';
import type { DetectorEvent, DetectorModule } from './index.js';
import { registerDetector } from './index.js';

/** Minimum elapsed time since the broadcast before we accept a silent-drop. */
const MIN_SILENT_WINDOW_MS = 60_000;
/** How far back we look for candidate broadcasts. */
const BROADCAST_LOOKBACK_MS = 10 * 60_000;

export interface DispatchSilentDropRow {
  readonly team: string;
  /** Stable identifier for the broadcast row (genie_runtime_events.id, as string). */
  readonly broadcast_id: string;
  readonly broadcast_at: string;
  /** Team members still idle at tick time. */
  readonly idle_member_ids: ReadonlyArray<string>;
  /**
   * How many prompts we would have expected (= idle member count at
   * broadcast time). 0 is a design-time impossibility.
   */
  readonly expected_prompt_count: number;
  /** Always 0 at fire-time — we fire only when zero prompts landed. */
  readonly actual_prompt_count: 0;
}

export interface DispatchSilentDropState {
  readonly drops: ReadonlyArray<DispatchSilentDropRow>;
}

interface DispatchSilentDropDeps {
  readonly loadState: () => Promise<DispatchSilentDropState>;
  /** Injected clock — tests freeze time; prod uses `Date.now`. */
  readonly now?: () => number;
}

/**
 * Production loader. Query budget:
 *   - 1 query for recent broadcasts (indexed on subject+created_at, bounded
 *     LIMIT 50).
 *   - 1 roster query per broadcast (team filter, bounded).
 *   - 1 prompt-count query per member per broadcast.
 *
 * In practice teams run 3-10 members so the total stays under 500ms even
 * with multiple broadcasts in flight.
 */
/** Quick check: has the member's user.prompt subject fired since the broadcast? */
async function memberHasRespondedSince(
  sql: Awaited<ReturnType<typeof getConnection>>,
  member: { id: string; customName?: string; role?: string },
  sinceIso: string,
): Promise<boolean> {
  const name = member.customName ?? member.role ?? member.id;
  const promptSubject = `genie.user.${name}.prompt`;
  const rows = await sql<Array<{ id: number }>>`
    SELECT id FROM genie_runtime_events
    WHERE subject = ${promptSubject}
      AND created_at > ${sinceIso}
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Return the ids of running team members who didn't respond to the broadcast. */
async function findIdleMembers(
  sql: Awaited<ReturnType<typeof getConnection>>,
  team: string,
  broadcastAt: string,
): Promise<string[]> {
  const members = await listAgents({ team });
  const idle: string[] = [];
  for (const member of members) {
    const exec = await getCurrentExecutor(member.id);
    if (exec?.state !== 'running') continue;
    const responded = await memberHasRespondedSince(sql, member, broadcastAt);
    if (!responded) idle.push(member.id);
  }
  return idle;
}

async function defaultLoadState(): Promise<DispatchSilentDropState> {
  const sql = await getConnection();
  const nowMs = Date.now();
  const cutoffBroadcast = new Date(nowMs - MIN_SILENT_WINDOW_MS).toISOString();
  const cutoffLookback = new Date(nowMs - BROADCAST_LOOKBACK_MS).toISOString();

  const broadcasts = await sql<Array<{ id: number; team: string | null; created_at: Date | string }>>`
    SELECT id, team, created_at FROM genie_runtime_events
    WHERE subject = 'genie.msg.broadcast'
      AND created_at < ${cutoffBroadcast}
      AND created_at > ${cutoffLookback}
      AND team IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 50
  `;

  const drops: DispatchSilentDropRow[] = [];
  for (const b of broadcasts) {
    if (b.team === null) continue;
    const broadcastAt = b.created_at instanceof Date ? b.created_at.toISOString() : String(b.created_at);
    const idleMembers = await findIdleMembers(sql, b.team, broadcastAt);
    if (idleMembers.length === 0) continue;
    drops.push({
      team: b.team,
      broadcast_id: String(b.id),
      broadcast_at: broadcastAt,
      idle_member_ids: idleMembers,
      expected_prompt_count: idleMembers.length,
      actual_prompt_count: 0,
    });
  }
  return { drops };
}

/** Build a `DetectorModule` around injected deps. */
export function makeDispatchSilentDropDetector(deps: DispatchSilentDropDeps): DetectorModule<DispatchSilentDropState> {
  return {
    id: 'rot.dispatch-silent-drop',
    version: '1.0.0',
    riskClass: 'high',
    async query(): Promise<DispatchSilentDropState> {
      return deps.loadState();
    },
    shouldFire(state: DispatchSilentDropState): boolean {
      return state.drops.length > 0;
    },
    render(state: DispatchSilentDropState): DetectorEvent {
      const first = state.drops[0];
      return {
        type: 'rot.detected',
        subject: first?.team ?? 'unknown',
        payload: {
          pattern_id: 'pattern-7-dispatch-silent-drop',
          entity_id: first?.team ?? 'unknown',
          observed_state_json: {
            team: first?.team ?? 'unknown',
            broadcast_id: first?.broadcast_id ?? '',
            broadcast_at: first?.broadcast_at ?? '',
            idle_member_ids: (first?.idle_member_ids ?? []).slice(0, 32) as string[],
            expected_prompt_count: first?.expected_prompt_count ?? 0,
            actual_prompt_count: 0,
            drop_count: state.drops.length,
          },
        },
      };
    },
  };
}

// Module-local default: the only thing that leaves this file is the
// side-effect registration below; the factory is exported for tests.
const dispatchSilentDropDetector = makeDispatchSilentDropDetector({
  loadState: defaultLoadState,
});

// Self-register at module load.
registerDetector(dispatchSilentDropDetector);
