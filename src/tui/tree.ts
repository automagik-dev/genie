/**
 * Tree data structure for TUI navigation.
 * Builds a hierarchical tree: Org → Project → Board → Column → Task
 * from flat TuiData arrays.
 */

import type { TuiBoard, TuiColumn, TuiData, TuiTask } from './types.js';

export type NodeKind = 'org' | 'project' | 'board' | 'column' | 'task';

export interface TreeNode {
  kind: NodeKind;
  id: string;
  label: string;
  depth: number;
  expanded: boolean;
  data: Record<string, unknown>;
  children: TreeNode[];
}

interface TreeState {
  cursor: number;
  expanded: Set<string>;
}

/**
 * Build navigation tree from flat data.
 * Sessions = set of live tmux session names (for project live indicators).
 */
export function buildTree(data: TuiData, liveSessions: Set<string>): TreeNode[] {
  const org = data.orgs[0];
  if (!org) return [];

  const projectNodes: TreeNode[] = data.projects.map((p) => {
    const isLive = p.tmuxSession ? liveSessions.has(p.tmuxSession) : false;
    const pBoards = data.boards.filter((b) => b.projectId === p.id);
    const pTasks = data.tasks.filter((t) => pBoards.some((b) => b.id === t.boardId));

    return {
      kind: 'project' as NodeKind,
      id: p.id,
      label: p.name,
      depth: 1,
      expanded: false,
      data: { ...p, isLive, taskCount: pTasks.length },
      children: pBoards.map((b) => buildBoardNode(b, data, 2)),
    };
  });

  return [
    {
      kind: 'org',
      id: org.id,
      label: org.name,
      depth: 0,
      expanded: true,
      data: { ...org },
      children: projectNodes,
    },
  ];
}

function buildBoardNode(board: TuiBoard, data: TuiData, depth: number): TreeNode {
  const boardCols = data.columns.filter((c) => c.boardId === board.id);
  const boardTasks = data.tasks.filter((t) => t.boardId === board.id);

  return {
    kind: 'board',
    id: board.id,
    label: board.name,
    depth,
    expanded: false,
    data: { ...board, taskCount: boardTasks.length },
    children: boardCols.map((c) => buildColumnNode(c, data, depth + 1)),
  };
}

function buildColumnNode(col: TuiColumn, data: TuiData, depth: number): TreeNode {
  const colTasks = data.tasks.filter(
    (t) => t.columnId === col.id || t.status?.toLowerCase() === col.name?.toLowerCase(),
  );

  return {
    kind: 'column',
    id: col.id,
    label: col.name,
    depth,
    expanded: false,
    data: { ...col, taskCount: colTasks.length },
    children: colTasks.slice(0, 30).map((t) => buildTaskNode(t, depth + 1)),
  };
}

function buildTaskNode(task: TuiTask, depth: number): TreeNode {
  return {
    kind: 'task',
    id: task.id,
    label: `#${task.seq} ${task.title}`,
    depth,
    expanded: false,
    data: { ...task },
    children: [],
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
