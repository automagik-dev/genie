import { useNats } from '@khal-os/sdk/app';
import { useCallback, useEffect, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';
import type { AppComponentProps } from '../../../lib/types';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { LoadingState } from '../../shared/LoadingState';

// ============================================================================
// Types
// ============================================================================

interface ScheduleRow {
  id: string;
  name: string;
  cron_expression: string;
  timezone: string | null;
  command: string;
  status: 'active' | 'paused' | 'disabled';
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  schedule_name: string | null;
  trigger: string;
  worker: string | null;
  status: 'success' | 'error' | 'running' | 'timeout';
  exit_code: number | null;
  duration_ms: number | null;
  output: string | null;
  error: string | null;
  trace_id: string | null;
  started_at: string;
  ended_at: string | null;
}

type LoadState = 'loading' | 'ready' | 'error';

// ============================================================================
// Constants
// ============================================================================

const ORG_ID = 'default';

// ============================================================================
// Helpers
// ============================================================================

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
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
    color: theme.text,
    fontFamily: theme.fontFamily,
    overflow: 'hidden',
  },
  header: {
    padding: '16px 20px',
    borderBottom: `1px solid ${theme.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
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
    margin: '2px 0 0',
  },
  body: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  section: {
    padding: '0 20px 16px',
  },
  sectionHeader: {
    fontSize: '11px',
    fontWeight: 600,
    color: theme.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    padding: '12px 0 8px',
    borderBottom: `1px solid ${theme.border}`,
    marginBottom: '8px',
  },
  scrollArea: {
    flex: 1,
    overflow: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '12px',
  },
  th: {
    textAlign: 'left' as const,
    padding: '6px 10px',
    fontSize: '10px',
    fontWeight: 600,
    color: theme.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    borderBottom: `1px solid ${theme.border}`,
    whiteSpace: 'nowrap' as const,
  },
  td: {
    padding: '8px 10px',
    borderBottom: '1px solid rgba(65, 72, 104, 0.4)',
    verticalAlign: 'top' as const,
    color: theme.text,
  },
  tdMuted: {
    padding: '8px 10px',
    borderBottom: '1px solid rgba(65, 72, 104, 0.4)',
    verticalAlign: 'top' as const,
    color: theme.textDim,
    fontSize: '11px',
  },
  cronPill: {
    fontFamily: theme.fontFamily,
    fontSize: '11px',
    backgroundColor: 'rgba(34, 211, 238, 0.1)',
    color: theme.cyan,
    padding: '2px 8px',
    borderRadius: theme.radiusSm,
    display: 'inline-block',
  },
  commandPill: {
    fontFamily: theme.fontFamily,
    fontSize: '11px',
    backgroundColor: theme.bgCard,
    color: theme.textDim,
    padding: '2px 8px',
    borderRadius: theme.radiusSm,
    display: 'inline-block',
    maxWidth: '300px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: status color mapper
  statusBadge: (s: string) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: theme.radiusSm,
    fontSize: '10px',
    fontWeight: 600,
    backgroundColor:
      s === 'active'
        ? 'rgba(52, 211, 153, 0.15)'
        : s === 'paused'
          ? 'rgba(251, 191, 36, 0.15)'
          : 'rgba(248, 113, 113, 0.15)',
    color:
      s === 'active'
        ? theme.emerald
        : s === 'paused'
          ? theme.warning
          : s === 'running'
            ? theme.cyan
            : s === 'success'
              ? theme.emerald
              : s === 'error' || s === 'timeout'
                ? theme.error
                : theme.error,
  }),
  expandRow: {
    backgroundColor: theme.bgCard,
    borderBottom: `1px solid ${theme.border}`,
  },
  expandContent: {
    padding: '10px 16px',
    fontSize: '11px',
    color: theme.textDim,
  },
  preBlock: {
    fontFamily: theme.fontFamily,
    fontSize: '10px',
    backgroundColor: 'rgba(0,0,0,0.3)',
    padding: '8px',
    borderRadius: theme.radiusSm,
    overflow: 'auto',
    maxHeight: '200px',
    color: theme.text,
    margin: '4px 0 8px',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  },
  expandLabel: {
    fontSize: '10px',
    color: theme.textMuted,
    marginBottom: '2px',
  },
  splitPane: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'hidden',
  },
  topHalf: {
    flex: '0 0 auto',
    maxHeight: '45%',
    overflow: 'auto',
    borderBottom: `2px solid ${theme.border}`,
  },
  bottomHalf: {
    flex: 1,
    overflow: 'auto',
  },
  clickableRow: {
    cursor: 'pointer',
    transition: 'background-color 0.1s ease',
  },
} as const;

// ============================================================================
// Status Icon
// ============================================================================

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: status icon dispatch
function RunStatusIcon({ status }: { status: string }) {
  const icon =
    status === 'success'
      ? '\u2713'
      : status === 'error'
        ? '\u2717'
        : status === 'running'
          ? '\u25cf'
          : status === 'timeout'
            ? '\u23F1'
            : '\u25cb';

  return (
    <span
      style={{
        color:
          status === 'success'
            ? theme.emerald
            : status === 'error' || status === 'timeout'
              ? theme.error
              : status === 'running'
                ? theme.cyan
                : theme.textMuted,
        fontSize: '14px',
        fontWeight: 700,
      }}
    >
      {icon}
    </span>
  );
}

// ============================================================================
// Run Detail Row (expandable)
// ============================================================================

interface RunDetailRowProps {
  run: ScheduleRunRow;
  expanded: boolean;
  onToggle: () => void;
}

function RunDetailRow({ run, expanded, onToggle }: RunDetailRowProps) {
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: expandable row; keyboard support tracked for V2 */}
      <tr
        style={{
          ...styles.clickableRow,
          backgroundColor: expanded ? theme.bgCard : 'transparent',
        }}
        onClick={onToggle}
        onMouseEnter={(e) => {
          if (!expanded) (e.currentTarget as HTMLTableRowElement).style.backgroundColor = theme.bgCard;
        }}
        onMouseLeave={(e) => {
          if (!expanded) (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent';
        }}
      >
        <td style={styles.td}>
          <RunStatusIcon status={run.status} />
        </td>
        <td style={styles.td}>{run.trigger}</td>
        <td style={styles.tdMuted}>{run.worker ?? '—'}</td>
        <td style={styles.td}>
          <span style={styles.statusBadge(run.status)}>{run.status}</span>
        </td>
        <td style={styles.tdMuted}>{run.exit_code != null ? run.exit_code : '—'}</td>
        <td style={styles.tdMuted}>{formatDuration(run.duration_ms)}</td>
        <td style={styles.tdMuted}>{formatRelativeTime(run.started_at)}</td>
        <td style={{ ...styles.tdMuted, textAlign: 'center' }}>
          <span style={{ fontSize: '10px', color: theme.textMuted }}>{expanded ? '\u25B2' : '\u25BC'}</span>
        </td>
      </tr>
      {expanded && (
        <tr style={styles.expandRow}>
          <td colSpan={8} style={{ padding: 0 }}>
            <div style={styles.expandContent}>
              {run.trace_id && (
                <div style={{ marginBottom: '8px' }}>
                  <div style={styles.expandLabel}>Trace ID</div>
                  <code style={{ fontSize: '10px', color: theme.cyan }}>{run.trace_id}</code>
                </div>
              )}
              {run.output && (
                <div>
                  <div style={styles.expandLabel}>Output</div>
                  <pre style={styles.preBlock}>{run.output}</pre>
                </div>
              )}
              {run.error && (
                <div>
                  <div style={styles.expandLabel}>Error</div>
                  <pre style={{ ...styles.preBlock, color: theme.error }}>{run.error}</pre>
                </div>
              )}
              {!run.output && !run.error && !run.trace_id && (
                <span style={{ color: theme.textMuted }}>No details available.</span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ============================================================================
// Schedule Table
// ============================================================================

function ScheduleTable({ schedules }: { schedules: ScheduleRow[] }) {
  if (schedules.length === 0) {
    return (
      <EmptyState icon="\u23F0" title="No schedules configured" description="Use `genie schedule create` to add one." />
    );
  }

  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Name</th>
          <th style={styles.th}>Cron</th>
          <th style={styles.th}>Command</th>
          <th style={styles.th}>Status</th>
          <th style={styles.th}>Timezone</th>
          <th style={styles.th}>Updated</th>
        </tr>
      </thead>
      <tbody>
        {schedules.map((s) => (
          <tr key={s.id}>
            <td style={styles.td}>{s.name}</td>
            <td style={styles.td}>
              <span style={styles.cronPill}>{s.cron_expression}</span>
            </td>
            <td style={styles.td}>
              <span style={styles.commandPill} title={s.command}>
                {s.command}
              </span>
            </td>
            <td style={styles.td}>
              <span style={styles.statusBadge(s.status)}>{s.status}</span>
            </td>
            <td style={styles.tdMuted}>{s.timezone ?? 'UTC'}</td>
            <td style={styles.tdMuted}>{formatRelativeTime(s.updated_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ============================================================================
// Run History Table
// ============================================================================

function RunHistoryTable({ runs }: { runs: ScheduleRunRow[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggle = useCallback(
    (id: string) => {
      setExpandedId(expandedId === id ? null : id);
    },
    [expandedId],
  );

  if (runs.length === 0) {
    return (
      <EmptyState
        icon="\u23F3"
        title="No run history yet"
        description="Schedule runs will appear here once a schedule fires."
      />
    );
  }

  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th} />
          <th style={styles.th}>Trigger</th>
          <th style={styles.th}>Worker</th>
          <th style={styles.th}>Status</th>
          <th style={styles.th}>Exit</th>
          <th style={styles.th}>Duration</th>
          <th style={styles.th}>Time</th>
          <th style={styles.th} />
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <RunDetailRow key={run.id} run={run} expanded={expandedId === run.id} onToggle={() => toggle(run.id)} />
        ))}
      </tbody>
    </table>
  );
}

// ============================================================================
// SchedulerView (Main Export)
// ============================================================================

export function SchedulerView({ windowId, meta: _meta }: AppComponentProps) {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [runs, setRuns] = useState<ScheduleRunRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);

  const nats = useNats();

  const fetchData = useCallback(async () => {
    try {
      const [scheduleData, runData] = await Promise.all([
        nats.request<ScheduleRow[] | { error: string }>(GENIE_SUBJECTS.schedules.list(ORG_ID)).catch(() => []),
        nats.request<ScheduleRunRow[] | { error: string }>(GENIE_SUBJECTS.schedules.history(ORG_ID)).catch(() => []),
      ]);

      setSchedules(Array.isArray(scheduleData) ? (scheduleData as ScheduleRow[]) : []);
      setRuns(Array.isArray(runData) ? (runData as ScheduleRunRow[]) : []);
      setLoadState('ready');
      setError(null);
    } catch (err) {
      setLoadState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [nats]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 15_000);
    return () => clearInterval(timer);
  }, [fetchData]);

  if (loadState === 'loading') {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <LoadingState message="Loading schedules..." />
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <ErrorState message={error ?? 'Failed to load schedules'} service="schedules.list" onRetry={fetchData} />
      </div>
    );
  }

  return (
    <div data-window-id={windowId} style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Scheduler</h1>
          <p style={styles.subtitle}>
            {schedules.length} schedule{schedules.length !== 1 ? 's' : ''} &middot; {runs.length} recent runs
          </p>
        </div>
      </div>

      {/* Split-pane body */}
      <div style={styles.splitPane}>
        {/* Top half — schedule list */}
        <div style={styles.topHalf}>
          <div style={{ padding: '0 20px' }}>
            <div style={styles.sectionHeader}>Schedules</div>
          </div>
          <div style={{ padding: '0 20px 16px' }}>
            <ScheduleTable schedules={schedules} />
          </div>
        </div>

        {/* Bottom half — run history */}
        <div style={styles.bottomHalf}>
          <div style={{ padding: '0 20px' }}>
            <div style={styles.sectionHeader}>Run History</div>
          </div>
          <div style={{ padding: '0 20px 16px' }}>
            <RunHistoryTable runs={runs} />
          </div>
        </div>
      </div>
    </div>
  );
}
