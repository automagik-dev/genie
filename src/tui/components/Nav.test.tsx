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
import type { TmuxSession } from '../diagnostics.js';
import { buildWorkspaceTree } from '../session-tree.js';
import type { TreeNode, TuiExecutor } from '../types.js';
import { computeNavCounts, handleEnterAgent } from './Nav.js';

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

  test('running canonical agent inside a team session attaches instead of spawning', () => {
    const teamSession: TmuxSession = {
      name: 'genie-bernardo',
      attached: false,
      windowCount: 2,
      created: 0,
      windows: [
        {
          sessionName: 'genie-bernardo',
          index: 0,
          name: 'zsh',
          active: false,
          paneCount: 1,
          panes: [],
        },
        {
          sessionName: 'genie-bernardo',
          index: 1,
          name: 'genie',
          active: true,
          paneCount: 1,
          panes: [
            {
              sessionName: 'genie-bernardo',
              windowIndex: 1,
              paneIndex: 0,
              paneId: '%825',
              pid: 123,
              command: 'claude',
              processCommand: '/home/genie/.local/bin/claude',
              title: 'claude',
              size: '120x40',
              isDead: false,
            },
          ],
        },
      ],
    };
    const executor: TuiExecutor = {
      id: 'exec-genie',
      agentId: 'agent-genie',
      agentName: 'genie',
      provider: 'claude',
      transport: 'tmux',
      pid: 123,
      tmuxSession: 'genie-bernardo',
      tmuxPaneId: '%825',
      state: 'idle',
      metadata: {},
      startedAt: new Date(0).toISOString(),
      role: 'genie',
      team: 'genie-bernardo',
    };
    const [node] = buildWorkspaceTree({
      agentNames: ['genie'],
      sessions: [teamSession],
      executors: [executor],
    });
    const spawn = mock<(name: string) => void>(() => undefined);
    const onTmuxSelect = mock<(s: string, w?: number) => void>(() => undefined);

    handleEnterAgent(node, onTmuxSelect, spawn);

    expect(spawn).not.toHaveBeenCalled();
    expect(onTmuxSelect).toHaveBeenCalledTimes(1);
    expect(onTmuxSelect.mock.calls[0][0]).toBe('genie-bernardo');
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

// ─── computeNavCounts — sidebar header counter (regression coverage) ─────────
//
// The "Agents 0/0" report on .12 surfaced a coverage gap: nothing in the test
// suite exercised the counter. The shallow Array.filter over top-level nodes
// also undercounted sub-agents, so a workspace with `genie` + `genie/qa`
// surfaced as "Agents 0/1" no matter how many subs the user had.

const realisticAgentNames = [
  'aegis',
  'brain',
  'felipe',
  'felipe/notes',
  'felipe/scout',
  'genie',
  'genie/qa',
  'genie/devrel',
  'genie/engineer',
  'genie-docs',
  'genie-docs/reviewer',
];

describe('computeNavCounts', () => {
  test('workspace mode counts canonical AND sub-agent nodes', () => {
    const tree = buildWorkspaceTree({
      agentNames: realisticAgentNames,
      sessions: [],
      executors: [],
    });
    const { agentCount, runningCount } = computeNavCounts('/ws', tree, null);
    expect(agentCount).toBe(realisticAgentNames.length);
    expect(runningCount).toBe(0);
  });

  test('running sub-agent contributes to runningCount', () => {
    const tree = buildWorkspaceTree({
      agentNames: ['genie', 'genie/qa'],
      sessions: [],
      executors: [],
    });
    // Force the sub-agent to running for the test — exercises recursive walk.
    tree[0].children[0].wsAgentState = 'running';
    const { agentCount, runningCount } = computeNavCounts('/ws', tree, null);
    expect(agentCount).toBe(2);
    expect(runningCount).toBe(1);
  });

  test('workspace mode with empty tree falls back to live tmux count', () => {
    // Reproduces the .12 "0/0" report: workspace mode active but scanAgents
    // returned [] (stale workspaceRoot, transient FS error). Without the
    // fallback the user saw "Agents 0/0" while tmux had live panes.
    const diagnostics = {
      sessions: [
        {
          name: 'felipe',
          attached: false,
          windowCount: 1,
          created: 0,
          windows: [
            {
              sessionName: 'felipe',
              index: 0,
              name: 'work',
              active: true,
              paneCount: 2,
              panes: [
                {
                  sessionName: 'felipe',
                  windowIndex: 0,
                  paneIndex: 0,
                  paneId: '%0',
                  pid: 1,
                  command: 'claude',
                  title: 'claude',
                  size: '80x24',
                  isDead: false,
                },
                {
                  sessionName: 'felipe',
                  windowIndex: 0,
                  paneIndex: 1,
                  paneId: '%1',
                  pid: 2,
                  command: 'bash',
                  title: 'bash',
                  size: '80x24',
                  isDead: false,
                },
              ],
            },
          ],
        },
      ],
      executors: [],
      assignments: [],
      gaps: {
        deadPidExecutors: [],
        orphanPanes: [],
        linkedCount: 0,
        totalExecutors: 0,
        totalClaudePanes: 0,
        deadPaneCount: 0,
      },
      workStates: new Map(),
      observability: new Map(),
      alertCount: 0,
      timestamp: 0,
    } as Parameters<typeof computeNavCounts>[2];

    const { agentCount, runningCount } = computeNavCounts('/stale-ws', [], diagnostics);
    expect(agentCount).toBe(1);
    expect(runningCount).toBe(2);
  });

  test('legacy mode (no workspaceRoot) reports session/pane totals', () => {
    const diagnostics = {
      sessions: [
        {
          name: 'a',
          attached: false,
          windowCount: 1,
          created: 0,
          windows: [
            {
              sessionName: 'a',
              index: 0,
              name: 'w',
              active: true,
              paneCount: 1,
              panes: [
                {
                  sessionName: 'a',
                  windowIndex: 0,
                  paneIndex: 0,
                  paneId: '%0',
                  pid: 1,
                  command: 'bash',
                  title: 'bash',
                  size: '80x24',
                  isDead: false,
                },
              ],
            },
          ],
        },
      ],
      executors: [],
      assignments: [],
      gaps: {
        deadPidExecutors: [],
        orphanPanes: [],
        linkedCount: 0,
        totalExecutors: 0,
        totalClaudePanes: 0,
        deadPaneCount: 0,
      },
      workStates: new Map(),
      observability: new Map(),
      alertCount: 0,
      timestamp: 0,
    } as Parameters<typeof computeNavCounts>[2];

    const { agentCount, runningCount } = computeNavCounts(undefined, [], diagnostics);
    expect(agentCount).toBe(1);
    expect(runningCount).toBe(1);
  });

  test('null diagnostics + empty tree returns 0/0 (initial render)', () => {
    expect(computeNavCounts(undefined, [], null)).toEqual({ agentCount: 0, runningCount: 0 });
  });
});
