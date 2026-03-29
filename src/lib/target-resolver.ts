/**
 * Target Resolver - Resolves target strings to tmux pane IDs
 *
 * Resolution chain (DEC-1 from wish-26):
 *   1. Raw pane ID (starts with %) -> passthrough
 *   2. Worker[:index] (left side is registered worker) -> registry lookup + subpane index
 *   3. Session:window (contains :, left side is tmux session) -> tmux lookup
 *   4. Bare name -> exact ID → role (team) → customName → partial ID → substring → role (global) → partial role → partial customName
 *
 * Returns { paneId, session, workerId?, paneIndex?, resolvedVia }
 */

import type { Agent } from './agent-registry.js';
import { getCurrentSessionName } from './tmux.js';

// ============================================================================
// Types
// ============================================================================

export type ResolutionMethod = 'raw' | 'worker' | 'session:window';

export interface ResolvedTarget {
  /** The resolved tmux pane ID (e.g., "%17") */
  paneId: string;
  /** The tmux session name (when known) */
  session?: string;
  /** The worker ID if resolved via worker registry */
  workerId?: string;
  /** The pane index if resolved via worker:N notation */
  paneIndex?: number;
  /** How the target was resolved */
  resolvedVia: ResolutionMethod;
}

/**
 * Options for controlling resolver behavior.
 * Test code can inject mocks via these options.
 */
interface ResolveOptions {
  /** Whether to validate pane liveness via tmux (default: true in production) */
  checkLiveness?: boolean;

  /** Override registry path for testing */
  registryPath?: string;

  /** Inject workers directly (bypasses file-based registry) */
  workers?: Record<string, Agent>;

  /** Custom tmux lookup function (for session:window and session fallback) */
  tmuxLookup?: (sessionName: string, windowName?: string) => Promise<{ paneId: string; session: string } | null>;

  /** Custom pane liveness check (for testing) */
  isPaneLive?: (paneId: string) => Promise<boolean>;

  /** Custom dead pane cleanup callback (for testing) */
  cleanupDeadPane?: (workerId: string, paneId: string) => Promise<void>;

  /** Custom session derivation from pane ID (for testing) */
  deriveSession?: (paneId: string) => Promise<string | null>;

  /** Custom current team resolver (for testing) */
  getCurrentTeam?: () => Promise<string | null>;
}

// ============================================================================
// Debug logging
// ============================================================================

function debug(msg: string): void {
  if (process.env.DEBUG) {
    console.error(`[target-resolver] ${msg}`);
  }
}

// ============================================================================
// Default tmux operations (used when no mocks injected)
// ============================================================================

async function defaultTmuxLookup(
  sessionName: string,
  windowName?: string,
): Promise<{ paneId: string; session: string } | null> {
  try {
    const tmux = await import('./tmux.js');

    const session = await tmux.findSessionByName(sessionName);
    if (!session) return null;

    const windows = await tmux.listWindows(session.id);
    if (!windows || windows.length === 0) return null;

    let targetWindow: Awaited<ReturnType<typeof tmux.listWindows>>[number] | undefined;
    if (windowName) {
      targetWindow = windows.find((w) => w.name === windowName);
      if (!targetWindow) return null;
    } else {
      targetWindow = windows.find((w) => w.active) || windows[0];
    }

    const panes = await tmux.listPanes(targetWindow.id);
    if (!panes || panes.length === 0) return null;

    const targetPane = panes.find((p) => p.active) || panes[0];
    return { paneId: targetPane.id, session: sessionName };
  } catch {
    return null;
  }
}

async function defaultIsPaneLive(paneId: string): Promise<boolean> {
  try {
    const tmux = await import('./tmux.js');
    // Try to query the pane; if it throws or returns empty, pane is dead
    const output = await tmux.executeTmux(`display-message -p -t '${paneId}' '#{pane_id}'`);
    return output.trim() === paneId;
  } catch {
    return false;
  }
}

async function defaultCleanupDeadPane(workerId: string, paneId: string): Promise<void> {
  try {
    const registry = await import('./agent-registry.js');
    await registry.removeSubPane(workerId, paneId);
  } catch {
    // Best-effort cleanup
  }
}

