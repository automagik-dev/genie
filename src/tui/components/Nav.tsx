/** @jsxImportSource @opentui/react */
/** Sessions panel — single tree view of tmux sessions > windows > panes */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type SpawnIntent, buildSpawnInvocation } from '../../lib/spawn-invocation.js';
import { scanAgents } from '../../lib/workspace.js';
import { buildMenuItems } from '../context-menu-items.js';
import { type DiagnosticSnapshot, collectDiagnostics } from '../diagnostics.js';
import { consumeInitialAgentSignal } from '../initial-agent.js';
import {
  buildSessionTree,
  buildWorkspaceTree,
  getSessionTarget,
  resolvePreferredWindowIndex,
} from '../session-tree.js';
import { palette } from '../theme.js';
import { flattenTree, toggleNode } from '../tree.js';
import type { TreeNode } from '../types.js';
import { AgentPicker, type AgentPickerTarget } from './AgentPicker.js';
import { ContextMenu } from './ContextMenu.js';
import { SpawnTargetPicker } from './SpawnTargetPicker.js';
import { SystemStats } from './SystemStats.js';
import { TreeNodeRow } from './TreeNode.js';

interface NavProps {
  onTmuxSessionSelect: (sessionName: string, windowIndex?: number) => void;
  /** Spawn a parallel worker of the same agent type */
  onNewAgentWindow?: (agentName: string) => void;
  /** Workspace root path — enables workspace mode (merged agent tree) */
  workspaceRoot?: string;
  /** Pre-select this agent on initial render */
  initialAgent?: string;
  /** Disable nav keyboard shortcuts while a modal owns input */
  keyboardDisabled?: boolean;
}

