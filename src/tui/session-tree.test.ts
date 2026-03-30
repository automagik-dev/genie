import { describe, expect, test } from 'bun:test';
import type { TmuxPane, TmuxSession, TmuxWindow } from './diagnostics.js';
import { buildSessionTree, buildWorkspaceTree, getSessionTarget } from './session-tree.js';
import type { TuiExecutor } from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    sessionName: 'test',
    windowIndex: 0,
    paneIndex: 0,
    paneId: '%0',
    pid: 1000,
    command: 'bash',
    title: 'bash',
    size: '80x24',
    isDead: false,
    ...overrides,
  };
}

function makeWindow(overrides: Partial<TmuxWindow> & { panes?: TmuxPane[] } = {}): TmuxWindow {
  return {
    sessionName: 'test',
    index: 0,
    name: 'bash',
    active: true,
    paneCount: 1,
    panes: [makePane()],
    ...overrides,
  };
}

function makeSession(name: string, windows?: TmuxWindow[]): TmuxSession {
  return {
    name,
    attached: false,
    windowCount: windows?.length ?? 1,
    created: Date.now(),
    windows: windows ?? [makeWindow({ sessionName: name })],
  };
}

function makeExecutor(overrides: Partial<TuiExecutor> = {}): TuiExecutor {
  return {
    id: 'exec-1',
    agentId: 'agent-1',
    agentName: null,
    provider: 'claude',
    transport: 'tmux',
    pid: 1000,
    tmuxSession: null,
    tmuxPaneId: null,
    state: 'working',
    metadata: {},
    startedAt: new Date().toISOString(),
    role: null,
    team: null,
    ...overrides,
  };
}

// ─── buildWorkspaceTree Tests ────────────────────────────────────────────────

describe('buildWorkspaceTree', () => {
  test('stopped agents show with wsAgentState=stopped', () => {
    const tree = buildWorkspaceTree({
      agentNames: ['sofia', 'vegapunk'],
      sessions: [],
      executors: [],
    });

    expect(tree).toHaveLength(2);
    expect(tree[0].type).toBe('agent');
    expect(tree[0].label).toBe('sofia');
    expect(tree[0].wsAgentState).toBe('stopped');
    expect(tree[0].children).toHaveLength(0);

    expect(tree[1].label).toBe('vegapunk');
    expect(tree[1].wsAgentState).toBe('stopped');
  });

  test('running agents show with wsAgentState=running and windows as children', () => {
    const win0 = makeWindow({ sessionName: 'sofia', index: 0, name: 'home' });
    const win1 = makeWindow({
      sessionName: 'sofia',
      index: 1,
      name: 'work',
      panes: [makePane({ sessionName: 'sofia', windowIndex: 1, paneId: '%1' })],
    });
    const sofiaSession = makeSession('sofia', [win0, win1]);

    const tree = buildWorkspaceTree({
      agentNames: ['sofia', 'vegapunk'],
      sessions: [sofiaSession],
      executors: [],
    });

    // sofia is running with window 1 as child (window 0 is the agent row itself)
    const sofia = tree.find((n) => n.label === 'sofia')!;
    expect(sofia.wsAgentState).toBe('running');
    expect(sofia.children).toHaveLength(1);
    expect(sofia.children[0].type).toBe('window');
    expect(sofia.children[0].label).toBe('work');

    // vegapunk is still stopped
    const vegapunk = tree.find((n) => n.label === 'vegapunk')!;
    expect(vegapunk.wsAgentState).toBe('stopped');
    expect(vegapunk.children).toHaveLength(0);
  });

  test('executor state reflected on agent nodes', () => {
    const sofiaSession = makeSession('sofia');
    const executor = makeExecutor({
      agentName: 'sofia',
      tmuxPaneId: '%0',
      state: 'working',
    });

    const tree = buildWorkspaceTree({
      agentNames: ['sofia'],
      sessions: [sofiaSession],
      executors: [executor],
    });

    const sofia = tree[0];
    expect(sofia.wsAgentState).toBe('running');
    expect(sofia.agentState).toBe('working');
  });

  test('error executor state bubbles to agent wsAgentState', () => {
    const sofiaSession = makeSession('sofia');
    const executor = makeExecutor({
      agentName: 'sofia',
      state: 'error',
    });

    const tree = buildWorkspaceTree({
      agentNames: ['sofia'],
      sessions: [sofiaSession],
      executors: [executor],
    });

    expect(tree[0].wsAgentState).toBe('error');
  });

  test('spawning executor state bubbles to agent wsAgentState', () => {
    const sofiaSession = makeSession('sofia');
    const executor = makeExecutor({
      agentName: 'sofia',
      state: 'spawning',
    });

    const tree = buildWorkspaceTree({
      agentNames: ['sofia'],
      sessions: [sofiaSession],
      executors: [executor],
    });

    expect(tree[0].wsAgentState).toBe('spawning');
  });

  test('permission executor state reflected on agentState', () => {
    const sofiaSession = makeSession('sofia');
    const executor = makeExecutor({
      agentName: 'sofia',
      tmuxPaneId: '%0',
      state: 'permission',
    });

    const tree = buildWorkspaceTree({
      agentNames: ['sofia'],
      sessions: [sofiaSession],
      executors: [executor],
    });

    expect(tree[0].agentState).toBe('permission');
  });

  test('filters out genie-tui session from tree', () => {
    const tuiSession = makeSession('genie-tui');

    const tree = buildWorkspaceTree({
      agentNames: ['sofia'],
      sessions: [tuiSession],
      executors: [],
    });

    // sofia should be stopped (genie-tui doesn't match)
    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe('sofia');
    expect(tree[0].wsAgentState).toBe('stopped');
  });

  test('orphan sessions (no matching agent) appended at end', () => {
    const orphanSession = makeSession('unknown-agent');

    const tree = buildWorkspaceTree({
      agentNames: ['sofia'],
      sessions: [orphanSession],
      executors: [],
    });

    expect(tree).toHaveLength(2);
    expect(tree[0].type).toBe('agent');
    expect(tree[0].label).toBe('sofia');
    expect(tree[1].type).toBe('session');
    expect(tree[1].label).toBe('unknown-agent');
  });

  test('multiple executors: working takes priority over idle', () => {
    const sofiaSession = makeSession('sofia');
    const exec1 = makeExecutor({ id: 'e1', agentName: 'sofia', state: 'idle', tmuxPaneId: '%0' });
    const exec2 = makeExecutor({ id: 'e2', agentName: 'sofia', state: 'working', tmuxPaneId: '%1' });

    const tree = buildWorkspaceTree({
      agentNames: ['sofia'],
      sessions: [sofiaSession],
      executors: [exec1, exec2],
    });

    expect(tree[0].agentState).toBe('working');
  });
});

