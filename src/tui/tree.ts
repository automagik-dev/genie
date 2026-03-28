/**
 * Tree data structure for TUI navigation.
 * Builds a hierarchical tree: Org → Project → Board → Column → Task
 * Uses indexed lookups (Map) instead of repeated filter() for O(1) access.
 */

import type { TreeNodeData, TuiBoard, TuiColumn, TuiData, TuiTask } from './types.js';

export type NodeKind = 'org' | 'project' | 'board' | 'column' | 'task';

export interface TreeNode {
  kind: NodeKind;
  id: string;
  label: string;
  depth: number;
  expanded: boolean;
  data: TreeNodeData;
  children: TreeNode[];
}

/** Pre-indexed data for O(1) lookups during tree construction. */
interface DataIndex {
  boardsByProject: Map<string, TuiBoard[]>;
  columnsByBoard: Map<string, TuiColumn[]>;
  tasksByBoard: Map<string, TuiTask[]>;
}

function buildIndex(data: TuiData): DataIndex {
  const boardsByProject = new Map<string, TuiBoard[]>();
  const columnsByBoard = new Map<string, TuiColumn[]>();
  const tasksByBoard = new Map<string, TuiTask[]>();

  for (const b of data.boards) {
    const arr = boardsByProject.get(b.projectId) ?? [];
    arr.push(b);
    boardsByProject.set(b.projectId, arr);
  }
  for (const c of data.columns) {
    const arr = columnsByBoard.get(c.boardId) ?? [];
    arr.push(c);
    columnsByBoard.set(c.boardId, arr);
  }
  for (const t of data.tasks) {
    const arr = tasksByBoard.get(t.boardId) ?? [];
    arr.push(t);
    tasksByBoard.set(t.boardId, arr);
  }

  return { boardsByProject, columnsByBoard, tasksByBoard };
}

/**
 * Build navigation tree from flat data.
 * Uses pre-indexed Maps for O(1) child lookups instead of O(n) filter.
 */
export function buildTree(data: TuiData, liveSessions: Set<string>): TreeNode[] {
  const org = data.orgs[0];
  if (!org) return [];

  const idx = buildIndex(data);

  const projectNodes: TreeNode[] = data.projects.map((p) => {
    const isLive = p.tmuxSession ? liveSessions.has(p.tmuxSession) : false;
    const pBoards = idx.boardsByProject.get(p.id) ?? [];
    const taskCount = pBoards.reduce((s, b) => s + (idx.tasksByBoard.get(b.id)?.length ?? 0), 0);

    return {
      kind: 'project' as NodeKind,
      id: p.id,
      label: p.name,
      depth: 1,
      expanded: false,
      data: { kind: 'project', ...p, isLive, taskCount },
      children: pBoards.map((b) => buildBoardNode(b, idx, 2)),
    };
  });

  return [
    {
      kind: 'org',
      id: org.id,
      label: org.name,
      depth: 0,
      expanded: true,
      data: { kind: 'org', ...org },
      children: projectNodes,
    },
  ];
}

function buildBoardNode(board: TuiBoard, idx: DataIndex, depth: number): TreeNode {
  const boardCols = idx.columnsByBoard.get(board.id) ?? [];
  const boardTasks = idx.tasksByBoard.get(board.id) ?? [];

  return {
    kind: 'board',
    id: board.id,
    label: board.name,
    depth,
    expanded: false,
    data: { kind: 'board', ...board, taskCount: boardTasks.length },
    children: boardCols.map((c) => buildColumnNode(c, boardTasks, depth + 1)),
  };
}

function buildColumnNode(col: TuiColumn, boardTasks: TuiTask[], depth: number): TreeNode {
  const colTasks = boardTasks.filter(
    (t) => t.columnId === col.id || t.status?.toLowerCase() === col.name?.toLowerCase(),
  );

  return {
    kind: 'column',
    id: col.id,
    label: col.name,
    depth,
    expanded: false,
    data: { kind: 'column', ...col, taskCount: colTasks.length },
    children: colTasks.slice(0, 30).map((t) => ({
      kind: 'task' as NodeKind,
      id: t.id,
      label: `#${t.seq} ${t.title}`,
      depth: depth + 1,
      expanded: false,
      data: { kind: 'task' as const, ...t },
      children: [],
    })),
  };
}

/** Flatten tree respecting expansion state. */
export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.expanded && n.children.length > 0) {
      out.push(...flattenTree(n.children));
    }
  }
  return out;
}

/** Restore expansion state from a set of expanded IDs. */
export function restoreExpansion(nodes: TreeNode[], expandedIds: Set<string>): void {
  for (const n of nodes) {
    if (expandedIds.has(n.id)) n.expanded = true;
    restoreExpansion(n.children, expandedIds);
  }
}

/** Collect all expanded node IDs. */
export function collectExpanded(nodes: TreeNode[]): Set<string> {
  const ids = new Set<string>();
  for (const n of nodes) {
    if (n.expanded) ids.add(n.id);
    if (n.expanded) {
      for (const id of collectExpanded(n.children)) ids.add(id);
    }
  }
  return ids;
}
