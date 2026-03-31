/** @jsxImportSource @opentui/react */
/** Root App component — Sessions nav + tmux right pane management */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { useKeyboard } from '@opentui/react';
import { useCallback, useState } from 'react';
import { Nav } from './components/Nav.js';
import { QuitDialog } from './components/QuitDialog.js';
import { attachProjectWindow } from './tmux.js';

interface AppProps {
  rightPane?: string;
  /** Workspace root path — enables workspace mode */
  workspaceRoot?: string;
  /** Pre-select this agent on initial render */
  initialAgent?: string;
}

export function App({ rightPane, workspaceRoot, initialAgent }: AppProps) {
  const [showQuit, setShowQuit] = useState(false);

  // Ctrl+Q: show quit confirmation, double Ctrl+Q: quit immediately
  useKeyboard((key) => {
    if (key.ctrl && key.name === 'q') {
      if (showQuit) {
        handleQuit();
      } else {
        setShowQuit(true);
      }
    }
  });

  const handleQuit = useCallback(() => {
    // Kill genie serve via its PID file
    try {
      const genieHome = process.env.GENIE_HOME ?? `${process.env.HOME}/.genie`;
      const pid = readFileSync(`${genieHome}/serve.pid`, 'utf-8').trim();
      process.kill(Number.parseInt(pid, 10), 'SIGTERM');
    } catch {
      // Fallback: kill the TUI tmux server directly
      try {
        execSync('tmux -L genie-tui kill-server', { stdio: 'ignore' });
      } catch {}
    }
  }, []);

  const handleTmuxSessionSelect = useCallback(
    (sessionName: string, windowIndex?: number) => {
      if (!rightPane) return;
      attachProjectWindow(rightPane, sessionName, windowIndex);
    },
    [rightPane],
  );

  return (
    <box width="100%" height="100%">
      <Nav
        onTmuxSessionSelect={handleTmuxSessionSelect}
        workspaceRoot={workspaceRoot}
        initialAgent={initialAgent}
        keyboardDisabled={showQuit}
      />
      {showQuit ? <QuitDialog onConfirm={handleQuit} onCancel={() => setShowQuit(false)} /> : null}
    </box>
  );
}