async function defaultDeriveSession(paneId: string): Promise<string | null> {
  try {
    const tmux = await import('./tmux.js');
    const sessionName = await tmux.executeTmux(`display-message -p -t '${paneId}' '#{session_name}'`);
    const trimmed = sessionName.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// ============================================================================
// Core Resolver
// ============================================================================

/**
 * Resolve a target string to a tmux pane ID using a multi-level resolution chain.
 *
 * @param target - The target string (e.g., "%17", "wish-42", "wish-42:1", "genie:OMNI")
 * @param options - Optional overrides for testing
 * @returns ResolvedTarget with paneId and metadata
 * @throws Error with prescriptive message if target cannot be resolved
 */
async function assertLive(
  paneId: string,
  isPaneLive: (id: string) => Promise<boolean>,
  errorMsg: string,
  cleanup?: () => Promise<void>,
): Promise<void> {
  const live = await isPaneLive(paneId);
  if (!live) {
    if (cleanup) await cleanup();
    throw new Error(errorMsg);
  }
}

async function resolveRawPane(
  target: string,
  opts: {
    checkLiveness: boolean;
    isPaneLive: (id: string) => Promise<boolean>;
    deriveSession: (id: string) => Promise<string | null>;
  },
): Promise<ResolvedTarget> {
  if (opts.checkLiveness) {
    await assertLive(
      target,
      opts.isPaneLive,
      `Pane ${target} is dead or does not exist. Check with: tmux list-panes -a`,
    );
  }
  const session = await opts.deriveSession(target);
  return { paneId: target, session: session ?? undefined, resolvedVia: 'raw' };
}

async function resolveWindowId(
  target: string,
  workers: Record<string, Agent>,
  opts: { checkLiveness: boolean; isPaneLive: (id: string) => Promise<boolean> },
): Promise<ResolvedTarget> {
  const matchingWorker = Object.values(workers).find((w) => w.windowId === target);
  if (!matchingWorker) {
    throw new Error(`Window "${target}" not found in worker registry.\nRun 'genie agent list' to list agents.`);
  }
  if (opts.checkLiveness) {
    await assertLive(
      matchingWorker.paneId,
      opts.isPaneLive,
      `Window ${target}: worker ${matchingWorker.id} pane ${matchingWorker.paneId} is dead. Run 'genie agent kill${matchingWorker.id}' to clean up.`,
    );
  }
  return {
    paneId: matchingWorker.paneId,
    session: matchingWorker.session,
    workerId: matchingWorker.id,
    resolvedVia: 'worker',
  };
}

function resolveWorkerSubPane(worker: Agent, leftSide: string, rightSide: string): string {
  const index = Number.parseInt(rightSide, 10);
  if (Number.isNaN(index) || index < 0) {
    throw new Error(
      `Invalid sub-pane index "${rightSide}" for worker "${leftSide}". Use a non-negative integer (0 = primary, 1+ = sub-panes).`,
    );
  }
  const paneId = getPaneByIndex(worker, index);
  if (!paneId) {
    const maxIndex = worker.subPanes ? worker.subPanes.length : 0;
    throw new Error(
      `Worker "${leftSide}" has no sub-pane index ${index}. Available: 0 (primary)${maxIndex > 0 ? `, 1-${maxIndex} (sub-panes)` : ''}. Sub-pane index ${index} does not exist.`,
    );
  }
  return paneId;
}

// ============================================================================
// Fuzzy Name Resolution (customName, partial ID, global role)
// ============================================================================

/** Pick a single match from candidates. Returns null if empty, the match if unique, throws on ambiguity. */
function pickUnique(target: string, candidates: [string, Agent][], label: string): ResolvedTarget | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const [id, w] = candidates[0];
    return { paneId: w.paneId, session: w.session, workerId: id, resolvedVia: 'worker' };
  }
  const ids = candidates.map(([id]) => id).join(', ');
  throw new Error(`Ambiguous target "${target}" — ${label}: ${ids}\nUse the full ID instead.`);
}

/** Resolve a target by role name, scoped to a specific team. */
function resolveByRole(
  target: string,
  workers: Record<string, Agent>,
  currentTeam: string | null,
): ResolvedTarget | null {
  if (!currentTeam) return null;
  const candidates = Object.entries(workers).filter(([, w]) => w.role === target && w.team === currentTeam);
  return pickUnique(target, candidates, `${candidates.length} workers with role "${target}" in team "${currentTeam}"`);
}

