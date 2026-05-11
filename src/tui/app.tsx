/** @jsxImportSource @opentui/react */
/** Root App component — Sessions nav + tmux right pane management */

import { execSync } from 'node:child_process';
import { useBindings } from '@opentui/keymap/react';
import { useRenderer } from '@opentui/react';
import { useCallback, useEffect, useState } from 'react';
import { HelpOverlay } from './components/HelpOverlay.js';
import { Nav } from './components/Nav.js';
import { QuitDialog } from './components/QuitDialog.js';
import { palette } from './theme.js';
import { attachProjectWindow, newAgentWindow } from './tmux.js';

const BASE_TERMINAL_TITLE = 'genie tui';

/**
 * Width of the Nav column in embed mode. Mirrors `NAV_WIDTH` in
 * `src/term-commands/serve.ts` (legacy mode uses the same split via
 * `tmux split-window -l ${cols - NAV_WIDTH - 1}`).
 */
const EMBED_NAV_WIDTH = 30;

interface AppProps {
  rightPane?: string;
  /** Workspace root path — enables workspace mode */
  workspaceRoot?: string;
  /** Pre-select this agent on initial render */
  initialAgent?: string;
  /**
   * Embed mode: OpenTUI hosts the right side via `<TerminalPane>`. When false,
   * the legacy dual-tmux mirror still owns the right side (`-L genie-tui`).
   * Group 6 will flip the default and delete the legacy branch.
   */
  embedMode?: boolean;
}

export function App({ rightPane, workspaceRoot, initialAgent, embedMode = false }: AppProps) {
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
    if (embedMode) {
      // Embed mode: OpenTUI owns the host, no tmux server to kill. Destroying
      // the renderer fires the `destroy` event awaited in `renderNav()`,
      // which resolves the keep-alive promise and lets bun exit cleanly.
      try {
        (renderer as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        // best-effort
      }
      return;
    }
    // Legacy: detach-only semantics: close the TUI window but leave the serve
    // daemon (and its pgserve, scheduler, hook socket, etc.) running. Next
    // `genie` attach is a fast reconnect instead of a full cold boot. Use
    // `genie serve stop` for explicit daemon shutdown.
    try {
      execSync('tmux -L genie-tui kill-server', { stdio: 'ignore' });
    } catch {}
  }, [embedMode, renderer]);

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
      if (embedMode) {
        // Embed mode: TerminalPane re-attaches via `tmux -CC` when its
        // `sessionName` prop changes (React remounts via `key={sessionName}`).
        // Window selection is honoured by issuing `select-window` on the
        // `-L genie` agent server before the new ControlSession attaches.
        if (windowIndex !== undefined) {
          try {
            execSync(`tmux -L genie select-window -t ${sessionName}:${windowIndex}`, { stdio: 'ignore' });
          } catch {
            // best-effort — TerminalPane will surface attach failures via the
            // `agent server unreachable` Nav status (success criterion #7).
          }
        }
        return;
      }
      if (!rightPane) return;
      attachProjectWindow(rightPane, sessionName, windowIndex);
    },
    [embedMode, rightPane],
  );

  const overlay = showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null;

  if (embedMode) {
    return (
      <box width="100%" height="100%" flexDirection="row">
        <box width={EMBED_NAV_WIDTH} height="100%">
          <Nav
            onTmuxSessionSelect={handleTmuxSessionSelect}
            onNewAgentWindow={newAgentWindow}
            workspaceRoot={workspaceRoot}
            initialAgent={initialAgent}
            keyboardDisabled={showQuit || showHelp}
          />
        </box>
        <box flexGrow={1} height="100%" backgroundColor={palette.bg}>
          {activeSession ? (
            <terminal-pane key={activeSession} sessionName={activeSession} focused flexGrow={1} height="100%" />
          ) : (
            <box flexGrow={1} alignItems="center" justifyContent="center">
              <text fg={palette.textDim}>Select an agent to attach</text>
            </box>
          )}
        </box>
        {overlay}
        {showQuit ? <QuitDialog onConfirm={handleQuit} onCancel={() => setShowQuit(false)} /> : null}
      </box>
    );
  }

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
