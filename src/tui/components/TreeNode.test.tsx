/** @jsxImportSource @opentui/react */
/**
 * Tests for TreeNode helpers — focused on the canonical-visibility wish
 * (group 2: `[Enter to start]` affordance suffix on stopped agent rows).
 *
 * Helpers (`getAgentSuffix`, etc.) are exported only for tests; production
 * code uses them via the rendered `<TreeNodeRow />`.
 */

import { describe, expect, test } from 'bun:test';
import { palette } from '../theme.js';
import type { TreeNode } from '../types.js';
import { getAgentColor, getAgentIcon, getAgentSuffix } from './TreeNode.js';

function makeAgentNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: 'agent:felipe',
    type: 'agent',
    label: 'felipe',
    depth: 0,
    expanded: false,
    children: [],
    data: { sessionName: 'felipe', windowCount: 0, attachWindowIndex: undefined, provider: null },
    activePanes: 0,
    wsAgentState: 'stopped',
    ...overrides,
  };
}

describe('getAgentSuffix — stopped affordance (G2)', () => {
  test('stopped agent gets " [Enter to start]" suffix', () => {
    const node = makeAgentNode({ wsAgentState: 'stopped' });
    expect(getAgentSuffix(node)).toBe(' [Enter to start]');
  });

  test('running agent with windowCount > 1 still gets "(N windows)" suffix', () => {
    const node = makeAgentNode({
      wsAgentState: 'running',
      data: { sessionName: 'felipe', windowCount: 3, attachWindowIndex: undefined, provider: null },
    });
    expect(getAgentSuffix(node)).toBe(' (3 windows)');
  });

  test('running agent with windowCount === 1 still gets "(1 window)" suffix', () => {
    const node = makeAgentNode({
      wsAgentState: 'running',
      data: { sessionName: 'felipe', windowCount: 1, attachWindowIndex: undefined, provider: null },
    });
    expect(getAgentSuffix(node)).toBe(' (1 window)');
  });

  test('running agent with windowCount === 0 returns empty suffix', () => {
    const node = makeAgentNode({
      wsAgentState: 'running',
      data: { sessionName: 'felipe', windowCount: 0, attachWindowIndex: undefined, provider: null },
    });
    expect(getAgentSuffix(node)).toBe('');
  });

  test('workState "stuck" precedence: takes priority over wsAgentState "stopped"', () => {
    const node = makeAgentNode({ wsAgentState: 'stopped', workState: 'stuck' });
    expect(getAgentSuffix(node)).toBe(' [stuck — press R to retry]');
  });

  test('workState "paused" precedence: takes priority over wsAgentState "stopped"', () => {
    const node = makeAgentNode({ wsAgentState: 'stopped', workState: 'paused' });
    expect(getAgentSuffix(node)).toBe(' [paused — auto-resume off]');
  });

  test('workState "done" precedence: takes priority over wsAgentState "stopped"', () => {
    const node = makeAgentNode({ wsAgentState: 'stopped', workState: 'done' });
    expect(getAgentSuffix(node)).toBe(' [done]');
  });

  test('spawning agent with no live panes still gets stuck-spawn hint (precedence over stopped)', () => {
    const node = makeAgentNode({ wsAgentState: 'spawning', activePanes: 0 });
    expect(getAgentSuffix(node)).toBe(' [stuck — press R to retry]');
  });

  test('spawning agent with live panes returns empty (no stuck hint, no stopped hint)', () => {
    const node = makeAgentNode({
      wsAgentState: 'spawning',
      activePanes: 1,
      data: { sessionName: 'felipe', windowCount: 0, attachWindowIndex: undefined, provider: null },
    });
    expect(getAgentSuffix(node)).toBe('');
  });

  test('error agent returns empty suffix (no [Enter to start] for error)', () => {
    const node = makeAgentNode({ wsAgentState: 'error' });
    expect(getAgentSuffix(node)).toBe('');
  });
});

describe('getAgentColor — wsAgentState (G1 visibility)', () => {
  test('stopped → palette.text (legible — was palette.textDim)', () => {
    const node = makeAgentNode({ wsAgentState: 'stopped' });
    expect(getAgentColor(node)).toBe(palette.text);
    expect(getAgentColor(node)).not.toBe(palette.textDim);
  });

  test('running → palette.success (regression)', () => {
    const node = makeAgentNode({ wsAgentState: 'running' });
    expect(getAgentColor(node)).toBe(palette.success);
  });

  test('error → palette.error (regression)', () => {
    const node = makeAgentNode({ wsAgentState: 'error' });
    expect(getAgentColor(node)).toBe(palette.error);
  });

  test('spawning → palette.warning (regression)', () => {
    const node = makeAgentNode({ wsAgentState: 'spawning' });
    expect(getAgentColor(node)).toBe(palette.warning);
  });

  test('workState in_flight overrides wsAgentState', () => {
    const node = makeAgentNode({ wsAgentState: 'stopped', workState: 'in_flight' });
    expect(getAgentColor(node)).toBe(palette.accentBright);
  });

  test('workState stuck overrides wsAgentState', () => {
    const node = makeAgentNode({ wsAgentState: 'running', workState: 'stuck' });
    expect(getAgentColor(node)).toBe(palette.error);
  });
});

describe('getAgentIcon — wsAgentState (G1 visibility)', () => {
  test('stopped → ◌ (U+25CC dotted circle, signals spawnable; was ○ U+25CB)', () => {
    const node = makeAgentNode({ wsAgentState: 'stopped' });
    expect(getAgentIcon(node)).toBe('◌');
    expect(getAgentIcon(node)).not.toBe('○');
  });

  test('running → ● (regression)', () => {
    const node = makeAgentNode({ wsAgentState: 'running' });
    expect(getAgentIcon(node)).toBe('●');
  });

  test('error → ⊘ (regression)', () => {
    const node = makeAgentNode({ wsAgentState: 'error' });
    expect(getAgentIcon(node)).toBe('⊘');
  });

  test('spawning → ⏳ (regression)', () => {
    const node = makeAgentNode({ wsAgentState: 'spawning' });
    expect(getAgentIcon(node)).toBe('⌛');
  });

  test('workState in_flight → ◆ (overrides wsAgentState)', () => {
    const node = makeAgentNode({ wsAgentState: 'stopped', workState: 'in_flight' });
    expect(getAgentIcon(node)).toBe('◆');
  });

  test('workState stuck → ✘ (overrides wsAgentState)', () => {
    const node = makeAgentNode({ wsAgentState: 'running', workState: 'stuck' });
    expect(getAgentIcon(node)).toBe('✘');
  });
});
