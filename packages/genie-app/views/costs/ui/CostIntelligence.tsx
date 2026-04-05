import { useNats } from '@khal-os/sdk/app';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';
import type { AppComponentProps } from '../../../lib/types';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { KpiCard } from '../../shared/KpiCard';
import { LoadingState } from '../../shared/LoadingState';

// ============================================================================
// Types
// ============================================================================

interface CostSummaryData {
  total_usd: number;
  today_usd: number;
  daily_average_usd: number;
  monthly_pace_usd: number;
  yesterday_usd: number;
  models: ModelCost[];
  teams: TeamCost[];
}

interface ModelCost {
  model: string;
  total_cost: number;
  percentage: number;
}

interface TeamCost {
  team: string;
  total_cost: number;
  agent_count: number;
  percentage: number;
}

interface CostSession {
  session_id: string;
  agent: string;
  model: string;
  turns: number;
  duration_seconds: number;
  cost_usd: number;
}

interface TokenData {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

interface EfficiencyData {
  cost_per_task: number;
  cost_per_commit: number;
  cost_per_turn: number;
  cost_per_loc: number;
  prev_cost_per_task: number;
  prev_cost_per_commit: number;
  prev_cost_per_turn: number;
  prev_cost_per_loc: number;
}

type LoadState = 'loading' | 'ready' | 'error';

// ============================================================================
// Constants
// ============================================================================

const ORG_ID = 'default';

const BAR_COLORS = [theme.purple, theme.cyan, theme.emerald, theme.warning, theme.blue, theme.violet];

// ============================================================================
// Formatters
// ============================================================================

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

function cacheHitRate(row: TokenData): number {
  const totalReads = row.cache_read_tokens + row.input_tokens;
  if (totalReads === 0) return 0;
  return (row.cache_read_tokens / totalReads) * 100;
}

// ============================================================================
// Trend helpers
// ============================================================================

type TrendDirection = 'up' | 'down' | 'flat';

function trendDirection(current: number, previous: number): TrendDirection {
  if (current > previous * 1.01) return 'up';
  if (current < previous * 0.99) return 'down';
  return 'flat';
}

function trendColor(direction: TrendDirection, inverted = false): string {
  // For costs, "up" is bad (red), "down" is good (green)
  // inverted: for efficiency metrics where "down" is good
  if (direction === 'flat') return theme.textMuted;
  if (inverted) {
    return direction === 'up' ? theme.error : theme.emerald;
  }
  return direction === 'up' ? theme.error : theme.emerald;
}

const TREND_ARROWS: Record<TrendDirection, string> = {
  up: '\u2191',
  down: '\u2193',
  flat: '\u2192',
};

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
// Section 1: Burn Rate
// ============================================================================

interface BurnRateProps {
  summary: CostSummaryData;
}

function BurnRate({ summary }: BurnRateProps) {
  const trend = trendDirection(summary.today_usd, summary.yesterday_usd);
  const trendDelta = summary.today_usd - summary.yesterday_usd;
  const trendLabel = `${trendDelta >= 0 ? '+' : ''}${fmtUsd(trendDelta)} vs yesterday`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="Burn Rate" />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '12px',
        }}
      >
        <KpiCard title="Total Spend" value={fmtUsd(summary.total_usd)} accentColor={theme.purple} />
        <KpiCard
          title="Today"
          value={fmtUsd(summary.today_usd)}
          trend={trend}
          trendLabel={trendLabel}
          accentColor={trend === 'up' ? theme.error : trend === 'down' ? theme.emerald : theme.cyan}
        />
        <KpiCard title="Daily Average" value={fmtUsd(summary.daily_average_usd)} accentColor={theme.cyan} />
        <KpiCard title="Monthly Pace" value={fmtUsd(summary.monthly_pace_usd)} accentColor={theme.warning} />
      </div>
    </div>
  );
}

