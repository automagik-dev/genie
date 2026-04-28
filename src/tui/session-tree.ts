/**
 * Build TreeNode[] from tmux sessions + executor state from PG.
 * Powers the Sessions view with the same tree pattern as TreeNodeRow.
 *
 * In workspace mode, merges three data sources:
 *   1. Filesystem: agents/AGENTS.md → all agents that COULD run
 *   2. tmux: `tmux -L genie ls` → agents that ARE running + their windows
 *   3. Executors table: state (working/idle/permission/error)
 */

import type { DiagnosticSnapshot, TmuxPane, TmuxSession, TmuxWindow } from './diagnostics.js';
import type { AgentState, TreeNode, TuiExecutor, WorkState } from './types.js';

/** The TUI's own session name — filtered from the tree to prevent self-attach loops */
const TUI_SESSION = 'genie-tui';

/** Normalize agent name to tmux session name (slashes → dashes, since tmux forbids slashes). */
function toSessionName(agentName: string): string {
  return agentName.replace(/\//g, '-');
}

// ─── Legacy Mode (no workspace) ──────────────────────────────────────────────

/** Build a TreeNode tree from tmux sessions, enriched with executor state. */
export function buildSessionTree(snapshot: DiagnosticSnapshot): TreeNode[] {
  const executorByPaneId = new Map<string, TuiExecutor>();
  for (const exec of snapshot.executors) {
    if (exec.tmuxPaneId) {
      executorByPaneId.set(exec.tmuxPaneId, exec);
    }
  }

  return snapshot.sessions
    .filter((s) => s.name !== TUI_SESSION)
    .map((session) => sessionToNode(session, executorByPaneId));
}

// ─── Workspace Mode (merged data sources) ────────────────────────────────────

interface WorkspaceTreeInput {
  /** Agent names from filesystem (agents/AGENTS.md) */
  agentNames: string[];
  /** Tmux sessions from `tmux -L genie ls` */
  sessions: TmuxSession[];
  /** Executors from PG */
  executors: TuiExecutor[];
  /**
   * Per-agent work state derived from `shouldResume()` (invincible-genie /
   * Group 2). Optional — empty map means workState badges are hidden, the
   * tree falls back to `wsAgentState` for icon/color decisions.
   */
  workStates?: Map<string, WorkState>;
}

/** Build workspace-aware tree: all agents from filesystem, enriched with tmux + executor state. */
export function buildWorkspaceTree(input: WorkspaceTreeInput): TreeNode[] {
  const { agentNames, sessions, executors } = input;
  const workStates = input.workStates ?? new Map<string, WorkState>();

  // Index tmux sessions by name
  const sessionByName = new Map<string, TmuxSession>();
  for (const s of sessions) {
    if (s.name !== TUI_SESSION) sessionByName.set(s.name, s);
  }

  // Index executors by pane ID
  const executorByPaneId = new Map<string, TuiExecutor>();
  for (const exec of executors) {
    if (exec.tmuxPaneId) executorByPaneId.set(exec.tmuxPaneId, exec);
  }

  // Index executors by agent name (for state derivation)
  const executorsByAgent = new Map<string, TuiExecutor[]>();
  for (const exec of executors) {
    const name = exec.agentName ?? exec.metadata?.agentName;
    if (typeof name === 'string') {
      const list = executorsByAgent.get(name) ?? [];
      list.push(exec);
      executorsByAgent.set(name, list);
    }
  }

  // Group agents into hierarchy and build nodes
  const { topLevel, subsByParent } = groupAgentNames(agentNames);

  const nodes = topLevel.map((name) => {
    const node = buildAgentNode(
      name,
      sessionByName.get(toSessionName(name)),
      executorsByAgent.get(name) ?? [],
      executorByPaneId,
      workStates.get(name),
    );
    appendSubAgentNodes(node, subsByParent.get(name), sessionByName, executorsByAgent, executorByPaneId, workStates);
    return node;
  });

  // Add orphan sessions (tmux sessions with no matching agent in filesystem)
  const claimedSessions = new Set(agentNames.map(toSessionName));
  for (const [name, session] of sessionByName) {
    if (!claimedSessions.has(name)) {
      nodes.push(sessionToNode(session, executorByPaneId));
    }
  }

  return nodes;
}

export function resolvePreferredWindowIndex(session: TmuxSession, agentName?: string): number | undefined {
  const windows = [...session.windows].sort((a, b) => a.index - b.index);
  const hasClaudePane = (window: TmuxWindow) =>
    window.panes.some((pane) => !pane.isDead && (pane.command === 'claude' || pane.title.includes('claude')));

  const preferred =
    windows.find((window) => window.active && hasClaudePane(window)) ??
    (agentName ? windows.find((window) => window.name === agentName) : undefined) ??
    windows.find((window) => hasClaudePane(window)) ??
    windows.find((window) => window.active && window.index !== 0) ??
    windows.find((window) => window.index !== 0);

  return preferred?.index;
}

function hasLiveClaudeWindow(session: TmuxSession): boolean {
  return session.windows.some((window) =>
    window.panes.some((pane) => !pane.isDead && (pane.command === 'claude' || pane.title.includes('claude'))),
  );
}

/** Separate scoped names (parent/sub) from top-level names. */
function groupAgentNames(names: string[]): { topLevel: string[]; subsByParent: Map<string, string[]> } {
  const topLevel: string[] = [];
  const subsByParent = new Map<string, string[]>();
  for (const name of names) {
    const slashIdx = name.indexOf('/');
    if (slashIdx === -1) {
      topLevel.push(name);
    } else {
      const parent = name.slice(0, slashIdx);
      const subs = subsByParent.get(parent) ?? [];
      subs.push(name);
      subsByParent.set(parent, subs);
    }
  }
  return { topLevel, subsByParent };
}

/** Append sub-agent nodes as children of a parent agent node. */
function appendSubAgentNodes(
  parent: TreeNode,
  subs: string[] | undefined,
  sessionByName: Map<string, TmuxSession>,
  executorsByAgent: Map<string, TuiExecutor[]>,
  executorByPaneId: Map<string, TuiExecutor>,
  workStates: Map<string, WorkState>,
): void {
  if (!subs) return;
  for (const subName of subs) {
    const subLabel = subName.slice(subName.indexOf('/') + 1);
    const subNode = buildAgentNode(
      subName,
      sessionByName.get(toSessionName(subName)),
      executorsByAgent.get(subName) ?? [],
      executorByPaneId,
      workStates.get(subName),
    );
    subNode.label = subLabel;
    subNode.depth = 1;
    parent.children.push(subNode);
  }
}

function countClaudePanes(session: TmuxSession): number {
  return session.windows.reduce(
    (sum, w) => sum + w.panes.filter((p) => p.command === 'claude' || p.title.includes('claude')).length,
    0,
  );
}

function buildAgentNode(
  name: string,
  session: TmuxSession | undefined,
  agentExecutors: TuiExecutor[],
  executorByPaneId: Map<string, TuiExecutor>,
  workState: WorkState | undefined,
): TreeNode {
  const wsState = deriveWsAgentState(session, agentExecutors);
  const attachWindowIndex = session ? resolvePreferredWindowIndex(session, name) : undefined;

  const children: TreeNode[] = [];
  if (session) {
    for (const win of session.windows) {
      if (win.index === 0) continue;
      children.push(windowToNode(session.name, win, executorByPaneId));
    }
  }

  const node: TreeNode = {
    id: `agent:${name}`,
    type: 'agent',
    label: name,
    depth: 0,
    expanded: children.length > 0,
    children,
    data: {
      sessionName: toSessionName(name),
      windowCount: session ? session.windows.length : 0,
      attachWindowIndex,
      provider: agentExecutors[0]?.provider ?? null,
    },
    activePanes: session ? countClaudePanes(session) : 0,
    agentState: agentExecutors.length > 0 ? deriveExecutorState(agentExecutors) : undefined,
    wsAgentState: wsState,
  };
  if (workState) node.workState = workState;
  return node;
}

/** Derive workspace-level agent state from tmux session + executors */
function deriveWsAgentState(session: TmuxSession | undefined, agentExecutors: TuiExecutor[]): AgentState {
  if (!session) return 'stopped';

  // A live Claude pane wins over stale executor rows, but fallback shell windows
  // alone should not mask spawning/error states.
  if (hasLiveClaudeWindow(session)) return 'running';

  // Check executor states
  for (const exec of agentExecutors) {
    if (exec.state === 'error' || exec.state === 'terminated') return 'error';
    if (exec.state === 'spawning') return 'spawning';
  }

  // Session exists but no live Claude panes and no active executors — agent is stopped.
  // This catches stale shell-only sessions left after Claude exits.
  if (agentExecutors.length === 0) return 'stopped';

  return 'running';
}

/** Derive pane-level executor state from multiple executors */
function deriveExecutorState(execs: TuiExecutor[]): TreeNode['agentState'] {
  for (const e of execs) {
    if (e.state === 'working') return 'working';
  }
  for (const e of execs) {
    if (e.state === 'permission') return 'permission';
  }
  for (const e of execs) {
    if (e.state === 'error' || e.state === 'terminated') return 'error';
  }
  return 'idle';
}

// ─── Shared Node Builders ────────────────────────────────────────────────────

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
    wsAgentState: undefined,
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
    wsAgentState: undefined,
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
    wsAgentState: undefined,
  };
}

