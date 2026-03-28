/**
 * Diagnostic data collection — tmux inventory + Claude Code processes + PID linking + gap detection.
 * Framework-agnostic: no OpenTUI imports. Pure data collection via shell commands.
 */

import { execSync } from 'node:child_process';

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

export interface ClaudeProcess {
  pid: number;
  ppid: number;
  agentId: string | null;
  agentName: string | null;
  teamName: string | null;
  agentType: string | null;
  sessionId: string | null;
  rawArgs: string;
}

export interface LinkedProcess extends ClaudeProcess {
  tmuxPane: TmuxPane | null;
  tmuxSession: string | null;
  tmuxLocation: string | null; // "session:window.pane" display string
}

export interface DiagnosticGaps {
  /** Claude processes with no tmux pane (zombie or subprocesses) */
  orphanProcesses: LinkedProcess[];
  /** Tmux panes running claude with no genie agent mapping */
  orphanPanes: TmuxPane[];
  /** Total linked count */
  linkedCount: number;
  /** Total processes */
  totalProcesses: number;
  /** Total panes running claude */
  totalClaudePanes: number;
}

export interface DiagnosticSnapshot {
  sessions: TmuxSession[];
  processes: LinkedProcess[];
  gaps: DiagnosticGaps;
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

/** Collect all tmux sessions, windows, and panes into a typed tree. */
export function getTmuxInventory(): TmuxSession[] {
  // Get all panes with full context in one call (most efficient)
  const paneOutput = execQuiet(
    "tmux list-panes -a -F '#{session_name}|#{window_index}|#{window_name}|#{window_active}|#{window_panes}|#{pane_index}|#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_title}|#{pane_width}x#{pane_height}|#{session_attached}|#{session_windows}|#{session_created}'",
  );

  if (!paneOutput) return [];

  const sessionMap = new Map<string, TmuxSession>();
  const windowMap = new Map<string, TmuxWindow>(); // key: "session:windowIndex"

  for (const line of paneOutput.split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 14) continue;

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
    ] = parts;

    // Ensure session exists
    if (!sessionMap.has(sessionName)) {
      sessionMap.set(sessionName, {
        name: sessionName,
        attached: sessAttached === '1',
        windowCount: Number.parseInt(sessWindows, 10) || 0,
        created: Number.parseInt(sessCreated, 10) || 0,
        windows: [],
      });
    }

    // Ensure window exists
    const winKey = `${sessionName}:${winIdxStr}`;
    if (!windowMap.has(winKey)) {
      const win: TmuxWindow = {
        sessionName,
        index: Number.parseInt(winIdxStr, 10) || 0,
        name: winName,
        active: winActive === '1',
        paneCount: Number.parseInt(winPanes, 10) || 0,
        panes: [],
      };
      windowMap.set(winKey, win);
      sessionMap.get(sessionName)!.windows.push(win);
    }

    // Add pane
    const pane: TmuxPane = {
      sessionName,
      windowIndex: Number.parseInt(winIdxStr, 10) || 0,
      paneIndex: Number.parseInt(paneIdxStr, 10) || 0,
      paneId,
      pid: Number.parseInt(panePidStr, 10) || 0,
      command: paneCmd,
      title: paneTitle,
      size: paneSize,
    };
    windowMap.get(winKey)!.panes.push(pane);
  }

  return Array.from(sessionMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Claude Code Processes ────────────────────────────────────────────────────

/** Parse a CLI flag value from a raw command line. */
function parseFlag(args: string, flag: string): string | null {
  // Match --flag value or --flag=value
  const eqMatch = args.match(new RegExp(`${flag}=(\\S+)`));
  if (eqMatch) return eqMatch[1];

  const spaceMatch = args.match(new RegExp(`${flag}\\s+(\\S+)`));
  if (spaceMatch) return spaceMatch[1];

  return null;
}

/** Collect all running Claude Code processes with parsed metadata. */
export function getClaudeProcesses(): ClaudeProcess[] {
  const psOutput = execQuiet('ps -eo pid,ppid,args --no-headers');
  if (!psOutput) return [];

  const processes: ClaudeProcess[] = [];

  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match lines where the command is "claude" (not claude-hindsight, etc.)
    const match = trimmed.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;

    const [, pidStr, ppidStr, args] = match;
    // Only match actual claude processes, not wrappers or related tools
    if (!args.includes('claude ') && !args.endsWith('claude')) continue;
    // Exclude non-claude-code processes
    if (args.includes('claude-hindsight') || args.includes('claude-memory')) continue;
    // Exclude shell wrappers that just launch claude
    if (args.startsWith('/bin/sh ') || args.startsWith('/bin/bash ')) continue;

    processes.push({
      pid: Number.parseInt(pidStr, 10),
      ppid: Number.parseInt(ppidStr, 10),
      agentId: parseFlag(args, '--agent-id'),
      agentName: parseFlag(args, '--agent-name'),
      teamName: parseFlag(args, '--team-name'),
      agentType: parseFlag(args, '--agent-type'),
      sessionId: parseFlag(args, '--session-id'),
      rawArgs: args,
    });
  }

  return processes;
}

