import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../../lib/ipc';
import type { TasksViewProps } from '../../../lib/types';

// ============================================================================
// Types
// ============================================================================

interface TaskRow {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  status: string;
  stage: string;
  priority: string;
  project_id: string | null;
  board_id: string | null;
  column_id: string | null;
  group_name: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface BoardColumn {
  id: string;
  name: string;
  label: string;
  color: string;
  position: number;
}

interface KanbanData {
  columns: BoardColumn[];
  tasks: TaskRow[];
}

type LoadState = 'loading' | 'ready' | 'error';

// ============================================================================
// Theme tokens
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

const STATUS_COLORS: Record<string, string> = {
  in_progress: t.cyan,
  ready: t.textDim,
  blocked: t.warning,
  done: t.emerald,
  failed: t.error,
  cancelled: t.textMuted,
};

const PRIORITY_ICONS: Record<string, string> = {
  urgent: '\u25b2\u25b2', // ▲▲
  high: '\u25b2', // ▲
  normal: '\u25cf', // ●
  low: '\u25bd', // ▽
};

function priorityColor(priority: string): string {
  if (priority === 'urgent') return t.error;
  if (priority === 'high') return t.warning;
  if (priority === 'low') return t.textMuted;
  return t.textDim;
}

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
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 24px',
    borderBottom: `1px solid ${t.border}`,
  },
  title: {
    fontSize: '16px',
    fontWeight: 600,
    color: t.text,
    margin: 0,
  },
  subtitle: {
    fontSize: '11px',
    color: t.textMuted,
    margin: '4px 0 0 0',
  },
  board: {
    display: 'flex',
    flex: 1,
    overflow: 'auto',
    padding: '16px',
    gap: '16px',
  },
  column: {
    minWidth: '260px',
    maxWidth: '320px',
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    backgroundColor: t.bgCard,
    borderRadius: '8px',
    border: `1px solid ${t.border}`,
    overflow: 'hidden',
  },
  columnHeader: {
    padding: '12px 16px',
    borderBottom: `1px solid ${t.border}`,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  columnDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
  },
  columnTitle: {
    fontSize: '12px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: t.textDim,
    margin: 0,
    flex: 1,
  },
  columnCount: {
    fontSize: '11px',
    color: t.textMuted,
    backgroundColor: t.bg,
    padding: '1px 6px',
    borderRadius: '8px',
  },
  columnBody: {
    flex: 1,
    overflow: 'auto',
    padding: '8px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  taskCard: {
    padding: '10px 12px',
    backgroundColor: t.bg,
    borderRadius: '6px',
    border: `1px solid ${t.border}`,
    transition: 'border-color 0.15s ease, background-color 0.15s ease',
  },
  taskTitle: {
    fontSize: '12px',
    fontWeight: 500,
    color: t.text,
    margin: 0,
    lineHeight: 1.4,
  },
  taskMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '6px',
    fontSize: '10px',
    color: t.textMuted,
  },
  statusBadge: {
    fontSize: '10px',
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: '3px',
    textTransform: 'uppercase' as const,
  },
  errorBox: {
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    border: `1px solid ${t.error}`,
    borderRadius: '8px',
    padding: '16px',
    color: t.error,
    fontSize: '13px',
    margin: '24px',
  },
  loadingBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: t.textMuted,
    fontSize: '14px',
  },
  emptyColumn: {
    padding: '16px',
    textAlign: 'center' as const,
    color: t.textMuted,
    fontSize: '11px',
  },
  // Fallback list mode (no board selected)
  listView: {
    flex: 1,
    overflow: 'auto',
    padding: '16px 24px',
  },
  listRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '8px 12px',
    borderBottom: `1px solid ${t.border}`,
  },
  listSeq: {
    fontSize: '11px',
    color: t.textMuted,
    width: '40px',
    textAlign: 'right' as const,
  },
} as const;

// ============================================================================
// Task Card
// ============================================================================

