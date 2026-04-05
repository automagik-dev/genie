import { useNats, useNatsSubscription } from '@khal-os/sdk/app';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

interface TerminalPaneProps {
  sessionId: string;
  active: boolean;
}

type PaneState = 'loading' | 'ready' | 'error';

// ============================================================================
// Constants
// ============================================================================

const ORG_ID = 'default';

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    height: '100%',
    backgroundColor: theme.bg,
    fontFamily: theme.fontFamily,
  },
  overlay: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  spinner: {
    width: '24px',
    height: '24px',
    border: `2px solid ${theme.border}`,
    borderTop: `2px solid ${theme.violet}`,
    borderRadius: '50%',
    animation: 'genie-spin 0.8s linear infinite',
  },
  errorBox: {
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    border: `1px solid ${theme.error}`,
    borderRadius: theme.radiusMd,
    padding: '16px 24px',
    color: theme.error,
    fontSize: '13px',
    textAlign: 'center' as const,
    maxWidth: '360px',
  },
} as const;

// ============================================================================
// Inject spinner keyframes once
// ============================================================================

let spinnerInjected = false;
function injectSpinnerStyle(): void {
  if (spinnerInjected) return;
  spinnerInjected = true;
  const style = document.createElement('style');
  style.textContent = '@keyframes genie-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}

// ============================================================================
// TerminalPane -- Single xterm.js instance connected to PTY via NATS
// ============================================================================

export function TerminalPane({ sessionId, active }: TerminalPaneProps) {
  const nats = useNats();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const natsRef = useRef(nats);
  const [paneState, setPaneState] = useState<PaneState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Keep natsRef current without triggering re-initialization
  useEffect(() => {
    natsRef.current = nats;
  }, [nats]);

  // Stable publish callback that always uses the latest nats ref
  const publishInput = useCallback(
    (data: string) => natsRef.current.publish(GENIE_SUBJECTS.pty.input(ORG_ID, sessionId), { data }),
    [sessionId],
  );

  const publishResize = useCallback(
    (cols: number, rows: number) =>
      natsRef.current.publish(GENIE_SUBJECTS.pty.resize(ORG_ID, sessionId), { cols, rows }),
    [sessionId],
  );

  // ── Initialize xterm.js ──
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is a prop that determines PTY identity
  useEffect(() => {
    injectSpinnerStyle();

    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      theme: {
        background: theme.bg,
        foreground: theme.text,
        cursor: theme.violet,
        selectionBackground: `${theme.violet}44`,
      },
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    // Attempt WebGL addon for performance; fall back gracefully
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
      });
      term.loadAddon(webgl);
    } catch {
      // WebGL not available — canvas renderer is fine
    }

    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // ── Keyboard input -> NATS ──
    term.onData((data: string) => {
      publishInput(data);
    });

    // ── Resize -> NATS ──
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      publishResize(cols, rows);
    });

    // Mark ready once terminal is open
    setPaneState('ready');

    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, publishInput, publishResize]);

  // ── Subscribe to PTY data output via NATS ──
  useNatsSubscription<{ data: string }>(
    GENIE_SUBJECTS.pty.data(ORG_ID, sessionId),
    (msg) => {
      if (termRef.current && msg.data) {
        termRef.current.write(msg.data);
      }
    },
    [sessionId],
  );

  // ── Handle connection errors ──
  useEffect(() => {
    if (!nats.connected && paneState === 'ready') {
      setPaneState('error');
      setErrorMessage('NATS connection lost');
    } else if (nats.connected && paneState === 'error') {
      setPaneState('ready');
      setErrorMessage(null);
    }
  }, [nats.connected, paneState]);

  // ── Refit on visibility/resize ──
  useEffect(() => {
    if (!active || !fitRef.current) return;

    // Fit when becoming active
    fitRef.current.fit();

    // Fit on window resize
    function handleResize() {
      fitRef.current?.fit();
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [active]);

  // ── Focus terminal when tab becomes active ──
  useEffect(() => {
    if (active && termRef.current) {
      termRef.current.focus();
    }
  }, [active]);

  return (
    <div
      style={{
        ...styles.container,
        display: active ? 'block' : 'none',
      }}
    >
      {/* Loading overlay */}
      {paneState === 'loading' && (
        <div style={styles.overlay}>
          <div style={styles.spinner} />
          <span style={{ color: theme.textMuted, fontSize: '13px' }}>Initializing terminal...</span>
        </div>
      )}

      {/* Error overlay */}
      {paneState === 'error' && (
        <div style={styles.overlay}>
          <div style={styles.errorBox}>{errorMessage || 'Failed to connect to PTY session'}</div>
        </div>
      )}

      {/* xterm.js container */}
      <div
        ref={containerRef}
        style={{
          height: '100%',
          visibility: paneState === 'ready' ? 'visible' : 'hidden',
        }}
      />
    </div>
  );
}
