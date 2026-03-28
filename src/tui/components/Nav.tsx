/** @jsxImportSource @opentui/react */
/** Navigation tree wrapped in <scrollbox> with keyboard + mouse support */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';
import { palette } from '../theme.js';
import { flattenTree, toggleNode } from '../tree.js';
import type { TreeNode } from '../types.js';
import { TreeNodeRow } from './TreeNode.js';

interface NavProps {
  tree: TreeNode[];
  onTreeChange: (tree: TreeNode[]) => void;
  onProjectSelect: (projectId: string, tmuxSession: string | null) => void;
}

export function Nav({ tree, onTreeChange, onProjectSelect }: NavProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const flatNodes = useMemo(() => flattenTree(tree), [tree]);
  const visibleCount = flatNodes.length;

  const handleSelect = useCallback(
    (id: string) => {
      const idx = flatNodes.findIndex((n) => n.node.id === id);
      if (idx >= 0) setSelectedIndex(idx);
    },
    [flatNodes],
  );

  const handleToggle = useCallback(
    (id: string) => {
      onTreeChange(toggleNode(tree, id));
    },
    [tree, onTreeChange],
  );

  // Check if selected node is a project and notify parent
  const handleEnter = useCallback(() => {
    const current = flatNodes[selectedIndex]?.node;
    if (!current) return;

    if (current.type === 'project') {
      const proj = current.data as { id: string; tmuxSession: string | null };
      onProjectSelect(proj.id, proj.tmuxSession);
    } else if (current.children.length > 0) {
      handleToggle(current.id);
    }
  }, [flatNodes, selectedIndex, onProjectSelect, handleToggle]);

  useKeyboard((key) => {
    switch (key.name) {
      case 'up':
      case 'k':
        setSelectedIndex((i) => (i > 0 ? i - 1 : visibleCount - 1));
        break;
      case 'down':
      case 'j':
        setSelectedIndex((i) => (i < visibleCount - 1 ? i + 1 : 0));
        break;
      case 'right':
      case 'l': {
        const node = flatNodes[selectedIndex]?.node;
        if (node && node.children.length > 0 && !node.expanded) {
          handleToggle(node.id);
        }
        break;
      }
      case 'left':
      case 'h': {
        const node = flatNodes[selectedIndex]?.node;
        if (node?.expanded) {
          handleToggle(node.id);
        }
        break;
      }
      case 'enter':
      case 'return':
        handleEnter();
        break;
    }
  });

  return (
    <box flexDirection="column" width={30} height="100%" backgroundColor={palette.bg}>
      {/* Header */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLight}>
        <text>
          <span fg={palette.purple}>Genie</span>
          <span fg={palette.textDim}> {visibleCount} items</span>
        </text>
      </box>

      {/* Tree */}
      <scrollbox
        focused
        height="100%"
        style={{
          scrollbarOptions: {
            showArrows: false,
            trackOptions: {
              foregroundColor: palette.scrollThumb,
              backgroundColor: palette.scrollTrack,
            },
          },
        }}
      >
        {flatNodes.map((flat, i) => (
          <TreeNodeRow
            key={flat.node.id}
            node={flat.node}
            selected={i === selectedIndex}
            onSelect={handleSelect}
            onToggle={handleToggle}
          />
        ))}
      </scrollbox>

      {/* Footer with shortcuts */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLight}>
        <text>
          <span fg={palette.textMuted}>Tab:pane ^B:toggle ^T:tab ^\\:quit</span>
        </text>
      </box>
    </box>
  );
}