function derivePaneLabel(pane: TmuxPane, executor: TuiExecutor | undefined, isClaude: boolean): string {
  if (executor?.agentName && executor?.team) return `${executor.team}/${executor.agentName}`;
  if (executor?.agentName) return executor.agentName;
  // Use custom pane title if it was explicitly set (differs from command and hostname defaults)
  if (pane.title && pane.title !== pane.command && !isDefaultPaneTitle(pane.title)) return pane.title;
  if (isClaude) return 'claude';
  return pane.command;
}

function isDefaultPaneTitle(title: string): boolean {
  // tmux defaults: hostname, hostname.local, or "~" prefix patterns
  const hostname = require('node:os').hostname();
  return title === hostname || title.startsWith(`${hostname}.`) || title.startsWith('\u2733');
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
  if (node.type === 'agent') {
    const sessionName = node.data.sessionName as string;
    const attachWindowIndex = node.data.attachWindowIndex;
    if (typeof attachWindowIndex === 'number') {
      return { sessionName, windowIndex: attachWindowIndex };
    }
    const firstWindowChild = node.children.find((child) => child.type === 'window');
    if (firstWindowChild) {
      const parts = firstWindowChild.id.split(':');
      return { sessionName, windowIndex: Number(parts[2]) };
    }
    return { sessionName };
  }
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
