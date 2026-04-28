import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, onEvent } from '../../../lib/ipc';
import { theme } from '../../../lib/theme';
import type { AgentsViewProps } from '../../../lib/types';
import { AgentDetail } from './AgentDetail';

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
  turn_count: number | null;
}

interface TeamGroup {
  name: string;
  agents: AgentRow[];
  activeCount: number;
}

type LoadState = 'loading' | 'ready' | 'error';

// ============================================================================
// Status color system — 4-color status
// ============================================================================

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  running: { color: theme.emerald, label: 'Running' },
  working: { color: theme.emerald, label: 'Working' },
  idle: { color: theme.emerald, label: 'Idle' },
  spawning: { color: theme.warning, label: 'Spawning' },
  permission: { color: theme.warning, label: 'Permission' },
  question: { color: theme.warning, label: 'Question' },
  error: { color: theme.error, label: 'Error' },
  done: { color: theme.textMuted, label: 'Done' },
  suspended: { color: theme.textMuted, label: 'Suspended' },
  offline: { color: theme.textMuted, label: 'Offline' },
};

function stateColor(state: string): string {
  return STATUS_CONFIG[state]?.color ?? theme.textMuted;
}

function stateLabel(state: string): string {
  return STATUS_CONFIG[state]?.label ?? state;
}

// ============================================================================
// Status Legend items (4-color)
// ============================================================================

const STATUS_LEGEND = [
  { color: theme.emerald, label: 'Running' },
  { color: theme.warning, label: 'Spawning' },
  { color: theme.error, label: 'Error' },
  { color: theme.textMuted, label: 'Offline' },
];

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
    .map(([name, agents]) => ({
      name,
      agents,
      activeCount: agents.filter((a) => ['working', 'running', 'idle', 'spawning'].includes(a.state)).length,
    }));
}

/**
 * Compute indentation level for reports_to hierarchy.
 * Agents that report to another agent in the same team get indented.
 */
function computeIndentLevel(agent: AgentRow, allAgents: AgentRow[]): number {
  let level = 0;
  let current = agent;
  const visited = new Set<string>();
  while (current.reports_to && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = allAgents.find((a) => a.id === current.reports_to || a.custom_name === current.reports_to);
    if (!parent) break;
    level++;
    current = parent;
  }
  return level;
}

// ============================================================================
// Styles
// ============================================================================