// ─── buildSessionTree (legacy mode) Tests ────────────────────────────────────

describe('buildSessionTree', () => {
  test('builds tree from diagnostic snapshot', () => {
    const sessions = [makeSession('team-lead'), makeSession('engineer')];

    const tree = buildSessionTree({
      sessions,
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
      timestamp: Date.now(),
    });

    expect(tree).toHaveLength(2);
    expect(tree[0].type).toBe('session');
    expect(tree[0].label).toBe('team-lead');
  });

  test('filters out genie-tui session', () => {
    const sessions = [makeSession('genie-tui'), makeSession('real-session')];

    const tree = buildSessionTree({
      sessions,
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
      timestamp: Date.now(),
    });

    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe('real-session');
  });
});

// ─── getSessionTarget Tests ──────────────────────────────────────────────────

describe('getSessionTarget', () => {
  test('resolves agent node target', () => {
    const tree = buildWorkspaceTree({
      agentNames: ['sofia'],
      sessions: [makeSession('sofia')],
      executors: [],
    });

    const target = getSessionTarget(tree[0]);
    expect(target).toEqual({ sessionName: 'sofia' });
  });

  test('resolves window node target', () => {
    const win0 = makeWindow({ sessionName: 'sofia', index: 0 });
    const win1 = makeWindow({ sessionName: 'sofia', index: 1, name: 'work' });
    const session = makeSession('sofia', [win0, win1]);

    const tree = buildWorkspaceTree({
      agentNames: ['sofia'],
      sessions: [session],
      executors: [],
    });

    // Window child (index 1)
    const windowNode = tree[0].children[0];
    const target = getSessionTarget(windowNode);
    expect(target).toEqual({ sessionName: 'sofia', windowIndex: 1 });
  });

  test('returns null for unknown node type', () => {
    const fakeNode = {
      id: 'unknown:1',
      type: 'unknown' as any,
      label: 'test',
      depth: 0,
      expanded: false,
      children: [],
      data: {},
      activePanes: 0,
    };

    expect(getSessionTarget(fakeNode)).toBeNull();
  });
});
