/**
 * Diagnostic data collection — executors from DB + tmux inventory + gap detection.
 * Framework-agnostic: no OpenTUI imports.
 *
 * Post-executor-model: executor metadata (PID, provider, state, agent) comes from
 * the DB instead of `ps` shell parsing. tmux inventory is still shell-based (no DB
 * equivalent for session/window/pane structure).
 */

import { execSync } from 'node:child_process';
import { tmuxBin } from '../lib/ensure-tmux.js';
import type { TuiAssignment, TuiExecutor, WorkState } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TmuxPane {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  paneId: string;
  pid: number;
  command: string;
  title: string;
  size: string;
  isDead: boolean;
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

function parsePaneLine(parts: string[]): {
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

  const sessionMap = new Map<string, TmuxSession>();
  const windowMap = new Map<string, TmuxWindow>();

  for (const line of paneOutput.split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 15) continue;

    const parsed = parsePaneLine(parts);

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
  return sessions
    .flatMap((s) => s.windows.flatMap((w) => w.panes))
    .filter((p) => p.command === 'claude' || p.title.includes('claude'));
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

/** Collect a complete diagnostic snapshot: executors from DB + tmux inventory + gaps. */
export async function collectDiagnostics(): Promise<DiagnosticSnapshot> {
  const { loadExecutors, loadAssignments, loadAgentWorkStates } = await import('./db.js');

  // Collect tmux inventory (shell) and executors (DB) in parallel
  const sessions = getTmuxInventory();
  const executors = await loadExecutors();

  // Load assignments for active executors
  const executorIds = executors.map((e) => e.id);
  const assignments = await loadAssignments(executorIds);

  // Load per-agent work-state via shouldResume() and active-signal count.
  // Both are best-effort: if PG is degraded, we still ship a usable
  // snapshot — just without work-state badges or the alert count.
  let workStates = new Map<string, WorkState>();
  let alertCount = 0;
  try {
    workStates = await loadAgentWorkStates();
  } catch {
    /* keep empty — Nav falls back to wsAgentState */
  }
  try {
    const { listActiveDerivedSignals } = await import('../lib/derived-signals/index.js');
    const signals = await listActiveDerivedSignals();
    alertCount = signals.length;
  } catch {
    /* keep zero — Nav header just hides the badge */
  }

  const gaps = detectGaps(executors, sessions);

  // Auto-terminate dead-PID executors so stale rows don't block re-spawning.
  if (gaps.deadPidExecutors.length > 0) {
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
  }

  return {
    sessions,
    executors,
    assignments,
    gaps,
    workStates,
    alertCount,
    timestamp: Date.now(),
  };
}
