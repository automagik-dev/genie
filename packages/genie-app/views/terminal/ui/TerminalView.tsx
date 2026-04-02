import { useCallback, useEffect, useState } from 'react';
import { invoke, onEvent } from '../../../lib/ipc';
import type { TerminalViewProps } from '../../../lib/types';
import { TerminalPane } from './TerminalPane';

// ============================================================================
// Types
// ============================================================================

interface TerminalSession {
  id: string;
  label: string;
  agentId: string | null;
}

// ============================================================================
// Theme
// ============================================================================

const t = {
  bg: '#1a1028',
  bgCard: '#241838',
  bgHover: '#2e2048',
  border: '#414868',
  borderActive: '#7c3aed',
  text: '#e2e8f0',
  textDim: '#94a3b8',
  textMuted: '#64748b',
  violet: '#7c3aed',
  error: '#f87171',
} as const;

// ============================================================================
// TerminalView — Multi-tab terminal host
// ============================================================================

export function TerminalView({ windowId }: TerminalViewProps) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [spawning, setSpawning] = useState(false);

  // Listen for PTY exits to remove closed sessions
  useEffect(() => {
    const unsub = onEvent('pty-exit', (payload) => {
      const exitedId = payload.sessionId as string;
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== exitedId);
        // If active tab was closed, switch to the last remaining
        if (exitedId === activeId && next.length > 0) {
          setActiveId(next[next.length - 1].id);
        } else if (next.length === 0) {
          setActiveId(null);
        }
        return next;
      });
    });
    return unsub;
  }, [activeId]);

  const spawnBash = useCallback(async () => {
    setSpawning(true);
    try {
      const result = await invoke<{ sessionId: string; agentId: string | null }>('spawn_terminal', {});
      const session: TerminalSession = {
        id: result.sessionId,
        label: `bash-${sessions.length + 1}`,
        agentId: null,
      };
      setSessions((prev) => [...prev, session]);
      setActiveId(session.id);
    } catch {
      // Spawn failed — silently ignore
    } finally {
      setSpawning(false);
    }
  }, [sessions.length]);

  const spawnAgent = useCallback(async () => {
    const name = `agent-${Date.now().toString(36)}`;
    setSpawning(true);
    try {
      const result = await invoke<{ sessionId: string; agentId: string | null }>('spawn_terminal', {
        agentName: name,
      });
      const session: TerminalSession = {
        id: result.sessionId,
        label: name,
        agentId: result.agentId,
      };
      setSessions((prev) => [...prev, session]);
      setActiveId(session.id);
    } catch {
      // Spawn failed
    } finally {
      setSpawning(false);
    }
  }, []);

  const closeTab = useCallback(
    async (sessionId: string) => {
      await invoke('kill_terminal', { sessionId });
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== sessionId);
        if (sessionId === activeId) {
          setActiveId(next.length > 0 ? next[next.length - 1].id : null);
        }
        return next;
      });
    },
    [activeId],
  );

  return (
    <div
      data-window-id={windowId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: t.bg,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      }}
    >
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: `1px solid ${t.border}`,
          backgroundColor: t.bgCard,
          minHeight: '36px',
          overflow: 'hidden',
        }}
      >
        {sessions.map((s) => (
          <div
            key={s.id}
            role="tab"
            tabIndex={0}
            aria-selected={s.id === activeId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              fontSize: '12px',
              cursor: 'pointer',
              color: s.id === activeId ? t.text : t.textDim,
              borderBottom: s.id === activeId ? `2px solid ${t.borderActive}` : '2px solid transparent',
              backgroundColor: s.id === activeId ? t.bgHover : 'transparent',
              transition: 'all 0.1s',
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
              style={{
                fontSize: '10px',
                color: t.textMuted,
                cursor: 'pointer',
                padding: '0 2px',
                background: 'none',
                border: 'none',
                fontFamily: 'inherit',
              }}
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
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px', padding: '4px 8px' }}>
          <button
            type="button"
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'inherit',
              border: `1px solid ${t.border}`,
              borderRadius: '4px',
              backgroundColor: 'transparent',
              color: t.textDim,
              cursor: 'pointer',
            }}
            onClick={spawnBash}
            disabled={spawning}
          >
            + Terminal
          </button>
          <button
            type="button"
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'inherit',
              border: `1px solid ${t.violet}`,
              borderRadius: '4px',
              backgroundColor: `${t.violet}22`,
              color: t.violet,
              cursor: 'pointer',
            }}
            onClick={spawnAgent}
            disabled={spawning}
          >
            + Agent
          </button>
        </div>
      </div>

      {/* Terminal content */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {sessions.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: t.textMuted,
              fontSize: '14px',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <p style={{ margin: 0 }}>No terminal sessions</p>
            <p style={{ margin: 0, fontSize: '12px' }}>Click &quot;+ Terminal&quot; or &quot;+ Agent&quot; to start</p>
          </div>
        ) : (
          sessions.map((s) => <TerminalPane key={s.id} sessionId={s.id} active={s.id === activeId} />)
        )}
      </div>
    </div>
  );
}
