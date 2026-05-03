/**
 * Diagnostic data collection — executors from DB + tmux inventory + gap detection.
 * Framework-agnostic: no OpenTUI imports.
 *
 * Post-executor-model: executor metadata (PID, provider, state, agent) comes from
 * the DB instead of `ps` shell parsing. tmux inventory is still shell-based (no DB
 * equivalent for session/window/pane structure).
 */

import { execSync } from 'node:child_process';
import type { AgentObservabilitySnapshot } from '../lib/agent-observability.js';
import { tmuxBin } from '../lib/ensure-tmux.js';
import { isClaudeLikePane } from './pane-detection.js';
import type { TuiAssignment, TuiExecutor, WorkState } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TmuxPane {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  paneId: string;
  pid: number;
  command: string;
  processCommand: string;
  title: string;
  size: string;
  isDead: boolean;
}

function getProcessCommandByPid(pids: number[]): Map<number, string> {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0))];
  if (uniquePids.length === 0) return new Map();
  const output = execQuiet(`ps -p ${uniquePids.join(',')} -o pid=,command=`);
  const commands = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    commands.set(Number.parseInt(match[1], 10), match[2]);
  }
  return commands;
}

export interface TmuxWindow {
  sessionName: string;
  index: number;
  name: string;
  active: boolean;
  paneCount: number;
  panes: TmuxPane[];
}

export interface TmuxSession {
  name: string;
  attached: boolean;
  windowCount: number;
  created: number;
  windows: TmuxWindow[];
}

export interface DiagnosticGaps {
  /** Executors in DB whose PID is dead (process no longer running) */
  deadPidExecutors: TuiExecutor[];
  /** Tmux panes running claude with no matching executor row */
  orphanPanes: TmuxPane[];
  /** Total executors with valid tmux link */
  linkedCount: number;
  /** Total active executors from DB */
  totalExecutors: number;
  /** Total panes running claude */
  totalClaudePanes: number;
  /** Total dead panes (exited) across all sessions */
  deadPaneCount: number;
}

export interface DiagnosticSnapshot {
  sessions: TmuxSession[];
  executors: TuiExecutor[];
  assignments: TuiAssignment[];
  gaps: DiagnosticGaps;
  /**
   * Per-agent work state keyed by display name. Populated from
   * `loadAgentWorkStates()` which routes through `shouldResume()` —
   * invincible-genie / Group 2.
   */
  workStates: Map<string, WorkState>;
  /**
   * Per-agent canonical observability snapshot keyed by display name.
   * Populated from `loadAgentObservabilityForTui()` (wish 3
   * agent-observability-snapshot Group 3). Lets badges read
   * `health.flags`, `recentToolCount`, `recentCostUsd`, etc. without
   * re-joining six tables.
   */
  observability: Map<string, AgentObservabilitySnapshot>;
  /**
   * Count of active derived-signal alerts (last hour). Drives the Nav
   * header alert badge.
   */
  alertCount: number;
  timestamp: number;
}

// ─── tmux Inventory ───────────────────────────────────────────────────────────

