import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../../lib/ipc';
import type { DashboardViewProps } from '../../../lib/types';

// ============================================================================
// Types
// ============================================================================

interface DashboardStats {
  agents: { online: number; total: number };
  tasks: { active: number; backlog: number; done: number; total: number };
  teams: { active: number; total: number };
}

type LoadState = 'loading' | 'ready' | 'error';

// ============================================================================
// Theme tokens (mirrors TUI palette)
// ============================================================================

const t = {
  bg: '#1a1028',
  bgCard: '#241838',
  bgCardHover: '#2e2048',
  border: '#414868',
  borderAccent: '#7c3aed',
  text: '#e2e8f0',
  textDim: '#94a3b8',
  textMuted: '#64748b',
  purple: '#a855f7',
  violet: '#7c3aed',
  cyan: '#22d3ee',
  emerald: '#34d399',
  warning: '#fbbf24',
  error: '#f87171',
} as const;

// ============================================================================
// Styles
// ============================================================================

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    backgroundColor: t.bg,
    color: t.text,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
    padding: '24px',
    gap: '24px',
    overflow: 'auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: '20px',
    fontWeight: 600,
    color: t.text,
    margin: 0,
  },
  subtitle: {
    fontSize: '12px',
    color: t.textMuted,
    margin: 0,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: '16px',
  },
  card: {
    backgroundColor: t.bgCard,
    border: `1px solid ${t.border}`,
    borderRadius: '8px',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    transition: 'border-color 0.15s ease, background-color 0.15s ease',
  },
  cardLabel: {
    fontSize: '11px',
    fontWeight: 500,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: t.textMuted,
    margin: 0,
  },
  cardValue: {
    fontSize: '32px',
    fontWeight: 700,
    lineHeight: 1,
    margin: 0,
  },
  cardDetail: {
    fontSize: '12px',
    color: t.textDim,
    margin: 0,
  },
  indicator: {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    marginRight: '6px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: t.textDim,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    margin: 0,
  },
  taskBar: {
    display: 'flex',
    height: '6px',
    borderRadius: '3px',
    overflow: 'hidden',
    backgroundColor: t.border,
  },
  errorBox: {
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    border: `1px solid ${t.error}`,
    borderRadius: '8px',
    padding: '16px',
    color: t.error,
    fontSize: '13px',
  },
  loadingBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: t.textMuted,
    fontSize: '14px',
  },
} as const;

// ============================================================================
// KPI Card
// ============================================================================

interface KpiCardProps {
  label: string;
  value: string;
  detail?: string;
  accentColor: string;
  indicatorColor?: string;
}

function KpiCard({ label, value, detail, accentColor, indicatorColor }: KpiCardProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{
        ...styles.card,
        borderColor: hovered ? accentColor : t.border,
        backgroundColor: hovered ? t.bgCardHover : t.bgCard,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <p style={styles.cardLabel}>{label}</p>
      <p style={{ ...styles.cardValue, color: accentColor }}>
        {indicatorColor && <span style={{ ...styles.indicator, backgroundColor: indicatorColor }} />}
        {value}
      </p>
      {detail && <p style={styles.cardDetail}>{detail}</p>}
    </div>
  );
}

// ============================================================================
// Task Progress Bar
// ============================================================================

