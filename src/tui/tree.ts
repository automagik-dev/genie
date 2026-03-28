/** Tree data structure — pure logic, no UI imports */

import type { FlatNode, TreeNode, TuiData } from './types.js';

/** Build the full tree from loaded data */
export function buildTree(data: TuiData): TreeNode[] {
  const orgNodes: TreeNode[] = [];

  for (const org of data.orgs) {
    const orgProjects = data.projects.filter((p) => p.orgId === org.id);

    const projectNodes: TreeNode[] = orgProjects.map((proj) => {
      const projBoards = data.boards.filter((b) => b.projectId === proj.id);

      const boardNodes: TreeNode[] = projBoards.map((board) => {
        const columnNodes: TreeNode[] = (board.columns || [])
          .sort((a, b) => a.position - b.position)
          .map((col) => {
            const colTasks = data.tasks.filter((t) => t.boardId === board.id && t.columnId === col.id);
            const taskNodes: TreeNode[] = colTasks.map((task) => ({
              id: task.id,
              type: 'task' as const,
              label: `#${task.seq} ${task.title}`,
              depth: 4,
              expanded: false,
              children: [],
              data: task,
              activePanes: 0,
            }));

            return {
              id: col.id,
              type: 'column' as const,
              label: `${col.label} (${colTasks.length})`,
              depth: 3,
              expanded: false,
              children: taskNodes,
              data: col,
              activePanes: 0,
            };
          });

        return {
          id: board.id,
          type: 'board' as const,
          label: board.name,
          depth: 2,
          expanded: false,
          children: columnNodes,
          data: board,
          activePanes: 0,
        };
      });

      return {
        id: proj.id,
        type: 'project' as const,
        label: proj.name,
        depth: 1,
        expanded: false,
        children: boardNodes,
        data: proj,
        activePanes: 0,
      };
    });

    orgNodes.push({
      id: org.id,
      type: 'org' as const,
      label: org.name,
      depth: 0,
      expanded: true,
      children: projectNodes,
      data: org,
      activePanes: 0,
    });
  }

  return orgNodes;
}

/** Flatten tree into a visible list for rendering */
export function flattenTree(nodes: TreeNode[]): FlatNode[] {
  const result: FlatNode[] = [];

  function walk(node: TreeNode, depth: number) {
    result.push({ node, depth, visible: true });
    if (node.expanded) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  for (const node of nodes) {
    walk(node, 0);
  }

  return result;
}

/** Toggle expand/collapse for a node */
export function toggleNode(nodes: TreeNode[], id: string): TreeNode[] {
  return nodes.map((node) => {
    if (node.id === id) {
      return { ...node, expanded: !node.expanded };
    }
    return { ...node, children: toggleNode(node.children, id) };
  });
}

/** Update active pane counts on tree from activity data */
export function applyActivity(
  nodes: TreeNode[],
  activity: Map<string, { panes: number; state?: 'idle' | 'working' | 'permission' | 'error' }>,
): TreeNode[] {
  return nodes.map((node) => {
    const act = activity.get(node.id);
    const updated = {
      ...node,
      activePanes: act?.panes ?? 0,
      agentState: act?.state,
      children: applyActivity(node.children, activity),
    };
    if (updated.children.some((c) => c.activePanes > 0) && updated.activePanes === 0) {
      updated.activePanes = updated.children.reduce((sum, c) => sum + c.activePanes, 0);
    }
    return updated;
  });
}
