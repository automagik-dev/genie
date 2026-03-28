/** @jsxImportSource @opentui/react */
/** Root App component — orchestrates nav tree, data loading, tmux integration */

import { useKeyboard, useRenderer } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveWork, matchWorkToTasks } from './activity.js';
import { Nav } from './components/Nav.js';
import { loadAll, subscribe } from './db.js';
import { palette } from './theme.js';
import { attachProject, switchRightPane } from './tmux.js';
import { applyActivity, buildTree } from './tree.js';
import type { TreeNode, TuiData } from './types.js';

export function App({ rightPane }: { rightPane?: string }) {
  const renderer = useRenderer();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentProject, setCurrentProject] = useState<string | null>(null);
  const dataRef = useRef<TuiData | null>(null);
  const subRef = useRef<{ stop: () => Promise<void> } | null>(null);

  // Exit handler
  useKeyboard((key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      renderer.destroy();
    }
  });

  // Load data on mount
  useEffect(() => {
    let cancelled = false;

    const onEvent = async () => {
      try {
        const freshData = await loadAll();
        if (cancelled) return;
        dataRef.current = freshData;
        setTree((prev) => mergeExpandedState(prev, buildTree(freshData)));
      } catch (err) {
        console.error('TUI: data refresh failed:', err);
      }
    };

    async function boot() {
      const data = await loadAll();
      if (cancelled) return;
      dataRef.current = data;
      setTree(buildTree(data));
      setLoading(false);

      const sub = await subscribe(onEvent);
      if (cancelled) return void sub.stop();
      subRef.current = sub;
    }

    boot().catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });

    return () => {
      cancelled = true;
      subRef.current?.stop();
      subRef.current = null;
    };
  }, []);

  // Activity detection tick (1s)
  useEffect(() => {
    const timer = setInterval(() => {
      if (!dataRef.current) return;
      const activity = scanActivity(dataRef.current);
      setTree((prev) => applyActivity(prev, activity));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const handleTreeChange = useCallback((newTree: TreeNode[]) => {
    setTree(newTree);
  }, []);

  const handleProjectSelect = useCallback(
    (projectId: string, tmuxSession: string | null) => {
      if (!tmuxSession || !rightPane) return;
      if (currentProject === projectId) return;
      if (currentProject) {
        switchRightPane(rightPane, tmuxSession);
      } else {
        attachProject(rightPane, tmuxSession);
      }
      setCurrentProject(projectId);
    },
    [rightPane, currentProject],
  );

  if (loading) {
    return (
      <box width={30} height="100%" backgroundColor={palette.bg} justifyContent="center" alignItems="center">
        <text fg={palette.purple}>Loading...</text>
      </box>
    );
  }

  if (error) {
    return (
      <box width={30} height="100%" backgroundColor={palette.bg} justifyContent="center" alignItems="center">
        <text fg={palette.error}>{error}</text>
      </box>
    );
  }

  return <Nav tree={tree} onTreeChange={handleTreeChange} onProjectSelect={handleProjectSelect} />;
}

/** Merge expanded state from old tree into new tree (preserves user navigation) */
function mergeExpandedState(oldTree: TreeNode[], newTree: TreeNode[]): TreeNode[] {
  const expandedIds = new Set<string>();
  function collect(nodes: TreeNode[]) {
    for (const n of nodes) {
      if (n.expanded) expandedIds.add(n.id);
      collect(n.children);
    }
  }
  collect(oldTree);

  function apply(nodes: TreeNode[]): TreeNode[] {
    return nodes.map((n) => ({
      ...n,
      expanded: expandedIds.has(n.id) || n.expanded,
      children: apply(n.children),
    }));
  }
  return apply(newTree);
}

/** Scan all project tmux sessions for active work */
function scanActivity(
  data: TuiData,
): Map<string, { panes: number; state?: 'idle' | 'working' | 'permission' | 'error' }> {
  const allActivity = new Map<string, { panes: number; state?: 'idle' | 'working' | 'permission' | 'error' }>();
  try {
    for (const proj of data.projects) {
      if (!proj.tmuxSession) continue;
      const windows = getActiveWork(proj.tmuxSession);
      const matched = matchWorkToTasks(windows, data.tasks);
      for (const [taskId, act] of matched) {
        allActivity.set(taskId, act);
      }
    }
  } catch (err) {
    console.error('TUI: activity scan failed:', err);
  }
  return allActivity;
}
