/** @jsxImportSource @opentui/react */
/** Navigation panel with 3 tabs: Projects | tmux | Claude — arrow keys navigate, left/right switch tabs */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type DiagnosticSnapshot, collectDiagnostics } from '../diagnostics.js';
import { palette } from '../theme.js';
import { flattenTree, toggleNode } from '../tree.js';
import type { TreeNode } from '../types.js';
import { ClaudeView, getClaudeRowCount } from './ClaudeView.js';
import { TAB_ORDER, TabBar, type TabId } from './TabBar.js';
import { TmuxView, getTmuxRowCount } from './TmuxView.js';
import { TreeNodeRow } from './TreeNode.js';

interface NavProps {
  tree: TreeNode[];
  onTreeChange: (tree: TreeNode[]) => void;
  onProjectSelect: (projectId: string, tmuxSession: string | null) => void;
}

export function Nav({ tree, onTreeChange, onProjectSelect }: NavProps) {
  const [activeTab, setActiveTab] = useState<TabId>('projects');
  const [tabBarFocused, setTabBarFocused] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot | null>(null);

  // Per-tab selected index (preserved when switching)
  const [projectIndex, setProjectIndex] = useState(0);
  const [tmuxIndex, setTmuxIndex] = useState(0);
  const [claudeIndex, setClaudeIndex] = useState(0);

  const flatNodes = useMemo(() => flattenTree(tree), [tree]);

  // Refresh diagnostics every 2s (now async — queries DB for executors)
  const diagTimer = useRef<ReturnType<typeof setInterval> | null>(null);
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

    // Initial collection
    refresh();

    diagTimer.current = setInterval(refresh, 2000);

    return () => {
      active = false;
      if (diagTimer.current) clearInterval(diagTimer.current);
    };
  }, []);

  // Get the active tab's item count
  const getRowCount = useCallback((): number => {
    switch (activeTab) {
      case 'projects':
        return flatNodes.length;
      case 'tmux':
        return diagnostics ? getTmuxRowCount(diagnostics.sessions) : 0;
      case 'claude':
        return diagnostics ? getClaudeRowCount(diagnostics.executors, diagnostics.assignments, diagnostics.gaps) : 0;
    }
  }, [activeTab, flatNodes, diagnostics]);

  // Get/set the active tab's selected index
  const getSelectedIndex = useCallback((): number => {
    switch (activeTab) {
      case 'projects':
        return projectIndex;
      case 'tmux':
        return tmuxIndex;
      case 'claude':
        return claudeIndex;
    }
  }, [activeTab, projectIndex, tmuxIndex, claudeIndex]);

  const setSelectedIndex = useCallback(
    (idx: number) => {
      switch (activeTab) {
        case 'projects':
          setProjectIndex(idx);
          break;
        case 'tmux':
          setTmuxIndex(idx);
          break;
        case 'claude':
          setClaudeIndex(idx);
          break;
      }
    },
    [activeTab],
  );

  const handleProjectSelect = useCallback(
    (id: string) => {
      const idx = flatNodes.findIndex((n) => n.node.id === id);
      if (idx >= 0) setProjectIndex(idx);
    },
    [flatNodes],
  );

  const handleToggle = useCallback(
    (id: string) => {
      onTreeChange(toggleNode(tree, id));
    },
    [tree, onTreeChange],
  );

  const handleEnter = useCallback(() => {
    if (activeTab !== 'projects') return;
    const current = flatNodes[projectIndex]?.node;
    if (!current) return;

    if (current.type === 'project') {
      const proj = current.data as { id: string; tmuxSession: string | null };
      onProjectSelect(proj.id, proj.tmuxSession);
    } else if (current.children.length > 0) {
      handleToggle(current.id);
    }
  }, [activeTab, flatNodes, projectIndex, onProjectSelect, handleToggle]);

  const handleTabBarKey = useCallback(
    (keyName: string): boolean => {
      if (keyName === 'left' || keyName === 'h') {
        const idx = (TAB_ORDER.indexOf(activeTab) - 1 + TAB_ORDER.length) % TAB_ORDER.length;
        setActiveTab(TAB_ORDER[idx]);
        return true;
      }
      if (keyName === 'right' || keyName === 'l') {
        const idx = (TAB_ORDER.indexOf(activeTab) + 1) % TAB_ORDER.length;
        setActiveTab(TAB_ORDER[idx]);
        return true;
      }
      if (keyName === 'down' || keyName === 'j') {
        setTabBarFocused(false);
        setSelectedIndex(0);
        return true;
      }
      return false;
    },
    [activeTab, setSelectedIndex],
  );

  const handleVerticalNav = useCallback(
    (keyName: string, selectedIdx: number, rowCount: number) => {
      if (rowCount === 0) return;
      if (keyName === 'up' || keyName === 'k') {
        setSelectedIndex(selectedIdx === 0 ? rowCount - 1 : selectedIdx - 1);
      } else if (keyName === 'down' || keyName === 'j') {
        setSelectedIndex(selectedIdx >= rowCount - 1 ? 0 : selectedIdx + 1);
      }
    },
    [setSelectedIndex],
  );

  const handleTreeExpand = useCallback(
    (keyName: string, selectedIdx: number) => {
      if (activeTab !== 'projects') return;
      const node = flatNodes[selectedIdx]?.node;
      if (!node) return;
      if ((keyName === 'right' || keyName === 'l') && node.children.length > 0 && !node.expanded) {
        handleToggle(node.id);
      } else if ((keyName === 'left' || keyName === 'h') && node.expanded) {
        handleToggle(node.id);
      }
    },
    [activeTab, flatNodes, handleToggle],
  );

  const handleListKey = useCallback(
    (keyName: string, selectedIdx: number, rowCount: number) => {
      if (keyName === 'enter' || keyName === 'return') {
        handleEnter();
      } else if (keyName === 'up' || keyName === 'k' || keyName === 'down' || keyName === 'j') {
        handleVerticalNav(keyName, selectedIdx, rowCount);
      } else {
        handleTreeExpand(keyName, selectedIdx);
      }
    },
    [handleEnter, handleVerticalNav, handleTreeExpand],
  );

  useKeyboard((key) => {
    if (tabBarFocused) {
      handleTabBarKey(key.name);
      return;
    }
    handleListKey(key.name, getSelectedIndex(), getRowCount());
  });

  const gapCounts = diagnostics
    ? {
        orphanProcesses: diagnostics.gaps.deadPidExecutors.length,
        orphanPanes: diagnostics.gaps.orphanPanes.length,
      }
    : undefined;

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.bg}>
      {/* Tab Bar */}
      <TabBar activeTab={activeTab} focused={tabBarFocused} gaps={gapCounts} />

      {/* Active View */}
      {activeTab === 'projects' && (
        <box flexDirection="column" flexGrow={1}>
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
                selected={!tabBarFocused && i === projectIndex}
                onSelect={handleProjectSelect}
                onToggle={handleToggle}
              />
            ))}
          </scrollbox>
        </box>
      )}

      {activeTab === 'tmux' && diagnostics && (
        <TmuxView sessions={diagnostics.sessions} selectedIndex={tabBarFocused ? -1 : tmuxIndex} />
      )}

      {activeTab === 'claude' && diagnostics && (
        <ClaudeView
          executors={diagnostics.executors}
          assignments={diagnostics.assignments}
          gaps={diagnostics.gaps}
          selectedIndex={tabBarFocused ? -1 : claudeIndex}
        />
      )}

      {(activeTab === 'tmux' || activeTab === 'claude') && !diagnostics && (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={palette.textDim}>Collecting...</text>
        </box>
      )}

      {/* Footer */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLight}>
        <text>
          <span fg={palette.textMuted}>
            {tabBarFocused ? '\u2190\u2192:tab \u2193:tree' : '\u2191\u2193:nav Enter:select'}
          </span>
        </text>
      </box>
    </box>
  );
}