/** Resolve a target by customName. Prefers team-scoped match, falls back to global. */
function resolveByCustomName(
  target: string,
  workers: Record<string, Agent>,
  currentTeam: string | null,
): ResolvedTarget | null {
  if (currentTeam) {
    const teamCandidates = Object.entries(workers).filter(([, w]) => w.customName === target && w.team === currentTeam);
    const teamHit = pickUnique(
      target,
      teamCandidates,
      `${teamCandidates.length} workers with customName "${target}" in team "${currentTeam}"`,
    );
    if (teamHit) return teamHit;
  }
  const allCandidates = Object.entries(workers).filter(([, w]) => w.customName === target);
  return pickUnique(target, allCandidates, `${allCandidates.length} workers with customName "${target}"`);
}

/** Resolve a target by partial ID suffix match. Prefers same-team on ambiguity. */
function resolveByPartialId(
  target: string,
  workers: Record<string, Agent>,
  currentTeam: string | null,
): ResolvedTarget | null {
  const candidates = Object.entries(workers).filter(([id]) => id !== target && id.endsWith(target));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const [id, w] = candidates[0];
    return { paneId: w.paneId, session: w.session, workerId: id, resolvedVia: 'worker' };
  }

  if (currentTeam) {
    const teamCandidates = candidates.filter(([, w]) => w.team === currentTeam);
    if (teamCandidates.length === 1) {
      const [id, w] = teamCandidates[0];
      return { paneId: w.paneId, session: w.session, workerId: id, resolvedVia: 'worker' };
    }
  }

  const ids = candidates.map(([id]) => id).join(', ');
  throw new Error(
    `Ambiguous target "${target}" — matches ${candidates.length} workers: ${ids}\nUse the full ID instead.`,
  );
}

/** Resolve a target by substring match on worker ID. Prefers same-team on ambiguity. */
function resolveBySubstring(
  target: string,
  workers: Record<string, Agent>,
  currentTeam: string | null,
): ResolvedTarget | null {
  // Only match IDs that contain the target but don't end with it (endsWith is handled by resolveByPartialId)
  const candidates = Object.entries(workers).filter(
    ([id]) => id !== target && !id.endsWith(target) && id.includes(target),
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const [id, w] = candidates[0];
    return { paneId: w.paneId, session: w.session, workerId: id, resolvedVia: 'worker' };
  }

  if (currentTeam) {
    const teamCandidates = candidates.filter(([, w]) => w.team === currentTeam);
    if (teamCandidates.length === 1) {
      const [id, w] = teamCandidates[0];
      return { paneId: w.paneId, session: w.session, workerId: id, resolvedVia: 'worker' };
    }
  }

  const ids = candidates.map(([id]) => id).join(', ');
  throw new Error(
    `Ambiguous target "${target}" — matches ${candidates.length} workers: ${ids}\nUse the full ID instead.`,
  );
}

/** Resolve a target by role name across all teams (global fallback). */
function resolveByRoleGlobal(target: string, workers: Record<string, Agent>): ResolvedTarget | null {
  const candidates = Object.entries(workers).filter(([, w]) => w.role === target);
  return pickUnique(target, candidates, `${candidates.length} workers with role "${target}"`);
}

/** Resolve by partial role prefix (e.g., "eng" matches "engineer"). Team-scoped first, then global. */
function resolveByPartialRole(
  target: string,
  workers: Record<string, Agent>,
  currentTeam: string | null,
): ResolvedTarget | null {
  const matches = ([, w]: [string, Agent]) => w.role !== undefined && w.role !== target && w.role.startsWith(target);

  if (currentTeam) {
    const teamCandidates = Object.entries(workers).filter((e) => matches(e) && e[1].team === currentTeam);
    const teamHit = pickUnique(
      target,
      teamCandidates,
      `${teamCandidates.length} workers with role starting with "${target}" in team "${currentTeam}"`,
    );
    if (teamHit) return teamHit;
  }

  const allCandidates = Object.entries(workers).filter(matches);
  return pickUnique(target, allCandidates, `${allCandidates.length} workers with role starting with "${target}"`);
}