function execQuiet(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function parsePaneLine(
  parts: string[],
  processCommandByPid: Map<number, string>,
): {
  sessionName: string;
  winIdxStr: string;
  session: Omit<TmuxSession, 'windows'>;
  window: Omit<TmuxWindow, 'panes'>;
  pane: TmuxPane;
} {
  const [
    sessionName,
    winIdxStr,
    winName,
    winActive,
    winPanes,
    paneIdxStr,
    paneId,
    panePidStr,
    paneCmd,
    paneTitle,
    paneSize,
    sessAttached,
    sessWindows,
    sessCreated,
    paneDead,
  ] = parts;
  return {
    sessionName,
    winIdxStr,
    session: {
      name: sessionName,
      attached: sessAttached === '1',
      windowCount: Number.parseInt(sessWindows, 10) || 0,
      created: Number.parseInt(sessCreated, 10) || 0,
    },
    window: {
      sessionName,
      index: Number.parseInt(winIdxStr, 10) || 0,
      name: winName,
      active: winActive === '1',
      paneCount: Number.parseInt(winPanes, 10) || 0,
    },
    pane: {
      sessionName,
      windowIndex: Number.parseInt(winIdxStr, 10) || 0,
      paneIndex: Number.parseInt(paneIdxStr, 10) || 0,
      paneId,
      pid: Number.parseInt(panePidStr, 10) || 0,
      command: paneCmd,
      processCommand: processCommandByPid.get(Number.parseInt(panePidStr, 10) || 0) ?? '',
      title: paneTitle,
      size: paneSize,
      isDead: paneDead === '1',
    },
  };
}

/** Collect all tmux sessions, windows, and panes into a typed tree (genie server). */
function getTmuxInventory(): TmuxSession[] {
  const paneOutput = execQuiet(
    `${tmuxBin()} -L genie list-panes -a -F '#{session_name}|#{window_index}|#{window_name}|#{window_active}|#{window_panes}|#{pane_index}|#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_title}|#{pane_width}x#{pane_height}|#{session_attached}|#{session_windows}|#{session_created}|#{pane_dead}'`,
  );

  if (!paneOutput) return [];

  const paneLines = paneOutput.split('\n').filter(Boolean);
  const panePids = paneLines
    .map((line) => Number.parseInt(line.split('|')[7] ?? '', 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
  const processCommandByPid = getProcessCommandByPid(panePids);
  const sessionMap = new Map<string, TmuxSession>();
  const windowMap = new Map<string, TmuxWindow>();

  for (const line of paneLines) {
    const parts = line.split('|');
    if (parts.length < 15) continue;

    const parsed = parsePaneLine(parts, processCommandByPid);

    if (!sessionMap.has(parsed.sessionName)) {
      sessionMap.set(parsed.sessionName, { ...parsed.session, windows: [] });
    }

    const winKey = `${parsed.sessionName}:${parsed.winIdxStr}`;
    if (!windowMap.has(winKey)) {
      const win: TmuxWindow = { ...parsed.window, panes: [] };
      windowMap.set(winKey, win);
      sessionMap.get(parsed.sessionName)?.windows.push(win);
    }

    windowMap.get(winKey)?.panes.push(parsed.pane);
  }

  return Array.from(sessionMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Gap Detection ────────────────────────────────────────────────────────────

/** Check if a PID is alive via kill(pid, 0). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Get all claude panes from all sessions flattened. */
function allClaudePanes(sessions: TmuxSession[]): TmuxPane[] {
  return sessions.flatMap((s) => s.windows.flatMap((w) => w.panes)).filter(isClaudeLikePane);
}

/**
 * Detect gaps between DB executors and live tmux state:
 * - Dead PID executors: executor row has a PID that is no longer running
 * - Orphan panes: tmux pane running claude with no matching executor row
 */
function detectGaps(executors: TuiExecutor[], sessions: TmuxSession[]): DiagnosticGaps {
  // Check for executors with dead PIDs
  const deadPidExecutors = executors.filter((e) => e.pid != null && !isPidAlive(e.pid));

  // Build set of executor tmux pane IDs for orphan detection
  const executorPaneIds = new Set(executors.map((e) => e.tmuxPaneId).filter(Boolean));

  const claudePanes = allClaudePanes(sessions);
  const orphanPanes = claudePanes.filter((p) => !executorPaneIds.has(p.paneId));

  const linkedCount = executors.filter((e) => e.tmuxPaneId && !deadPidExecutors.some((d) => d.id === e.id)).length;

  const allPanes = sessions.flatMap((s) => s.windows.flatMap((w) => w.panes));
  const deadPaneCount = allPanes.filter((p) => p.isDead).length;

  return {
    deadPidExecutors,
    orphanPanes,
    linkedCount,
    totalExecutors: executors.length,
    totalClaudePanes: claudePanes.length,
    deadPaneCount,
  };
}

// ─── Full Snapshot ────────────────────────────────────────────────────────────

/** Collect a complete diagnostic snapshot: executors from DB + tmux inventory + gaps.
 *
 * Every PG-touching loader is fail-soft. Under transient pgserve saturation
 * (`too many clients already`, `CONNECTION_ENDED`, etc.) the snapshot still
 * renders with empty/stale data instead of crashing the TUI refresh — the
 * Nav.tsx interval will retry every 2s. Single-error spam in the TUI console
 * was the original symptom of /trace report 2026-04-30.
 */
export async function collectDiagnostics(): Promise<DiagnosticSnapshot> {
  const { loadExecutors, loadAssignments, loadAgentWorkStates, loadAgentObservabilityForTui } = await import('./db.js');

  // Collect tmux inventory (shell, no DB) and executors (DB, fail-soft) in parallel
  const sessions = getTmuxInventory();

  let executors: Awaited<ReturnType<typeof loadExecutors>> = [];
  try {
    executors = await loadExecutors();
  } catch {
    /* keep empty — Nav still renders with sessions only */
  }

  // Load assignments for active executors (DB, fail-soft)
  const executorIds = executors.map((e) => e.id);
  let assignments: Awaited<ReturnType<typeof loadAssignments>> = [];
  try {
    assignments = await loadAssignments(executorIds);
  } catch {
    /* keep empty — Nav hides assignment column */
  }

  // Load per-agent work-state via shouldResume() and active-signal count.
  // Both are best-effort: if PG is degraded, we still ship a usable
  // snapshot — just without work-state badges or the alert count.
  let workStates = new Map<string, WorkState>();
  let alertCount = 0;
  let observability = new Map<string, AgentObservabilitySnapshot>();
  try {
    workStates = await loadAgentWorkStates();
  } catch {
    /* keep empty — Nav falls back to wsAgentState */
  }
  // Wish 3 (agent-observability-snapshot): canonical per-agent snapshot
  // exposed alongside workStates so badges can render health flags
  // (`stale_executor`, `recent_failure`, `cost_spike`, …) without
  // recomputing them. Failure path returns an empty map.
  observability = await loadAgentObservabilityForTui();
  try {
    const { listActiveDerivedSignals } = await import('../lib/derived-signals/index.js');
    const signals = await listActiveDerivedSignals();
    alertCount = signals.length;
  } catch {
    /* keep zero — Nav header just hides the badge */
  }

  const gaps = detectGaps(executors, sessions);

  // Auto-terminate dead-PID executors so stale rows don't block re-spawning.
  // Fail-soft: under DB saturation, defer cleanup to the next refresh tick
  // rather than crashing the snapshot.
  if (gaps.deadPidExecutors.length > 0) {
    try {
      const { terminateExecutor } = await import('../lib/executor-registry.js');
      const { getConnection } = await import('../lib/db.js');
      const sql = await getConnection();
      await Promise.allSettled(
        gaps.deadPidExecutors.map(async (exec) => {
          await terminateExecutor(exec.id);
          // Clear the agent FK so the duplicate guard won't block new spawns
          if (exec.agentId) {
            await sql`UPDATE agents SET current_executor_id = NULL WHERE current_executor_id = ${exec.id}`;
          }
        }),
      );
    } catch {
      /* keep gaps surfaced — next refresh tick retries cleanup */
    }
  }

  return {
    sessions,
    executors,
    assignments,
    gaps,
    workStates,
    observability,
    alertCount,
    timestamp: Date.now(),
  };
}