export function Nav({
  onTmuxSessionSelect,
  onNewAgentWindow,
  workspaceRoot,
  initialAgent,
  keyboardDisabled = false,
}: NavProps) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot | null>(null);
  const [sessionTree, setSessionTree] = useState<TreeNode[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [requestedInitialAgent, setRequestedInitialAgent] = useState<string | undefined>(initialAgent);
  const [contextMenuNodeId, setContextMenuNodeId] = useState<string | null>(null);
  /** Name of the agent whose spawn-into picker is open (null = picker closed). */
  const [spawnIntoAgent, setSpawnIntoAgent] = useState<string | null>(null);
  /** Target for the spawn-here agent picker (null = picker closed). */
  const [spawnPickerTarget, setSpawnPickerTarget] = useState<AgentPickerTarget | null>(null);
  const lastTarget = useRef<string | null>(null);
  const selectedNodeId = useRef<string | null>(null);

  // Refresh diagnostics every 2s
  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const snap = await collectDiagnostics();
        if (!active) return;
        setDiagnostics(snap);

        const signaledAgent = consumeInitialAgentSignal();
        if (signaledAgent) {
          setRequestedInitialAgent(signaledAgent);
        }
      } catch (err) {
        console.error('TUI: diagnostics failed:', err);
      }
    }

    refresh();
    const timer = setInterval(refresh, 2000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  // Build session tree from diagnostics, preserving expanded state
  useEffect(() => {
    if (!diagnostics) return;

    let newTree: TreeNode[];
    if (workspaceRoot) {
      const agentNames = scanAgents(workspaceRoot);
      newTree = buildWorkspaceTree({
        agentNames,
        sessions: diagnostics.sessions,
        executors: diagnostics.executors,
      });
    } else {
      newTree = buildSessionTree(diagnostics);
    }

    setSessionTree((prev) => mergeExpandedState(prev, newTree));
  }, [diagnostics, workspaceRoot]);

  const flatNodes = useMemo(() => flattenTree(sessionTree), [sessionTree]);

  // Keep selectedNodeId in sync with the current selection
  useEffect(() => {
    const node = flatNodes[selectedIndex]?.node;
    if (node) selectedNodeId.current = node.id;
  }, [selectedIndex, flatNodes]);

  // Stabilize selection across tree rebuilds: if the node at selectedIndex changed,
  // find the previously selected node by ID and restore the correct index.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex intentionally excluded — including it creates infinite loop since effect calls setSelectedIndex
  useLayoutEffect(() => {
    if (flatNodes.length === 0) return;
    if (selectedIndex >= flatNodes.length) {
      setSelectedIndex(flatNodes.length - 1);
      return;
    }
    if (!selectedNodeId.current) return;
    const currentAtIndex = flatNodes[selectedIndex]?.node;
    if (currentAtIndex && currentAtIndex.id === selectedNodeId.current) return;
    const restored = flatNodes.findIndex((n) => n.node.id === selectedNodeId.current);
    if (restored >= 0) {
      setSelectedIndex(restored);
    }
  }, [flatNodes]);

  // Initial agent selection / auto-spawn. Triggered by startup env or file signal.
  useEffect(() => {
    if (!requestedInitialAgent || flatNodes.length === 0) return;
    const idx = flatNodes.findIndex((n) => n.node.id === `agent:${requestedInitialAgent}`);
    if (idx >= 0) {
      setSelectedIndex(idx);
      const node = flatNodes[idx].node;
      if (node.type === 'agent' && node.wsAgentState !== 'running' && node.wsAgentState !== 'spawning') {
        spawnAgent(agentNameFromNode(node), onTmuxSessionSelect);
      }
      setRequestedInitialAgent(undefined);
    }
  }, [requestedInitialAgent, flatNodes, onTmuxSessionSelect]);

  // Auto-switch right pane when cursor moves to a new target
  useEffect(() => {
    const current = flatNodes[selectedIndex]?.node;
    if (!current) return;
    const target = getSessionTarget(current);
    if (!target) return;

    // Only auto-attach for running agents (or session/window/pane nodes)
    if (current.type === 'agent' && current.wsAgentState !== 'running') return;
    const key = `${target.sessionName}:${target.windowIndex ?? ''}`;
    if (key === lastTarget.current) return;
    lastTarget.current = key;
    onTmuxSessionSelect(target.sessionName, target.windowIndex);
  }, [selectedIndex, flatNodes, onTmuxSessionSelect]);

  const handleSelect = useCallback(
    (id: string) => {
      const idx = flatNodes.findIndex((n) => n.node.id === id);
      if (idx >= 0) setSelectedIndex(idx);
    },
    [flatNodes],
  );

  const handleToggle = useCallback((id: string) => {
    setSessionTree((prev) => toggleNode(prev, id));
  }, []);

  const handleVerticalNav = useCallback(
    (keyName: string) => {
      const rowCount = flatNodes.length;
      if (rowCount === 0) return;
      if (keyName === 'up' || keyName === 'k') {
        setSelectedIndex((prev) => (prev === 0 ? rowCount - 1 : prev - 1));
      } else if (keyName === 'down' || keyName === 'j') {
        setSelectedIndex((prev) => (prev >= rowCount - 1 ? 0 : prev + 1));
      }
    },
    [flatNodes.length],
  );

  const handleExpandCollapse = useCallback(
    (keyName: string) => {
      const node = flatNodes[selectedIndex]?.node;
      if (!node) return;
      if ((keyName === 'right' || keyName === 'l') && node.children.length > 0 && !node.expanded) {
        handleToggle(node.id);
      } else if ((keyName === 'left' || keyName === 'h') && node.expanded) {
        handleToggle(node.id);
      }
    },
    [flatNodes, selectedIndex, handleToggle],
  );

  const handleEnter = useCallback(() => {
    const node = flatNodes[selectedIndex]?.node;
    if (!node) return;

    if (node.type === 'agent') {
      handleEnterAgent(node, onTmuxSessionSelect);
      return;
    }

    if (node.children.length > 0) handleToggle(node.id);
    const target = getSessionTarget(node);
    if (target) onTmuxSessionSelect(target.sessionName, target.windowIndex);
  }, [flatNodes, selectedIndex, handleToggle, onTmuxSessionSelect]);

  const handleRetry = useCallback(() => {
    const node = flatNodes[selectedIndex]?.node;
    if (!node || node.type !== 'agent') return;
    if (node.wsAgentState !== 'spawning' && node.wsAgentState !== 'error') return;

    // Reset stuck agents then respawn
    void (async () => {
      try {
        const { reconcileStaleSpawns } = await import('../../lib/agent-registry.js');
        await reconcileStaleSpawns();
      } catch {
        // best-effort
      }
      spawnAgent(agentNameFromNode(node), onTmuxSessionSelect);
    })();
  }, [flatNodes, selectedIndex, onTmuxSessionSelect]);

  const handleContextMenu = useCallback(
    (nodeId: string) => {
      const flat = flatNodes.find((n) => n.node.id === nodeId);
      if (flat && buildMenuItems(flat.node).length > 0) {
        setContextMenuNodeId(nodeId);
      }
    },
    [flatNodes],
  );

  const handleContextMenuAction = useCallback(
    (action: string, payload?: string) => {
      const node = flatNodes.find((n) => n.node.id === contextMenuNodeId)?.node;
      if (!node) return;
      setContextMenuNodeId(null);
      if (action === 'spawn-here') {
        const target = resolveSpawnHereTarget(node);
        if (target) setSpawnPickerTarget(target);
        return;
      }
      dispatchContextMenuAction(action, node, payload, {
        sessionTree,
        onTmuxSessionSelect,
        onNewAgentWindow,
        openSpawnInto: setSpawnIntoAgent,
      });
    },
    [flatNodes, contextMenuNodeId, sessionTree, onTmuxSessionSelect, onNewAgentWindow],
  );

  const handleSpawnIntoConfirm = useCallback((intent: SpawnIntent) => {
    executeSpawnIntent(intent);
    setSpawnIntoAgent(null);
  }, []);

  const handleSpawnIntoCancel = useCallback(() => {
    setSpawnIntoAgent(null);
  }, []);

  const handleSpawnPickerConfirm = useCallback((intent: SpawnIntent) => {
    setSpawnPickerTarget(null);
    executeSpawnIntent(intent);
  }, []);

  const handleSpawnPickerCancel = useCallback(() => {
    setSpawnPickerTarget(null);
  }, []);

  const _menuDisabled = keyboardDisabled || contextMenuNodeId !== null;

  useKeyboard((key) => {
    if (keyboardDisabled) return;
    // Spawn-into/spawn-here pickers own the keyboard while open — they
    // register their own useKeyboard handlers.
    if (spawnIntoAgent !== null || spawnPickerTarget !== null) return;
    handleKeyboardInput(key, {
      contextMenuNodeId,
      flatNodes,
      selectedIndex,
      setContextMenuNodeId,
      handleVerticalNav,
      handleExpandCollapse,
      handleEnter,
      handleRetry,
      onNewAgentWindow,
    });
  });

  // Summary counts
  const agentCount = workspaceRoot
    ? sessionTree.filter((n) => n.type === 'agent').length
    : (diagnostics?.sessions.length ?? 0);
  const runningCount = workspaceRoot
    ? sessionTree.filter((n) => n.wsAgentState === 'running').length
    : (diagnostics?.sessions.reduce((sum, s) => sum + s.windows.reduce((ws, w) => ws + w.panes.length, 0), 0) ?? 0);

  const headerLabel = workspaceRoot ? 'Agents' : 'Sessions';

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.bg}>
      {/* Header */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLight}>
        <text>
          <span fg={palette.purple}>{headerLabel}</span>
          {diagnostics ? (
            <span fg={palette.textDim}>
              {' '}
              {workspaceRoot ? `${runningCount}/${agentCount}` : `${agentCount}s ${runningCount}p`}
            </span>
          ) : null}
        </text>
      </box>

      {/* Session Tree */}
      {diagnostics ? (
        <scrollbox
          focused
          height="100%"
          style={{
            scrollbarOptions: {
              showArrows: false,
              trackOptions: {
                foregroundColor: palette.scrollThumb,
                backgroundColor: palette.scrollTrack,
              },
            },
          }}
        >
          {flatNodes.map((flat, i) => (
            <TreeNodeRow
              key={flat.node.id}
              node={flat.node}
              selected={i === selectedIndex}
              onSelect={handleSelect}
              onToggle={handleToggle}
              onContextMenu={handleContextMenu}
            />
          ))}
        </scrollbox>
      ) : (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={palette.textDim}>Collecting...</text>
        </box>
      )}

      {/* Context menu overlay */}
      {contextMenuNodeId ? (
        <ContextMenu
          items={buildMenuItems(flatNodes.find((n) => n.node.id === contextMenuNodeId)?.node ?? ({} as TreeNode))}
          onAction={handleContextMenuAction}
          onClose={() => setContextMenuNodeId(null)}
          positionY={flatNodes.findIndex((n) => n.node.id === contextMenuNodeId) + 1}
        />
      ) : null}

      {/* Spawn-into target picker — live tmux topology + CliPreviewLine */}
      {spawnIntoAgent !== null ? (
        <SpawnTargetPicker
          agentName={spawnIntoAgent}
          sessions={diagnostics?.sessions ?? []}
          onConfirm={handleSpawnIntoConfirm}
          onCancel={handleSpawnIntoCancel}
        />
      ) : null}

      {/* Spawn-here agent picker (opened from session/window context menu) */}
      {spawnPickerTarget !== null ? (
        <AgentPicker
          target={spawnPickerTarget}
          onConfirm={handleSpawnPickerConfirm}
          onCancel={handleSpawnPickerCancel}
        />
      ) : null}

      {/* System stats */}
      <SystemStats />

      {/* Footer */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLight}>
        <text>
          <span fg={palette.textMuted}>
            {'\u2191\u2193'}:nav {'\u2190\u2192'}:expand Enter:{workspaceRoot ? 'spawn/attach' : 'attach'} ^T:new
            R:retry .:menu
          </span>
        </text>
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Extracted helpers to keep cognitive complexity low
// ---------------------------------------------------------------------------

