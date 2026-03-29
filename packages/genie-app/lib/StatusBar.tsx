import { useEffect, useState } from 'react';
import { invoke } from './ipc';

// ============================================================================
// Theme tokens (matches all views)
// ============================================================================

const t = {
  bg: '#1a1028',
  bgLight: '#241838',
  border: '#414868',
  text: '#e2e8f0',
  textDim: '#94a3b8',
  textMuted: '#64748b',
  purple: '#a855f7',
  emerald: '#34d399',
  warning: '#fbbf24',
  error: '#f87171',
} as const;

// ============================================================================
// Types
// ============================================================================

interface StatusBarProps {
  activeView: string;
  shortcuts?: Array<{ key: string; label: string }>;
}

interface QuickStats {
  agentsOnline: number;
  tasksActive: number;
  teamsActive: number;
}

// ============================================================================
// StatusBar — Bottom bar with shortcuts, quick stats, and connection status
// ============================================================================

const REFRESH_MS = 10_000;

export function StatusBar({ activeView, shortcuts = [] }: StatusBarProps) {
  const [stats, setStats] = useState<QuickStats | null>(null);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const data = await invoke<{ agents: { online: number }; tasks: { active: number }; teams: { active: number } }>(
          'dashboard_stats',
        );
        if (active) {
          setStats({
            agentsOnline: data.agents.online,
            tasksActive: data.tasks.active,
            teamsActive: data.teams.active,
          });
          setConnected(true);
        }
      } catch {
        if (active) setConnected(false);
      }
    }

    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const defaultShortcuts = [
    { key: 'j/k', label: 'navigate' },
    { key: 'Enter', label: 'select' },
    { key: 'Esc', label: 'back' },
  ];

  const mergedShortcuts = shortcuts.length > 0 ? shortcuts : defaultShortcuts;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '28px',
        padding: '0 16px',
        borderTop: `1px solid ${t.border}`,
        backgroundColor: t.bgLight,
        fontSize: '11px',
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
        gap: '16px',
        flexShrink: 0,
      }}
    >
      {/* Left: keyboard shortcuts */}
      <div style={{ display: 'flex', gap: '12px', color: t.textMuted }}>
        {mergedShortcuts.map((s) => (
          <span key={s.key}>
            <span style={{ color: t.textDim, fontWeight: 500 }}>{s.key}</span>
            <span style={{ marginLeft: '4px' }}>{s.label}</span>
          </span>
        ))}
      </div>

      {/* Center: active view */}
      <span style={{ color: t.purple, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {activeView}
      </span>

      {/* Right: quick stats + connection */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', color: t.textMuted }}>
        {stats && (
          <>
            <span>
              <span style={{ color: t.emerald }}>{stats.agentsOnline}</span> agents
            </span>
            <span>
              <span style={{ color: t.textDim }}>{stats.tasksActive}</span> tasks
            </span>
            <span>
              <span style={{ color: t.purple }}>{stats.teamsActive}</span> teams
            </span>
          </>
        )}
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: connected ? t.emerald : t.error,
          }}
          title={connected ? 'Connected' : 'Disconnected'}
        />
      </div>
    </div>
  );
}
