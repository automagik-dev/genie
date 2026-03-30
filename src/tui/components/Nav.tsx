/** @jsxImportSource @opentui/react */
/** Sessions panel — single tree view of tmux sessions > windows > panes */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { scanAgents } from '../../lib/workspace.js';
import { type DiagnosticSnapshot, collectDiagnostics } from '../diagnostics.js';
import { buildSessionTree, buildWorkspaceTree, getSessionTarget } from '../session-tree.js';
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
}

export function Nav({ onTmuxSessionSelect, workspaceRoot, initialAgent }: NavProps) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot | null>(null);
  const [sessionTree, setSessionTree] = useState<TreeNode[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const lastTarget = useRef<string | null>(null);
  const genieHome = useRef(process.env.GENIE_HOME ?? `${process.env.HOME}/.genie`);

  // Refresh diagnostics every 2s
  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const snap = await collectDiagnostics();
        if (active) setDiagnostics(snap);
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

  // File-based initial agent: thin client writes ~/.genie/tui-initial-agent before attaching.
  // Check on each diagnostics refresh (2s) so re-attach from a different agent dir works.
  const [pendingAgent, setPendingAgent] = useState<string | undefined>(initialAgent);

  useEffect(() => {
    if (!diagnostics) return;
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const agentFile = `${genieHome.current}/tui-initial-agent`;
      if (fs.existsSync(agentFile)) {
        const agent = fs.readFileSync(agentFile, 'utf-8').trim();
        fs.unlinkSync(agentFile);
        if (agent) setPendingAgent(agent);
      }
    } catch {
      // best-effort
    }
  }, [diagnostics]);

  // Apply pending agent selection (from prop or file)
  useEffect(() => {
    if (!pendingAgent || flatNodes.length === 0) return;
    const idx = flatNodes.findIndex((n) => n.node.id === `agent:${pendingAgent}`);
    if (idx >= 0) {
      setSelectedIndex(idx);
      setPendingAgent(undefined);
    }
  }, [pendingAgent, flatNodes]);

  // Auto-switch right pane when cursor moves to a new target
  useEffect(() => {
    const current = flatNodes[selectedIndex]?.node;
    if (!current) return;
    const target = getSessionTarget(current);
    if (!target) return;
    const key = `${target.sessionName}:${target.windowIndex ?? ''}`;
    if (key === lastTarget.current) return;
    lastTarget.current = key;

    // Only auto-attach for running agents (or session/window/pane nodes)
    if (current.type === 'agent' && current.wsAgentState !== 'running') return;
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

    // Agent node: spawn if not running, then attach
    if (node.type === 'agent') {
      if (node.wsAgentState !== 'running') {
        spawnAgent(node.label);
      }
      const target = getSessionTarget(node);
      if (target) onTmuxSessionSelect(target.sessionName, target.windowIndex);
      return;
    }

    if (node.children.length > 0) handleToggle(node.id);
    const target = getSessionTarget(node);
    if (target) onTmuxSessionSelect(target.sessionName, target.windowIndex);
  }, [flatNodes, selectedIndex, handleToggle, onTmuxSessionSelect]);

  useKeyboard((key) => {
    if (key.name === 'up' || key.name === 'k' || key.name === 'down' || key.name === 'j') {
      handleVerticalNav(key.name);
    } else if (key.name === 'right' || key.name === 'l' || key.name === 'left' || key.name === 'h') {
      handleExpandCollapse(key.name);
    } else if (key.name === 'enter' || key.name === 'return') {
      handleEnter();
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
            {'\u2191\u2193'}:nav {'\u2190\u2192'}:expand Enter:{workspaceRoot ? 'spawn/attach' : 'attach'}
          </span>
        </text>
      </box>
    </box>
  );
}

/** Spawn a stopped agent by launching `genie spawn <name>` in background */
function spawnAgent(name: string): void {
  try {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    spawn('genie', ['spawn', name], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    // best-effort spawn
  }
}

/** Merge expanded state from old tree into new tree (preserves user navigation) */
function mergeExpandedState(oldTree: TreeNode[], newTree: TreeNode[]): TreeNode[] {
  if (oldTree.length === 0) return newTree;

  const oldState = new Map<string, boolean>();
  function collect(nodes: TreeNode[]) {
    for (const n of nodes) {
      oldState.set(n.id, n.expanded);
      collect(n.children);
    }
  }
  collect(oldTree);

  function apply(nodes: TreeNode[]): TreeNode[] {
    return nodes.map((n) => ({
      ...n,
      expanded: oldState.has(n.id) ? (oldState.get(n.id) as boolean) : n.expanded,
      children: apply(n.children),
    }));
  }
  return apply(newTree);
}
