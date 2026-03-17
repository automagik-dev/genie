/**
 * Inbox Watcher — Polls native inboxes for unread messages and
 * auto-spawns offline team-leads.
 *
 * Follows the idle-timeout.ts dependency-injection pattern so all
 * logic is unit-testable without tmux or filesystem side effects.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveSessionName } from '../genie-commands/session.js';
import { listTeamsWithUnreadInbox } from './claude-native-teams.js';
import { ensureTeamLead, isTeamActive } from './team-auto-spawn.js';

// ============================================================================
// Dependency injection (testability without real filesystem/tmux)
// ============================================================================

/** Dependencies used by inbox-watcher functions. */
export interface InboxWatcherDeps {
  listTeamsWithUnreadInbox: typeof listTeamsWithUnreadInbox;
  isTeamActive: (teamName: string, sessionName: string) => Promise<boolean>;
  ensureTeamLead: (teamName: string, workingDir: string) => Promise<{ created: boolean }>;
  warn: (msg: string) => void;
}

/** Default production dependencies. */
const defaultDeps: InboxWatcherDeps = {
  listTeamsWithUnreadInbox,
  isTeamActive: (teamName, sessionName) => isTeamActive(teamName, sessionName),
  ensureTeamLead: (teamName, workingDir) => ensureTeamLead(teamName, workingDir),
  warn: (msg) => console.warn(msg),
};

// ============================================================================
// Configuration
// ============================================================================

/** Default inbox poll interval in milliseconds (30 seconds). */
export const INBOX_POLL_INTERVAL_MS = 30_000;
const INBOX_WATCHER_PID_FILE = 'inbox-watcher.pid';

/** Maximum consecutive spawn failures before skipping a team. */
const MAX_SPAWN_FAILURES = 3;

/** Resolve the session name for a team's working directory. */
async function resolveTeamSession(workingDir: string | null | undefined): Promise<string> {
  if (process.env.GENIE_SESSION) return process.env.GENIE_SESSION;
  if (workingDir) return resolveSessionName(workingDir);
  return 'genie';
}

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

function getGlobalDir(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

export function getInboxWatcherPidPath(): string {
  return join(getGlobalDir(), INBOX_WATCHER_PID_FILE);
}

export async function readInboxWatcherPid(): Promise<number | null> {
  try {
    const raw = (await readFile(getInboxWatcherPidPath(), 'utf-8')).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeInboxWatcherPid(pid = process.pid): Promise<void> {
  const pidPath = getInboxWatcherPidPath();
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, `${pid}\n`);
}

export async function clearInboxWatcherPid(pid = process.pid): Promise<void> {
  const currentPid = await readInboxWatcherPid();
  if (currentPid !== pid) return;

  try {
    await unlink(getInboxWatcherPidPath());
  } catch {
    // Best-effort cleanup.
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

  for (const { teamName, workingDir } of teamsWithUnread) {
    // Skip teams that have exceeded max spawn failures
    const failures = spawnFailures.get(teamName) ?? 0;
    if (failures >= MAX_SPAWN_FAILURES) {
      deps.warn(`[inbox-watcher] Skipping team "${teamName}" — ${failures} consecutive spawn failures`);
      continue;
    }

    const sessionName = await resolveTeamSession(workingDir ?? undefined);

    // Skip teams that already have an active team-lead
    const active = await deps.isTeamActive(teamName, sessionName);
    if (active) continue;

    // No working dir means we can't spawn
    if (!workingDir) {
      deps.warn(`[inbox-watcher] Cannot spawn team-lead for "${teamName}" — no workingDir in config`);
      continue;
    }

    // Attempt to spawn team-lead
    try {
      await deps.ensureTeamLead(teamName, workingDir);
      spawnFailures.set(teamName, 0); // Reset on success
      spawned.push(teamName);
    } catch (err) {
      const newCount = failures + 1;
      spawnFailures.set(teamName, newCount);
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
 * Returns `null` when polling is disabled.
 */
export function startInboxWatcher(deps: InboxWatcherDeps = defaultDeps): NodeJS.Timeout | null {
  const pollMs = getInboxPollIntervalMs();
  if (pollMs === 0) return null;

  checkInboxes(deps).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    deps.warn(`[inbox-watcher] Initial poll error: ${message}`);
  });

  return setInterval(() => {
    checkInboxes(deps).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.warn(`[inbox-watcher] Poll error: ${message}`);
    });
  }, pollMs);
}

/**
 * Stop the inbox watcher polling loop.
 */
export function stopInboxWatcher(handle: NodeJS.Timeout | null): void {
  if (!handle) return;
  clearInterval(handle);
}
