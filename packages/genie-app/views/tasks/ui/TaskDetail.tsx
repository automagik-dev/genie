import { useNats } from '@khal-os/sdk/app';
import { useCallback, useEffect, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

interface TaskDetailRow {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  status: string;
  stage: string;
  priority: string;
  type_id: string;
  board_id: string | null;
  board_name: string | null;
  column_id: string | null;
  column_name: string | null;
  external_url: string | null;
  executor_name: string | null;
  team_name: string | null;
  session_id: string | null;
  acceptance_criteria: AcceptanceCriterion[];
  stage_history: StageLogEntry[];
  depends_on: TaskDependency[];
  blocks: TaskDependency[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface AcceptanceCriterion {
  text: string;
  done: boolean;
}

interface StageLogEntry {
  id: string;
  from_stage: string;
  to_stage: string;
  actor: string | null;
  gate_type: string | null;
  timestamp: string;
}

interface TaskDependency {
  task_id: string;
  task_seq: number;
  task_title: string;
  task_stage: string;
  dep_type: string;
}

// ============================================================================
// Constants
// ============================================================================

const ORG_ID = 'default';

// ============================================================================
// Priority config
// ============================================================================

const PRIORITY_CONFIG: Record<string, { color: string; label: string }> = {
  P0: { color: theme.error, label: 'P0 Critical' },
  P1: { color: theme.warning, label: 'P1 High' },
  P2: { color: theme.blue, label: 'P2 Medium' },
  P3: { color: theme.textMuted, label: 'P3 Low' },
  urgent: { color: theme.error, label: 'Urgent' },
  high: { color: theme.warning, label: 'High' },
  normal: { color: theme.blue, label: 'Normal' },
  low: { color: theme.textMuted, label: 'Low' },
};

function priorityColor(priority: string): string {
  return PRIORITY_CONFIG[priority]?.color ?? theme.textMuted;
}

function priorityLabel(priority: string): string {
  return PRIORITY_CONFIG[priority]?.label ?? priority;
}

// ============================================================================
// Stage color
// ============================================================================

const STAGE_COLORS: Record<string, string> = {
  triage: theme.textMuted,
  draft: theme.textDim,
  brainstorm: theme.purple,
  wish: theme.violet,
  work: theme.cyan,
  review: theme.warning,
  qa: theme.blue,
  ship: theme.emerald,
  done: theme.emerald,
  blocked: theme.error,
};

function stageColor(stage: string): string {
  return STAGE_COLORS[stage] ?? theme.textDim;
}

// ============================================================================
// Dependency status dot
// ============================================================================

function depStatusColor(stage: string): string {
  if (['done', 'ship'].includes(stage)) return theme.emerald;
  if (['work', 'review', 'qa'].includes(stage)) return theme.cyan;
  if (stage === 'blocked') return theme.error;
  return theme.textMuted;
}

// ============================================================================
// Time formatting
// ============================================================================

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
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
    alignItems: 'flex-start',
    gap: '12px',
    flexWrap: 'wrap' as const,
  },
  seqBadge: {
    fontSize: '13px',
    fontWeight: 600,
    color: theme.textMuted,
    padding: '2px 8px',
    backgroundColor: theme.bgCard,
    borderRadius: theme.radiusSm,
    flexShrink: 0,
  },
  title: {
    fontSize: '18px',
    fontWeight: 600,
    color: theme.text,
    margin: 0,
    flex: 1,
    minWidth: 0,
  },
  badges: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap' as const,
    marginTop: '8px',
  },
  badge: {
    fontSize: '10px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: theme.radiusSm,
    textTransform: 'uppercase' as const,
  },
  section: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '10px',
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
    gap: '10px',
  },
  fieldCard: {
    backgroundColor: theme.bgCard,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusMd,
    padding: '10px',
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
  // Acceptance criteria
  criteriaList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  criterionRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    padding: '6px 10px',
    backgroundColor: theme.bgCard,
    borderRadius: theme.radiusSm,
    border: `1px solid ${theme.border}`,
    fontSize: '12px',
    lineHeight: 1.4,
  },
  criterionCheckbox: {
    width: '14px',
    height: '14px',
    borderRadius: '3px',
    border: `1px solid ${theme.border}`,
    flexShrink: 0,
    marginTop: '2px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '10px',
  },
  // Stage timeline
  timelineItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '8px 0',
    borderLeft: `2px solid ${theme.border}`,
    paddingLeft: '16px',
    marginLeft: '6px',
    position: 'relative' as const,
  },
  timelineDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    position: 'absolute' as const,
    left: '-6px',
    top: '10px',
  },
  timelineContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  timelineStages: {
    fontSize: '12px',
    color: theme.text,
    fontWeight: 500,
  },
  timelineMeta: {
    fontSize: '11px',
    color: theme.textMuted,
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap' as const,
  },
  // Dependencies
  depItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    backgroundColor: theme.bgCard,
    borderRadius: theme.radiusSm,
    border: `1px solid ${theme.border}`,
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'border-color 0.15s ease',
  },
  depDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  depSeq: {
    color: theme.textMuted,
    fontWeight: 500,
    flexShrink: 0,
  },
  depTitle: {
    flex: 1,
    color: theme.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  depStage: {
    fontSize: '10px',
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: '3px',
    textTransform: 'uppercase' as const,
    flexShrink: 0,
  },
  // Link
  link: {
    fontSize: '12px',
    color: theme.cyan,
    textDecoration: 'none',
    wordBreak: 'break-all' as const,
  },
} as const;

