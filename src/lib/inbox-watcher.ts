/**
 * Inbox Watcher — Polls native inboxes for unread messages and
 * auto-spawns offline team-leads.
 *
 * Follows the idle-timeout.ts dependency-injection pattern so all
 * logic is unit-testable without tmux or filesystem side effects.
 */

import { listTeamsWithUnreadInbox } from './claude-native-teams.js';
import { parseRoutingHeader, resolveSessionKey } from './routing-header.js';
import { ensureTeamLead, isAgentAlive, isTeamActive } from './team-auto-spawn.js';

// ============================================================================
// Dependency injection (testability without real filesystem/tmux)
// ============================================================================

/** Dependencies used by inbox-watcher functions. */
export interface InboxWatcherDeps {
  listTeamsWithUnreadInbox: typeof listTeamsWithUnreadInbox;
  isTeamActive: (teamName: string) => Promise<boolean>;
  isAgentAlive: (agentName: string) => Promise<boolean>;
  ensureTeamLead: (teamName: string, workingDir: string) => Promise<{ created: boolean }>;
  warn: (msg: string) => void;
}

/** Default production dependencies. */
const defaultDeps: InboxWatcherDeps = {
  listTeamsWithUnreadInbox,
  isTeamActive: (teamName) => isTeamActive(teamName),
  isAgentAlive: (agentName) => isAgentAlive(agentName),
  ensureTeamLead: (teamName, workingDir) => ensureTeamLead(teamName, workingDir),
  warn: (msg) => console.warn(msg),
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
