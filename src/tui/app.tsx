/** @jsxImportSource @opentui/react */
/** Root App component — orchestrates nav tree, data loading, tmux integration */

import { useKeyboard, useRenderer } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveWork, getExecutorActivity, matchWorkToTasks } from './activity.js';
import { Nav } from './components/Nav.js';
import { loadAll, loadAssignments, loadExecutors, subscribe } from './db.js';
import { palette } from './theme.js';
import { attachProject, cleanup, switchRightPane } from './tmux.js';
import { applyActivity, buildTree } from './tree.js';
import type { TreeNode, TuiAssignment, TuiData, TuiExecutor } from './types.js';

export function App({ rightPane }: { rightPane?: string }) {
  const renderer = useRenderer();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentProject, setCurrentProject] = useState<string | null>(null);
  const dataRef = useRef<TuiData | null>(null);
  const subRef = useRef<{ stop: () => Promise<void> } | null>(null);

  // Exit handler — kill entire TUI session, not just the renderer
  useKeyboard((key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      renderer.destroy();
      // Kill the genie-tui tmux session so both panes die together
      cleanup();
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

  // Executor + assignment state refs (for activity scan)
  const executorsRef = useRef<TuiExecutor[]>([]);
  const assignmentsRef = useRef<TuiAssignment[]>([]);

  // Activity detection tick (1s) — DB executor state + tmux fallback
  useEffect(() => {
    let active = true;

    async function refreshActivity() {
      if (!dataRef.current) return;
      const activity = await fetchMergedActivity(dataRef.current, executorsRef, assignmentsRef);
      if (active) setTree((prev) => applyActivity(prev, activity));
    }

    const timer = setInterval(refreshActivity, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
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
      <box width="100%" height="100%" backgroundColor={palette.bg} justifyContent="center" alignItems="center">
        <text fg={palette.purple}>Loading...</text>
      </box>
    );
  }

  if (error) {
    return (
      <box width="100%" height="100%" backgroundColor={palette.bg} justifyContent="center" alignItems="center">
        <text fg={palette.error}>{error}</text>
      </box>
    );
  }

  return (
    <Nav
      tree={tree}
      tasks={dataRef.current?.tasks ?? []}
      onTreeChange={handleTreeChange}
      onProjectSelect={handleProjectSelect}
    />
  );
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

type ActivityMap = Map<string, { panes: number; state?: 'idle' | 'working' | 'permission' | 'error' }>;

/** Scan all project tmux sessions for active work (fallback). */
function scanTmuxActivity(data: TuiData): ActivityMap {
  const result: ActivityMap = new Map();
  for (const proj of data.projects) {
    if (!proj.tmuxSession) continue;
    const windows = getActiveWork(proj.tmuxSession);
    for (const [taskId, act] of matchWorkToTasks(windows, data.tasks)) {
      result.set(taskId, act);
    }
  }
  return result;
}

/** Fetch DB executor activity, merge with tmux fallback. */
async function fetchMergedActivity(
  data: TuiData,
  executorsRef: { current: TuiExecutor[] },
  assignmentsRef: { current: TuiAssignment[] },
): Promise<ActivityMap> {
  try {
    const execs = await loadExecutors();
    const execIds = execs.map((e) => e.id);
    const assigns = execIds.length > 0 ? await loadAssignments(execIds) : [];
    executorsRef.current = execs;
    assignmentsRef.current = assigns;

    const activity = getExecutorActivity(execs, assigns);
    // Merge tmux fallback for tasks without DB assignments
    for (const [taskId, act] of scanTmuxActivity(data)) {
      if (!activity.has(taskId)) activity.set(taskId, act);
    }
    return activity;
  } catch {
    return scanTmuxActivity(data);
  }
}
