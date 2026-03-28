/**
 * TUI App — React/Ink root component.
 *
 * Renders nav tree on the left (Ink), auto-switches tmux right pane.
 * Live data: subscribes to PG LISTEN + runtime events for auto-refresh.
 */

import { Box, Text, useApp } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import Nav from './components/Nav.js';
import { type TuiSubscription, loadAll, parseRuntimeEvent, subscribe } from './db.js';
import { hasProjectSession, switchRightPane } from './tmux.js';
import { type TreeNode, buildTree, collectExpanded, restoreExpansion } from './tree.js';
import type { TuiData } from './types.js';

type AppState = 'loading' | 'ready' | 'error';

/** Get live tmux session names */
function getLiveSessions(): Set<string> {
  try {
    const { execSync } = require('node:child_process');
    const out = execSync("tmux list-sessions -F '#{session_name}'", { encoding: 'utf8', timeout: 2000 });
    return new Set(out.trim().split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

export default function App() {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>('loading');
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const subRef = useRef<TuiSubscription | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandedRef = useRef<Set<string>>(new Set());

  /** Rebuild tree from data, preserving expansion state */
  const rebuildTree = useCallback((data: TuiData) => {
    const sessions = getLiveSessions();
    const newTree = buildTree(data, sessions);
    // Restore expansion
    restoreExpansion(newTree, expandedRef.current);
    // First load: expand org root + first live project
    if (expandedRef.current.size === 0 && newTree[0]) {
      newTree[0].expanded = true;
      const liveProject = newTree[0].children.find((n) => n.data.kind === 'project' && n.data.isLive);
      if (liveProject) liveProject.expanded = true;
    }
    setTree(newTree);
  }, []);

  /** Debounced data reload */
  const scheduleReload = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      loadAll()
        .then((data) => {
          expandedRef.current = collectExpanded(tree);
          rebuildTree(data);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[tui] data reload failed: ${msg}`);
        });
    }, 100);
  }, [tree, rebuildTree]);

  // Boot: load all data
  useEffect(() => {
    loadAll()
      .then((data) => {
        rebuildTree(data);
        setState('ready');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      });
  }, [rebuildTree]);

  // Subscribe to live events
  useEffect(() => {
    if (state !== 'ready') return;
    let cancelled = false;

    subscribe({
      onDataChange: () => {
        if (!cancelled) scheduleReload();
      },
      onRuntimeEvent: (event) => {
        if (cancelled) return;
        const action = parseRuntimeEvent(event);
        if (action.type === 'data_change') scheduleReload();
      },
    })
      .then((sub) => {
        if (cancelled) sub.stop();
        else subRef.current = sub;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[tui] subscribe failed: ${msg}`);
      });

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      subRef.current?.stop();
      subRef.current = null;
    };
  }, [state, scheduleReload]);

  /** Handle project selection from Nav — switch right tmux pane */
  const handleProjectSelect = useCallback(async (sessionName: string) => {
    try {
      const exists = await hasProjectSession(sessionName);
      if (exists) await switchRightPane(sessionName);
    } catch {}
  }, []);

  if (state === 'loading') {
    return (
      <Box flexDirection="column">
        <Text color="#a855f7" bold>
          {' '}
          ◆ genie
        </Text>
        <Text dimColor> Loading...</Text>
      </Box>
    );
  }

  if (state === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red" bold>
          {' '}
          Error
        </Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  return <Nav tree={tree} onProjectSelect={handleProjectSelect} onExit={exit} />;
}
