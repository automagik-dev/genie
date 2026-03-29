/** @jsxImportSource @opentui/react */
/** Root App component — Sessions nav + tmux right pane management */

import { useKeyboard, useRenderer } from '@opentui/react';
import { useCallback } from 'react';
import { Nav } from './components/Nav.js';
import { attachProjectWindow, cleanup } from './tmux.js';

export function App({ rightPane }: { rightPane?: string }) {
  const renderer = useRenderer();

  useKeyboard((key) => {
    // Ctrl+Q or Ctrl+C: kill the entire TUI (both panes)
    if ((key.ctrl && key.name === 'q') || (key.ctrl && key.name === 'c')) {
      // Kill tmux session FIRST (kills both panes), then destroy renderer
      cleanup();
      renderer.destroy();
    }
  });

  const handleTmuxSessionSelect = useCallback(
    (sessionName: string, windowIndex?: number) => {
      if (!rightPane) return;
      attachProjectWindow(rightPane, sessionName, windowIndex);
    },
    [rightPane],
  );

  return <Nav onTmuxSessionSelect={handleTmuxSessionSelect} />;
}
