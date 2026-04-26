import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../../../lib/ipc';
import { theme } from '../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

interface AgentRow {
  id: string;
  custom_name: string | null;
  role: string | null;
  team: string | null;
  title: string | null;
  state: string;
  reports_to: string | null;
  current_executor_id: string | null;
  started_at: string;
  session_id: string | null;
  turn_count: number | null;
  cost_usd: number | null;
}

interface ExecutorRow {
  id: string;
  agent_id: string;
  provider: string;
  transport: string;
  state: string;
  pid: number | null;
  tmux_pane_id: string | null;
  worktree: string | null;
  repo_path: string | null;
  started_at: string;
  ended_at: string | null;
}

interface RuntimeEventRow {
  id: number;
  kind: string;
  text: string;
  created_at: string;
}

export interface AgentDetailData {
  agent: AgentRow;
  executor: ExecutorRow | null;
  recent_events: RuntimeEventRow[];
}

// ============================================================================
// Helpers
// ============================================================================

function displayName(agent: AgentRow): string {
  return agent.custom_name ?? agent.id.slice(0, 8);
}

function formatDuration(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hrs < 24) return `${hrs}h ${remainMins}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const STATE_COLORS: Record<string, string> = {
  running: theme.emerald,
  working: theme.emerald,
  spawning: theme.warning,
  error: theme.error,
  idle: theme.textMuted,
  done: theme.textMuted,
  suspended: theme.textMuted,
  offline: theme.textMuted,
};

function stateColor(state: string): string {
  return STATE_COLORS[state] ?? theme.textMuted;
}

const EVENT_KIND_COLORS: Record<string, string> = {
  user: theme.cyan,
  assistant: theme.emerald,
  state: theme.warning,
  tool_call: theme.blue,
  message: theme.purple,
  system: theme.textMuted,
};

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'auto',
    padding: '24px',
    gap: '24px',
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: theme.textMuted,
    fontSize: '14px',
    fontFamily: theme.fontFamily,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  statusDot: {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  name: {
    fontSize: '20px',
    fontWeight: 600,
    color: theme.text,
    margin: 0,
  },
  stateBadge: {
    fontSize: '11px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: '4px',
    textTransform: 'uppercase' as const,
  },
  section: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  sectionTitle: {
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: theme.textMuted,
    margin: 0,
    paddingBottom: '4px',
    borderBottom: `1px solid ${theme.border}`,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
  },
  fieldCard: {
    backgroundColor: theme.bgCard,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusMd,
    padding: '12px',
  },
  fieldLabel: {
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: theme.textMuted,
    margin: '0 0 4px 0',
  },
  fieldValue: {
    fontSize: '13px',
    color: theme.text,
    margin: 0,
    wordBreak: 'break-all' as const,
  },
  actionsBar: {
    display: 'flex',
    gap: '8px',
  },
  actionButton: {
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: 500,
    fontFamily: theme.fontFamily,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.bgCard,
    color: theme.text,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  eventRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    padding: '4px 0',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  eventTime: {
    color: theme.textMuted,
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums' as const,
    minWidth: '60px',
    flexShrink: 0,
  },
  eventKind: {
    fontSize: '10px',
    fontWeight: 600,
    padding: '1px 4px',
    borderRadius: '3px',
    textTransform: 'uppercase' as const,
    minWidth: '50px',
    textAlign: 'center' as const,
    flexShrink: 0,
  },
  eventText: {
    flex: 1,
    color: theme.textDim,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
} as const;

// ============================================================================
// Sub-Components
// ============================================================================

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={styles.fieldCard}>
      <p style={styles.fieldLabel}>{label}</p>
      <p style={styles.fieldValue}>{value || '\u2014'}</p>
    </div>
  );
}

// ============================================================================
// Agent Detail Component
// ============================================================================

interface AgentDetailProps {
  agentId: string | null;
}

export function AgentDetail({ agentId }: AgentDetailProps) {
  const [detail, setDetail] = useState<AgentDetailData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchDetail = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const data = await invoke<AgentDetailData | null>('show_agent', { id });
      setDetail(data);
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!agentId) {
      setDetail(null);
      return;
    }

    fetchDetail(agentId);

    // Refresh detail every 5s for duration/activity updates
    const timer = setInterval(() => fetchDetail(agentId), 5_000);
    return () => clearInterval(timer);
  }, [agentId, fetchDetail]);

  if (!agentId) {
    return <div style={styles.emptyState}>Select an agent to view details</div>;
  }

  if (loading && !detail) {
    return <div style={styles.emptyState}>Loading...</div>;
  }

  if (!detail) {
    return <div style={styles.emptyState}>Agent not found</div>;
  }

  const { agent, executor, recent_events } = detail;
  const color = stateColor(agent.state);

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={{ ...styles.statusDot, backgroundColor: color }} />
        <h1 style={styles.name}>{displayName(agent)}</h1>
        <span style={{ ...styles.stateBadge, backgroundColor: `${color}22`, color }}>{agent.state}</span>
      </div>

      {/* Status Section */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Status</p>
        <div style={styles.grid}>
          <Field label="State" value={`${agent.state} (${formatDuration(agent.started_at)})`} />
          <Field label="Role" value={agent.role} />
          <Field label="Team" value={agent.team} />
          <Field label="Reports To" value={agent.reports_to} />
        </div>
      </div>

      {/* Executor Section */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Executor</p>
        {executor ? (
          <div style={styles.grid}>
            <Field label="PID" value={executor.pid?.toString()} />
            <Field label="Tmux Pane" value={executor.tmux_pane_id} />
            <Field label="Transport" value={executor.transport} />
            <Field label="Worktree" value={executor.worktree} />
            <Field label="Provider" value={executor.provider} />
            <Field label="Executor State" value={executor.state} />
          </div>
        ) : (
          <p style={{ fontSize: '12px', color: theme.textMuted, margin: 0 }}>No active executor</p>
        )}
      </div>

      {/* Session Section */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Session</p>
        <div style={styles.grid}>
          <Field label="Session ID" value={agent.session_id} />
          <Field label="Turn Count" value={agent.turn_count?.toString()} />
          <Field label="Cost" value={agent.cost_usd != null ? `$${agent.cost_usd.toFixed(4)}` : null} />
          <Field label="Started" value={agent.started_at ? relativeTime(agent.started_at) : null} />
        </div>
      </div>

      {/* Actions */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Actions</p>
        <div style={styles.actionsBar}>
          <button type="button" style={styles.actionButton}>
            Connect Terminal
          </button>
          <button type="button" style={styles.actionButton}>
            Open Chat
          </button>
          <button type="button" style={styles.actionButton}>
            Session Log
          </button>
        </div>
      </div>

      {/* Recent Activity */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Recent Activity</p>
        {recent_events.length === 0 ? (
          <p style={{ fontSize: '12px', color: theme.textMuted, margin: 0 }}>No recent events</p>
        ) : (
          <div>
            {recent_events.map((event) => {
              const kindColor = EVENT_KIND_COLORS[event.kind] ?? theme.textMuted;
              return (
                <div key={event.id} style={styles.eventRow}>
                  <span style={styles.eventTime}>{relativeTime(event.created_at)}</span>
                  <span
                    style={{
                      ...styles.eventKind,
                      backgroundColor: `${kindColor}22`,
                      color: kindColor,
                    }}
                  >
                    {event.kind}
                  </span>
                  <span style={styles.eventText}>{event.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
