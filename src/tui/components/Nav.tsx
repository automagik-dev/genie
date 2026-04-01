/** @jsxImportSource @opentui/react */
/** Sessions panel — single tree view of tmux sessions > windows > panes */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { scanAgents } from '../../lib/workspace.js';
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
import { TreeNodeRow } from './TreeNode.js';

interface NavProps {
  onTmuxSessionSelect: (sessionName: string, windowIndex?: number) => void;
  /** Workspace root path — enables workspace mode (merged agent tree) */
  workspaceRoot?: string;
  /** Pre-select this agent on initial render */
  initialAgent?: string;
  /** Disable nav keyboard shortcuts while a modal owns input */
  keyboardDisabled?: boolean;
}

export function Nav({ onTmuxSessionSelect, workspaceRoot, initialAgent, keyboardDisabled = false }: NavProps) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot | null>(null);
  const [sessionTree, setSessionTree] = useState<TreeNode[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [requestedInitialAgent, setRequestedInitialAgent] = useState<string | undefined>(initialAgent);
  const lastTarget = useRef<string | null>(null);

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

  // Clamp selectedIndex when tree shrinks
  useEffect(() => {
    if (flatNodes.length > 0 && selectedIndex >= flatNodes.length) {
      setSelectedIndex(flatNodes.length - 1);
    }
  }, [flatNodes.length, selectedIndex]);

  // Initial agent selection / auto-spawn. Triggered by startup env or file signal.
  useEffect(() => {
    if (!requestedInitialAgent || flatNodes.length === 0) return;
    const idx = flatNodes.findIndex((n) => n.node.id === `agent:${requestedInitialAgent}`);
    if (idx >= 0) {
      setSelectedIndex(idx);
      const node = flatNodes[idx].node;
      if (node.type === 'agent' && node.wsAgentState !== 'running' && node.wsAgentState !== 'spawning') {
        spawnAgent(node.label, onTmuxSessionSelect);
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
        spawnAgent(node.label, onTmuxSessionSelect);
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
      spawnAgent(node.label, onTmuxSessionSelect);
    })();
  }, [flatNodes, selectedIndex, onTmuxSessionSelect]);

  useKeyboard((key) => {
    if (keyboardDisabled) return;
    if (key.name === 'up' || key.name === 'k' || key.name === 'down' || key.name === 'j') {
      handleVerticalNav(key.name);
    } else if (key.name === 'right' || key.name === 'l' || key.name === 'left' || key.name === 'h') {
      handleExpandCollapse(key.name);
    } else if (key.name === 'enter' || key.name === 'return') {
      handleEnter();
    } else if (key.name === 'r') {
      handleRetry();
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
            />
          ))}
        </scrollbox>
      ) : (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={palette.textDim}>Collecting...</text>
        </box>
      )}

      {/* Footer */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLight}>
        <text>
          <span fg={palette.textMuted}>
            {'\u2191\u2193'}:nav {'\u2190\u2192'}:expand Enter:{workspaceRoot ? 'spawn/attach' : 'attach'} R:retry
          </span>
        </text>
      </box>
    </box>
  );
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
    let cwd: string | undefined;
    if (wsRoot) {
      const agentDir = resolve(join(wsRoot, 'agents', name));
      if (existsSync(agentDir)) cwd = agentDir;
    }
    const child =
      genieBin && genieBin !== 'genie'
        ? spawn(bunPath, [genieBin, 'spawn', name, '--session', name], { detached: true, stdio: 'ignore', cwd })
        : spawn('genie', ['spawn', name, '--session', name], { detached: true, stdio: 'ignore', cwd });
    child.unref();
    if (onTmuxSessionSelect) {
      attachSpawnedAgentWhenReady(name, onTmuxSessionSelect);
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
