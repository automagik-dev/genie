/**
 * TreeNode — renders a single node in the navigation tree.
 * Uses typed TreeNodeData — zero Record<string, unknown> casts.
 */

import { Box, Text } from 'ink';
import type { TreeNode as TN } from '../tree.js';
import type { TreeNodeData } from '../types.js';

const C = {
  accent: '#a855f7',
  accentBg: '#7c3aed',
  live: '#22d3ee',
  dim: '#525270',
  text: '#c4b5fd',
  textBright: '#ede9fe',
  success: '#34d399',
  warn: '#fbbf24',
  danger: '#f87171',
} as const;

interface Props {
  node: TN;
  isSelected: boolean;
}

interface NodeStyle {
  bg: string | undefined;
  fg: string | undefined;
  cur: string;
  ind: string;
  arrow: string;
}

function getStyle(node: TN, isSelected: boolean): NodeStyle {
  return {
    bg: isSelected ? C.accentBg : undefined,
    fg: isSelected ? C.textBright : undefined,
    cur: isSelected ? '▸' : ' ',
    ind: '  '.repeat(node.depth),
    arrow: node.children.length > 0 ? (node.expanded ? '▾' : '▸') : ' ',
  };
}

function statusIcon(status: string): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'in_progress':
      return '●';
    case 'ready':
      return '○';
    case 'blocked':
      return '✖';
    default:
      return '·';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'done':
      return C.success;
    case 'in_progress':
      return C.warn;
    case 'ready':
      return C.text;
    case 'blocked':
      return C.danger;
    default:
      return C.dim;
  }
}

function OrgNode({ s }: { s: NodeStyle; d: TreeNodeData & { kind: 'org' } }) {
  return (
    <Text backgroundColor={s.bg} color={s.fg || C.accent} bold>
      {s.cur} {s.arrow} ◆ {s.ind}
    </Text>
  );
}

function ProjectNode({ node, s, d }: { node: TN; s: NodeStyle; d: TreeNodeData & { kind: 'project' } }) {
  const liveColor = d.isLive ? C.success : C.dim;
  return (
    <Box>
      <Text backgroundColor={s.bg} color={s.fg || C.text} bold={!!s.bg}>
        {s.cur} {s.ind}
        {s.arrow}{' '}
      </Text>
      <Text backgroundColor={s.bg} color={s.bg ? C.textBright : liveColor}>
        {d.isLive ? '●' : '○'}{' '}
      </Text>
      <Text backgroundColor={s.bg} color={s.fg || C.text} bold={!!s.bg}>
        {node.label}
      </Text>
      {d.taskCount > 0 && (
        <Text backgroundColor={s.bg} color={s.fg || C.dim}>
          {' '}
          ({d.taskCount})
        </Text>
      )}
    </Box>
  );
}

function BoardNode({ node, s, d }: { node: TN; s: NodeStyle; d: TreeNodeData & { kind: 'board' } }) {
  return (
    <Box>
      <Text backgroundColor={s.bg} color={s.fg || C.text} bold={!!s.bg}>
        {s.cur} {s.ind}
        {s.arrow} ⊞ {node.label}
      </Text>
      {d.taskCount > 0 && (
        <Text backgroundColor={s.bg} color={s.fg || C.dim}>
          {' '}
          ({d.taskCount})
        </Text>
      )}
    </Box>
  );
}

function ColumnNode({ node, s, d }: { node: TN; s: NodeStyle; d: TreeNodeData & { kind: 'column' } }) {
  return (
    <Box>
      <Text backgroundColor={s.bg} color={s.fg || (d.taskCount > 0 ? C.text : C.dim)} bold={!!s.bg}>
        {s.cur} {s.ind}
        {s.arrow} ┃ {node.label}
      </Text>
      {d.taskCount > 0 && (
        <Text backgroundColor={s.bg} color={s.fg || C.warn}>
          {' '}
          ({d.taskCount})
        </Text>
      )}
    </Box>
  );
}

function TaskNode({ node, s, d }: { node: TN; s: NodeStyle; d: TreeNodeData & { kind: 'task' } }) {
  const icon = d.active ? '▶' : statusIcon(d.status);
  const color = d.active ? C.live : statusColor(d.status);
  return (
    <Text backgroundColor={s.bg} color={s.fg || color} bold={!!s.bg || !!d.active}>
      {s.cur} {s.ind}
      {icon} {node.label}
    </Text>
  );
}

export default function TreeNodeView({ node, isSelected }: Props) {
  const s = getStyle(node, isSelected);
  const d = node.data;

  switch (d.kind) {
    case 'org':
      return <OrgNode s={s} d={d} />;
    case 'project':
      return <ProjectNode node={node} s={s} d={d} />;
    case 'board':
      return <BoardNode node={node} s={s} d={d} />;
    case 'column':
      return <ColumnNode node={node} s={s} d={d} />;
    case 'task':
      return <TaskNode node={node} s={s} d={d} />;
    default:
      return <Text color={C.dim}>{node.label}</Text>;
  }
}