/** Handle Enter key for agent nodes: spawn if stopped, attach if running. */
function handleEnterAgent(
  node: TreeNode,
  onTmuxSessionSelect: (sessionName: string, windowIndex?: number) => void,
): void {
  if (node.wsAgentState !== 'running' && node.wsAgentState !== 'spawning') {
    spawnAgent(agentNameFromNode(node), onTmuxSessionSelect);
  } else if (node.wsAgentState === 'running') {
    const target = getSessionTarget(node);
    if (target) onTmuxSessionSelect(target.sessionName, target.windowIndex);
  }
}

/** Top-level context menu dispatcher — delegates to focused helpers. */
function dispatchContextMenuAction(
  action: string,
  node: TreeNode,
  payload: string | undefined,
  deps: {
    sessionTree: TreeNode[];
    onTmuxSessionSelect: (sessionName: string, windowIndex?: number) => void;
    onNewAgentWindow?: (agentName: string) => void;
    openSpawnInto?: (agentName: string) => void;
  },
): void {
  const name = node.label;
  // Agent-node "Spawn into…" — open the target picker modal; actual spawn
  // happens on picker confirm in the Nav render scope.
  if (action === 'spawn-into' && node.type === 'agent' && deps.openSpawnInto) {
    deps.openSpawnInto(agentNameFromNode(node));
    return;
  }
  if (handleAttachAction(action, node, deps.onTmuxSessionSelect)) return;
  if (handleRetryAction(action, name, deps.onTmuxSessionSelect)) return;
  if (handleGenieAction(action, name, payload)) return;
  const tmuxServer = process.env.GENIE_TMUX_SERVER || 'genie';
  if (handleRenameAction(action, node, tmuxServer, payload)) return;
  if (handleAgentWindowActions(action, node, name, tmuxServer, deps.onNewAgentWindow)) return;
  if (handleSessionNodeActions(action, node, tmuxServer, payload)) return;
  if (handleWindowNodeActions(action, node, deps.sessionTree, tmuxServer, payload)) return;
  handlePaneNodeActions(action, node, deps.sessionTree, tmuxServer, deps.onNewAgentWindow);
}

