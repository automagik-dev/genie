/**
 * TUI App — React/Ink root component.
 *
 * Renders "Loading..." then the data summary.
 * When a project is selected, auto-switches the right pane.
 * Live data: subscribes to PG LISTEN + runtime events for auto-refresh.
 *
 * Group 4 will add the nav tree components.
 * Group 6 will add activity detection.
 */

import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type TuiSubscription, loadAll, parseRuntimeEvent, subscribe } from './db.js';
import { hasProjectSession, switchRightPane } from './tmux.js';
import type { TuiData, TuiProject } from './types.js';

type AppState = 'loading' | 'ready' | 'error';

export default function App() {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>('loading');
  const [data, setData] = useState<TuiData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const subRef = useRef<TuiSubscription | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Debounced data reload — collapses rapid events into a single query. */
  const scheduleReload = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      loadAll()
        .then(setData)
        .catch((err) => {
          // Don't crash on reload failures — keep showing stale data
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[tui] data reload failed: ${msg}`);
        });
    }, 100);
  }, []);

  // Boot: load all data
  useEffect(() => {
    loadAll()
      .then((result) => {
        setData(result);
        setState('ready');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      });
  }, []);

  // Subscribe to live events once data is loaded
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
        if (action.type === 'data_change') {
          scheduleReload();
        }
        // agent_activity events will be consumed by Group 6 (activity detection)
      },
    })
      .then((sub) => {
        if (cancelled) {
          sub.stop();
        } else {
          subRef.current = sub;
        }
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

  // Auto-switch right pane when project selection changes
  const handleProjectSelect = useCallback(async (project: TuiProject) => {
    const sessionName = project.tmuxSession || project.slug;
    const exists = await hasProjectSession(sessionName);
    if (exists) {
      await switchRightPane(sessionName);
      setActiveProject(sessionName);
    }
  }, []);

  // Keyboard navigation (temporary — Group 4 Nav component will replace this)
  const projects = data?.projects ?? [];
  useInput((input, key) => {
    if (state !== 'ready' || projects.length === 0) return;

    if (key.downArrow) setSelectedIdx((prev) => (prev + 1) % projects.length);
    if (key.upArrow) setSelectedIdx((prev) => (prev - 1 + projects.length) % projects.length);
    if (key.return && projects[selectedIdx]) handleProjectSelect(projects[selectedIdx]);
    if (input === 'q') exit();
  });

  if (state === 'loading') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="#a855f7" bold>
          Genie TUI
        </Text>
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  if (state === 'error') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>
          Error
        </Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  const taskCount = data?.tasks.length ?? 0;

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="#a855f7" bold>
        Genie TUI
      </Text>
      <Text dimColor>
        {projects.length} projects, {taskCount} tasks
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {projects.map((p, i) => (
          <Text
            key={p.id}
            color={i === selectedIdx ? '#ffffff' : '#6b6b8b'}
            backgroundColor={i === selectedIdx ? '#7c3aed' : undefined}
            bold={i === selectedIdx}
          >
            {activeProject === (p.tmuxSession || p.slug) ? ' ▶ ' : '   '}
            {p.name}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate • Enter attach • q quit</Text>
      </Box>
    </Box>
  );
}