// ============================================================================
// Sub-components
// ============================================================================

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={styles.fieldCard}>
      <p style={styles.fieldLabel}>{label}</p>
      <p style={styles.fieldValue}>{value || '\u2014'}</p>
    </div>
  );
}

function AcceptanceCriteriaList({ criteria }: { criteria: AcceptanceCriterion[] }) {
  if (criteria.length === 0) {
    return <p style={{ fontSize: '12px', color: theme.textMuted, margin: 0 }}>No acceptance criteria defined</p>;
  }

  const doneCount = criteria.filter((c) => c.done).length;

  return (
    <div style={styles.criteriaList}>
      <p style={{ fontSize: '11px', color: theme.textMuted, margin: 0 }}>
        {doneCount}/{criteria.length} complete
      </p>
      {criteria.map((criterion, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: criteria list is static and reordering is not supported
        <div key={i} style={styles.criterionRow}>
          <div
            style={{
              ...styles.criterionCheckbox,
              backgroundColor: criterion.done ? theme.emerald : 'transparent',
              borderColor: criterion.done ? theme.emerald : theme.border,
              color: criterion.done ? theme.bg : theme.textMuted,
            }}
          >
            {criterion.done ? '\u2713' : ''}
          </div>
          <span style={{ color: criterion.done ? theme.textDim : theme.text }}>{criterion.text}</span>
        </div>
      ))}
    </div>
  );
}