/** Context-menu: 'attach' action — returns true if handled. */
function handleAttachAction(
  action: string,
  node: TreeNode,
  onTmuxSessionSelect: (sessionName: string, windowIndex?: number) => void,
): boolean {
  if (action !== 'attach') return false;
  const target = getSessionTarget(node);
  if (target) onTmuxSessionSelect(target.sessionName, target.windowIndex);
  return true;
}

/** Context-menu: 'retry' action — returns true if handled. */
function handleRetryAction(
  action: string,
  name: string,
  onTmuxSessionSelect: (sessionName: string, windowIndex?: number) => void,
): boolean {
  if (action !== 'retry') return false;
  void (async () => {
    try {
      const { reconcileStaleSpawns } = await import('../../lib/agent-registry.js');
      await reconcileStaleSpawns();
    } catch {
      // best-effort
    }
    spawnAgent(name, onTmuxSessionSelect);
  })();
  return true;
}

/** Context-menu: genie CLI commands (spawn, stop, kill, log, show, read, answer-*, send). Returns true if handled. */
function handleGenieAction(action: string, name: string, payload?: string): boolean {
  if (action === 'send' && payload) {
    executeGenie(['agent', 'send', payload, '--to', name]);
    return true;
  }
  if (action === 'answer-text' && payload) {
    executeGenie(['agent', 'answer', name, `text:${payload}`]);
    return true;
  }

  const genieCommands: Record<string, string[]> = {
    spawn: ['spawn', name],
    'spawn-plan': ['spawn', name, '--plan-mode'],
    stop: ['agent', 'stop', name],
    kill: ['agent', 'kill', name],
    log: ['agent', 'log', name],
    show: ['agent', 'show', name],
    read: ['read', name],
    'answer-yes': ['agent', 'answer', name, 'yes'],
    'answer-no': ['agent', 'answer', name, 'no'],
  };

  const genieArgs = genieCommands[action];
  if (genieArgs) {
    executeGenie(genieArgs);
    return true;
  }
  return false;
}

