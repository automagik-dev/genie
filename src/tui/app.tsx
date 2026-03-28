/**
 * TUI App — React/Ink root component.
 *
 * Group 2 scaffold: renders "Loading..." state.
 * Groups 3-7 will add the nav tree, live data, and agent indicators.
 */

import { Box, Text, useApp } from 'ink';
import { useEffect, useState } from 'react';
import { loadAll } from './db.js';
import type { TuiData } from './types.js';

type AppState = 'loading' | 'ready' | 'error';

export default function App() {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>('loading');
  const [data, setData] = useState<TuiData | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  // Exit after showing ready/error state (scaffold behavior — Group 4+ will keep alive)
  useEffect(() => {
    if (state === 'ready' || state === 'error') {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
  }, [state, exit]);

  if (state === 'loading') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
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

  const projectCount = data?.projects.length ?? 0;
  const taskCount = data?.tasks.length ?? 0;

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        Genie TUI
      </Text>
      <Text>
        {projectCount} projects, {taskCount} tasks
      </Text>
      <Text dimColor>Scaffold ready. Navigation tree coming in Group 4.</Text>
    </Box>
  );
}
