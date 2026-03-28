/**
 * TreeNode — renders a single node in the navigation tree.
 * Handles all node kinds: org, project, board, column, task.
 * 2050 palette: purple accent, cyan live, emerald success.
 */

import { Box, Text } from 'ink';
import type { TreeNode as TN } from '../tree.js';

/** 2050 color palette */
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

interface Props {
  node: TN;
  isSelected: boolean;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: render function with many node kinds — intentional branching
export default function TreeNodeView({ node, isSelected }: Props) {
  const n = node;
  const ind = '  '.repeat(n.depth);
  const arrow = n.children.length > 0 ? (n.expanded ? '▾' : '▸') : ' ';
  const cur = isSelected ? '▸' : ' ';
  const bg = isSelected ? C.accentBg : undefined;
  const fg = isSelected ? C.textBright : undefined;

  if (n.kind === 'org') {
    return (
      <Box>
        <Text backgroundColor={bg} color={fg || C.accent} bold>
          {cur} {arrow} ◆ {n.label}
        </Text>
      </Box>
    );
  }

  if (n.kind === 'project') {
    const isLive = !!(n.data as Record<string, unknown>).isLive;
    const taskCount = ((n.data as Record<string, unknown>).taskCount as number) || 0;
    return (
      <Box>
        <Text backgroundColor={bg} color={fg || C.text} bold={isSelected}>
          {cur} {ind}
          {arrow}{' '}
        </Text>
        <Text backgroundColor={bg} color={isSelected ? C.textBright : isLive ? C.success : C.dim}>
          {isLive ? '●' : '○'}{' '}
        </Text>
        <Text backgroundColor={bg} color={fg || C.text} bold={isSelected}>
          {n.label}
        </Text>
        {taskCount > 0 && (
          <Text backgroundColor={bg} color={fg || C.dim}>
            {' '}
            ({taskCount})
          </Text>
        )}
      </Box>
    );
  }

  if (n.kind === 'board') {
    const taskCount = ((n.data as Record<string, unknown>).taskCount as number) || 0;
    return (
      <Box>
        <Text backgroundColor={bg} color={fg || C.text} bold={isSelected}>
          {cur} {ind}
          {arrow} ⊞ {n.label}
        </Text>
        {taskCount > 0 && (
          <Text backgroundColor={bg} color={fg || C.dim}>
            {' '}
            ({taskCount})
          </Text>
        )}
      </Box>
    );
  }

  if (n.kind === 'column') {
    const count = ((n.data as Record<string, unknown>).taskCount as number) || 0;
    return (
      <Box>
        <Text backgroundColor={bg} color={fg || (count > 0 ? C.text : C.dim)} bold={isSelected}>
          {cur} {ind}
          {arrow} ┃ {n.label}
        </Text>
        {count > 0 && (
          <Text backgroundColor={bg} color={fg || C.warn}>
            {' '}
            ({count})
          </Text>
        )}
      </Box>
    );
  }

  if (n.kind === 'task') {
    const status = ((n.data as Record<string, unknown>).status as string) || '';
    const active = !!(n.data as Record<string, unknown>).active;
    const icon = active ? '▶' : statusIcon(status);
    const color = active ? C.live : statusColor(status);
    return (
      <Box>
        <Text backgroundColor={bg} color={fg || color} bold={isSelected || active}>
          {cur} {ind}
          {icon} {n.label}
        </Text>
      </Box>
    );
  }

  return <Text color={C.dim}>{n.label}</Text>;
}