/** Context-menu: rename-session, rename-window, rename-pane. Returns true if handled. */
function handleRenameAction(action: string, node: TreeNode, tmuxServer: string, payload?: string): boolean {
  if (action === 'rename-session' && payload) {
    const sess =
      node.type === 'agent' ? (node.data.sessionName as string) || node.label : node.id.split(':').slice(1).join(':');
    executeTmux(['-L', tmuxServer, 'rename-session', '-t', sess, payload]);
    return true;
  }
  if (action === 'rename-window' && payload) {
    const idParts = node.id.split(':');
    const windowTarget = `${idParts[1]}:${idParts[2]}`;
    executeTmux(['-L', tmuxServer, 'rename-window', '-t', windowTarget, payload]);
    return true;
  }
  if (action === 'rename-pane' && payload && node.type === 'pane') {
    const paneId = node.data.paneId as string;
    executeTmux(['-L', tmuxServer, 'select-pane', '-t', `${paneId}`, '-T', payload]);
    return true;
  }
  return false;
}

/** Context-menu: agent-new-window, new-empty-window. Returns true if handled. */
function handleAgentWindowActions(
  action: string,
  node: TreeNode,
  name: string,
  tmuxServer: string,
  onNewAgentWindow?: (agentName: string) => void,
): boolean {
  if (action === 'agent-new-window' && node.type === 'agent') {
    if (onNewAgentWindow) onNewAgentWindow(agentNameFromNode(node));
    return true;
  }
  if (action === 'new-empty-window' && node.type === 'agent') {
    const sessionName = (node.data.sessionName as string) || name;
    executeTmux(['-L', tmuxServer, 'new-window', '-a', '-t', sessionName]);
    return true;
  }
  return false;
}

