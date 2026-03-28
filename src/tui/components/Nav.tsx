/**
 * Nav — scrollable navigation tree with keyboard controls.
 * Handles: ↑↓ navigate, →← expand/collapse, circular wrapping.
 * Emits: onProjectSelect when cursor moves to a project with a live session.
 */

import { Box, Text, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TreeNode as TN } from '../tree.js';
import { flattenTree } from '../tree.js';
import TreeNodeView from './TreeNode.js';

const C = {
  accent: '#a855f7',
  dim: '#525270',
  text: '#c4b5fd',
  live: '#22d3ee',
  success: '#34d399',
} as const;

interface Props {
  tree: TN[];
  onProjectSelect: (sessionName: string) => void;
  onExit: () => void;
}

export default function Nav({ tree, onProjectSelect, onExit }: Props) {
  const { stdout } = useStdout();
  const cols = stdout?.columns || 30;
  const rows = stdout?.rows || 40;

  const [cursor, setCursor] = useState(0);
  const [version, setVersion] = useState(0); // force re-render on tree mutation

  // biome-ignore lint/correctness/useExhaustiveDependencies: version triggers re-flatten on tree mutation
  const nodes = useMemo(() => flattenTree(tree), [tree, version]);
  const sel = nodes[cursor];

  const contentH = rows - 4; // header + separator + footer + separator
  const scrollOff = Math.max(0, cursor - contentH + 3);
  const visible = nodes.slice(scrollOff, scrollOff + contentH);
  const visCursor = cursor - scrollOff;

  // Auto-switch right pane when cursor changes to a project with session
  // biome-ignore lint/correctness/useExhaustiveDependencies: sel derived from cursor+nodes
  useEffect(() => {
    if (!sel) return;
    // Walk up to find nearest project/org with tmuxSession
    for (let i = cursor; i >= 0; i--) {
      const n = nodes[i];
      if (n && (n.kind === 'org' || n.kind === 'project')) {
        const session = (n.data as Record<string, unknown>).tmuxSession as string | null;
        if (session) {
          onProjectSelect(session);
          break;
        }
      }
    }
  }, [cursor, nodes, onProjectSelect]);

  const toggleExpand = useCallback((node: TN) => {
    node.expanded = !node.expanded;
    setVersion((v) => v + 1);
  }, []);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keyboard handler with many shortcuts
  // biome-ignore lint/correctness/useExhaustiveDependencies: sel derived from cursor+nodes, re-evaluated each render
  useInput((input, key) => {
    if (input === 'q') {
      onExit();
      return;
    }

    // Circular navigation
    if (key.upArrow) setCursor((c) => (c <= 0 ? nodes.length - 1 : c - 1));
    if (key.downArrow) setCursor((c) => (c >= nodes.length - 1 ? 0 : c + 1));

    // Expand/collapse
    if (key.rightArrow && sel?.children.length && !sel.expanded) {
      toggleExpand(sel);
    }
    if (key.leftArrow && sel?.expanded) {
      toggleExpand(sel);
    }

    // Enter: expand/collapse nodes with children
    if (key.return && sel?.children.length) {
      toggleExpand(sel);
    }

    // Tab: switch to right pane
    if (key.tab) {
      try {
        const { execSync } = require('node:child_process');
        execSync('tmux select-pane -t genie-tui:main.1');
      } catch {}
    }
  });

  const liveCount = nodes.filter((n) => n.kind === 'project' && !!(n.data as Record<string, unknown>).isLive).length;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* Header */}
      <Box justifyContent="space-between">
        <Box>
          <Text color={C.accent} bold>
            {' '}
            ◆
          </Text>
          <Text color={C.text} bold>
            {' '}
            genie
          </Text>
          <Text color={C.dim}> {liveCount}●</Text>
        </Box>
        <Text color={C.dim}>◀ ^B</Text>
      </Box>
      <Box>
        <Text color={C.dim}> {'─'.repeat(Math.max(1, cols - 2))}</Text>
      </Box>

      {/* Tree */}
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((n, i) => (
          <Box key={`${n.id}-${i}`}>
            <TreeNodeView node={n} isSelected={i === visCursor} />
          </Box>
        ))}
      </Box>

      {/* Footer */}
      <Box>
        <Text color={C.dim}> {'─'.repeat(Math.max(1, cols - 2))}</Text>
      </Box>
      <Box>
        <Text color={C.accent}> ↑↓</Text>
        <Text color={C.dim}> nav </Text>
        <Text color={C.accent}>⏎</Text>
        <Text color={C.dim}> open </Text>
        <Text color={C.accent}>^B</Text>
        <Text color={C.dim}> ◀▶</Text>
      </Box>
    </Box>
  );
}
