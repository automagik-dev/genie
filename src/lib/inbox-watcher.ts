/**
 * Inbox Watcher — Polls native inboxes for unread messages and
 * auto-spawns offline team-leads.
 *
 * Follows the idle-timeout.ts dependency-injection pattern so all
 * logic is unit-testable without tmux or filesystem side effects.
 */

import { listTeamsWithUnreadInbox } from './claude-native-teams.js';
import { emitEvent } from './emit.js';
import { parseRoutingHeader, resolveSessionKey } from './routing-header.js';
import { ensureTeamLead, isAgentAlive, isTeamActive } from './team-auto-spawn.js';

// ============================================================================
// Dependency injection (testability without real filesystem/tmux)
// ============================================================================

/**
 * Payload emitted when a session crosses the `MAX_SPAWN_FAILURES` threshold
 * and the watcher flips into silent-skip mode. See
 * `src/lib/events/schemas/rot.inbox-watcher-spawn-loop.detected.ts` for the
 * full Zod schema (Pattern 9 of the BUGLESS-GENIE roster).
 */
export interface DeadInboxEventPayload {
  team_name: string;
  session_key: string;
  failure_count: number;
  last_error_message: string;
}

/** Dependencies used by inbox-watcher functions. */
export interface InboxWatcherDeps {
  listTeamsWithUnreadInbox: typeof listTeamsWithUnreadInbox;
  isTeamActive: (teamName: string) => Promise<boolean>;
  isAgentAlive: (agentName: string) => Promise<boolean>;
  ensureTeamLead: (teamName: string, workingDir: string) => Promise<{ created: boolean }>;
  warn: (msg: string) => void;
  /**
   * Emits `rot.inbox-watcher-spawn-loop.detected` on the transition from
   * `failures === MAX_SPAWN_FAILURES - 1` to `failures === MAX_SPAWN_FAILURES`.
   * Called exactly once per session key per daemon lifetime (until
   * `resetSpawnFailures()` clears the counter). Fire-and-forget — errors
   * must not bubble into the watcher loop.
   */
  emitDeadInbox: (payload: DeadInboxEventPayload) => void;
}

/** Default production dependencies. */
const defaultDeps: InboxWatcherDeps = {
  listTeamsWithUnreadInbox,
  isTeamActive: (teamName) => isTeamActive(teamName),
  isAgentAlive: (agentName) => isAgentAlive(agentName),
  ensureTeamLead: (teamName, workingDir) => ensureTeamLead(teamName, workingDir),
  warn: (msg) => console.warn(msg),
  emitDeadInbox: (payload) => {
    // Fire-and-forget per emit.ts contract; swallow any synchronous error so
    // the watcher poll loop never crashes on an emit glitch. The cast widens
    // our strictly-typed payload to `Record<string, unknown>` at the emit
    // boundary only — internal callers keep the full DeadInboxEventPayload
    // signature for compile-time correctness.
    try {
      emitEvent('rot.inbox-watcher-spawn-loop.detected', payload as unknown as Record<string, unknown>);
    } catch {
      // intentionally swallowed — emit path is best-effort
    }
  },
};

// ============================================================================
// Configuration
// ============================================================================

/** Default inbox poll interval in milliseconds (30 seconds). */
const INBOX_POLL_INTERVAL_MS = 30_000;

/** Maximum consecutive spawn failures before skipping a team. */
const MAX_SPAWN_FAILURES = 3;

/**
 * Re-warn interval for teams missing workingDir (1 hour).
 * After this interval, the warning re-fires — so if workingDir gets populated,
 * the next poll cycle will naturally attempt the spawn again.
 */
const NO_WORKING_DIR_RECHECK_MS = 60 * 60 * 1000;

/**
 * Get the inbox poll interval from env or default.
 * Set GENIE_INBOX_POLL_MS to override (0 = disabled).
 */
