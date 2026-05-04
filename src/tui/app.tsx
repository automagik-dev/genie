/** @jsxImportSource @opentui/react */
/** Root App component — Sessions nav + tmux right pane management */

import { execSync } from 'node:child_process';
import { useBindings } from '@opentui/keymap/react';
import { useRenderer } from '@opentui/react';
import { useCallback, useEffect, useState } from 'react';
import { HelpOverlay } from './components/HelpOverlay.js';
import { Nav } from './components/Nav.js';
import { QuitDialog } from './components/QuitDialog.js';
import { attachProjectWindow, newAgentWindow } from './tmux.js';

const BASE_TERMINAL_TITLE = 'genie tui';

interface AppProps {
  rightPane?: string;
  /** Workspace root path — enables workspace mode */
  workspaceRoot?: string;
  /** Pre-select this agent on initial render */
  initialAgent?: string;
}

export function App({ rightPane, workspaceRoot, initialAgent }: AppProps) {
  const renderer = useRenderer();
  const [showQuit, setShowQuit] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [activeSession, setActiveSession] = useState<string | null>(null);

  useEffect(() => {
    const title = activeSession ? `${BASE_TERMINAL_TITLE} — ${activeSession}` : BASE_TERMINAL_TITLE;
    try {
      renderer.setTerminalTitle(title);
    } catch {
      // setTerminalTitle is best-effort — terminals without OSC 0/2 support
      // silently no-op, but a thrown error must not break the TUI.
    }
  }, [renderer, activeSession]);

  const handleQuit = useCallback(() => {
    // Detach-only semantics: close the TUI window but leave the serve daemon
    // (and its pgserve, scheduler, hook socket, etc.) running. Next `genie`
    // attach is a fast reconnect instead of a full cold boot. Use
    // `genie serve stop` for explicit daemon shutdown.
    try {
      execSync('tmux -L genie-tui kill-server', { stdio: 'ignore' });
    } catch {}
  }, []);

  useBindings(
    () => ({
      commands: [
        {
          name: 'app.quit',
          title: 'Close TUI',
          desc: 'Close TUI window (daemon keeps running — use `genie serve stop` to shut down)',
          category: 'app',
          run() {
            if (showQuit) {
              handleQuit();
            } else {
              setShowQuit(true);
            }
          },
        },
        {
          name: 'app.help.toggle',
          title: 'Toggle help overlay',
          desc: 'Show/hide the keyboard shortcut overlay',
          category: 'app',
          run() {
            setShowHelp((prev) => !prev);
          },
        },
        {
          name: 'app.console.toggle',
          title: 'Toggle console overlay',
          desc: 'Show/hide the OpenTUI console (logs)',
          category: 'app',
          run() {
            renderer.console.toggle();
          },
        },
      ],
      bindings: [
        { key: 'ctrl+q', cmd: 'app.quit' },
        { key: 'f1', cmd: 'app.help.toggle' },
        { key: '`', cmd: 'app.console.toggle' },
      ],
    }),
    [renderer, showQuit, handleQuit],
  );

  const handleTmuxSessionSelect = useCallback(
    (sessionName: string, windowIndex?: number) => {
      setActiveSession(sessionName);
      if (!rightPane) return;
      attachProjectWindow(rightPane, sessionName, windowIndex);
    },
    [rightPane],
  );

  const overlay = showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null;

  return (
    <box width="100%" height="100%">
      <Nav
        onTmuxSessionSelect={handleTmuxSessionSelect}
        onNewAgentWindow={newAgentWindow}
        workspaceRoot={workspaceRoot}
        initialAgent={initialAgent}
        keyboardDisabled={showQuit || showHelp}
      />
      {overlay}
      {showQuit ? <QuitDialog onConfirm={handleQuit} onCancel={() => setShowQuit(false)} /> : null}
    </box>
  );
}