/** Resolve by partial customName prefix (e.g., "eng" matches "engineer-4"). Team-scoped first, then global. */
function resolveByPartialCustomName(
  target: string,
  workers: Record<string, Agent>,
  currentTeam: string | null,
): ResolvedTarget | null {
  const matches = ([, w]: [string, Agent]) =>
    w.customName !== undefined && w.customName !== target && w.customName.startsWith(target);

  if (currentTeam) {
    const teamCandidates = Object.entries(workers).filter((e) => matches(e) && e[1].team === currentTeam);
    const teamHit = pickUnique(
      target,
      teamCandidates,
      `${teamCandidates.length} workers with customName starting with "${target}" in team "${currentTeam}"`,
    );
    if (teamHit) return teamHit;
  }

  const allCandidates = Object.entries(workers).filter(matches);
  return pickUnique(target, allCandidates, `${allCandidates.length} workers with customName starting with "${target}"`);
}

// ============================================================================
// Extracted sub-resolvers (keeps resolveTarget under complexity limit)
// ============================================================================

/** Resolve a colon target: worker:index or session:window. */
async function resolveColonTarget(
  target: string,
  workers: Record<string, Agent>,
  opts: {
    checkLiveness: boolean;
    isPaneLive: (id: string) => Promise<boolean>;
    cleanupDeadPane: (workerId: string, paneId: string) => Promise<void>;
    tmuxLookup: (sessionName: string, windowName?: string) => Promise<{ paneId: string; session: string } | null>;
  },
): Promise<ResolvedTarget> {
  const colonIndex = target.indexOf(':');
  const leftSide = target.substring(0, colonIndex);
  const rightSide = target.substring(colonIndex + 1);
  const worker = workers[leftSide];

  if (worker) {
    const paneId = resolveWorkerSubPane(worker, leftSide, rightSide);
    const index = Number.parseInt(rightSide, 10);
    if (opts.checkLiveness) {
      await assertLive(
        paneId,
        opts.isPaneLive,
        `Worker ${leftSide}: pane ${paneId} is dead. Run 'genie agent kill${leftSide}' to clean up.`,
        () => opts.cleanupDeadPane(leftSide, paneId),
      );
    }
    return { paneId, session: worker.session, workerId: leftSide, paneIndex: index, resolvedVia: 'worker' };
  }

  const sessionWindowResult = await opts.tmuxLookup(leftSide, rightSide);
  if (!sessionWindowResult) {
    throw new Error(
      `Target "${target}" not found. No worker "${leftSide}" in registry and no tmux session:window "${leftSide}:${rightSide}" found.\nRun 'genie agent list' to list agents.`,
    );
  }
  if (opts.checkLiveness) {
    await assertLive(
      sessionWindowResult.paneId,
      opts.isPaneLive,
      `Session "${leftSide}" window "${rightSide}": pane ${sessionWindowResult.paneId} is dead.`,
    );
  }
  return { paneId: sessionWindowResult.paneId, session: sessionWindowResult.session, resolvedVia: 'session:window' };
}

/** Resolve a bare name: exact ID → role (team) → customName → partial ID → substring → role (global) → partial role → partial customName. */
async function resolveBareName(
  target: string,
  workers: Record<string, Agent>,
  opts: {
    checkLiveness: boolean;
    isPaneLive: (id: string) => Promise<boolean>;
    cleanupDeadPane: (workerId: string, paneId: string) => Promise<void>;
    getCurrentTeam?: () => Promise<string | null>;
  },
): Promise<ResolvedTarget> {
  const worker = workers[target];
  if (worker) {
    if (opts.checkLiveness) {
      await assertLive(
        worker.paneId,
        opts.isPaneLive,
        `Worker ${target}: pane ${worker.paneId} is dead. Run 'genie agent kill${target}' to clean up.`,
        () => opts.cleanupDeadPane(target, worker.paneId),
      );
    }
    return { paneId: worker.paneId, session: worker.session, workerId: target, resolvedVia: 'worker' };
  }

  const currentTeam = opts.getCurrentTeam
    ? await opts.getCurrentTeam()
    : ((await getCurrentSessionName()) ?? process.env.GENIE_TEAM ?? null);

  const fuzzyMatch =
    resolveByRole(target, workers, currentTeam) ??
    resolveByCustomName(target, workers, currentTeam) ??
    resolveByPartialId(target, workers, currentTeam) ??
    resolveBySubstring(target, workers, currentTeam) ??
    resolveByRoleGlobal(target, workers) ??
    resolveByPartialRole(target, workers, currentTeam) ??
    resolveByPartialCustomName(target, workers, currentTeam);

  if (fuzzyMatch) {
    const rid = fuzzyMatch.workerId ?? target;
    if (opts.checkLiveness) {
      await assertLive(fuzzyMatch.paneId, opts.isPaneLive, `Worker ${rid}: pane ${fuzzyMatch.paneId} is dead.`, () =>
        opts.cleanupDeadPane(rid, fuzzyMatch.paneId),
      );
    }
    return fuzzyMatch;
  }

  throw new Error(`Target "${target}" not found. Not a worker or pane ID.\nRun 'genie agent list' to list agents.`);
}

