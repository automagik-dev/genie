/**
 * Nav-level tests — regression coverage for Enter on a stopped agent.
 *
 * The Enter handler picks one of three behaviors based on `wsAgentState`:
 *   - `stopped` / `error`              → spawn (G2 affordance)
 *   - `running`                        → attach to live tmux pane
 *   - `spawning`                       → no-op (already spawning)
 *
 * `handleEnterAgent` is exported with an injectable `spawn` parameter so tests
 * can verify the decision without forking a real `genie` subprocess.
 */

import { describe, expect, mock, test } from 'bun:test';
import type { TreeNode } from '../types.js';
import { handleEnterAgent } from './Nav.js';

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

describe('handleEnterAgent — Enter on stopped agent (G2)', () => {
  test('stopped agent: invokes spawn with the agent name', () => {
    const node = makeAgentNode({ wsAgentState: 'stopped' });
    const spawn = mock<(name: string) => void>(() => undefined);
    const onTmuxSelect = mock<(s: string, w?: number) => void>(() => undefined);

    handleEnterAgent(node, onTmuxSelect, spawn);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe('felipe');
    expect(onTmuxSelect).not.toHaveBeenCalled();
  });

  test('stopped scoped agent: spawn receives full name (e.g. "felipe/scout")', () => {
    const node = makeAgentNode({ id: 'agent:felipe/scout', wsAgentState: 'stopped' });
    const spawn = mock<(name: string) => void>(() => undefined);
    const onTmuxSelect = mock<(s: string, w?: number) => void>(() => undefined);

    handleEnterAgent(node, onTmuxSelect, spawn);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe('felipe/scout');
  });

  test('error agent: also invokes spawn (treated as restart)', () => {
    const node = makeAgentNode({ wsAgentState: 'error' });
    const spawn = mock<(name: string) => void>(() => undefined);
    const onTmuxSelect = mock<(s: string, w?: number) => void>(() => undefined);

    handleEnterAgent(node, onTmuxSelect, spawn);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(onTmuxSelect).not.toHaveBeenCalled();
  });

  test('running agent: attaches via onTmuxSessionSelect (no spawn)', () => {
    const node = makeAgentNode({
      wsAgentState: 'running',
      data: { sessionName: 'felipe', windowCount: 1, attachWindowIndex: 1, provider: null },
    });
    const spawn = mock<(name: string) => void>(() => undefined);
    const onTmuxSelect = mock<(s: string, w?: number) => void>(() => undefined);

    handleEnterAgent(node, onTmuxSelect, spawn);

    expect(spawn).not.toHaveBeenCalled();
    expect(onTmuxSelect).toHaveBeenCalledTimes(1);
    expect(onTmuxSelect.mock.calls[0][0]).toBe('felipe');
    expect(onTmuxSelect.mock.calls[0][1]).toBe(1);
  });

  test('spawning agent: no-op (neither spawn nor attach)', () => {
    const node = makeAgentNode({ wsAgentState: 'spawning' });
    const spawn = mock<(name: string) => void>(() => undefined);
    const onTmuxSelect = mock<(s: string, w?: number) => void>(() => undefined);

    handleEnterAgent(node, onTmuxSelect, spawn);

    expect(spawn).not.toHaveBeenCalled();
    expect(onTmuxSelect).not.toHaveBeenCalled();
  });
});
