import { useNats } from '@khal-os/sdk/app';
import { useCallback, useEffect, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';
import type { TerminalViewProps } from '../../../lib/types';
import { TerminalPane } from './TerminalPane';

// ============================================================================
// Constants
// ============================================================================

const MAX_TABS = 8;
const ORG_ID = 'default';

// ============================================================================
// Types
// ============================================================================

interface TerminalSession {
  id: string;
  label: string;
  agentId: string | null;
}

// ============================================================================
// Styles
// ============================================================================

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    backgroundColor: theme.bg,
    fontFamily: theme.fontFamily,
  },
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    borderBottom: `1px solid ${theme.border}`,
    backgroundColor: theme.bgCard,
    minHeight: '36px',
    overflow: 'hidden',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'all 0.1s',
    border: 'none',
    background: 'none',
    fontFamily: theme.fontFamily,
  },
  tabClose: {
    fontSize: '10px',
    cursor: 'pointer',
    padding: '0 2px',
    background: 'none',
    border: 'none',
    fontFamily: 'inherit',
    color: theme.textMuted,
  },
  actions: {
    marginLeft: 'auto',
    display: 'flex',
    gap: '4px',
    padding: '4px 8px',
  },
  actionBtn: {
    padding: '4px 10px',
    fontSize: '11px',
    fontFamily: theme.fontFamily,
    borderRadius: theme.radiusSm,
    cursor: 'pointer',
    border: `1px solid ${theme.border}`,
    backgroundColor: 'transparent',
    color: theme.textDim,
  },
  actionBtnAccent: {
    padding: '4px 10px',
    fontSize: '11px',
    fontFamily: theme.fontFamily,
    borderRadius: theme.radiusSm,
    cursor: 'pointer',
    border: `1px solid ${theme.violet}`,
    backgroundColor: `${theme.violet}22`,
    color: theme.violet,
  },
  content: {
    flex: 1,
    position: 'relative' as const,
    overflow: 'hidden',
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: theme.textMuted,
    fontSize: '14px',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  warning: {
    padding: '6px 12px',
    fontSize: '11px',
    color: theme.warning,
    backgroundColor: `${theme.warning}11`,
    borderBottom: `1px solid ${theme.warning}33`,
    textAlign: 'center' as const,
  },
} as const;

// ============================================================================
// TerminalView -- Multi-tab terminal host using NATS for PTY relay
// ============================================================================

export function TerminalView({ windowId }: TerminalViewProps) {
  const nats = useNats();
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [spawning, setSpawning] = useState(false);
  const [tabLimitWarning, setTabLimitWarning] = useState(false);

  // ── Spawn a new terminal tab ──
  const spawnTerminal = useCallback(
    async (agentId?: string) => {
      if (sessions.length >= MAX_TABS) {
        setTabLimitWarning(true);
        setTimeout(() => setTabLimitWarning(false), 3000);
        return;
      }

      setSpawning(true);
      try {
        const result = await nats.request<{ sessionId: string; agentId: string | null }>(
          GENIE_SUBJECTS.pty.create(ORG_ID),
          { agentId: agentId ?? null },
        );

        const label = agentId
          ? `${agentId} \u00b7 ${result.sessionId.slice(0, 8)}`
          : `bash \u00b7 ${result.sessionId.slice(0, 8)}`;

        const session: TerminalSession = {
          id: result.sessionId,
          label,
          agentId: result.agentId,
        };

        setSessions((prev) => [...prev, session]);
        setActiveId(session.id);
      } catch {
        // Spawn failed — silently ignore (TerminalPane shows error state)
      } finally {
        setSpawning(false);
      }
    },
    [nats, sessions.length],
  );

  // ── Close a tab and kill its PTY session ──
  const closeTab = useCallback(
    (sessionId: string) => {
      nats.publish(GENIE_SUBJECTS.pty.kill(ORG_ID, sessionId));
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== sessionId);
        if (sessionId === activeId) {
          setActiveId(next.length > 0 ? next[next.length - 1].id : null);
        }
        return next;
      });
    },
    [nats, activeId],
  );

  // ── Fleet integration: listen for "Connect Terminal" requests ──
  useEffect(() => {
    function handleOpenTerminal(e: Event) {
      const detail = (e as CustomEvent<{ agentId: string }>).detail;
      if (detail?.agentId) {
        spawnTerminal(detail.agentId);
      }
    }
    window.addEventListener('genie:open-terminal', handleOpenTerminal);
    return () => window.removeEventListener('genie:open-terminal', handleOpenTerminal);
  }, [spawnTerminal]);

  return (
    <div data-window-id={windowId} style={styles.root}>
      {/* Max tabs warning */}
      {tabLimitWarning && <div style={styles.warning}>Maximum of {MAX_TABS} terminal tabs reached.</div>}

      {/* Tab bar */}
      <div style={styles.tabBar}>
        {sessions.map((s) => (
          <div
            key={s.id}
            role="tab"
            tabIndex={0}
            aria-selected={s.id === activeId}
            style={{
              ...styles.tab,
              color: s.id === activeId ? theme.text : theme.textDim,
              borderBottom: s.id === activeId ? `2px solid ${theme.borderActive}` : '2px solid transparent',
              backgroundColor: s.id === activeId ? theme.bgCardHover : 'transparent',
            }}
            onClick={() => setActiveId(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') setActiveId(s.id);
            }}
          >
            <span>{s.label}</span>
            <button
              type="button"
              tabIndex={-1}
              style={styles.tabClose}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(s.id);
              }}
            >
              {'\u2715'}
            </button>
          </div>
        ))}

        {/* Action buttons */}
        <div style={styles.actions}>
          <button
            type="button"
            style={styles.actionBtn}
            onClick={() => spawnTerminal()}
            disabled={spawning || !nats.connected}
          >
            + Terminal
          </button>
          <button
            type="button"
            style={styles.actionBtnAccent}
            onClick={() => spawnTerminal(`agent-${Date.now().toString(36)}`)}
            disabled={spawning || !nats.connected}
          >
            + Agent
          </button>
        </div>
      </div>

      {/* Terminal content */}
      <div style={styles.content}>
        {sessions.length === 0 ? (
          <div style={styles.emptyState}>
            <p style={{ margin: 0 }}>No terminal sessions</p>
            <p style={{ margin: 0, fontSize: '12px' }}>
              {nats.connected ? 'Click "+ Terminal" or "+ Agent" to start' : 'Connecting to NATS...'}
            </p>
          </div>
        ) : (
          sessions.map((s) => <TerminalPane key={s.id} sessionId={s.id} active={s.id === activeId} />)
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Fleet integration — exported function to open a terminal for a specific agent
// ============================================================================

/**
 * Opens a terminal tab for a given agent. Designed to be called from the
 * Fleet "Connect Terminal" button or any external view.
 *
 * Usage:
 *   import { openTerminalForAgent } from './TerminalView';
 *   openTerminalForAgent('my-agent-id');
 *
 * Dispatches a custom event that TerminalView listens for (when mounted).
 */
export function openTerminalForAgent(agentId: string): void {
  window.dispatchEvent(new CustomEvent('genie:open-terminal', { detail: { agentId } }));
}