// ============================================================================
// Section 2: Model Breakdown (Horizontal Bar Chart)
// ============================================================================

interface ModelBreakdownProps {
  models: ModelCost[];
}

function ModelBreakdown({ models }: ModelBreakdownProps) {
  if (models.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <SectionHeader title="Model Breakdown" />
        <EmptyState
          icon={'\u2302'}
          title="No model data"
          description="Cost data by model will appear once sessions are recorded."
        />
      </div>
    );
  }

  const maxCost = Math.max(...models.map((m) => m.total_cost), 1);
  const mostExpensiveModel = models[0]?.model;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="Model Breakdown" />
      <div
        style={{
          backgroundColor: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusMd,
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        {models.map((m, i) => {
          const barWidth = maxCost > 0 ? (m.total_cost / maxCost) * 100 : 0;
          const color = BAR_COLORS[i % BAR_COLORS.length];
          const isMostExpensive = m.model === mostExpensiveModel;

          return (
            <div key={m.model} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
                <span
                  style={{
                    color: theme.text,
                    fontWeight: isMostExpensive ? 600 : 400,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  {m.model}
                  {isMostExpensive && (
                    <span
                      style={{
                        fontSize: '9px',
                        padding: '1px 5px',
                        borderRadius: '3px',
                        backgroundColor: `${theme.warning}22`,
                        color: theme.warning,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      highest
                    </span>
                  )}
                </span>
                <span style={{ color: theme.textDim, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtUsd(m.total_cost)} ({fmtPercent(m.percentage)})
                </span>
              </div>
              {/* Pure CSS bar */}
              <div
                style={{
                  height: '8px',
                  borderRadius: '4px',
                  backgroundColor: theme.border,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${barWidth}%`,
                    height: '100%',
                    backgroundColor: color,
                    borderRadius: '4px',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Section 3: Team Breakdown (Horizontal Bar Chart)
// ============================================================================

interface TeamBreakdownProps {
  teams: TeamCost[];
}

function TeamBreakdown({ teams }: TeamBreakdownProps) {
  if (teams.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <SectionHeader title="Team Breakdown" />
        <EmptyState
          icon={'\u2302'}
          title="No team data"
          description="Cost data by team will appear once teams are created."
        />
      </div>
    );
  }

  const maxCost = Math.max(...teams.map((t) => t.total_cost), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="Team Breakdown" />
      <div
        style={{
          backgroundColor: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusMd,
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        {teams.map((t, i) => {
          const barWidth = maxCost > 0 ? (t.total_cost / maxCost) * 100 : 0;
          const color = BAR_COLORS[i % BAR_COLORS.length];

          return (
            <div key={t.team} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
                <span style={{ color: theme.text, fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {t.team}
                  <span style={{ fontSize: '10px', color: theme.textMuted }}>
                    {t.agent_count} agent{t.agent_count !== 1 ? 's' : ''}
                  </span>
                </span>
                <span style={{ color: theme.textDim, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtUsd(t.total_cost)} ({fmtPercent(t.percentage)})
                </span>
              </div>
              {/* Pure CSS bar */}
              <div
                style={{
                  height: '8px',
                  borderRadius: '4px',
                  backgroundColor: theme.border,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${barWidth}%`,
                    height: '100%',
                    backgroundColor: color,
                    borderRadius: '4px',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Section 4: Efficiency Metrics
// ============================================================================

interface EfficiencyProps {
  efficiency: EfficiencyData;
}

function EfficiencyMetrics({ efficiency }: EfficiencyProps) {
  const metrics = [
    { title: 'Cost / Task', current: efficiency.cost_per_task, previous: efficiency.prev_cost_per_task },
    { title: 'Cost / Commit', current: efficiency.cost_per_commit, previous: efficiency.prev_cost_per_commit },
    { title: 'Cost / Turn', current: efficiency.cost_per_turn, previous: efficiency.prev_cost_per_turn },
    { title: 'Cost / LOC', current: efficiency.cost_per_loc, previous: efficiency.prev_cost_per_loc },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="Efficiency Metrics" />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '12px',
        }}
      >
        {metrics.map((m) => {
          const trend = trendDirection(m.current, m.previous);
          // For cost-per-X, lower is better so "down" = green, "up" = red
          const color = trendColor(trend, true);

          return (
            <KpiCard
              key={m.title}
              title={m.title}
              value={fmtUsd(m.current)}
              trend={trend}
              trendLabel={`${TREND_ARROWS[trend]} vs prev period`}
              accentColor={color}
            />
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Section 5: Token Analysis Table
// ============================================================================

interface TokenAnalysisProps {
  tokens: TokenData[];
}

const tableHeaderStyle: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: theme.textMuted,
  padding: '8px 12px',
  textAlign: 'right',
  borderBottom: `1px solid ${theme.border}`,
};

const tableCellStyle: React.CSSProperties = {
  fontSize: '12px',
  color: theme.text,
  padding: '8px 12px',
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  borderBottom: `1px solid ${theme.border}`,
};

function TokenAnalysis({ tokens }: TokenAnalysisProps) {
  if (tokens.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <SectionHeader title="Token Analysis" />
        <EmptyState
          icon={'\u2302'}
          title="No token data"
          description="Token usage will appear once sessions are recorded."
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="Token Analysis" />
      <div
        style={{
          backgroundColor: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusMd,
          overflow: 'auto',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontFamily: theme.fontFamily,
          }}
        >
          <thead>
            <tr>
              <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Model</th>
              <th style={tableHeaderStyle}>Input</th>
              <th style={tableHeaderStyle}>Output</th>
              <th style={tableHeaderStyle}>Cache Read</th>
              <th style={tableHeaderStyle}>Cache Write</th>
              <th style={tableHeaderStyle}>Cache Hit %</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((row) => {
              const hitRate = cacheHitRate(row);
              const hitColor = hitRate >= 70 ? theme.emerald : hitRate >= 40 ? theme.warning : theme.error;

              return (
                <tr key={row.model}>
                  <td style={{ ...tableCellStyle, textAlign: 'left', fontWeight: 500 }}>{row.model}</td>
                  <td style={tableCellStyle}>{fmtTokens(row.input_tokens)}</td>
                  <td style={tableCellStyle}>{fmtTokens(row.output_tokens)}</td>
                  <td style={tableCellStyle}>{fmtTokens(row.cache_read_tokens)}</td>
                  <td style={tableCellStyle}>{fmtTokens(row.cache_write_tokens)}</td>
                  <td style={{ ...tableCellStyle, color: hitColor, fontWeight: 600 }}>{fmtPercent(hitRate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// Section 6: Top Sessions by Cost
// ============================================================================

interface TopSessionsProps {
  sessions: CostSession[];
  onNavigate?: (view: string) => void;
}

function TopSessions({ sessions, onNavigate }: TopSessionsProps) {
  if (sessions.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <SectionHeader title="Top Sessions by Cost" />
        <EmptyState icon={'\u2302'} title="No session data" description="Expensive sessions will be listed here." />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionHeader title="Top Sessions by Cost" />
      <div
        style={{
          backgroundColor: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusMd,
          overflow: 'auto',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontFamily: theme.fontFamily,
          }}
        >
          <thead>
            <tr>
              <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Agent</th>
              <th style={{ ...tableHeaderStyle, textAlign: 'left' }}>Model</th>
              <th style={tableHeaderStyle}>Turns</th>
              <th style={tableHeaderStyle}>Duration</th>
              <th style={tableHeaderStyle}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: table row nav; keyboard support tracked for V2
              <tr
                key={s.session_id}
                onClick={() => onNavigate?.('sessions')}
                style={{ cursor: 'pointer', transition: 'background-color 0.1s' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = theme.bgCardHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <td style={{ ...tableCellStyle, textAlign: 'left', fontWeight: 500, color: theme.purple }}>
                  {s.agent}
                </td>
                <td style={{ ...tableCellStyle, textAlign: 'left' }}>{s.model}</td>
                <td style={tableCellStyle}>{s.turns}</td>
                <td style={tableCellStyle}>{fmtDuration(s.duration_seconds)}</td>
                <td style={{ ...tableCellStyle, fontWeight: 600, color: theme.warning }}>{fmtUsd(s.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// CostIntelligence (main export)
// ============================================================================

export function CostIntelligence({ windowId, meta }: AppComponentProps) {
  const [summary, setSummary] = useState<CostSummaryData | null>(null);
  const [sessions, setSessions] = useState<CostSession[]>([]);
  const [tokens, setTokens] = useState<TokenData[]>([]);
  const [efficiency, setEfficiency] = useState<EfficiencyData | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Fetch all cost data from NATS subjects
  const fetchData = useCallback(async () => {
    try {
      const [summaryResult, sessionsResult, tokensResult, efficiencyResult] = await Promise.all([
        nats.request<CostSummaryData>(GENIE_SUBJECTS.costs.summary(ORG_ID)),
        nats.request<CostSession[]>(GENIE_SUBJECTS.costs.sessions(ORG_ID)),
        nats.request<TokenData[]>(GENIE_SUBJECTS.costs.tokens(ORG_ID)),
        nats.request<EfficiencyData>(GENIE_SUBJECTS.costs.efficiency(ORG_ID)),
      ]);
      setSummary(summaryResult);
      setSessions(Array.isArray(sessionsResult) ? sessionsResult : []);
      setTokens(Array.isArray(tokensResult) ? tokensResult : []);
      setEfficiency(efficiencyResult);
      setState('ready');
      setError(null);
    } catch (err) {
      if (!summary) setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [nats, summary]);

  // Initial fetch + polling
  useEffect(() => {
    fetchData();
    timerRef.current = setInterval(fetchData, 15_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchData]);

  // ---- Render States ----

  if (state === 'loading') {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <LoadingState message="Loading Cost Intelligence..." />
      </div>
    );
  }

  if (state === 'error' && !summary) {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <ErrorState message={error ?? 'Failed to load cost data'} service="costs.summary" onRetry={fetchData} />
      </div>
    );
  }

  const s = summary as CostSummaryData;
  const eff = efficiency ?? {
    cost_per_task: 0,
    cost_per_commit: 0,
    cost_per_turn: 0,
    cost_per_loc: 0,
    prev_cost_per_task: 0,
    prev_cost_per_commit: 0,
    prev_cost_per_turn: 0,
    prev_cost_per_loc: 0,
  };

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
        <h1 style={{ fontSize: '20px', fontWeight: 600, color: theme.text, margin: 0 }}>Cost Intelligence</h1>
        <p style={{ fontSize: '12px', color: theme.textMuted, margin: '4px 0 0' }}>
          {nats.connected ? 'Live' : 'Reconnecting...'} {'\u00b7'} {new Date().toLocaleDateString()}
          {error && <span style={{ color: theme.warning, marginLeft: '8px' }}>(refresh failed)</span>}
        </p>
      </div>

      {/* Section 1: Burn Rate */}
      <BurnRate summary={s} />

      {/* Section 2: Model Breakdown */}
      <ModelBreakdown models={s.models ?? []} />

      {/* Section 3: Team Breakdown */}
      <TeamBreakdown teams={s.teams ?? []} />

      {/* Section 4: Efficiency Metrics */}
      <EfficiencyMetrics efficiency={eff} />

      {/* Section 5: Token Analysis */}
      <TokenAnalysis tokens={tokens} />

      {/* Section 6: Top Sessions by Cost */}
      <TopSessions sessions={sessions} onNavigate={navigate} />
    </div>
  );
}