/** Context-menu: session-level actions (kill-session, new-window, clone-session, spawn-in-session). Returns true if handled. */
function handleSessionNodeActions(action: string, node: TreeNode, tmuxServer: string, payload?: string): boolean {
  if (node.type !== 'session') return false;
  const sess = node.id.split(':').slice(1).join(':');
  if (action === 'kill-session') {
    executeTmux(['-L', tmuxServer, 'kill-session', '-t', sess]);
    return true;
  }
  if (action === 'new-window') {
    executeTmux(['-L', tmuxServer, 'new-window', '-a', '-t', sess]);
    return true;
  }
  if (action === 'clone-session') {
    executeTmux(['-L', tmuxServer, 'new-session', '-d', '-s', `${sess}-clone`, '-t', sess]);
    return true;
  }
  if (action === 'spawn-in-session' && payload) {
    executeGenie(['spawn', payload, '--session', sess]);
    return true;
  }
  return false;
}

/** Context-menu: window-level actions (kill-window, window-new-agent, split-pane, spawn-in-window). Returns true if handled. */
function handleWindowNodeActions(
  action: string,
  node: TreeNode,
  sessionTree: TreeNode[],
  tmuxServer: string,
  payload?: string,
): boolean {
  if (node.type !== 'window') return false;
  const idParts = node.id.split(':');
  const windowTarget = `${idParts[1]}:${idParts[2]}`;
  if (action === 'kill-window') {
    executeTmux(['-L', tmuxServer, 'kill-window', '-t', windowTarget]);
    return true;
  }
  if (action === 'window-new-agent') {
    const parentAgent = findParentAgent(sessionTree, node.id);
    if (parentAgent) {
      const agentFullName = agentNameFromNode(parentAgent);
      const suffix = Date.now() % 10000;
      const role = `${agentFullName}-${suffix}`;
      executeGenie(['spawn', agentFullName, '--role', role, '--window', windowTarget]);
    }
    return true;
  }
  if (action === 'split-pane') {
    executeTmux(['-L', tmuxServer, 'split-window', '-t', windowTarget]);
    return true;
  }
  if (action === 'spawn-in-window' && payload) {
    executeGenie(['spawn', payload, '--session', idParts[1]]);
    return true;
  }
  return false;
}

/** Context-menu: pane-level actions (clone-agent, kill-pane, split-h, split-v). Returns true if handled. */
function handlePaneNodeActions(
  action: string,
  node: TreeNode,
  sessionTree: TreeNode[],
  tmuxServer: string,
  onNewAgentWindow?: (agentName: string) => void,
): boolean {
  if (node.type !== 'pane') return false;
  const paneId = node.data.paneId as string;
  if (action === 'clone-agent') {
    const parentAgent = findParentAgent(sessionTree, node.id);
    if (parentAgent && onNewAgentWindow) {
      onNewAgentWindow(agentNameFromNode(parentAgent));
    }
    return true;
  }
  if (action === 'kill-pane') {
    executeTmux(['-L', tmuxServer, 'kill-pane', '-t', `${paneId}`]);
    return true;
  }
  if (action === 'split-h') {
    executeTmux(['-L', tmuxServer, 'split-window', '-h', '-t', `${paneId}`]);
    return true;
  }
  if (action === 'split-v') {
    executeTmux(['-L', tmuxServer, 'split-window', '-v', '-t', `${paneId}`]);
    return true;
  }
  return false;
}

/** Try to open context menu for selected node. Returns true if opened. */
function tryOpenContextMenu(
  flatNodes: { node: TreeNode }[],
  selectedIndex: number,
  setContextMenuNodeId: (id: string | null) => void,
): boolean {
  const node = flatNodes[selectedIndex]?.node;
  if (node && buildMenuItems(node).length > 0) {
    setContextMenuNodeId(node.id);
    return true;
  }
  return false;
}

