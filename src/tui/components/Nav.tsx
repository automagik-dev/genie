/** @jsxImportSource @opentui/react */
/** Sessions panel — single tree view of tmux sessions > windows > panes */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { ContextMenu } from './ContextMenu.js';
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
      // No session → spawn the agent (creates session + window 0 with Claude)
      if (node.wsAgentState !== 'running' && node.wsAgentState !== 'spawning') {
        spawnAgent(agentNameFromNode(node), onTmuxSessionSelect);
      } else if (node.wsAgentState === 'running') {
        // Attach right pane to the agent's session when already running
        const target = getSessionTarget(node);
        if (target) onTmuxSessionSelect(target.sessionName, target.windowIndex);
      }
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
      const name = node.label;
      setContextMenuNodeId(null);

      // Shared: attach right pane
      if (action === 'attach') {
        const target = getSessionTarget(node);
        if (target) onTmuxSessionSelect(target.sessionName, target.windowIndex);
        return;
      }

      // Agent: retry stuck spawn
      if (action === 'retry') {
        void (async () => {
          try {
            const { reconcileStaleSpawns } = await import('../../lib/agent-registry.js');
            await reconcileStaleSpawns();
          } catch {
            // best-effort
          }
          spawnAgent(name, onTmuxSessionSelect);
        })();
        return;
      }

      // Agent: genie CLI commands
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

      if (action === 'send' && payload) {
        executeGenie(['agent', 'send', payload, '--to', name]);
        return;
      }
      if (action === 'answer-text' && payload) {
        executeGenie(['agent', 'answer', name, `text:${payload}`]);
        return;
      }

      const genieArgs = genieCommands[action];
      if (genieArgs) {
        executeGenie(genieArgs);
        return;
      }

      // Tmux actions — extract identifiers from node ID
      const tmuxServer = process.env.GENIE_TMUX_SERVER || 'genie';

      // Rename: works for agent (session) and session nodes
      if (action === 'rename-session' && payload) {
        const sess =
          node.type === 'agent' ? (node.data.sessionName as string) || name : node.id.split(':').slice(1).join(':');
        executeTmux(['-L', tmuxServer, 'rename-session', '-t', sess, payload]);
        return;
      }
      if (action === 'rename-window' && payload) {
        const idParts = node.id.split(':');
        const windowTarget = `${idParts[1]}:${idParts[2]}`;
        executeTmux(['-L', tmuxServer, 'rename-window', '-t', windowTarget, payload]);
        return;
      }
      if (action === 'rename-pane' && payload && node.type === 'pane') {
        const paneId = node.data.paneId as string;
        executeTmux(['-L', tmuxServer, 'select-pane', '-t', `${paneId}`, '-T', payload]);
        return;
      }

      // Agent: spawn a new parallel worker via genie spawn (with identity, hooks, team)
      if (action === 'agent-new-window' && node.type === 'agent') {
        if (onNewAgentWindow) onNewAgentWindow(agentNameFromNode(node));
        return;
      }

      // Agent: new empty window (shell)
      if (action === 'new-empty-window' && node.type === 'agent') {
        const sessionName = (node.data.sessionName as string) || name;
        executeTmux(['-L', tmuxServer, 'new-window', '-a', '-t', sessionName]);
        return;
      }

      const idParts = node.id.split(':');

      // session:<name>
      if (node.type === 'session') {
        const sess = idParts.slice(1).join(':');
        if (action === 'kill-session') {
          executeTmux(['-L', tmuxServer, 'kill-session', '-t', sess]);
          return;
        }
        if (action === 'new-window') {
          executeTmux(['-L', tmuxServer, 'new-window', '-a', '-t', sess]);
          return;
        }
        if (action === 'clone-session') {
          executeTmux(['-L', tmuxServer, 'new-session', '-d', '-s', `${sess}-clone`, '-t', sess]);
          return;
        }
        if (action === 'spawn-in-session' && payload) {
          executeGenie(['spawn', payload, '--session', sess]);
          return;
        }
      }

      // window:<session>:<index>
      if (node.type === 'window') {
        const windowTarget = `${idParts[1]}:${idParts[2]}`;
        if (action === 'kill-window') {
          executeTmux(['-L', tmuxServer, 'kill-window', '-t', windowTarget]);
          return;
        }
        if (action === 'window-new-agent') {
          const parentAgent = findParentAgent(sessionTree, node.id);
          if (parentAgent) {
            const agentFullName = agentNameFromNode(parentAgent);
            const suffix = Date.now() % 10000;
            const role = `${agentFullName}-${suffix}`;
            executeGenie(['spawn', agentFullName, '--role', role, '--window', windowTarget]);
          }
          return;
        }
        if (action === 'split-pane') {
          executeTmux(['-L', tmuxServer, 'split-window', '-t', windowTarget]);
          return;
        }
        if (action === 'spawn-in-window' && payload) {
          executeGenie(['spawn', payload, '--session', idParts[1]]);
          return;
        }
      }

      // pane:<paneId>
      if (node.type === 'pane') {
        const paneId = node.data.paneId as string;
        if (action === 'clone-agent') {
          // Find parent agent and spawn a parallel worker via genie spawn
          const parentAgent = findParentAgent(sessionTree, node.id);
          if (parentAgent && onNewAgentWindow) {
            onNewAgentWindow(agentNameFromNode(parentAgent));
          }
          return;
        }
        if (action === 'kill-pane') {
          executeTmux(['-L', tmuxServer, 'kill-pane', '-t', `${paneId}`]);
          return;
        }
        if (action === 'split-h') {
          executeTmux(['-L', tmuxServer, 'split-window', '-h', '-t', `${paneId}`]);
          return;
        }
        if (action === 'split-v') {
          executeTmux(['-L', tmuxServer, 'split-window', '-v', '-t', `${paneId}`]);
          return;
        }
      }
    },
    [flatNodes, contextMenuNodeId, sessionTree, onTmuxSessionSelect, onNewAgentWindow],
  );

  const _menuDisabled = keyboardDisabled || contextMenuNodeId !== null;

  useKeyboard((key) => {
    if (keyboardDisabled) return;
    // '.' opens context menu for selected node
    if (key.name === '.' && !contextMenuNodeId) {
      const node = flatNodes[selectedIndex]?.node;
      if (node && buildMenuItems(node).length > 0) {
        setContextMenuNodeId(node.id);
        return;
      }
    }
    if (contextMenuNodeId) return;
    if (key.name === 'up' || key.name === 'k' || key.name === 'down' || key.name === 'j') {
      handleVerticalNav(key.name);
    } else if (key.name === 'right' || key.name === 'l' || key.name === 'left' || key.name === 'h') {
      handleExpandCollapse(key.name);
    } else if (key.name === 'enter' || key.name === 'return') {
      handleEnter();
    } else if (key.name === 'r') {
      handleRetry();
    } else if (key.ctrl && key.name === 't') {
      // Ctrl+T: spawn a parallel worker of the selected agent
      const node = flatNodes[selectedIndex]?.node;
      if (node?.type === 'agent' && node.wsAgentState === 'running' && onNewAgentWindow) {
        onNewAgentWindow(agentNameFromNode(node));
      }
    }
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
        ? spawn(bunPath, [genieBin, 'spawn', name, '--session', sessionName], spawnOpts)
        : spawn('genie', ['spawn', name, '--session', sessionName], spawnOpts);
    child.unref();
    if (onTmuxSessionSelect) {
      attachSpawnedAgentWhenReady(sessionName, onTmuxSessionSelect);
    }
  } catch {
    // best-effort spawn
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