// ─── PID Linking ──────────────────────────────────────────────────────────────

/**
 * Link Claude processes to tmux panes via PID ancestry.
 *
 * tmux pane PID = shell PID. Claude is a child (or grandchild via /bin/sh wrapper).
 * We check: claude.ppid == pane.pid OR claude.ppid's ppid == pane.pid (for sh -c wrappers).
 */
export function linkProcessesToPanes(processes: ClaudeProcess[], sessions: TmuxSession[]): LinkedProcess[] {
  // Build a flat lookup of all pane PIDs
  const paneByPid = new Map<number, TmuxPane>();
  for (const session of sessions) {
    for (const window of session.windows) {
      for (const pane of window.panes) {
        paneByPid.set(pane.pid, pane);
      }
    }
  }

  // Build parent PID lookup for grandchild matching
  const ppidMap = new Map<number, number>();
  const psOutput = execQuiet('ps -eo pid,ppid --no-headers');
  for (const line of psOutput.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) {
      ppidMap.set(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10));
    }
  }

  return processes.map((proc) => {
    // Direct match: claude's parent is the tmux pane shell
    let pane = paneByPid.get(proc.ppid) ?? null;

    // Grandchild match: claude -> sh -c wrapper -> tmux pane shell
    if (!pane) {
      const grandparent = ppidMap.get(proc.ppid);
      if (grandparent !== undefined) {
        pane = paneByPid.get(grandparent) ?? null;
      }
    }

    const tmuxLocation = pane ? `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}` : null;

    return {
      ...proc,
      tmuxPane: pane,
      tmuxSession: pane?.sessionName ?? null,
      tmuxLocation,
    };
  });
}

// ─── Gap Detection ────────────────────────────────────────────────────────────

/** Detect gaps: orphan processes (no tmux), orphan panes (claude running but no agent mapping). */
export function detectGaps(linked: LinkedProcess[], sessions: TmuxSession[]): DiagnosticGaps {
  const orphanProcesses = linked.filter((p) => !p.tmuxPane);

  // Find panes running claude that aren't linked to any known agent
  const linkedPaneIds = new Set(linked.filter((p) => p.tmuxPane).map((p) => p.tmuxPane!.paneId));
  const orphanPanes: TmuxPane[] = [];
  let totalClaudePanes = 0;

  for (const session of sessions) {
    for (const window of session.windows) {
      for (const pane of window.panes) {
        if (pane.command === 'claude' || pane.title.includes('claude')) {
          totalClaudePanes++;
          if (!linkedPaneIds.has(pane.paneId)) {
            orphanPanes.push(pane);
          }
        }
      }
    }
  }

  return {
    orphanProcesses,
    orphanPanes,
    linkedCount: linked.length - orphanProcesses.length,
    totalProcesses: linked.length,
    totalClaudePanes,
  };
}

// ─── Full Snapshot ────────────────────────────────────────────────────────────

/** Collect a complete diagnostic snapshot: tmux + processes + links + gaps. */
export function collectDiagnostics(): DiagnosticSnapshot {
  const sessions = getTmuxInventory();
  const rawProcesses = getClaudeProcesses();
  const processes = linkProcessesToPanes(rawProcesses, sessions);
  const gaps = detectGaps(processes, sessions);

  return {
    sessions,
    processes,
    gaps,
    timestamp: Date.now(),
  };
}
