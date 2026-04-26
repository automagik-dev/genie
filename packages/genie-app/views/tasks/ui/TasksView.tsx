import { useNats, useNatsSubscription } from '@khal-os/sdk/app';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';
import type { TasksViewProps } from '../../../lib/types';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { LoadingState } from '../../shared/LoadingState';
import { TaskDetail } from './TaskDetail';

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
  executor_name: string | null;
  agent_avatar: string | null;
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

interface Board {
  id: string;
  name: string;
  columns: BoardColumn[];
}

interface TaskStageEvent {
  task_id: string;
  from_stage: string;
  to_stage: string;
  column_id: string | null;
}

type LoadState = 'loading' | 'ready' | 'error';
type ViewMode = 'kanban' | 'list';
type SortKey = 'seq' | 'priority' | 'stage' | 'title' | 'updated_at';
type SortDir = 'asc' | 'desc';

// ============================================================================
// Constants
// ============================================================================

const ORG_ID = 'default';
const REFRESH_INTERVAL_MS = 10_000;

// ============================================================================
// Priority config
// ============================================================================

const PRIORITY_CONFIG: Record<string, { color: string; label: string; sort: number }> = {
  P0: { color: theme.error, label: 'P0', sort: 0 },
  P1: { color: theme.warning, label: 'P1', sort: 1 },
  P2: { color: theme.blue, label: 'P2', sort: 2 },
  P3: { color: theme.textMuted, label: 'P3', sort: 3 },
  urgent: { color: theme.error, label: 'P0', sort: 0 },
  high: { color: theme.warning, label: 'P1', sort: 1 },
  normal: { color: theme.blue, label: 'P2', sort: 2 },
  low: { color: theme.textMuted, label: 'P3', sort: 3 },
};

function priorityColor(priority: string): string {
  return PRIORITY_CONFIG[priority]?.color ?? theme.textMuted;
}

function priorityLabel(priority: string): string {
  return PRIORITY_CONFIG[priority]?.label ?? priority;
}

function prioritySortValue(priority: string): number {
  return PRIORITY_CONFIG[priority]?.sort ?? 99;
}

// ============================================================================
// Stage colors
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
  in_progress: theme.cyan,
  ready: theme.textDim,
  backlog: theme.textMuted,
};

function stageColor(stage: string): string {
  return STAGE_COLORS[stage] ?? theme.textDim;
}

