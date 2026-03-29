/** @jsxImportSource @opentui/react */
/** Individual tree node: <box onMouseDown> + <text><span fg="..."> */

import { memo } from 'react';
import { icons, palette } from '../theme.js';
import type { TreeNode as TreeNodeType } from '../types.js';

interface TreeNodeProps {
  node: TreeNodeType;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

export const TreeNodeRow = memo(function TreeNodeRow({ node, selected, onSelect, onToggle }: TreeNodeProps) {
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
        {node.agentState ? <span fg={getStateColor(node.agentState)}> {node.agentState}</span> : null}
      </text>
    </box>
  );
});

function getNodeIcon(node: TreeNodeType): string {
  switch (node.type) {
    case 'session':
      return node.data.attached ? '\u25b6' : '\u25b8'; // ▶ attached, ▸ detached
    case 'window':
      return node.data.active ? '\u25a0' : '\u25a1'; // ■ active, □ inactive
    case 'pane':
      return getPaneIcon(node);
    default:
      return ' ';
  }
}

function getPaneIcon(node: TreeNodeType): string {
  if (node.data.isDead) return '\u2718'; // ✘
  if (node.agentState === 'working') return '\u25cf'; // ●
  if (node.agentState === 'idle') return '\u25cb'; // ○
  if (node.agentState === 'permission') return '\u26a0'; // ⚠
  if (node.agentState === 'error') return '\u2718'; // ✘
  if (node.data.command === 'claude') return '\u25c6'; // ◆
  return '\u25cb'; // ○
}

function getNodeColor(node: TreeNodeType): string {
  switch (node.type) {
    case 'session':
      return node.data.attached ? palette.emerald : palette.textDim;
    case 'window':
      return node.data.active ? palette.cyan : palette.text;
    case 'pane':
      return getPaneColor(node);
    default:
      return palette.text;
  }
}

function getPaneColor(node: TreeNodeType): string {
  if (node.data.isDead) return palette.error;
  if (node.agentState === 'working') return palette.cyan;
  if (node.agentState === 'permission') return palette.warning;
  if (node.agentState === 'error') return palette.error;
  if (node.agentState === 'idle') return palette.textDim;
  if (node.data.command === 'claude') return palette.cyan;
  return palette.textDim;
}

function getStateColor(state: string): string {
  switch (state) {
    case 'working':
      return palette.cyan;
    case 'idle':
      return palette.textDim;
    case 'permission':
      return palette.warning;
    case 'error':
      return palette.error;
    default:
      return palette.textMuted;
  }
}
