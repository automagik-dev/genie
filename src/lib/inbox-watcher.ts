/**
 * Inbox Watcher — Polls native inboxes for unread messages and
 * auto-spawns offline team-leads.
 *
 * Follows the idle-timeout.ts dependency-injection pattern so all
 * logic is unit-testable without tmux or filesystem side effects.
 */

import { listTeamsWithUnreadInbox } from './claude-native-teams.js';
import { parseRoutingHeader, resolveSessionKey } from './routing-header.js';
import { ensureTeamLead, isTeamActive } from './team-auto-spawn.js';

// ============================================================================
// Dependency injection (testability without real filesystem/tmux)
// ============================================================================

/** Dependencies used by inbox-watcher functions. */
export interface InboxWatcherDeps {
  listTeamsWithUnreadInbox: typeof listTeamsWithUnreadInbox;
  isTeamActive: (teamName: string) => Promise<boolean>;
  ensureTeamLead: (teamName: string, workingDir: string) => Promise<{ created: boolean }>;
  warn: (msg: string) => void;
}

/** Default production dependencies. */
const defaultDeps: InboxWatcherDeps = {
  listTeamsWithUnreadInbox,
  isTeamActive: (teamName) => isTeamActive(teamName),
  ensureTeamLead: (teamName, workingDir) => ensureTeamLead(teamName, workingDir),
  warn: (msg) => console.warn(msg),
};

// ============================================================================
// Configuration
// ============================================================================

/** Default inbox poll interval in milliseconds (30 seconds). */
export const INBOX_POLL_INTERVAL_MS = 30_000;

/** Maximum consecutive spawn failures before skipping a team. */
const MAX_SPAWN_FAILURES = 3;

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

/** Reset all failure counts (exposed for testing). */
export function resetSpawnFailures(): void {
  spawnFailures.clear();
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

    // No working dir means we can't spawn
    if (!workingDir) {
      deps.warn(`[inbox-watcher] Cannot spawn team-lead for "${teamName}" — no workingDir in config`);
      continue;
    }

    // Attempt to spawn team-lead
    try {
      await deps.ensureTeamLead(teamName, workingDir);
      spawnFailures.set(sessionKey, 0); // Reset on success
      spawned.push(teamName);
    } catch (err) {
      const newCount = failures + 1;
      spawnFailures.set(sessionKey, newCount);
      const message = err instanceof Error ? err.message : String(err);
      deps.warn(
        `[inbox-watcher] Failed to spawn team-lead for "${teamName}" (attempt ${newCount}/${MAX_SPAWN_FAILURES}): ${message}`,
      );
    }
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
