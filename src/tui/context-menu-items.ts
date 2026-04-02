/** State-aware context menu item builder for tree nodes. */

import type { MenuItem, TreeNode } from './types.js';

/** Build menu items based on node type and state. */
export function buildMenuItems(node: TreeNode): MenuItem[] {
  switch (node.type) {
    case 'agent':
      return buildAgentItems(node);
    case 'session':
      return buildSessionItems();
    case 'window':
      return buildWindowItems();
    case 'pane':
      return buildPaneItems(node);
    default:
      return [];
  }
}

function buildAgentItems(node: TreeNode): MenuItem[] {
  const ws = node.wsAgentState;

  if (ws === 'running') {
    return [
      { label: 'New agent', shortcut: 'N', action: 'agent-new-window' },
      { label: 'New window', shortcut: 'W', action: 'new-empty-window' },
      { label: 'Rename...', shortcut: 'R', action: 'rename-session', needsInput: true, separator: true },
      { label: 'Remove', shortcut: 'K', action: 'kill' },
    ];
  }

  return [{ label: 'Spawn agent', shortcut: 'S', action: 'spawn' }];
}

function buildSessionItems(): MenuItem[] {
  return [
    { label: 'New window', shortcut: 'N', action: 'new-window' },
    { label: 'Rename...', shortcut: 'R', action: 'rename-session', needsInput: true, separator: true },
    { label: 'Kill session', shortcut: 'K', action: 'kill-session' },
  ];
}

function buildWindowItems(): MenuItem[] {
  return [
    { label: 'New agent', shortcut: 'N', action: 'window-new-agent' },
    { label: 'New pane', shortcut: 'P', action: 'split-pane' },
    { label: 'Rename...', shortcut: 'R', action: 'rename-window', needsInput: true, separator: true },
    { label: 'Close window', shortcut: 'K', action: 'kill-window' },
  ];
}

function buildPaneItems(node: TreeNode): MenuItem[] {
  const isClaude = node.data.command === 'claude';
  const items: MenuItem[] = [];

  if (isClaude && !node.data.isDead) {
    items.push({ label: 'Clone agent', shortcut: 'C', action: 'clone-agent' });
  }

  items.push({ label: 'Rename...', shortcut: 'R', action: 'rename-pane', needsInput: true, separator: true });
  items.push({ label: 'Kill pane', shortcut: 'K', action: 'kill-pane' });

  return items;
}