function TaskCard({ task }: { task: TaskRow }) {
  const [hovered, setHovered] = useState(false);
  const statusColor = STATUS_COLORS[task.status] ?? t.textMuted;

  return (
    <div
      style={{
        ...styles.taskCard,
        borderColor: hovered ? t.borderAccent : t.border,
        backgroundColor: hovered ? t.bgCardHover : t.bg,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <p style={styles.taskTitle}>
        <span style={{ color: t.textMuted }}>#{task.seq}</span> {task.title}
      </p>
      <div style={styles.taskMeta}>
        <span style={{ ...styles.statusBadge, backgroundColor: `${statusColor}22`, color: statusColor }}>
          {task.status}
        </span>
        <span style={{ color: priorityColor(task.priority) }}>
          {PRIORITY_ICONS[task.priority] ?? ''} {task.priority}
        </span>
        {task.group_name && <span style={{ color: t.purple }}>{task.group_name}</span>}
      </div>
    </div>
  );
}

// ============================================================================
// Default Columns (when no board is loaded)
// ============================================================================

const DEFAULT_COLUMNS: BoardColumn[] = [
  { id: 'col-backlog', name: 'backlog', label: 'Backlog', color: t.textMuted, position: 0 },
  { id: 'col-ready', name: 'ready', label: 'Ready', color: t.textDim, position: 1 },
  { id: 'col-in_progress', name: 'in_progress', label: 'In Progress', color: t.cyan, position: 2 },
  { id: 'col-done', name: 'done', label: 'Done', color: t.emerald, position: 3 },
];

function assignToDefaultColumn(task: TaskRow): string {
  if (task.status === 'done') return 'col-done';
  if (task.status === 'in_progress') return 'col-in_progress';
  if (task.status === 'ready') return 'col-ready';
  return 'col-backlog';
}

// ============================================================================
// Tasks View
// ============================================================================

const REFRESH_INTERVAL_MS = 5_000;

export function TasksView({ windowId }: TasksViewProps) {
  const [kanban] = useState<KanbanData | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTasks = useCallback(async () => {
    try {
      // Try loading all tasks (no board filter — kanban fallback)
      const data = await invoke<TaskRow[]>('list_tasks', {});
      setTasks(data);
      setState('ready');
      setError(null);
    } catch (err) {
      if (tasks.length === 0) setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tasks.length]);

  useEffect(() => {
    fetchTasks();
    timerRef.current = setInterval(fetchTasks, REFRESH_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchTasks]);

  if (state === 'loading') {
    return (
      <div data-window-id={windowId} style={styles.root}>
        <div style={styles.loadingBox}>Loading tasks...</div>
      </div>
    );
  }

  if (state === 'error' && tasks.length === 0) {
    return (
      <div data-window-id={windowId} style={styles.root}>
        <div style={styles.errorBox}>Failed to load tasks: {error}</div>
      </div>
    );
  }

  // Use default columns based on status if no kanban board
  const columns = kanban?.columns ?? DEFAULT_COLUMNS;
  const taskList = kanban?.tasks ?? tasks;

  // Group tasks by column
  const columnTasks = new Map<string, TaskRow[]>();
  for (const col of columns) {
    columnTasks.set(col.id, []);
  }

  for (const task of taskList) {
    const colId = task.column_id ?? assignToDefaultColumn(task);
    const arr = columnTasks.get(colId);
    if (arr) {
      arr.push(task);
    } else {
      // Task doesn't match any column — put in first
      const first = columns[0]?.id;
      if (first) columnTasks.get(first)?.push(task);
    }
  }

  return (
    <div data-window-id={windowId} style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Tasks</h1>
          <p style={styles.subtitle}>
            {taskList.length} tasks \u00b7 {taskList.filter((t) => t.status === 'in_progress').length} active
            {error && <span style={{ color: t.warning, marginLeft: '8px' }}>(stale)</span>}
          </p>
        </div>
      </div>

      {/* Kanban board */}
      <div style={styles.board}>
        {columns.map((col) => {
          const colTasks = columnTasks.get(col.id) ?? [];
          return (
            <div key={col.id} style={styles.column}>
              <div style={styles.columnHeader}>
                <div style={{ ...styles.columnDot, backgroundColor: col.color }} />
                <p style={styles.columnTitle}>{col.label}</p>
                <span style={styles.columnCount}>{colTasks.length}</span>
              </div>
              <div style={styles.columnBody}>
                {colTasks.length === 0 ? (
                  <div style={styles.emptyColumn}>No tasks</div>
                ) : (
                  colTasks.map((task) => <TaskCard key={task.id} task={task} />)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
