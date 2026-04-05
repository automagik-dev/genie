import { useNats, useNatsSubscription } from '@khal-os/sdk/app';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';
import type { AppComponentProps, RuntimeEvent } from '../../../lib/types';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { KpiCard } from '../../shared/KpiCard';
import { LiveFeed } from '../../shared/LiveFeed';
import { LoadingState } from '../../shared/LoadingState';

// ============================================================================
// Types
// ============================================================================

interface DashboardStats {
  agents: { online: number; errored: number; total: number };
  tasks: { active: number; backlog: number; done: number; total: number };
  teams: { active: number; total: number };
  cost_usd: number;
  snapshot: {
    cpu_percent: number;
    memory_used_mb: number;
    memory_total_mb: number;
    worker_count: number;
  } | null;
}

interface CostSummary {
  model: string;
  total_cost: number;
  usage_count: number;
}

type LoadState = 'loading' | 'ready' | 'error';

// ============================================================================
// Constants
// ============================================================================

const ORG_ID = 'default';

// ============================================================================
// Section Header
// ============================================================================

function SectionHeader({ title }: { title: string }) {
  return (
    <h2
      style={{
        fontSize: '13px',
        fontWeight: 600,
        color: theme.textDim,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        margin: 0,
        padding: '0 0 4px 0',
        borderBottom: `1px solid ${theme.border}`,
      }}
    >
      {title}
    </h2>
  );
}

// ============================================================================
// Section 1: System Health
// ============================================================================

interface SystemHealthProps {
  stats: DashboardStats;
}