/** Dispatch navigation key to the appropriate handler. */
function dispatchNavKey(
  key: { name?: string; ctrl?: boolean },
  handlers: {
    handleVerticalNav: (keyName: string) => void;
    handleExpandCollapse: (keyName: string) => void;
    handleEnter: () => void;
    handleRetry: () => void;
  },
  agentAction: () => void,
): void {
  const n = key.name;
  if (n === 'up' || n === 'k' || n === 'down' || n === 'j') {
    handlers.handleVerticalNav(n);
  } else if (n === 'right' || n === 'l' || n === 'left' || n === 'h') {
    handlers.handleExpandCollapse(n);
  } else if (n === 'enter' || n === 'return') {
    handlers.handleEnter();
  } else if (n === 'r') {
    handlers.handleRetry();
  } else if (key.ctrl && n === 't') {
    agentAction();
  }
}

/** Handle keyboard input — extracted from useKeyboard to reduce complexity. */
function handleKeyboardInput(
  key: { name?: string; ctrl?: boolean },
  opts: {
    contextMenuNodeId: string | null;
    flatNodes: { node: TreeNode }[];
    selectedIndex: number;
    setContextMenuNodeId: (id: string | null) => void;
    handleVerticalNav: (keyName: string) => void;
    handleExpandCollapse: (keyName: string) => void;
    handleEnter: () => void;
    handleRetry: () => void;
    onNewAgentWindow?: (agentName: string) => void;
  },
): void {
  if (key.name === '.' && !opts.contextMenuNodeId) {
    if (tryOpenContextMenu(opts.flatNodes, opts.selectedIndex, opts.setContextMenuNodeId)) return;
  }
  if (opts.contextMenuNodeId) return;

  dispatchNavKey(key, opts, () => {
    const node = opts.flatNodes[opts.selectedIndex]?.node;
    if (node?.type === 'agent' && node.wsAgentState === 'running' && opts.onNewAgentWindow) {
      opts.onNewAgentWindow(agentNameFromNode(node));
    }
  });
}

/** Extract the full agent name from a TreeNode (node.id = "agent:<full-name>"). */
function agentNameFromNode(node: TreeNode): string {
  return node.id.replace(/^agent:/, '');
}