const styles = {
  root: {
    display: 'flex',
    height: '100%',
    backgroundColor: theme.bg,
    color: theme.text,
    fontFamily: theme.fontFamily,
  },
  // Left list panel
  listPanel: {
    width: '380px',
    minWidth: '320px',
    borderRight: `1px solid ${theme.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  listHeader: {
    padding: '16px',
    borderBottom: `1px solid ${theme.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: '16px',
    fontWeight: 600,
    color: theme.text,
    margin: 0,
  },
  subtitle: {
    fontSize: '11px',
    color: theme.textMuted,
    margin: 0,
  },
  // Status legend
  legend: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap' as const,
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '10px',
    color: theme.textMuted,
  },
  legendDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
  },
  // Filter bar
  filterBar: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap' as const,
  },
  filterSelect: {
    padding: '4px 8px',
    fontSize: '11px',
    fontFamily: theme.fontFamily,
    backgroundColor: theme.bgCard,
    color: theme.textDim,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    cursor: 'pointer',
    outline: 'none',
    appearance: 'auto' as const,
  },
  filterInput: {
    padding: '4px 8px',
    fontSize: '11px',
    fontFamily: theme.fontFamily,
    backgroundColor: theme.bgCard,
    color: theme.text,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    outline: 'none',
    flex: 1,
    minWidth: '80px',
  },
  // Agent list
  agentList: {
    flex: 1,
    overflow: 'auto',
    padding: '4px 0',
  },
  // Team header (collapsible)
  teamHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 16px 6px',
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    width: '100%',
    textAlign: 'left' as const,
    font: 'inherit',
    color: 'inherit',
  },
  teamChevron: {
    fontSize: '10px',
    color: theme.textMuted,
    width: '12px',
    transition: 'transform 0.15s ease',
  },
  teamName: {
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: theme.textMuted,
    flex: 1,
  },
  teamCount: {
    fontSize: '10px',
    color: theme.textMuted,
    backgroundColor: theme.bgCard,
    padding: '1px 6px',
    borderRadius: '8px',
  },
  // Agent row
  agentRow: {
    padding: '6px 16px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    transition: 'background-color 0.1s ease',
    border: 'none',
    width: '100%',
    textAlign: 'left' as const,
    font: 'inherit',
    color: 'inherit',
    background: 'none',
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
  agentNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  agentName: {
    fontSize: '13px',
    fontWeight: 500,
    color: theme.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  agentRole: {
    fontSize: '10px',
    color: theme.textMuted,
    padding: '0 4px',
    backgroundColor: theme.bgCard,
    borderRadius: '3px',
  },
  agentMeta: {
    fontSize: '11px',
    color: theme.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  turnCount: {
    fontSize: '10px',
    color: theme.textMuted,
    flexShrink: 0,
  },
  // Detail panel (right)
  detailPanel: {
    flex: 1,
    overflow: 'hidden',
  },
  // Loading / Error
  errorBox: {
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    border: `1px solid ${theme.error}`,
    borderRadius: theme.radiusMd,
    padding: '16px',
    color: theme.error,
    fontSize: '13px',
  },
  loadingBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: theme.textMuted,
    fontSize: '14px',
  },
} as const;

// ============================================================================
// Status Dot Component
// ============================================================================

function StatusDot({ state, size = 8 }: { state: string; size?: number }) {
  const color = stateColor(state);
  const isActive = ['running', 'working', 'spawning'].includes(state);
  return (
    <span
      style={{
        display: 'inline-block',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '50%',
        backgroundColor: color,
        flexShrink: 0,
        boxShadow: isActive ? `0 0 4px ${color}66` : 'none',
      }}
      title={stateLabel(state)}
    />
  );
}

// ============================================================================
// Status Legend Component
// ============================================================================

function StatusLegend() {
  return (
    <div style={styles.legend}>
      {STATUS_LEGEND.map((item) => (
        <span key={item.label} style={styles.legendItem}>
          <span style={{ ...styles.legendDot, backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

// ============================================================================
// Team Header Component (Collapsible)
// ============================================================================

function TeamHeader({
  group,
  collapsed,
  onToggle,
}: {
  group: TeamGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" style={styles.teamHeader} onClick={onToggle}>
      <span
        style={{
          ...styles.teamChevron,
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
        }}
      >
        {'\u25BE'}
      </span>
      <span style={styles.teamName}>{group.name}</span>
      <span style={styles.teamCount}>
        {group.activeCount}/{group.agents.length}
      </span>
    </button>
  );
}

// ============================================================================
// Agent Row Component
// ============================================================================

function AgentRowItem({
  agent,
  selected,
  indentLevel,
  onSelect,
}: {
  agent: AgentRow;
  selected: boolean;
  indentLevel: number;
  onSelect: (id: string) => void;
}) {
  const duration = formatDuration(agent.started_at);

  return (
    <button
      type="button"
      style={{
        ...styles.agentRow,
        backgroundColor: selected ? theme.bgCardHover : 'transparent',
        borderLeft: selected ? `2px solid ${theme.violet}` : '2px solid transparent',
        paddingLeft: `${16 + indentLevel * 16}px`,
      }}
      onClick={() => onSelect(agent.id)}
    >
      <StatusDot state={agent.state} />
      <div style={styles.agentInfo}>
        <div style={styles.agentNameRow}>
          <span style={styles.agentName}>{displayName(agent)}</span>
          {agent.role && <span style={styles.agentRole}>{agent.role}</span>}
        </div>
        <div style={styles.agentMeta}>
          <span>
            {'\u25CF'} {stateLabel(agent.state)} {duration}
          </span>
          {agent.reports_to && (
            <span style={{ color: theme.textMuted }}>
              {'\u2192'} {agent.reports_to}
            </span>
          )}
        </div>
      </div>
      {agent.turn_count != null && agent.turn_count > 0 && <span style={styles.turnCount}>{agent.turn_count}t</span>}
    </button>
  );
}

// ============================================================================
// Filter Bar Component
// ============================================================================

interface Filters {
  state: string;
  team: string;
  role: string;
  search: string;
}

function FilterBar({
  filters,
  onChange,
  states,
  teams,
  roles,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  states: string[];
  teams: string[];
  roles: string[];
}) {
  return (
    <div style={styles.filterBar}>
      <select
        style={styles.filterSelect}
        value={filters.state}
        onChange={(e) => onChange({ ...filters, state: e.target.value })}
        aria-label="Filter by state"
      >
        <option value="">All States</option>
        {states.map((s) => (
          <option key={s} value={s}>
            {stateLabel(s)}
          </option>
        ))}
      </select>
      <select
        style={styles.filterSelect}
        value={filters.team}
        onChange={(e) => onChange({ ...filters, team: e.target.value })}
        aria-label="Filter by team"
      >
        <option value="">All Teams</option>
        {teams.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <select
        style={styles.filterSelect}
        value={filters.role}
        onChange={(e) => onChange({ ...filters, role: e.target.value })}
        aria-label="Filter by role"
      >
        <option value="">All Roles</option>
        {roles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <input
        style={styles.filterInput}
        type="text"
        placeholder="Search..."
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
        aria-label="Search agents"
      />
    </div>
  );
}

// ============================================================================
// Fleet View (main export)
// ============================================================================

const REFRESH_INTERVAL_MS = 3_000;

export function AgentsView({ windowId }: AgentsViewProps) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filters>({
    state: '',
    team: '',
    role: '',
    search: '',
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- Data fetching ----

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

  // ---- Live updates via NATS/IPC event subscription ----
  // Bridges to onEvent for PG LISTEN/NOTIFY → Tauri IPC events.
  // When @khal-os/sdk is available, this will become:
  //   useNatsSubscription(GENIE_SUBJECTS.events.agentState(orgId), handler)

  useEffect(() => {
    const unsub = onEvent('executor-state-changed', () => {
      // Refetch agents on any state change event
      fetchAgents();
    });
    return unsub;
  }, [fetchAgents]);

  // ---- Computed values ----

  const filteredAgents = useMemo(() => {
    let result = agents;
    if (filters.state) {
      result = result.filter((a) => a.state === filters.state);
    }
    if (filters.team) {
      result = result.filter((a) => (a.team ?? 'unassigned') === filters.team);
    }
    if (filters.role) {
      result = result.filter((a) => a.role === filters.role);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(
        (a) =>
          displayName(a).toLowerCase().includes(q) ||
          (a.role ?? '').toLowerCase().includes(q) ||
          (a.team ?? '').toLowerCase().includes(q) ||
          (a.title ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [agents, filters]);

  const teams = useMemo(() => groupByTeam(filteredAgents), [filteredAgents]);

  const allStates = useMemo(() => [...new Set(agents.map((a) => a.state))].sort(), [agents]);
  const allTeams = useMemo(() => [...new Set(agents.map((a) => a.team ?? 'unassigned'))].sort(), [agents]);
  const allRoles = useMemo(() => [...new Set(agents.map((a) => a.role).filter(Boolean) as string[])].sort(), [agents]);

  const onlineCount = agents.filter((a) => ['working', 'idle', 'running', 'spawning'].includes(a.state)).length;

  // ---- Team collapse toggle ----

  const toggleTeam = useCallback((teamName: string) => {
    setCollapsedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(teamName)) {
        next.delete(teamName);
      } else {
        next.add(teamName);
      }
      return next;
    });
  }, []);

  // ---- Keyboard navigation ----

  const flatAgentIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of teams) {
      if (!collapsedTeams.has(group.name)) {
        for (const agent of group.agents) {
          ids.push(agent.id);
        }
      }
    }
    return ids;
  }, [teams, collapsedTeams]);

  const navigateAgent = useCallback(
    (direction: 1 | -1) => {
      if (flatAgentIds.length === 0) return;
      const idx = selectedId ? flatAgentIds.indexOf(selectedId) : -1;
      const next =
        direction === 1 ? (idx >= flatAgentIds.length - 1 ? 0 : idx + 1) : idx <= 0 ? flatAgentIds.length - 1 : idx - 1;
      setSelectedId(flatAgentIds[next]);
    },
    [flatAgentIds, selectedId],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't capture when in an input/select
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        navigateAgent(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        navigateAgent(-1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigateAgent]);

  // ---- Render ----

  if (state === 'loading') {
    return (
      <div data-window-id={windowId} style={{ ...styles.root, ...styles.loadingBox }}>
        Loading fleet...
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
      {/* Left panel — agent list */}
      <div style={styles.listPanel}>
        <div style={styles.listHeader}>
          <div style={styles.titleRow}>
            <div>
              <h1 style={styles.title}>Fleet</h1>
              <p style={styles.subtitle}>
                {onlineCount} online {'\u00b7'} {agents.length} total
                {error && <span style={{ color: theme.warning }}> (stale)</span>}
              </p>
            </div>
          </div>

          {/* Status legend */}
          <StatusLegend />

          {/* Filter bar */}
          <FilterBar filters={filters} onChange={setFilters} states={allStates} teams={allTeams} roles={allRoles} />
        </div>

        {/* Agent list grouped by team */}
        <div style={styles.agentList}>
          {teams.length === 0 && filteredAgents.length === 0 && (
            <div style={{ padding: '16px', color: theme.textMuted, fontSize: '13px' }}>
              {agents.length === 0 ? 'No agents registered' : 'No agents match filters'}
            </div>
          )}
          {teams.map((group) => {
            const isCollapsed = collapsedTeams.has(group.name);
            return (
              <div key={group.name}>
                <TeamHeader group={group} collapsed={isCollapsed} onToggle={() => toggleTeam(group.name)} />
                {!isCollapsed &&
                  group.agents.map((agent) => (
                    <AgentRowItem
                      key={agent.id}
                      agent={agent}
                      selected={agent.id === selectedId}
                      indentLevel={computeIndentLevel(agent, agents)}
                      onSelect={setSelectedId}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel — agent detail (SplitPane pattern) */}
      <div style={styles.detailPanel}>
        <AgentDetail agentId={selectedId} />
      </div>
    </div>
  );
}