export function getInboxPollIntervalMs(): number {
  const env = process.env.GENIE_INBOX_POLL_MS;
  if (env !== undefined) {
    if (env === '') return INBOX_POLL_INTERVAL_MS;
    const parsed = Number(env);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return INBOX_POLL_INTERVAL_MS;
}

// ============================================================================
// Spawn failure tracking (in-memory, resets on daemon restart)
// ============================================================================

/** Consecutive spawn failure counts per team. */
const spawnFailures = new Map<string, number>();

/**
 * Last timestamp (ms) a "missing workingDir" warning was emitted per team.
 * Prevents logging the same warning every poll cycle (every 30s by default);
 * re-fires after NO_WORKING_DIR_RECHECK_MS so populated configs recover.
 */
const noWorkingDirWarned = new Map<string, number>();

/** Reset all failure counts (exposed for testing). */
export function resetSpawnFailures(): void {
  spawnFailures.clear();
}

/** Reset missing-workingDir warning cache (exposed for testing). */
export function resetNoWorkingDirWarned(): void {
  noWorkingDirWarned.clear();
}

// ============================================================================
// Session key resolution
// ============================================================================

/** Resolve a session key from the first unread message's routing header, or fall back to team name. */
function resolveSessionKeyFromMessage(teamName: string, firstUnreadText: string | null): string {
  if (!firstUnreadText) return teamName;
  const header = parseRoutingHeader(firstUnreadText);
  return header ? resolveSessionKey(teamName, header) : teamName;
}

/**
 * Rate-limit the "no workingDir" warning per team. Returns true if the
 * caller should emit a warning now; false if it was recently emitted.
 * The cache re-opens after NO_WORKING_DIR_RECHECK_MS so populated configs
 * naturally re-warn if they regress.
 */
function shouldWarnMissingWorkingDir(teamName: string): boolean {
  const now = Date.now();
  const lastWarned = noWorkingDirWarned.get(teamName) ?? 0;
  if (now - lastWarned < NO_WORKING_DIR_RECHECK_MS) return false;
  noWorkingDirWarned.set(teamName, now);
  return true;
}

/**
 * Attempt to spawn a team-lead; track failures in `spawnFailures`.
 * Returns true on success (caller adds team to `spawned` list).
 *
 * On the exact transition to `MAX_SPAWN_FAILURES`, fires a
 * `rot.inbox-watcher-spawn-loop.detected` event via `deps.emitDeadInbox`
 * so downstream consumers (B-project detectors, operator runbooks) can
 * observe the silent-skip state without polling the in-memory counter.
 * Subsequent failures at or above the threshold do NOT re-emit (prevents
 * polling-cadence flooding of the event substrate). The counter is reset
 * on a successful spawn.
 */
async function attemptSpawn(
  deps: InboxWatcherDeps,
  teamName: string,
  workingDir: string,
  sessionKey: string,
  currentFailures: number,
): Promise<boolean> {
  try {
    await deps.ensureTeamLead(teamName, workingDir);
    spawnFailures.set(sessionKey, 0); // Reset on success
    return true;
  } catch (err) {
    const newCount = currentFailures + 1;
    spawnFailures.set(sessionKey, newCount);
    const message = err instanceof Error ? err.message : String(err);
    deps.warn(
      `[inbox-watcher] Failed to spawn team-lead for "${teamName}" (attempt ${newCount}/${MAX_SPAWN_FAILURES}): ${message}`,
    );
    // Pattern 9 — fire dead-inbox event exactly on the transition to the
    // silent-skip state. The watcher has already tracked the failure; now
    // the rest of the system learns about it.
    if (newCount === MAX_SPAWN_FAILURES) {
      deps.emitDeadInbox({
        team_name: teamName,
        session_key: sessionKey,
        failure_count: newCount,
        // Bound the message length to match the schema cap (2 KiB).
        last_error_message: message.length > 2048 ? `${message.slice(0, 2045)}...` : message,
      });
    }
    return false;
  }
}

// ============================================================================
// Main polling function
// ============================================================================

/**
 * Check all team inboxes and spawn team-leads for inactive teams
 * that have unread messages.
 *
 * Returns list of team names where spawn was triggered.
 */
export async function checkInboxes(deps: InboxWatcherDeps = defaultDeps): Promise<string[]> {
  const pollMs = getInboxPollIntervalMs();
  if (pollMs === 0) return []; // Disabled

  const teamsWithUnread = await deps.listTeamsWithUnreadInbox();
  const spawned: string[] = [];

  for (const { teamName, workingDir, firstUnreadText } of teamsWithUnread) {
    const sessionKey = resolveSessionKeyFromMessage(teamName, firstUnreadText);

    // Skip sessions that have exceeded max spawn failures
    const failures = spawnFailures.get(sessionKey) ?? 0;
    if (failures >= MAX_SPAWN_FAILURES) {
      deps.warn(`[inbox-watcher] Skipping "${sessionKey}" — ${failures} consecutive spawn failures`);
      continue;
    }

    // Skip teams that already have an active team-lead
    const active = await deps.isTeamActive(teamName);
    if (active) continue;

    // No working dir means we can't spawn — warn once per team, then silence
    // until NO_WORKING_DIR_RECHECK_MS elapses (lets populated configs recover).
    if (!workingDir) {
      if (shouldWarnMissingWorkingDir(teamName)) {
        deps.warn(`[inbox-watcher] Cannot spawn team-lead for "${teamName}" — no workingDir in config`);
      }
      continue;
    }
    // Config recovered — clear cache so any future regression re-warns immediately.
    noWorkingDirWarned.delete(teamName);

    const ok = await attemptSpawn(deps, teamName, workingDir, sessionKey, failures);
    if (ok) spawned.push(teamName);
  }

  return spawned;
}

// ============================================================================
// Daemon lifecycle
// ============================================================================

/**
 * Start the inbox watcher polling loop.
 * Returns a handle that can be passed to `stopInboxWatcher()`.
 */
export function startInboxWatcher(deps: InboxWatcherDeps = defaultDeps): NodeJS.Timeout {
  return setInterval(() => {
    checkInboxes(deps).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.warn(`[inbox-watcher] Poll error: ${message}`);
    });
  }, getInboxPollIntervalMs());
}

/**
 * Stop the inbox watcher polling loop.
 */
export function stopInboxWatcher(handle: NodeJS.Timeout): void {
  clearInterval(handle);
}