/** Spawn a stopped agent by launching `genie spawn <name>` from its workspace directory */
function spawnAgent(name: string, onTmuxSessionSelect?: (sessionName: string, windowIndex?: number) => void): void {
  try {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const { join, resolve } = require('node:path') as typeof import('node:path');
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    const bunPath = process.execPath || 'bun';
    const genieBin = process.argv[1];
    const wsRoot = process.env.GENIE_TUI_WORKSPACE;
    // tmux session names use the agent name (/ replaced with -)
    const sessionName = name.replace(/\//g, '-');
    let cwd: string | undefined;
    if (wsRoot) {
      // For scoped agents like "genie/qa", resolve to the parent agent dir
      const parentName = name.includes('/') ? name.slice(0, name.indexOf('/')) : name;
      const agentDir = resolve(join(wsRoot, 'agents', parentName));
      if (existsSync(agentDir)) cwd = agentDir;
    }
    // Strip TUI env vars so spawned agents don't inherit them and accidentally
    // launch a second TUI nav sidebar instead of claude.
    const {
      GENIE_TUI_PANE: _a,
      GENIE_TUI_RIGHT: _b,
      GENIE_TUI_WORKSPACE: _c,
      GENIE_IS_DAEMON: _d,
      ...cleanEnv
    } = process.env;
    const spawnOpts = { detached: true, stdio: 'ignore' as const, cwd, env: cleanEnv };
    const child =
      genieBin && genieBin !== 'genie'
        ? spawn(bunPath, [genieBin, 'spawn', name, '--session', sessionName, '--new-window'], spawnOpts)
        : spawn('genie', ['spawn', name, '--session', sessionName, '--new-window'], spawnOpts);
    child.unref();
    if (onTmuxSessionSelect) {
      attachSpawnedAgentWhenReady(sessionName, onTmuxSessionSelect);
    }
  } catch (err) {
    console.error(`TUI: spawn failed for ${name}:`, err instanceof Error ? err.message : err);
  }
}

function attachSpawnedAgentWhenReady(
  sessionName: string,
  onTmuxSessionSelect: (sessionName: string, windowIndex?: number) => void,
  attempt = 0,
): void {
  const maxAttempts = 40;
  const retryDelayMs = 250;

  void (async () => {
    try {
      const snap = await collectDiagnostics();
      const session = snap.sessions.find((candidate) => candidate.name === sessionName);
      if (session) {
        const windowIndex = resolvePreferredWindowIndex(session, sessionName);
        if (windowIndex !== undefined) {
          onTmuxSessionSelect(sessionName, windowIndex);
          return;
        }
      }
    } catch {
      // best-effort polling
    }

    if (attempt >= maxAttempts) {
      onTmuxSessionSelect(sessionName);
      return;
    }

    setTimeout(() => {
      attachSpawnedAgentWhenReady(sessionName, onTmuxSessionSelect, attempt + 1);
    }, retryDelayMs);
  })();
}

/** Execute a tmux command in the background (fire-and-forget). */
function executeTmux(args: string[]): void {
  try {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const child = spawn('tmux', args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // best-effort
  }
}

/** Execute a genie CLI command in the background (fire-and-forget). */
function executeGenie(args: string[]): void {
  try {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const bunPath = process.execPath || 'bun';
    const genieBin = process.argv[1];
    const child =
      genieBin && genieBin !== 'genie'
        ? spawn(bunPath, [genieBin, ...args], { detached: true, stdio: 'ignore' })
        : spawn('genie', args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // best-effort
  }
}

/**
 * Resolve a Nav tree node into an AgentPickerTarget — the (session, window?)
 * pair that "Spawn here…" should populate into the intent. Returns null if
 * the node isn't spawn-here eligible.
 */
function resolveSpawnHereTarget(node: TreeNode): AgentPickerTarget | null {
  if (node.type === 'session') {
    const sess = node.id.split(':').slice(1).join(':');
    if (sess.length === 0) return null;
    return { session: sess };
  }
  if (node.type === 'window') {
    const idParts = node.id.split(':');
    if (idParts.length < 3) return null;
    return { session: idParts[1], window: `${idParts[1]}:${idParts[2]}` };
  }
  return null;
}

/**
 * Execute a SpawnIntent via the genie CLI (fire-and-forget).
 *
 * Uses the argv returned by `buildSpawnInvocation` as the single source of
 * truth — the same intent that powered the CliPreviewLine is handed to the
 * child process, so the previewed and executed commands cannot drift.
 */
function executeSpawnIntent(intent: SpawnIntent): void {
  try {
    const { argv } = buildSpawnInvocation(intent);
    executeGenie(argv);
  } catch (err) {
    console.error('TUI: spawn-intent execution failed:', err instanceof Error ? err.message : err);
  }
}

/** Find the ancestor agent node that contains a given node ID. */
function findParentAgent(tree: TreeNode[], targetId: string): TreeNode | null {
  for (const node of tree) {
    if (node.type === 'agent' && containsNode(node, targetId)) return node;
    const found = findParentAgent(node.children, targetId);
    if (found) return found;
  }
  return null;
}

function containsNode(node: TreeNode, targetId: string): boolean {
  if (node.id === targetId) return true;
  return node.children.some((c) => containsNode(c, targetId));
}

/** Merge expanded state from old tree into new tree (preserves user navigation) */
function mergeExpandedState(oldTree: TreeNode[], newTree: TreeNode[]): TreeNode[] {
  if (oldTree.length === 0) return newTree;

  const oldState = new Map<string, { expanded: boolean; childCount: number }>();
  function collect(nodes: TreeNode[]) {
    for (const n of nodes) {
      oldState.set(n.id, { expanded: n.expanded, childCount: n.children.length });
      collect(n.children);
    }
  }
  collect(oldTree);

  function apply(nodes: TreeNode[]): TreeNode[] {
    return nodes.map((n) => ({
      ...n,
      expanded: (() => {
        const previous = oldState.get(n.id);
        if (!previous) return n.expanded;
        // Let nodes auto-expand the first time they gain children.
        if (previous.childCount === 0 && n.children.length > 0) return n.expanded;
        return previous.expanded;
      })(),
      children: apply(n.children),
    }));
  }
  return apply(newTree);
}
