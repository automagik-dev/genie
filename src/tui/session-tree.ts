/**
 * Build TreeNode[] from tmux sessions + executor state from PG.
 * Powers the Sessions view with the same tree pattern as TreeNodeRow.
 */

import type { DiagnosticSnapshot, TmuxPane, TmuxSession, TmuxWindow } from './diagnostics.js';
import type { TreeNode, TuiExecutor } from './types.js';

/** Build a TreeNode tree from tmux sessions, enriched with executor state. */
export function buildSessionTree(snapshot: DiagnosticSnapshot): TreeNode[] {
  const executorByPaneId = new Map<string, TuiExecutor>();
  for (const exec of snapshot.executors) {
    if (exec.tmuxPaneId) {
      executorByPaneId.set(exec.tmuxPaneId, exec);
    }
  }

  return snapshot.sessions.map((session) => sessionToNode(session, executorByPaneId));
}

function sessionToNode(session: TmuxSession, executorMap: Map<string, TuiExecutor>): TreeNode {
  const claudePanes = session.windows.reduce(
    (sum, w) => sum + w.panes.filter((p) => p.command === 'claude' || p.title.includes('claude')).length,
    0,
  );

  return {
    id: `session:${session.name}`,
    type: 'session',
    label: session.name,
    depth: 0,
    expanded: true,
    children: session.windows.map((w) => windowToNode(session.name, w, executorMap)),
    data: { attached: session.attached, windowCount: session.windowCount },
    activePanes: claudePanes,
    agentState: undefined,
  };
}

function windowToNode(sessionName: string, window: TmuxWindow, executorMap: Map<string, TuiExecutor>): TreeNode {
  const activePanes = window.panes.filter(
    (p) => !p.isDead && (p.command === 'claude' || p.title.includes('claude')),
  ).length;

  return {
    id: `window:${sessionName}:${window.index}`,
    type: 'window',
    label: window.name,
    depth: 1,
    expanded: true,
    children: window.panes.map((p) => paneToNode(sessionName, window.index, p, executorMap)),
    data: { active: window.active, paneCount: window.paneCount },
    activePanes,
    agentState: undefined,
  };
}

function paneToNode(
  sessionName: string,
  windowIndex: number,
  pane: TmuxPane,
  executorMap: Map<string, TuiExecutor>,
): TreeNode {
  const executor = executorMap.get(pane.paneId);
  const isClaude = pane.command === 'claude' || pane.title.includes('claude');

  return {
    id: `pane:${pane.paneId}`,
    type: 'pane',
    label: derivePaneLabel(pane, executor, isClaude),
    depth: 2,
    expanded: false,
    children: [],
    data: {
      command: pane.command,
      isDead: pane.isDead,
      pid: pane.pid,
      size: pane.size,
      paneId: pane.paneId,
      sessionName,
      windowIndex,
    },
    activePanes: 0,
    agentState: derivePaneState(pane, executor),
  };
}

function derivePaneLabel(pane: TmuxPane, executor: TuiExecutor | undefined, isClaude: boolean): string {
  if (executor?.agentName && executor?.team) return `${executor.team}/${executor.agentName}`;
  if (executor?.agentName) return executor.agentName;
  if (isClaude) return 'claude';
  return pane.command;
}

function derivePaneState(pane: TmuxPane, executor: TuiExecutor | undefined): TreeNode['agentState'] {
  if (pane.isDead) return 'error';
  if (!executor) return undefined;
  const s = executor.state;
  if (s === 'working') return 'working';
  if (s === 'idle' || s === 'spawning') return 'idle';
  if (s === 'permission') return 'permission';
  if (s === 'error' || s === 'terminated') return 'error';
  return undefined;
}

/** Resolve tmux target for a tree node (for right pane attach). */
export function getSessionTarget(node: TreeNode): { sessionName: string; windowIndex?: number } | null {
  if (node.type === 'session') {
    return { sessionName: node.label };
  }
  if (node.type === 'window') {
    const parts = node.id.split(':');
    return { sessionName: parts[1], windowIndex: Number(parts[2]) };
  }
  if (node.type === 'pane') {
    const data = node.data as { sessionName: string; windowIndex: number };
    return { sessionName: data.sessionName, windowIndex: data.windowIndex };
  }
  return null;
}
