/**
 * TreeNode — renders a single node in the navigation tree.
 * Split into per-kind renderers to keep cognitive complexity low.
 */

import { Box, Text } from 'ink';
import type React from 'react';
import type { TreeNode as TN } from '../tree.js';

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

function getNodeStyle(node: TN, isSelected: boolean): NodeStyle {
  return {
    bg: isSelected ? C.accentBg : undefined,
    fg: isSelected ? C.textBright : undefined,
    cur: isSelected ? '▸' : ' ',
    ind: '  '.repeat(node.depth),
    arrow: node.children.length > 0 ? (node.expanded ? '▾' : '▸') : ' ',
  };
}

function getData<T>(node: TN, key: string): T {
  return (node.data as Record<string, unknown>)[key] as T;
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

function OrgNode({ node, style }: { node: TN; style: NodeStyle }) {
  return (
    <Box>
      <Text backgroundColor={style.bg} color={style.fg || C.accent} bold>
        {style.cur} {style.arrow} ◆ {node.label}
      </Text>
    </Box>
  );
}

function ProjectNode({ node, style }: { node: TN; style: NodeStyle }) {
  const isLive = getData<boolean>(node, 'isLive');
  const taskCount = getData<number>(node, 'taskCount') || 0;
  const liveColor = isLive ? C.success : C.dim;

  return (
    <Box>
      <Text backgroundColor={style.bg} color={style.fg || C.text} bold={!!style.bg}>
        {style.cur} {style.ind}
        {style.arrow}{' '}
      </Text>
      <Text backgroundColor={style.bg} color={style.bg ? C.textBright : liveColor}>
        {isLive ? '●' : '○'}{' '}
      </Text>
      <Text backgroundColor={style.bg} color={style.fg || C.text} bold={!!style.bg}>
        {node.label}
      </Text>
      {taskCount > 0 && (
        <Text backgroundColor={style.bg} color={style.fg || C.dim}>
          {' '}
          ({taskCount})
        </Text>
      )}
    </Box>
  );
}

function BoardNode({ node, style }: { node: TN; style: NodeStyle }) {
  const taskCount = getData<number>(node, 'taskCount') || 0;
  return (
    <Box>
      <Text backgroundColor={style.bg} color={style.fg || C.text} bold={!!style.bg}>
        {style.cur} {style.ind}
        {style.arrow} ⊞ {node.label}
      </Text>
      {taskCount > 0 && (
        <Text backgroundColor={style.bg} color={style.fg || C.dim}>
          {' '}
          ({taskCount})
        </Text>
      )}
    </Box>
  );
}

function ColumnNode({ node, style }: { node: TN; style: NodeStyle }) {
  const count = getData<number>(node, 'taskCount') || 0;
  return (
    <Box>
      <Text backgroundColor={style.bg} color={style.fg || (count > 0 ? C.text : C.dim)} bold={!!style.bg}>
        {style.cur} {style.ind}
        {style.arrow} ┃ {node.label}
      </Text>
      {count > 0 && (
        <Text backgroundColor={style.bg} color={style.fg || C.warn}>
          {' '}
          ({count})
        </Text>
      )}
    </Box>
  );
}

function TaskNode({ node, style }: { node: TN; style: NodeStyle }) {
  const status = getData<string>(node, 'status') || '';
  const active = getData<boolean>(node, 'active');
  const icon = active ? '▶' : statusIcon(status);
  const color = active ? C.live : statusColor(status);

  return (
    <Box>
      <Text backgroundColor={style.bg} color={style.fg || color} bold={!!style.bg || active}>
        {style.cur} {style.ind}
        {icon} {node.label}
      </Text>
    </Box>
  );
}

const renderers: Record<string, (props: { node: TN; style: NodeStyle }) => React.JSX.Element> = {
  org: OrgNode,
  project: ProjectNode,
  board: BoardNode,
  column: ColumnNode,
  task: TaskNode,
};

export default function TreeNodeView({ node, isSelected }: Props) {
  const style = getNodeStyle(node, isSelected);
  const Renderer = renderers[node.kind];
  if (Renderer) return <Renderer node={node} style={style} />;
  return <Text color={C.dim}>{node.label}</Text>;
}
