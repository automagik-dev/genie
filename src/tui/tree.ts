/** Tree data structure — pure logic, no UI imports */

import type { FlatNode, TreeNode } from './types.js';

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