function TaskProgressBar({ tasks }: { tasks: DashboardStats['tasks'] }) {
  if (tasks.total === 0) return null;

  const pct = (n: number) => `${((n / tasks.total) * 100).toFixed(1)}%`;

  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>Task Distribution</p>
      <div style={styles.taskBar}>
        {tasks.done > 0 && (
          <div
            style={{
              width: pct(tasks.done),
              backgroundColor: t.emerald,
              transition: 'width 0.3s ease',
            }}
            title={`Done: ${tasks.done}`}
          />
        )}
        {tasks.active > 0 && (
          <div
            style={{
              width: pct(tasks.active),
              backgroundColor: t.cyan,
              transition: 'width 0.3s ease',
            }}
            title={`Active: ${tasks.active}`}
          />
        )}
        {tasks.backlog > 0 && (
          <div
            style={{
              width: pct(tasks.backlog),
              backgroundColor: t.textMuted,
              transition: 'width 0.3s ease',
            }}
            title={`Backlog: ${tasks.backlog}`}
          />
        )}
      </div>
      <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: t.textDim }}>
        <span>
          <span style={{ ...styles.indicator, backgroundColor: t.emerald }} />
          Done {pct(tasks.done)}
        </span>
        <span>
          <span style={{ ...styles.indicator, backgroundColor: t.cyan }} />
          Active {pct(tasks.active)}
        </span>
        <span>
          <span style={{ ...styles.indicator, backgroundColor: t.textMuted }} />
          Backlog {pct(tasks.backlog)}
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// Dashboard View
// ============================================================================

const REFRESH_INTERVAL_MS = 5_000;

export function DashboardView({ windowId }: DashboardViewProps) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const data = await invoke<DashboardStats>('dashboard_stats');
      setStats(data);
      setState('ready');
      setError(null);
      setLastRefresh(new Date());
    } catch (err) {
      // Keep showing stale data if we had a previous successful fetch
      if (!stats) setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [stats]);

  useEffect(() => {
    fetchStats();

    timerRef.current = setInterval(fetchStats, REFRESH_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchStats]);

  if (state === 'loading') {
    return (
      <div data-window-id={windowId} style={styles.root}>
        <div style={styles.loadingBox}>Loading dashboard...</div>
      </div>
    );
  }

  if (state === 'error' && !stats) {
    return (
      <div data-window-id={windowId} style={styles.root}>
        <div style={styles.errorBox}>Failed to load dashboard: {error}</div>
      </div>
    );
  }

  // stats is guaranteed non-null here (loading/error states handled above)
  const s = stats as DashboardStats;

  return (
    <div data-window-id={windowId} style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Dashboard</h1>
          <p style={styles.subtitle}>
            {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : 'Loading...'}
            {error && <span style={{ color: t.warning, marginLeft: '8px' }}>(refresh failed)</span>}
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div style={styles.grid}>
        <KpiCard
          label="Agents Online"
          value={`${s.agents.online} / ${s.agents.total}`}
          detail={
            s.agents.total === 0
              ? 'No agents registered'
              : `${Math.round((s.agents.online / s.agents.total) * 100)}% utilization`
          }
          accentColor={s.agents.online > 0 ? t.emerald : t.textMuted}
          indicatorColor={s.agents.online > 0 ? t.emerald : t.textMuted}
        />

        <KpiCard
          label="Tasks Active"
          value={String(s.tasks.active)}
          detail={`${s.tasks.backlog} backlog \u00b7 ${s.tasks.done} done`}
          accentColor={t.cyan}
        />

        <KpiCard
          label="Tasks Completed"
          value={String(s.tasks.done)}
          detail={
            s.tasks.total > 0 ? `${Math.round((s.tasks.done / s.tasks.total) * 100)}% completion rate` : 'No tasks yet'
          }
          accentColor={t.emerald}
        />

        <KpiCard
          label="Teams Active"
          value={`${s.teams.active} / ${s.teams.total}`}
          detail={
            s.teams.total === 0
              ? 'No teams created'
              : s.teams.active === s.teams.total
                ? 'All teams active'
                : `${s.teams.total - s.teams.active} idle`
          }
          accentColor={t.violet}
        />

        <KpiCard
          label="Backlog"
          value={String(s.tasks.backlog)}
          detail={s.tasks.backlog > 10 ? 'Consider triaging' : 'Healthy backlog size'}
          accentColor={s.tasks.backlog > 10 ? t.warning : t.textDim}
        />

        <KpiCard label="Spend" value="\u2014" detail="Tracking coming soon" accentColor={t.purple} />
      </div>

      {/* Task progress bar */}
      <TaskProgressBar tasks={s.tasks} />
    </div>
  );
}
