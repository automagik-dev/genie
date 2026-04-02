import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/ipc';
import { theme } from '../../lib/theme';

// ============================================================================
// Types
// ============================================================================

interface DashboardStats {
  agents: { online: number; total: number };
  tasks: { active: number; backlog: number; done: number; total: number };
  teams: { active: number; total: number };
}

interface StatusBarProps {
  viewName: string;
}

// ============================================================================
// StatusBar — Bottom bar with PG status, agent count, task count, view name
// ============================================================================

const POLL_MS = 5_000;

export function StatusBar({ viewName }: StatusBarProps) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [pgConnected, setPgConnected] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const data = await invoke<DashboardStats>('dashboard_stats');
      setStats(data);
      setPgConnected(true);
    } catch {
      setPgConnected(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    timerRef.current = setInterval(fetchStats, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchStats]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '4px 16px',
        borderTop: `1px solid ${theme.border}`,
        backgroundColor: theme.bgCard,
        fontSize: '11px',
        fontFamily: theme.fontFamily,
        color: theme.textMuted,
        minHeight: '24px',
      }}
    >
      {/* PG connection status */}
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: pgConnected ? theme.success : theme.error,
          }}
        />
        {pgConnected ? 'PG connected' : 'PG disconnected'}
      </span>

      {stats && (
        <>
          <span>
            {stats.agents.online}/{stats.agents.total} agents
          </span>
          <span>
            {stats.tasks.active} active \u00b7 {stats.tasks.total} tasks
          </span>
        </>
      )}

      {/* Spacer */}
      <span style={{ flex: 1 }} />

      {/* View name */}
      <span style={{ color: theme.violet, fontWeight: 500 }}>{viewName}</span>
    </div>
  );
}