export async function resolveTarget(target: string, options: ResolveOptions = {}): Promise<ResolvedTarget> {
  const {
    checkLiveness = false,
    workers: injectedWorkers,
    tmuxLookup = defaultTmuxLookup,
    isPaneLive = defaultIsPaneLive,
    cleanupDeadPane = defaultCleanupDeadPane,
    deriveSession = defaultDeriveSession,
  } = options;

  debug(`resolving "${target}"`);

  // Level 1: Raw pane ID (starts with %)
  if (target.startsWith('%')) {
    return resolveRawPane(target, { checkLiveness, isPaneLive, deriveSession });
  }

  // Level 1.5: Raw window ID (starts with @)
  if (target.startsWith('@')) {
    const workers = await getWorkers(injectedWorkers, options.registryPath);
    return resolveWindowId(target, workers, { checkLiveness, isPaneLive });
  }

  const workers = await getWorkers(injectedWorkers, options.registryPath);

  // Level 2: Worker[:index] or session:window
  if (target.indexOf(':') !== -1) {
    return resolveColonTarget(target, workers, { checkLiveness, isPaneLive, cleanupDeadPane, tmuxLookup });
  }

  // Level 3: Bare name — exact ID → role (team) → customName → partial ID → substring → role (global) → partial role → partial customName
  return resolveBareName(target, workers, {
    checkLiveness,
    isPaneLive,
    cleanupDeadPane,
    getCurrentTeam: options.getCurrentTeam,
  });
}

// ============================================================================
// Label formatting (shared by exec, send, orchestrate)
// ============================================================================

/**
 * Format a human-readable label from a resolved target.
 *
 * Examples:
 *   worker "wish-42" pane %17, session "genie"  -> "wish-42 (pane %17, session genie)"
 *   worker "wish-42:1" pane %22, session "genie" -> "wish-42:1 (pane %22, session genie)"
 *   raw pane "%17"                             -> "%17 (pane %17)"
 */
export function formatResolvedLabel(resolved: ResolvedTarget, originalTarget: string): string {
  const parts: string[] = [];
  if (resolved.workerId) {
    parts.push(resolved.workerId);
    if (resolved.paneIndex !== undefined && resolved.paneIndex > 0) {
      parts[parts.length - 1] += `:${resolved.paneIndex}`;
    }
  } else {
    parts.push(originalTarget);
  }
  const details: string[] = [`pane ${resolved.paneId}`];
  if (resolved.session) {
    details.push(`session ${resolved.session}`);
  }
  return `${parts[0]} (${details.join(', ')})`;
}

// ============================================================================
// Helpers
// ============================================================================

async function getWorkers(injected?: Record<string, Agent>, _registryPath?: string): Promise<Record<string, Agent>> {
  if (injected !== undefined) {
    return injected;
  }

  try {
    const registry = await import('./agent-registry.js');
    const workersList = await registry.list();
    const map: Record<string, Agent> = {};
    for (const w of workersList) {
      map[w.id] = w;
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Get pane ID by index from a worker.
 * Index 0 = primary paneId, 1+ = subPanes[index - 1].
 */
function getPaneByIndex(worker: Agent, index: number): string | null {
  if (index === 0) {
    return worker.paneId;
  }

  const subIndex = index - 1;
  if (!worker.subPanes || subIndex >= worker.subPanes.length || subIndex < 0) {
    return null;
  }

  return worker.subPanes[subIndex];
}
