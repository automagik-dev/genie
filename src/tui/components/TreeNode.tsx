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
  onContextMenu?: (id: string) => void;
}

export const TreeNodeRow = memo(function TreeNodeRow({
  node,
  selected,
  onSelect,
  onToggle,
  onContextMenu,
}: TreeNodeProps) {
  const indent = '  '.repeat(node.depth);
  const hasChildren = node.children.length > 0;
  const expandIcon = hasChildren ? (node.expanded ? icons.expanded : icons.collapsed) : ' ';

  const icon = getNodeIcon(node);
  const color = getNodeColor(node);
  const suffix = getNodeSuffix(node);

  return (
    <box
      height={1}
      width="100%"
      backgroundColor={selected ? palette.accentDim : undefined}
      onMouseDown={(event: { button?: number }) => {
        if (event.button === 2 && onContextMenu) {
          onSelect(node.id);
          onContextMenu(node.id);
          return;
        }
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
        <span fg={selected ? palette.accentBright : palette.text}>{node.label}</span>
        {suffix ? <span fg={palette.textDim}>{suffix}</span> : null}
        {node.agentState ? <span fg={getStateColor(node.agentState)}> {node.agentState}</span> : null}
        <span fg={palette.textMuted}>{` [${node.type}]`}</span>
      </text>
    </box>
  );
});

function getNodeIcon(node: TreeNodeType): string {
  // Workspace agent nodes
  if (node.type === 'agent') {
    return getAgentIcon(node);
  }

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

function getAgentIcon(node: TreeNodeType): string {
  switch (node.wsAgentState) {
    case 'running':
      return '\u25cf'; // ●
    case 'stopped':
      return '\u25cb'; // ○
    case 'error':
      return '\u2298'; // ⊘
    case 'spawning':
      return '\u231b'; // ⏳
    default:
      return '\u25cb'; // ○
  }
}

function getPaneIcon(node: TreeNodeType): string {
  if (node.data.isDead) return '\u2718'; // ✘
  if (node.agentState === 'working') return '\u25cf'; // ●
  if (node.agentState === 'idle') return '\u25cb'; // ○
  if (node.agentState === 'permission') return '\u26a0'; // ⚠
  if (node.agentState === 'error') return '\u2718'; // ✘
  if (node.data.command === 'claude') return '\u25c6'; // ���
  return '\u25cb'; // ○
}

function getNodeColor(node: TreeNodeType): string {
  if (node.type === 'agent') {
    return getAgentColor(node);
  }

  switch (node.type) {
    case 'session':
      return node.data.attached ? palette.success : palette.textDim;
    case 'window':
      return node.data.active ? palette.info : palette.text;
    case 'pane':
      return getPaneColor(node);
    default:
      return palette.text;
  }
}

function getAgentColor(node: TreeNodeType): string {
  switch (node.wsAgentState) {
    case 'running':
      return palette.success;
    case 'stopped':
      return palette.textDim;
    case 'error':
      return palette.error;
    case 'spawning':
      return palette.warning;
    default:
      return palette.textDim;
  }
}

function getPaneColor(node: TreeNodeType): string {
  if (node.data.isDead) return palette.error;
  if (node.agentState === 'working') return palette.info;
  if (node.agentState === 'permission') return palette.warning;
  if (node.agentState === 'error') return palette.error;
  if (node.agentState === 'idle') return palette.textDim;
  if (node.data.command === 'claude') return palette.info;
  return palette.textDim;
}

function getNodeSuffix(node: TreeNodeType): string {
  if (node.type === 'agent') {
    // Show retry hint for stuck agents (spawning with no live panes)
    if (node.wsAgentState === 'spawning' && node.activePanes === 0) {
      return ' [stuck — press R to retry]';
    }
    const wc = node.data.windowCount as number;
    if (wc > 1) return ` (${wc} windows)`;
    if (wc === 1) return ' (1 window)';
    return '';
  }
  if (node.type === 'session' || node.type === 'pane') {
    const count = node.activePanes;
    if (count > 0) return ` ${icons.agent}${count}`;
  }
  return '';
}

function getStateColor(state: string): string {
  switch (state) {
    case 'working':
      return palette.info;
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