function StageTimeline({ entries }: { entries: StageLogEntry[] }) {
  if (entries.length === 0) {
    return <p style={{ fontSize: '12px', color: theme.textMuted, margin: 0 }}>No stage transitions recorded</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {entries.map((entry) => {
        const toColor = stageColor(entry.to_stage);
        return (
          <div key={entry.id} style={styles.timelineItem}>
            <div style={{ ...styles.timelineDot, backgroundColor: toColor }} />
            <div style={styles.timelineContent}>
              <span style={styles.timelineStages}>
                <span style={{ color: stageColor(entry.from_stage) }}>{entry.from_stage}</span>
                {' \u2192 '}
                <span style={{ color: toColor }}>{entry.to_stage}</span>
              </span>
              <div style={styles.timelineMeta}>
                <span>{formatTimestamp(entry.timestamp)}</span>
                {entry.actor && <span>by {entry.actor}</span>}
                {entry.gate_type && (
                  <span
                    style={{
                      padding: '0 4px',
                      backgroundColor: theme.bgCard,
                      borderRadius: '3px',
                    }}
                  >
                    {entry.gate_type}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DependencyList({
  deps,
  label,
  onSelect,
}: {
  deps: TaskDependency[];
  label: string;
  onSelect?: (taskId: string) => void;
}) {
  if (deps.length === 0) {
    return <p style={{ fontSize: '12px', color: theme.textMuted, margin: 0 }}>No {label.toLowerCase()} dependencies</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {deps.map((dep) => {
        const dotColor = depStatusColor(dep.task_stage);
        const sColor = stageColor(dep.task_stage);
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: dependency row — keyboard nav via arrow keys in parent list
          <div
            key={dep.task_id}
            style={styles.depItem}
            onClick={() => onSelect?.(dep.task_id)}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = theme.borderActive;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = theme.border;
            }}
          >
            <div style={{ ...styles.depDot, backgroundColor: dotColor }} />
            <span style={styles.depSeq}>#{dep.task_seq}</span>
            <span style={styles.depTitle}>{dep.task_title}</span>
            <span
              style={{
                ...styles.depStage,
                backgroundColor: `${sColor}22`,
                color: sColor,
              }}
            >
              {dep.task_stage}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// TaskDetail Component
// ============================================================================

interface TaskDetailProps {
  taskId: string | null;
  onSelectTask?: (taskId: string) => void;
}

export function TaskDetail({ taskId, onSelectTask }: TaskDetailProps) {
  const [detail, setDetail] = useState<TaskDetailRow | null>(null);
  const [loading, setLoading] = useState(false);
  const nats = useNats();

  const fetchDetail = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        const data = await nats.request<TaskDetailRow | null>(GENIE_SUBJECTS.tasks.show(ORG_ID), { id });
        setDetail(data);
      } catch {
        setDetail(null);
      } finally {
        setLoading(false);
      }
    },
    [nats],
  );

  useEffect(() => {
    if (!taskId) {
      setDetail(null);
      return;
    }

    fetchDetail(taskId);

    // Refresh detail every 10s for updates
    const timer = setInterval(() => fetchDetail(taskId), 10_000);
    return () => clearInterval(timer);
  }, [taskId, fetchDetail]);

  if (!taskId) {
    return <div style={styles.emptyState}>Select a task to view details</div>;
  }

  if (loading && !detail) {
    return <div style={styles.emptyState}>Loading...</div>;
  }

  if (!detail) {
    return <div style={styles.emptyState}>Task not found</div>;
  }

  const pColor = priorityColor(detail.priority);
  const sColor = stageColor(detail.stage);

  return (
    <div style={styles.container}>
      {/* Header */}
      <div>
        <div style={styles.header}>
          <span style={styles.seqBadge}>#{detail.seq}</span>
          <h1 style={styles.title}>{detail.title}</h1>
        </div>
        <div style={styles.badges}>
          {/* Stage badge */}
          <span
            style={{
              ...styles.badge,
              backgroundColor: `${sColor}22`,
              color: sColor,
            }}
          >
            {detail.stage}
          </span>
          {/* Priority badge */}
          <span
            style={{
              ...styles.badge,
              backgroundColor: `${pColor}22`,
              color: pColor,
            }}
          >
            {priorityLabel(detail.priority)}
          </span>
          {/* Type badge */}
          <span
            style={{
              ...styles.badge,
              backgroundColor: `${theme.violet}22`,
              color: theme.violet,
            }}
          >
            {detail.type_id}
          </span>
        </div>
      </div>

      {/* Overview fields */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Overview</p>
        <div style={styles.grid}>
          <Field label="Board" value={detail.board_name} />
          <Field label="Column" value={detail.column_name} />
          <Field label="Status" value={detail.status} />
          <Field label="Priority" value={priorityLabel(detail.priority)} />
          <Field label="Created" value={relativeTime(detail.created_at)} />
          <Field label="Updated" value={relativeTime(detail.updated_at)} />
        </div>
      </div>

      {/* Description */}
      {detail.description && (
        <div style={styles.section}>
          <p style={styles.sectionTitle}>Description</p>
          <p style={{ fontSize: '12px', color: theme.textDim, margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {detail.description}
          </p>
        </div>
      )}

      {/* Assignment */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Assignment</p>
        <div style={styles.grid}>
          <Field label="Executor" value={detail.executor_name} />
          <Field label="Team" value={detail.team_name} />
          <Field label="Session" value={detail.session_id} />
        </div>
      </div>

      {/* Acceptance Criteria */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Acceptance Criteria</p>
        <AcceptanceCriteriaList criteria={detail.acceptance_criteria ?? []} />
      </div>

      {/* Stage History Timeline */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Stage History</p>
        <StageTimeline entries={detail.stage_history ?? []} />
      </div>

      {/* Dependencies: Depends On */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Depends On</p>
        <DependencyList deps={detail.depends_on ?? []} label="Depends On" onSelect={onSelectTask} />
      </div>

      {/* Dependencies: Blocks */}
      <div style={styles.section}>
        <p style={styles.sectionTitle}>Blocks</p>
        <DependencyList deps={detail.blocks ?? []} label="Blocks" onSelect={onSelectTask} />
      </div>

      {/* External Links */}
      {detail.external_url && (
        <div style={styles.section}>
          <p style={styles.sectionTitle}>External Links</p>
          <a href={detail.external_url} target="_blank" rel="noopener noreferrer" style={styles.link}>
            {detail.external_url}
          </a>
        </div>
      )}
    </div>
  );
}
