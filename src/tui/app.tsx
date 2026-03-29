/** @jsxImportSource @opentui/react */
/** Root App component — Sessions nav + tmux right pane management */

import { useCallback } from 'react';
import { Nav } from './components/Nav.js';
import { attachProjectWindow } from './tmux.js';

interface AppProps {
  rightPane?: string;
  /** Workspace root path — enables workspace mode */
  workspaceRoot?: string;
  /** Pre-select this agent on initial render */
  initialAgent?: string;
}

export function App({ rightPane, workspaceRoot, initialAgent }: AppProps) {
  // Quit is handled by tmux key table (Ctrl+Q → kill-session), not by OpenTUI.
  // This ensures BOTH panes die together regardless of which pane has focus.

  const handleTmuxSessionSelect = useCallback(
    (sessionName: string, windowIndex?: number) => {
      if (!rightPane) return;
      attachProjectWindow(rightPane, sessionName, windowIndex);
    },
    [rightPane],
  );

  return (
    <Nav onTmuxSessionSelect={handleTmuxSessionSelect} workspaceRoot={workspaceRoot} initialAgent={initialAgent} />
  );
}
