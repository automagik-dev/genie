/** @jsxImportSource @opentui/react */
/** Individual tree node: <box onMouseDown> + <text><span fg="..."> */

import { icons, palette } from '../theme.js';
import type { TreeNode as TreeNodeType } from '../types.js';

interface TreeNodeProps {
  node: TreeNodeType;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

export function TreeNodeRow({ node, selected, onSelect, onToggle }: TreeNodeProps) {
  const indent = '  '.repeat(node.depth);
  const hasChildren = node.children.length > 0;
  const expandIcon = hasChildren ? (node.expanded ? icons.expanded : icons.collapsed) : ' ';

  const icon = getNodeIcon(node);
  const color = getNodeColor(node);
  const activeIndicator = node.activePanes > 0 ? ` ${icons.agent}${node.activePanes}` : '';

  return (
    <box
      height={1}
      width="100%"
      backgroundColor={selected ? palette.violet : undefined}
      onMouseDown={() => {
        onSelect(node.id);
        if (hasChildren) onToggle(node.id);
      }}
    >
      <text>
        <span fg={palette.textDim}>
          {indent}
          {expandIcon}{' '}
        </span>
        <span fg={color}>{icon} </span>
        <span fg={selected ? '#ffffff' : palette.text}>{node.label}</span>
        {activeIndicator ? <span fg={palette.cyan}>{activeIndicator}</span> : null}
      </text>
    </box>
  );
}

function getNodeIcon(node: TreeNodeType): string {
  switch (node.type) {
    case 'org':
      return icons.org;
    case 'project':
      return node.expanded ? icons.projectOpen : icons.project;
    case 'board':
      return node.expanded ? icons.boardOpen : icons.board;
    case 'column':
      return icons.column;
    case 'task':
      if (node.activePanes > 0) return icons.taskActive;
      if ((node.data as { status: string }).status === 'done') return icons.taskDone;
      return icons.task;
    default:
      return ' ';
  }
}

function getNodeColor(node: TreeNodeType): string {
  switch (node.type) {
    case 'org':
      return palette.purple;
    case 'project':
      return node.activePanes > 0 ? palette.emerald : palette.textDim;
    case 'board':
      return palette.violet;
    case 'column':
      return palette.textMuted;
    case 'task':
      if (node.activePanes > 0) return palette.cyan;
      if ((node.data as { status: string }).status === 'done') return palette.emerald;
      return palette.text;
    default:
      return palette.text;
  }
}