function ProgressBar({ value, max, color, label }: { value: number; max: number; color: string; label: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
        <span style={{ color: theme.textDim }}>{label}</span>
        <span style={{ color: theme.text, fontWeight: 500 }}>{pct.toFixed(0)}%</span>
      </div>
      <div
        style={{
          height: '6px',
          borderRadius: '3px',
          backgroundColor: theme.border,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            backgroundColor: color,
            borderRadius: '3px',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  );
}

function SystemHealth({ stats }: SystemHealthProps) {
  const snap = stats.snapshot;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="System Health" />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '16px',
        }}
      >
        {/* pgserve status */}
        <div
          style={{
            backgroundColor: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusMd,
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: theme.emerald,
              }}
            />
            <span style={{ fontSize: '12px', color: theme.text, fontWeight: 500 }}>pgserve connected</span>
          </div>
          <span style={{ fontSize: '11px', color: theme.textMuted }}>
            {stats.agents.total} agents registered \u00b7 {stats.agents.errored} errored
          </span>
        </div>

        {/* CPU */}
        <div
          style={{
            backgroundColor: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusMd,
            padding: '16px',
          }}
        >
          <ProgressBar
            label="CPU"
            value={snap?.cpu_percent ?? 0}
            max={100}
            color={
              (snap?.cpu_percent ?? 0) > 80 ? theme.error : (snap?.cpu_percent ?? 0) > 50 ? theme.warning : theme.cyan
            }
          />
        </div>

        {/* Memory */}
        <div
          style={{
            backgroundColor: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusMd,
            padding: '16px',
          }}
        >
          <ProgressBar
            label="Memory"
            value={snap?.memory_used_mb ?? 0}
            max={snap?.memory_total_mb ?? 1}
            color={
              snap && snap.memory_total_mb > 0 && snap.memory_used_mb / snap.memory_total_mb > 0.8
                ? theme.error
                : theme.blue
            }
          />
        </div>

        {/* Workers */}
        <div
          style={{
            backgroundColor: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusMd,
            padding: '16px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span style={{ fontSize: '24px', fontWeight: 700, color: theme.violet }}>{snap?.worker_count ?? 0}</span>
          <span style={{ fontSize: '12px', color: theme.textDim }}>active workers</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Section 2: Live Activity Feed
// ============================================================================

interface LiveActivityProps {
  events: RuntimeEvent[];
}

function LiveActivity({ events }: LiveActivityProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="Live Activity Feed" />
      <LiveFeed events={events} maxItems={20} />
    </div>
  );
}

// ============================================================================
// Section 3: KPI Cards
// ============================================================================

interface KpiSectionProps {
  stats: DashboardStats;
  onNavigate?: (view: string) => void;
}

function KpiSection({ stats, onNavigate }: KpiSectionProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="Key Metrics" />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '12px',
        }}
      >
        <KpiCard
          title="Agents"
          value={`${stats.agents.online}/${stats.agents.total}`}
          breakdown={[
            { label: 'online', value: stats.agents.online, color: theme.emerald },
            { label: 'errored', value: stats.agents.errored, color: theme.error },
            {
              label: 'idle',
              value: stats.agents.total - stats.agents.online - stats.agents.errored,
              color: theme.textMuted,
            },
          ]}
          accentColor={stats.agents.online > 0 ? theme.emerald : theme.textMuted}
          onClick={() => onNavigate?.('agents')}
        />

        <KpiCard
          title="Executors Running"
          value={String(stats.agents.online)}
          breakdown={[{ label: 'total registered', value: stats.agents.total, color: theme.textDim }]}
          accentColor={theme.cyan}
          onClick={() => onNavigate?.('agents')}
        />

        <KpiCard
          title="Tasks Active"
          value={String(stats.tasks.active)}
          breakdown={[
            { label: 'backlog', value: stats.tasks.backlog, color: theme.warning },
            { label: 'done', value: stats.tasks.done, color: theme.emerald },
          ]}
          accentColor={theme.cyan}
          onClick={() => onNavigate?.('tasks')}
        />

        <KpiCard
          title="Sessions Total"
          value={String(stats.tasks.total)}
          breakdown={[
            { label: 'active', value: stats.tasks.active, color: theme.cyan },
            { label: 'complete', value: stats.tasks.done, color: theme.emerald },
          ]}
          accentColor={theme.violet}
          onClick={() => onNavigate?.('sessions')}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Section 4: Cost Summary
// ============================================================================

interface CostSectionProps {
  totalCost: number;
  costBreakdown: CostSummary[];
  onNavigate?: (view: string) => void;
}

function CostSection({ totalCost, costBreakdown, onNavigate }: CostSectionProps) {
  // Calculate "today" approximation and burn rate
  const burnRate = costBreakdown.length > 0 ? totalCost / Math.max(costBreakdown.length, 1) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="Cost Summary" />
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        {/* Total spend */}
        <button
          type="button"
          onClick={() => onNavigate?.('costs')}
          style={{
            backgroundColor: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusMd,
            padding: '20px',
            minWidth: '180px',
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: theme.fontFamily,
          }}
        >
          <p
            style={{
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: theme.textMuted,
              margin: 0,
            }}
          >
            Total Spend
          </p>
          <p style={{ fontSize: '28px', fontWeight: 700, color: theme.purple, margin: '8px 0 0' }}>
            ${totalCost.toFixed(2)}
          </p>
        </button>

        {/* Burn rate */}
        <div
          style={{
            backgroundColor: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusMd,
            padding: '20px',
            minWidth: '180px',
          }}
        >
          <p
            style={{
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: theme.textMuted,
              margin: 0,
            }}
          >
            Avg per Model
          </p>
          <p style={{ fontSize: '28px', fontWeight: 700, color: theme.warning, margin: '8px 0 0' }}>
            ${burnRate.toFixed(2)}
          </p>
        </div>

        {/* Model breakdown mini-bar */}
        {costBreakdown.length > 0 && (
          <div
            style={{
              flex: 1,
              minWidth: '240px',
              backgroundColor: theme.bgCard,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusMd,
              padding: '16px',
            }}
          >
            <p
              style={{
                fontSize: '11px',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: theme.textMuted,
                margin: '0 0 12px',
              }}
            >
              Model Breakdown
            </p>
            {/* Mini bar */}
            <div
              style={{
                display: 'flex',
                height: '8px',
                borderRadius: '4px',
                overflow: 'hidden',
                backgroundColor: theme.border,
                marginBottom: '8px',
              }}
            >
              {costBreakdown.map((row, i) => {
                const pct = totalCost > 0 ? (row.total_cost / totalCost) * 100 : 0;
                const colors = [theme.purple, theme.cyan, theme.emerald, theme.warning, theme.blue];
                return (
                  <div
                    key={row.model}
                    style={{
                      width: `${pct}%`,
                      backgroundColor: colors[i % colors.length],
                      transition: 'width 0.3s ease',
                    }}
                    title={`${row.model}: $${row.total_cost.toFixed(2)}`}
                  />
                );
              })}
            </div>
            {/* Legend */}
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '10px', color: theme.textDim }}>
              {costBreakdown.slice(0, 5).map((row, i) => {
                const colors = [theme.purple, theme.cyan, theme.emerald, theme.warning, theme.blue];
                return (
                  <span key={row.model} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        backgroundColor: colors[i % colors.length],
                      }}
                    />
                    {row.model}: ${row.total_cost.toFixed(2)}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Section 5: Team Activity
// ============================================================================

interface TeamActivityProps {
  stats: DashboardStats;
  costBreakdown: CostSummary[];
}

function TeamActivity({ stats }: TeamActivityProps) {
  // Team activity uses agent breakdown by team — for now show summary bars
  const totalAgents = stats.agents.total;
  const teamsActive = stats.teams.active;
  const teamsTotal = stats.teams.total;

  if (teamsTotal === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <SectionHeader title="Team Activity" />
        <EmptyState
          icon={'\u2302'}
          title="No teams created"
          description="Teams will appear here once agents are organized into teams."
        />
      </div>
    );
  }

  // Show horizontal bars for active vs total teams
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="Team Activity" />
      <div
        style={{
          backgroundColor: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusMd,
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        {/* Active teams bar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
            <span style={{ color: theme.textDim }}>Active Teams</span>
            <span style={{ color: theme.text, fontWeight: 500 }}>
              {teamsActive} / {teamsTotal}
            </span>
          </div>
          <div style={{ height: '10px', borderRadius: '5px', backgroundColor: theme.border, overflow: 'hidden' }}>
            <div
              style={{
                width: teamsTotal > 0 ? `${(teamsActive / teamsTotal) * 100}%` : '0%',
                height: '100%',
                backgroundColor: theme.violet,
                borderRadius: '5px',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>

        {/* Agents per team approximation */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
            <span style={{ color: theme.textDim }}>Agents Online</span>
            <span style={{ color: theme.text, fontWeight: 500 }}>
              {stats.agents.online} / {totalAgents}
            </span>
          </div>
          <div style={{ height: '10px', borderRadius: '5px', backgroundColor: theme.border, overflow: 'hidden' }}>
            <div
              style={{
                width: totalAgents > 0 ? `${(stats.agents.online / totalAgents) * 100}%` : '0%',
                height: '100%',
                backgroundColor: theme.emerald,
                borderRadius: '5px',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>

        {/* Cost per team placeholder */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
            <span style={{ color: theme.textDim }}>Cost Allocation</span>
            <span style={{ color: theme.text, fontWeight: 500 }}>${stats.cost_usd?.toFixed?.(2) ?? '0.00'}</span>
          </div>
          <div style={{ height: '10px', borderRadius: '5px', backgroundColor: theme.border, overflow: 'hidden' }}>
            <div
              style={{
                width: '100%',
                height: '100%',
                backgroundColor: theme.purple,
                borderRadius: '5px',
                opacity: 0.6,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Command Center (DashboardView)
// ============================================================================

export function DashboardView({ windowId, meta }: AppComponentProps) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [costBreakdown, setCostBreakdown] = useState<CostSummary[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventsRef = useRef<RuntimeEvent[]>([]);

  const nats = useNats();

  // Navigate callback — extracts navigate fn from meta if passed by App shell
  const navigate = useCallback(
    (view: string) => {
      if (meta && typeof (meta as Record<string, unknown>).navigate === 'function') {
        (meta as Record<string, (v: string) => void>).navigate(view);
      }
    },
    [meta],
  );

  // Fetch dashboard stats + cost summary
  const fetchData = useCallback(async () => {
    try {
      const [statsResult, costResult] = await Promise.all([
        nats.request<DashboardStats>(GENIE_SUBJECTS.dashboard.stats(ORG_ID)),
        nats.request<CostSummary[]>(GENIE_SUBJECTS.costs.summary(ORG_ID)),
      ]);
      setStats(statsResult);
      setCostBreakdown(Array.isArray(costResult) ? costResult : []);
      setState('ready');
      setError(null);
    } catch (err) {
      if (!stats) setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [nats, stats]);

  // Initial fetch + polling
  useEffect(() => {
    fetchData();
    timerRef.current = setInterval(fetchData, 10_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchData]);

  // Live event stream via NATS subscription
  useNatsSubscription<RuntimeEvent>(
    GENIE_SUBJECTS.events.runtime(ORG_ID),
    useCallback((event: RuntimeEvent) => {
      eventsRef.current = [event, ...eventsRef.current].slice(0, 50);
      setEvents([...eventsRef.current]);
    }, []),
  );

  // ---- Render States ----

  if (state === 'loading') {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <LoadingState message="Loading Command Center..." />
      </div>
    );
  }

  if (state === 'error' && !stats) {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <ErrorState message={error ?? 'Failed to load dashboard'} service="dashboard.stats" onRetry={fetchData} />
      </div>
    );
  }

  const s = stats as DashboardStats;

  return (
    <div
      data-window-id={windowId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: theme.bg,
        color: theme.text,
        fontFamily: theme.fontFamily,
        padding: '24px',
        gap: '28px',
        overflow: 'auto',
      }}
    >
      {/* Header */}
      <div>
        <h1 style={{ fontSize: '20px', fontWeight: 600, color: theme.text, margin: 0 }}>Command Center</h1>
        <p style={{ fontSize: '12px', color: theme.textMuted, margin: '4px 0 0' }}>
          {nats.connected ? 'Live' : 'Reconnecting...'} \u00b7 {new Date().toLocaleDateString()}
          {error && <span style={{ color: theme.warning, marginLeft: '8px' }}>(refresh failed)</span>}
        </p>
      </div>

      {/* Section 1: System Health */}
      <SystemHealth stats={s} />

      {/* Section 2: Live Activity Feed */}
      <LiveActivity events={events} />

      {/* Section 3: KPI Cards */}
      <KpiSection stats={s} onNavigate={navigate} />

      {/* Section 4: Cost Summary */}
      <CostSection totalCost={s.cost_usd ?? 0} costBreakdown={costBreakdown} onNavigate={navigate} />

      {/* Section 5: Team Activity */}
      <TeamActivity stats={s} costBreakdown={costBreakdown} />
    </div>
  );
}