// ============================================================================
// Helpers
// ============================================================================

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}\u2026`;
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
// Default Columns (when no board is loaded)
// ============================================================================

const DEFAULT_COLUMNS: BoardColumn[] = [
  { id: 'col-backlog', name: 'backlog', label: 'Backlog', color: theme.textMuted, position: 0 },
  { id: 'col-ready', name: 'ready', label: 'Ready', color: theme.textDim, position: 1 },
  { id: 'col-in_progress', name: 'in_progress', label: 'In Progress', color: theme.cyan, position: 2 },
  { id: 'col-review', name: 'review', label: 'Review', color: theme.warning, position: 3 },
  { id: 'col-done', name: 'done', label: 'Done', color: theme.emerald, position: 4 },
];

function assignToDefaultColumn(task: TaskRow): string {
  if (['done', 'ship'].includes(task.stage) || task.status === 'done') return 'col-done';
  if (['review', 'qa'].includes(task.stage)) return 'col-review';
  if (['work', 'in_progress'].includes(task.stage) || task.status === 'in_progress') return 'col-in_progress';
  if (task.stage === 'ready' || task.status === 'ready') return 'col-ready';
  return 'col-backlog';
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
  // Left panel (kanban or list)
  mainPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    minWidth: 0,
  },
  // Header bar
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 20px',
    borderBottom: `1px solid ${theme.border}`,
    gap: '12px',
    flexWrap: 'wrap' as const,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
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
    margin: '2px 0 0 0',
  },
  select: {
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
  toggleButton: {
    padding: '4px 10px',
    fontSize: '11px',
    fontFamily: theme.fontFamily,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    cursor: 'pointer',
    transition: 'all 0.1s',
    backgroundColor: 'transparent',
    color: theme.textDim,
  },
  toggleActive: {
    backgroundColor: `${theme.violet}22`,
    borderColor: theme.violet,
    color: theme.violet,
  },
  // Kanban board
  board: {
    display: 'flex',
    flex: 1,
    overflow: 'auto',
    padding: '12px',
    gap: '12px',
  },
  column: {
    minWidth: '240px',
    maxWidth: '300px',
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    backgroundColor: theme.bgCard,
    borderRadius: theme.radiusMd,
    border: `1px solid ${theme.border}`,
    overflow: 'hidden',
  },
  columnHeader: {
    padding: '10px 14px',
    borderBottom: `1px solid ${theme.border}`,
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
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: theme.textDim,
    margin: 0,
    flex: 1,
  },
  columnCount: {
    fontSize: '10px',
    color: theme.textMuted,
    backgroundColor: theme.bg,
    padding: '1px 6px',
    borderRadius: '8px',
  },
  columnBody: {
    flex: 1,
    overflow: 'auto',
    padding: '6px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  // Task card
  taskCard: {
    padding: '8px 10px',
    backgroundColor: theme.bg,
    borderRadius: '6px',
    border: `1px solid ${theme.border}`,
    cursor: 'pointer',
    transition: 'border-color 0.15s ease, background-color 0.15s ease',
  },
  taskCardSelected: {
    borderColor: theme.borderActive,
    backgroundColor: theme.bgCardHover,
  },
  taskTitleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
  },
  taskSeq: {
    fontSize: '11px',
    color: theme.textMuted,
    fontWeight: 500,
    flexShrink: 0,
  },
  taskTitle: {
    fontSize: '12px',
    fontWeight: 500,
    color: theme.text,
    margin: 0,
    lineHeight: 1.4,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as const,
  },
  taskMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '6px',
    fontSize: '10px',
    color: theme.textMuted,
    flexWrap: 'wrap' as const,
  },
  priorityBadge: {
    fontSize: '9px',
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: '3px',
    textTransform: 'uppercase' as const,
    lineHeight: 1.4,
  },
  stageBadge: {
    fontSize: '9px',
    fontWeight: 600,
    padding: '1px 5px',
    borderRadius: '3px',
    textTransform: 'uppercase' as const,
  },
  agentAvatar: {
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    backgroundColor: theme.violet,
    color: theme.text,
    fontSize: '9px',
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  // Flat list view
  listContainer: {
    flex: 1,
    overflow: 'auto',
  },
  listTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '12px',
  },
  listTh: {
    padding: '8px 12px',
    textAlign: 'left' as const,
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: theme.textMuted,
    borderBottom: `1px solid ${theme.border}`,
    cursor: 'pointer',
    userSelect: 'none' as const,
    whiteSpace: 'nowrap' as const,
  },
  listTd: {
    padding: '6px 12px',
    borderBottom: `1px solid ${theme.border}`,
    color: theme.text,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '300px',
  },
  listTr: {
    cursor: 'pointer',
    transition: 'background-color 0.1s',
  },
  // Detail panel (right)
  detailPanel: {
    width: '380px',
    minWidth: '340px',
    borderLeft: `1px solid ${theme.border}`,
    overflow: 'hidden',
  },
  // Empty column
  emptyColumn: {
    padding: '16px',
    textAlign: 'center' as const,
    color: theme.textMuted,
    fontSize: '11px',
  },
} as const;

// ============================================================================
// Priority Badge Component
// ============================================================================

function PriorityBadge({ priority }: { priority: string }) {
  const color = priorityColor(priority);
  return (
    <span
      style={{
        ...styles.priorityBadge,
        backgroundColor: `${color}22`,
        color,
      }}
    >
      {priorityLabel(priority)}
    </span>
  );
}

// ============================================================================
// Stage Badge Component
// ============================================================================

function StageBadge({ stage }: { stage: string }) {
  const color = stageColor(stage);
  return (
    <span
      style={{
        ...styles.stageBadge,
        backgroundColor: `${color}22`,
        color,
      }}
    >
      {stage}
    </span>
  );
}

// ============================================================================
// Agent Avatar Component
// ============================================================================

function AgentAvatar({ name }: { name: string | null }) {
  if (!name) return null;
  const initial = name.charAt(0).toUpperCase();
  return (
    <span style={styles.agentAvatar} title={name}>
      {initial}
    </span>
  );
}

// ============================================================================
// Task Card (Kanban)
// ============================================================================

function TaskCard({
  task,
  selected,
  onSelect,
}: {
  task: TaskRow;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: kanban card nav; keyboard support tracked for V2
    <div
      style={{
        ...styles.taskCard,
        ...(selected || hovered ? { borderColor: theme.borderActive, backgroundColor: theme.bgCardHover } : {}),
      }}
      onClick={() => onSelect(task.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={styles.taskTitleRow}>
        <span style={styles.taskSeq}>#{task.seq}</span>
        <p style={styles.taskTitle}>{truncate(task.title, 60)}</p>
      </div>
      <div style={styles.taskMeta}>
        <PriorityBadge priority={task.priority} />
        <StageBadge stage={task.stage} />
        {task.group_name && <span style={{ color: theme.purple }}>{task.group_name}</span>}
        <span style={{ flex: 1 }} />
        <AgentAvatar name={task.executor_name ?? task.agent_avatar} />
      </div>
    </div>
  );
}

// ============================================================================
// Board Selector
// ============================================================================

function BoardSelector({
  boards,
  selectedId,
  onChange,
}: {
  boards: Board[];
  selectedId: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <select
      style={styles.select}
      value={selectedId ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Select board"
    >
      <option value="">All Boards</option>
      {boards.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}

// ============================================================================
// View Mode Toggle
// ============================================================================

function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div style={{ display: 'flex', gap: '2px' }}>
      <button
        type="button"
        style={{
          ...styles.toggleButton,
          ...(mode === 'kanban' ? styles.toggleActive : {}),
          borderRadius: `${theme.radiusSm} 0 0 ${theme.radiusSm}`,
        }}
        onClick={() => onChange('kanban')}
        title="Kanban view"
      >
        {'\u2637'} Kanban
      </button>
      <button
        type="button"
        style={{
          ...styles.toggleButton,
          ...(mode === 'list' ? styles.toggleActive : {}),
          borderRadius: `0 ${theme.radiusSm} ${theme.radiusSm} 0`,
        }}
        onClick={() => onChange('list')}
        title="List view"
      >
        {'\u2630'} List
      </button>
    </div>
  );
}

// ============================================================================
// Kanban Board
// ============================================================================

function KanbanBoard({
  columns,
  tasks,
  selectedTaskId,
  onSelectTask,
}: {
  columns: BoardColumn[];
  tasks: TaskRow[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
}) {
  // Group tasks by column
  const columnTasks = useMemo(() => {
    const map = new Map<string, TaskRow[]>();
    for (const col of columns) {
      map.set(col.id, []);
    }
    for (const task of tasks) {
      const colId = task.column_id ?? assignToDefaultColumn(task);
      const arr = map.get(colId);
      if (arr) {
        arr.push(task);
      } else {
        // Task doesn't match any column — put in first
        const first = columns[0]?.id;
        if (first) map.get(first)?.push(task);
      }
    }
    return map;
  }, [columns, tasks]);

  return (
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
                colTasks.map((task) => (
                  <TaskCard key={task.id} task={task} selected={task.id === selectedTaskId} onSelect={onSelectTask} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Flat List View
// ============================================================================

function FlatListView({
  tasks,
  selectedTaskId,
  onSelectTask,
  sortKey,
  sortDir,
  onSort,
}: {
  tasks: TaskRow[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const sortedTasks = useMemo(() => {
    const sorted = [...tasks];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'seq':
          cmp = a.seq - b.seq;
          break;
        case 'priority':
          cmp = prioritySortValue(a.priority) - prioritySortValue(b.priority);
          break;
        case 'stage':
          cmp = a.stage.localeCompare(b.stage);
          break;
        case 'title':
          cmp = a.title.localeCompare(b.title);
          break;
        case 'updated_at':
          cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [tasks, sortKey, sortDir]);

  function sortIndicator(key: SortKey): string {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u25B4' : ' \u25BE';
  }

  return (
    <div style={styles.listContainer}>
      <table style={styles.listTable}>
        <thead>
          <tr>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: sortable header */}
            <th style={styles.listTh} onClick={() => onSort('seq')}>
              #{sortIndicator('seq')}
            </th>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: sortable header */}
            <th style={styles.listTh} onClick={() => onSort('title')}>
              Title{sortIndicator('title')}
            </th>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: sortable header */}
            <th style={styles.listTh} onClick={() => onSort('priority')}>
              Priority{sortIndicator('priority')}
            </th>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: sortable header */}
            <th style={styles.listTh} onClick={() => onSort('stage')}>
              Stage{sortIndicator('stage')}
            </th>
            <th style={styles.listTh}>Agent</th>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: sortable header */}
            <th style={styles.listTh} onClick={() => onSort('updated_at')}>
              Updated{sortIndicator('updated_at')}
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedTasks.map((task) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: row selection; keyboard support tracked for V2
            <tr
              key={task.id}
              style={{
                ...styles.listTr,
                backgroundColor: task.id === selectedTaskId ? theme.bgCardHover : 'transparent',
              }}
              onClick={() => onSelectTask(task.id)}
              onMouseEnter={(e) => {
                if (task.id !== selectedTaskId) {
                  e.currentTarget.style.backgroundColor = theme.bgCard;
                }
              }}
              onMouseLeave={(e) => {
                if (task.id !== selectedTaskId) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }
              }}
            >
              <td style={{ ...styles.listTd, color: theme.textMuted, width: '50px' }}>#{task.seq}</td>
              <td style={{ ...styles.listTd, maxWidth: '400px' }}>{truncate(task.title, 80)}</td>
              <td style={styles.listTd}>
                <PriorityBadge priority={task.priority} />
              </td>
              <td style={styles.listTd}>
                <StageBadge stage={task.stage} />
              </td>
              <td style={styles.listTd}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <AgentAvatar name={task.executor_name ?? task.agent_avatar} />
                  {task.executor_name && (
                    <span style={{ fontSize: '11px', color: theme.textDim }}>{truncate(task.executor_name, 16)}</span>
                  )}
                </div>
              </td>
              <td style={{ ...styles.listTd, color: theme.textMuted, fontSize: '11px' }}>
                {relativeTime(task.updated_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// Mission Control (TasksView)
// ============================================================================

export function TasksView({ windowId }: TasksViewProps) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('kanban');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('seq');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const nats = useNats();

  // ---- Fetch boards ----

  const fetchBoards = useCallback(async () => {
    try {
      const data = await nats.request<Board[]>(GENIE_SUBJECTS.boards.list(ORG_ID));
      setBoards(Array.isArray(data) ? data : []);
    } catch {
      // Non-critical — boards may not exist yet
    }
  }, [nats]);

  // ---- Fetch tasks ----

  const fetchTasks = useCallback(async () => {
    try {
      const params: Record<string, unknown> = {};
      if (selectedBoardId) params.board_id = selectedBoardId;
      const data = await nats.request<TaskRow[]>(GENIE_SUBJECTS.tasks.list(ORG_ID), params);
      setTasks(Array.isArray(data) ? data : []);
      setState('ready');
      setError(null);
    } catch (err) {
      if (tasks.length === 0) setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [nats, selectedBoardId, tasks.length]);

  // ---- Initial fetch + polling ----

  useEffect(() => {
    fetchBoards();
  }, [fetchBoards]);

  useEffect(() => {
    fetchTasks();
    timerRef.current = setInterval(fetchTasks, REFRESH_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchTasks]);

  // ---- Real-time card updates via NATS subscription ----

  useNatsSubscription<TaskStageEvent>(
    GENIE_SUBJECTS.events.taskStage(ORG_ID),
    useCallback((event: TaskStageEvent) => {
      // Update the task in-place when its stage changes
      setTasks((prev) =>
        prev.map((t) =>
          t.id === event.task_id ? { ...t, stage: event.to_stage, column_id: event.column_id ?? t.column_id } : t,
        ),
      );
    }, []),
  );

  // ---- Sort toggle ----

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [sortKey],
  );

  // ---- Resolve columns for current board ----

  const currentBoard = useMemo(() => boards.find((b) => b.id === selectedBoardId) ?? null, [boards, selectedBoardId]);

  const columns = useMemo(() => {
    if (currentBoard?.columns && currentBoard.columns.length > 0) {
      return [...currentBoard.columns].sort((a, b) => a.position - b.position);
    }
    return DEFAULT_COLUMNS;
  }, [currentBoard]);

  // ---- Counts ----

  const activeCount = tasks.filter(
    (t) => ['work', 'in_progress', 'review', 'qa'].includes(t.stage) || t.status === 'in_progress',
  ).length;

  // ---- Render ----

  if (state === 'loading') {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <LoadingState message="Loading Mission Control..." />
      </div>
    );
  }

  if (state === 'error' && tasks.length === 0) {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <ErrorState message={error ?? 'Failed to load tasks'} service="tasks.list" onRetry={fetchTasks} />
      </div>
    );
  }

  if (tasks.length === 0 && state === 'ready') {
    return (
      <div data-window-id={windowId} style={{ ...styles.root, flexDirection: 'column' }}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <div>
              <h1 style={styles.title}>Mission Control</h1>
              <p style={styles.subtitle}>0 tasks</p>
            </div>
            <BoardSelector boards={boards} selectedId={selectedBoardId} onChange={setSelectedBoardId} />
          </div>
        </div>
        <EmptyState
          icon={'\u2637'}
          title="No tasks on this board yet"
          description="Use `genie task create` to add one."
        />
      </div>
    );
  }

  return (
    <div data-window-id={windowId} style={styles.root}>
      {/* Main panel (kanban or list) */}
      <div style={styles.mainPanel}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <div>
              <h1 style={styles.title}>Mission Control</h1>
              <p style={styles.subtitle}>
                {tasks.length} tasks {'\u00b7'} {activeCount} active
                {error && <span style={{ color: theme.warning, marginLeft: '8px' }}>(stale)</span>}
              </p>
            </div>
            <BoardSelector boards={boards} selectedId={selectedBoardId} onChange={setSelectedBoardId} />
          </div>
          <div style={styles.headerRight}>
            <ViewModeToggle mode={viewMode} onChange={setViewMode} />
          </div>
        </div>

        {/* Board content */}
        {viewMode === 'kanban' ? (
          <KanbanBoard
            columns={columns}
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
          />
        ) : (
          <FlatListView
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          />
        )}
      </div>

      {/* Right panel — task detail (SplitPane pattern) */}
      <div style={styles.detailPanel}>
        <TaskDetail taskId={selectedTaskId} onSelectTask={setSelectedTaskId} />
      </div>
    </div>
  );
}
