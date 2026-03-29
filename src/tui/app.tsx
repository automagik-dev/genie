/** @jsxImportSource @opentui/react */
/** Root App component — Sessions nav + tmux right pane management */

import { useKeyboard, useRenderer } from '@opentui/react';
import { useCallback } from 'react';
import { Nav } from './components/Nav.js';
import { attachProjectWindow, cleanup } from './tmux.js';

export function App({ rightPane }: { rightPane?: string }) {
  const renderer = useRenderer();

  useKeyboard((key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      renderer.destroy();
      cleanup();
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
