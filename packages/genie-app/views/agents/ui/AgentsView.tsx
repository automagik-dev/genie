import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../../lib/ipc';
import type { AgentsViewProps } from '../../../lib/types';

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
}

interface ExecutorRow {
  id: string;
  agent_id: string;
  provider: string;
  transport: string;
  state: string;
  pid: number | null;
  worktree: string | null;
  repo_path: string | null;
  started_at: string;
  ended_at: string | null;
}

interface AgentDetail {
  agent: AgentRow;
  executor: ExecutorRow | null;
}

interface TeamGroup {
  name: string;
  agents: AgentRow[];
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

const STATE_COLORS: Record<string, string> = {
  working: t.emerald,
  idle: t.textDim,
  spawning: t.warning,
  running: t.cyan,
  permission: t.warning,
  question: t.warning,
  error: t.error,
  done: t.textMuted,
  suspended: t.textMuted,
};

function stateColor(state: string): string {
  return STATE_COLORS[state] ?? t.textMuted;
}

function stateIndicatorColor(state: string): string | undefined {
  if (state === 'working' || state === 'running') return t.emerald;
  if (state === 'error') return t.error;
  if (state === 'permission' || state === 'question' || state === 'spawning') return t.warning;
  return undefined;
}

function displayName(agent: AgentRow): string {
  return agent.custom_name ?? agent.id.slice(0, 8);
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ============================================================================
// Styles
// ============================================================================

const styles = {
  root: {
    display: 'flex',
    height: '100%',
    backgroundColor: t.bg,
    color: t.text,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
  },
  sidebar: {
    width: '300px',
    minWidth: '300px',
    borderRight: `1px solid ${t.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  sidebarHeader: {
    padding: '16px',
    borderBottom: `1px solid ${t.border}`,
  },
  sidebarTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: t.text,
    margin: 0,
  },
  sidebarSubtitle: {
    fontSize: '11px',
    color: t.textMuted,
    margin: '4px 0 0 0',
  },
  agentList: {
    flex: 1,
    overflow: 'auto',
    padding: '8px 0',
  },
  teamHeader: {
    padding: '12px 16px 4px',
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    color: t.textMuted,
  },
  agentRow: {
    padding: '8px 16px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    transition: 'background-color 0.1s ease',
  },
  agentDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  agentInfo: {
    flex: 1,
    minWidth: 0,
  },
  agentName: {
    fontSize: '13px',
    fontWeight: 500,
    color: t.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  agentMeta: {
    fontSize: '11px',
    color: t.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  detail: {
    flex: 1,
    overflow: 'auto',
    padding: '24px',
  },
  detailEmpty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: t.textMuted,
    fontSize: '14px',
  },
  detailHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '24px',
  },
  detailName: {
    fontSize: '20px',
    fontWeight: 600,
    color: t.text,
    margin: 0,
  },
  stateBadge: {
    fontSize: '11px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: '4px',
    textTransform: 'uppercase' as const,
  },
  detailGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '16px',
  },
  fieldCard: {
    backgroundColor: t.bgCard,
    border: `1px solid ${t.border}`,
    borderRadius: '8px',
    padding: '16px',
  },
  fieldLabel: {
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: t.textMuted,
    margin: '0 0 8px 0',
  },
  fieldValue: {
    fontSize: '14px',
    color: t.text,
    margin: 0,
    wordBreak: 'break-all' as const,
  },
  executorSection: {
    marginTop: '24px',
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: t.textDim,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    margin: '0 0 12px 0',
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
// Agent Row Component
// ============================================================================

function AgentRowItem({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentRow;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const color = stateColor(agent.state);
  const roleLine = [agent.role, agent.title].filter(Boolean).join(' \u00b7 ');

  return (
    <button
      type="button"
      style={{
        ...styles.agentRow,
        backgroundColor: selected ? t.bgCardHover : 'transparent',
        borderLeft: selected ? `2px solid ${t.violet}` : '2px solid transparent',
        border: 'none',
        borderLeftWidth: '2px',
        borderLeftStyle: 'solid',
        borderLeftColor: selected ? t.violet : 'transparent',
        width: '100%',
        textAlign: 'left' as const,
        font: 'inherit',
        color: 'inherit',
      }}
      onClick={() => onSelect(agent.id)}
    >
      <div style={{ ...styles.agentDot, backgroundColor: color }} />
      <div style={styles.agentInfo}>
        <div style={styles.agentName}>{displayName(agent)}</div>
        <div style={styles.agentMeta}>
          {agent.state} {roleLine ? `\u00b7 ${roleLine}` : ''}
        </div>
      </div>
    </button>
  );
}

// ============================================================================
// Detail Field
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
// Agent Detail Panel
// ============================================================================

function AgentDetailPanel({ detail }: { detail: AgentDetail }) {
  const { agent, executor } = detail;
  const color = stateColor(agent.state);
  const indicatorColor = stateIndicatorColor(agent.state);

  return (
    <div>
      {/* Header */}
      <div style={styles.detailHeader}>
        {indicatorColor && (
          <div style={{ ...styles.agentDot, width: '12px', height: '12px', backgroundColor: indicatorColor }} />
        )}
        <h1 style={styles.detailName}>{displayName(agent)}</h1>
        <span style={{ ...styles.stateBadge, backgroundColor: `${color}22`, color }}>{agent.state}</span>
      </div>

      {/* Agent fields */}
      <div style={styles.detailGrid}>
        <Field label="ID" value={agent.id} />
        <Field label="Role" value={agent.role} />
        <Field label="Team" value={agent.team} />
        <Field label="Title" value={agent.title} />
        <Field label="Reports To" value={agent.reports_to} />
        <Field label="Started" value={timeAgo(agent.started_at)} />
      </div>

      {/* Executor info */}
      {executor && (
        <div style={styles.executorSection}>
          <p style={styles.sectionTitle}>Executor</p>
          <div style={styles.detailGrid}>
            <Field label="Provider" value={executor.provider} />
            <Field label="Transport" value={executor.transport} />
            <Field label="State" value={executor.state} />
            <Field label="PID" value={executor.pid?.toString()} />
            <Field label="Worktree" value={executor.worktree} />
            <Field label="Repo" value={executor.repo_path} />
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Agents View
// ============================================================================

const REFRESH_INTERVAL_MS = 3_000;

function groupByTeam(agents: AgentRow[]): TeamGroup[] {
  const groups = new Map<string, AgentRow[]>();
  for (const agent of agents) {
    const team = agent.team ?? 'unassigned';
    const arr = groups.get(team);
    if (arr) {
      arr.push(agent);
    } else {
      groups.set(team, [agent]);
    }
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => (a === 'unassigned' ? 1 : b === 'unassigned' ? -1 : a.localeCompare(b)))
    .map(([name, agents]) => ({ name, agents }));
}

export function AgentsView({ windowId }: AgentsViewProps) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      const data = await invoke<AgentRow[]>('list_agents');
      setAgents(data);
      setState('ready');
      setError(null);
    } catch (err) {
      if (agents.length === 0) setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agents.length]);

  useEffect(() => {
    fetchAgents();
    timerRef.current = setInterval(fetchAgents, REFRESH_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchAgents]);

  // Fetch detail when selection changes
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    invoke<AgentDetail | null>('show_agent', { id: selectedId }).then(
      (data) => {
        if (!cancelled) setDetail(data);
      },
      () => {
        if (!cancelled) setDetail(null);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const teams = groupByTeam(agents);
  const onlineCount = agents.filter((a) => ['working', 'idle', 'running', 'spawning'].includes(a.state)).length;

  if (state === 'loading') {
    return (
      <div data-window-id={windowId} style={{ ...styles.root, ...styles.loadingBox }}>
        Loading agents...
      </div>
    );
  }

  if (state === 'error' && agents.length === 0) {
    return (
      <div data-window-id={windowId} style={styles.root}>
        <div style={{ padding: '24px' }}>
          <div style={styles.errorBox}>Failed to load agents: {error}</div>
        </div>
      </div>
    );
  }

  return (
    <div data-window-id={windowId} style={styles.root}>
      {/* Sidebar — agent list */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <p style={styles.sidebarTitle}>Agents</p>
          <p style={styles.sidebarSubtitle}>
            {onlineCount} online \u00b7 {agents.length} total
            {error && <span style={{ color: t.warning }}> (stale)</span>}
          </p>
        </div>
        <div style={styles.agentList}>
          {teams.map((group) => (
            <div key={group.name}>
              <div style={styles.teamHeader}>{group.name}</div>
              {group.agents.map((agent) => (
                <AgentRowItem
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedId}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          ))}
          {agents.length === 0 && (
            <div style={{ padding: '16px', color: t.textMuted, fontSize: '13px' }}>No agents registered</div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      <div style={styles.detail}>
        {detail ? (
          <AgentDetailPanel detail={detail} />
        ) : (
          <div style={styles.detailEmpty}>{selectedId ? 'Loading...' : 'Select an agent to view details'}</div>
        )}
      </div>
    </div>
  );
}
