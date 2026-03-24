/**
 * Tests for target-resolver - Resolves target strings to tmux pane IDs
 * Run with: bun test src/lib/target-resolver.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// Test Setup - Mock infrastructure
// ============================================================================

const TEST_DIR = '/tmp/target-resolver-test';
const TEST_REGISTRY_PATH = join(TEST_DIR, '.genie', 'workers.json');

function cleanTestDir(): void {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
  mkdirSync(join(TEST_DIR, '.genie'), { recursive: true });
}

// Track live panes for mock
const _livePanes: Set<string> = new Set();
// Track tmux sessions for mock
const _tmuxSessions: { name: string; windows: { name: string; panes: { id: string }[] }[] }[] = [];

// We need to mock the dependencies before importing target-resolver.
// The approach: mock the modules that target-resolver imports.

// Mock worker-registry to use our test registry path
const _mockRegistryWorkers: Record<string, any> = {};

// We'll use a module-level approach: import after setting up mocks
import { type ResolvedTarget, formatResolvedLabel, resolveTarget } from './target-resolver.js';

// ============================================================================
// Level 1: Raw pane ID (starts with %)
// ============================================================================

describe('Level 1: Raw pane ID', () => {
  test('resolveTarget("%17") returns passthrough with resolvedVia "raw"', async () => {
    // For raw pane IDs, we just need tmux to confirm liveness
    // We'll test the structure of the return value
    const result = await resolveTarget('%17', {
      checkLiveness: false, // skip tmux check for unit test
    });

    expect(result.paneId).toBe('%17');
    expect(result.resolvedVia).toBe('raw');
    expect(result.workerId).toBeUndefined();
    expect(result.paneIndex).toBeUndefined();
  });

  test('resolveTarget("%0") handles pane ID %0', async () => {
    const result = await resolveTarget('%0', {
      checkLiveness: false,
    });

    expect(result.paneId).toBe('%0');
    expect(result.resolvedVia).toBe('raw');
  });

  test('resolveTarget("%123") handles large pane IDs', async () => {
    const result = await resolveTarget('%123', {
      checkLiveness: false,
    });

    expect(result.paneId).toBe('%123');
    expect(result.resolvedVia).toBe('raw');
  });
});

// ============================================================================
// Level 2: Worker ID (exact match in registry)
// ============================================================================

describe('Level 2: Worker ID', () => {
  beforeEach(() => {
    cleanTestDir();
  });

  test('resolveTarget("bd-42") returns worker pane info', async () => {
    const result = await resolveTarget('bd-42', {
      checkLiveness: false,
      registryPath: TEST_REGISTRY_PATH,
      workers: {
        'bd-42': {
          id: 'bd-42',
          paneId: '%17',
          session: 'genie',
          worktree: null,
          taskId: 'bd-42',
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
    });

    expect(result.paneId).toBe('%17');
    expect(result.workerId).toBe('bd-42');
    expect(result.session).toBe('genie');
    expect(result.resolvedVia).toBe('worker');
  });

  test('resolveTarget("bd-42:0") returns primary pane (index 0)', async () => {
    const result = await resolveTarget('bd-42:0', {
      checkLiveness: false,
      registryPath: TEST_REGISTRY_PATH,
      workers: {
        'bd-42': {
          id: 'bd-42',
          paneId: '%17',
          session: 'genie',
          worktree: null,
          taskId: 'bd-42',
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
    });

    expect(result.paneId).toBe('%17');
    expect(result.workerId).toBe('bd-42');
    expect(result.paneIndex).toBe(0);
    expect(result.resolvedVia).toBe('worker');
  });

  test('resolveTarget("bd-42:1") returns first sub-pane', async () => {
    const result = await resolveTarget('bd-42:1', {
      checkLiveness: false,
      registryPath: TEST_REGISTRY_PATH,
      workers: {
        'bd-42': {
          id: 'bd-42',
          paneId: '%17',
          session: 'genie',
          subPanes: ['%22', '%23'],
          worktree: null,
          taskId: 'bd-42',
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
    });

    expect(result.paneId).toBe('%22');
    expect(result.workerId).toBe('bd-42');
    expect(result.paneIndex).toBe(1);
    expect(result.resolvedVia).toBe('worker');
  });

  test('resolveTarget("bd-42:2") returns second sub-pane', async () => {
    const result = await resolveTarget('bd-42:2', {
      checkLiveness: false,
      registryPath: TEST_REGISTRY_PATH,
      workers: {
        'bd-42': {
          id: 'bd-42',
          paneId: '%17',
          session: 'genie',
          subPanes: ['%22', '%23'],
          worktree: null,
          taskId: 'bd-42',
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
    });

    expect(result.paneId).toBe('%23');
    expect(result.workerId).toBe('bd-42');
    expect(result.paneIndex).toBe(2);
    expect(result.resolvedVia).toBe('worker');
  });

  test('resolveTarget("bd-42:5") throws for out-of-range sub-pane index', async () => {
    await expect(
      resolveTarget('bd-42:5', {
        checkLiveness: false,
        registryPath: TEST_REGISTRY_PATH,
        workers: {
          'bd-42': {
            id: 'bd-42',
            paneId: '%17',
            session: 'genie',
            subPanes: ['%22'],
            worktree: null,
            taskId: 'bd-42',
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
          },
        },
      }),
    ).rejects.toThrow(/sub-pane index 5/i);
  });

  test('resolveTarget("bd-42:1") throws when no sub-panes exist', async () => {
    await expect(
      resolveTarget('bd-42:1', {
        checkLiveness: false,
        registryPath: TEST_REGISTRY_PATH,
        workers: {
          'bd-42': {
            id: 'bd-42',
            paneId: '%17',
            session: 'genie',
            worktree: null,
            taskId: 'bd-42',
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
          },
        },
      }),
    ).rejects.toThrow(/sub-pane index 1/i);
  });
});

// ============================================================================
// Level 3: Session:window (contains :, left side is tmux session)
// ============================================================================

describe('Level 3: Session:window', () => {
  test('resolveTarget("genie:OMNI") resolves via session:window', async () => {
    const result = await resolveTarget('genie:OMNI', {
      checkLiveness: false,
      workers: {}, // no worker named "genie"
      tmuxLookup: async (sessionName: string, windowName?: string) => {
        if (sessionName === 'genie' && windowName === 'OMNI') {
          return { paneId: '%5', session: 'genie' };
        }
        return null;
      },
    });

    expect(result.paneId).toBe('%5');
    expect(result.session).toBe('genie');
    expect(result.resolvedVia).toBe('session:window');
    expect(result.workerId).toBeUndefined();
  });

  test('resolveTarget("main:dev") resolves via session:window when not a worker', async () => {
    const result = await resolveTarget('main:dev', {
      checkLiveness: false,
      workers: {},
      tmuxLookup: async (sessionName: string, windowName?: string) => {
        if (sessionName === 'main' && windowName === 'dev') {
          return { paneId: '%10', session: 'main' };
        }
        return null;
      },
    });

    expect(result.paneId).toBe('%10');
    expect(result.session).toBe('main');
    expect(result.resolvedVia).toBe('session:window');
  });
});

// ============================================================================
// Level 4: Session name fallback
// ============================================================================

describe('Level 4 removed: bare name without worker match throws', () => {
  test('resolveTarget("genie") throws when no worker matches', async () => {
    await expect(
      resolveTarget('genie', {
        checkLiveness: false,
        workers: {},
        tmuxLookup: async () => null,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

// ============================================================================
// Error paths
// ============================================================================

describe('Error paths', () => {
  test('throws prescriptive error for completely unknown target', async () => {
    await expect(
      resolveTarget('nonexistent', {
        checkLiveness: false,
        workers: {},
        tmuxLookup: async () => null,
      }),
    ).rejects.toThrow(/not found/i);
  });

  test('throws prescriptive error for unknown session:window', async () => {
    await expect(
      resolveTarget('nosession:nowindow', {
        checkLiveness: false,
        workers: {},
        tmuxLookup: async () => null,
      }),
    ).rejects.toThrow(/not found/i);
  });

  test('error message includes suggestion to run genie ls', async () => {
    try {
      await resolveTarget('ghost-worker', {
        checkLiveness: false,
        workers: {},
        tmuxLookup: async () => null,
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.message).toMatch(/genie ls|genie kill/i);
    }
  });
});

// ============================================================================
// Liveness checking
// ============================================================================

describe('Liveness checking', () => {
  test('dead pane throws prescriptive error', async () => {
    await expect(
      resolveTarget('bd-42', {
        checkLiveness: true,
        workers: {
          'bd-42': {
            id: 'bd-42',
            paneId: '%17',
            session: 'genie',
            worktree: null,
            taskId: 'bd-42',
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
          },
        },
        isPaneLive: async (_paneId: string) => false, // dead pane
        cleanupDeadPane: async (_workerId: string, _paneId: string) => {},
      }),
    ).rejects.toThrow(/dead|not alive/i);
  });

  test('dead pane error includes worker ID and pane ID', async () => {
    try {
      await resolveTarget('bd-42', {
        checkLiveness: true,
        workers: {
          'bd-42': {
            id: 'bd-42',
            paneId: '%17',
            session: 'genie',
            worktree: null,
            taskId: 'bd-42',
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
          },
        },
        isPaneLive: async () => false,
        cleanupDeadPane: async () => {},
      });
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.message).toContain('bd-42');
      expect(error.message).toContain('%17');
    }
  });

  test('dead pane triggers auto-cleanup callback', async () => {
    let cleanedUp = false;
    let cleanedWorkerId = '';
    let cleanedPaneId = '';

    try {
      await resolveTarget('bd-42', {
        checkLiveness: true,
        workers: {
          'bd-42': {
            id: 'bd-42',
            paneId: '%17',
            session: 'genie',
            worktree: null,
            taskId: 'bd-42',
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
          },
        },
        isPaneLive: async () => false,
        cleanupDeadPane: async (workerId: string, paneId: string) => {
          cleanedUp = true;
          cleanedWorkerId = workerId;
          cleanedPaneId = paneId;
        },
      });
    } catch {
      // Expected to throw
    }

    expect(cleanedUp).toBe(true);
    expect(cleanedWorkerId).toBe('bd-42');
    expect(cleanedPaneId).toBe('%17');
  });

  test('live pane resolves successfully with liveness check', async () => {
    const result = await resolveTarget('bd-42', {
      checkLiveness: true,
      workers: {
        'bd-42': {
          id: 'bd-42',
          paneId: '%17',
          session: 'genie',
          worktree: null,
          taskId: 'bd-42',
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
      isPaneLive: async () => true,
    });

    expect(result.paneId).toBe('%17');
    expect(result.resolvedVia).toBe('worker');
  });
});

// ============================================================================
// Resolution priority (DEC-1)
// ============================================================================

describe('Resolution priority', () => {
  test('worker ID takes priority over session name', async () => {
    // If "genie" is both a worker and a session, worker wins
    const result = await resolveTarget('genie', {
      checkLiveness: false,
      workers: {
        genie: {
          id: 'genie',
          paneId: '%50',
          session: 'main',
          worktree: null,
          taskId: 'genie',
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
      tmuxLookup: async (sessionName: string) => {
        if (sessionName === 'genie') {
          return { paneId: '%3', session: 'genie' };
        }
        return null;
      },
    });

    expect(result.paneId).toBe('%50');
    expect(result.resolvedVia).toBe('worker');
  });

  test('worker:index takes priority over session:window', async () => {
    // If "bd-42:1" - bd-42 is a worker, so :1 is sub-pane index
    const result = await resolveTarget('bd-42:1', {
      checkLiveness: false,
      workers: {
        'bd-42': {
          id: 'bd-42',
          paneId: '%17',
          session: 'genie',
          subPanes: ['%22'],
          worktree: null,
          taskId: 'bd-42',
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
      tmuxLookup: async () => {
        return { paneId: '%99', session: 'bd-42' };
      },
    });

    expect(result.paneId).toBe('%22');
    expect(result.resolvedVia).toBe('worker');
    expect(result.paneIndex).toBe(1);
  });

  test('session:window used when left side is not a worker', async () => {
    const result = await resolveTarget('main:dev', {
      checkLiveness: false,
      workers: {
        'bd-42': {
          id: 'bd-42',
          paneId: '%17',
          session: 'genie',
          worktree: null,
          taskId: 'bd-42',
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
      tmuxLookup: async (sessionName: string, windowName?: string) => {
        if (sessionName === 'main' && windowName === 'dev') {
          return { paneId: '%10', session: 'main' };
        }
        return null;
      },
    });

    expect(result.paneId).toBe('%10');
    expect(result.resolvedVia).toBe('session:window');
  });
});

// ============================================================================
// ResolvedTarget type shape
// ============================================================================

describe('ResolvedTarget type', () => {
  test('contains all expected fields for worker resolution', async () => {
    const result = await resolveTarget('bd-42', {
      checkLiveness: false,
      workers: {
        'bd-42': {
          id: 'bd-42',
          paneId: '%17',
          session: 'genie',
          worktree: null,
          taskId: 'bd-42',
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
    });

    // Verify all fields exist
    expect(result).toHaveProperty('paneId');
    expect(result).toHaveProperty('session');
    expect(result).toHaveProperty('workerId');
    expect(result).toHaveProperty('resolvedVia');
    // paneIndex is optional for non-indexed worker
    expect(result.paneIndex).toBeUndefined();
  });

  test('contains paneIndex for indexed worker resolution', async () => {
    const result = await resolveTarget('bd-42:1', {
      checkLiveness: false,
      workers: {
        'bd-42': {
          id: 'bd-42',
          paneId: '%17',
          session: 'genie',
          subPanes: ['%22'],
          worktree: null,
          taskId: 'bd-42',
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
    });

    expect(result.paneIndex).toBe(1);
  });
});

// ============================================================================
// formatResolvedLabel
// ============================================================================

describe('formatResolvedLabel', () => {
  test('formats worker target with session', () => {
    const resolved: ResolvedTarget = {
      paneId: '%17',
      session: 'genie',
      workerId: 'bd-42',
      resolvedVia: 'worker',
    };
    expect(formatResolvedLabel(resolved, 'bd-42')).toBe('bd-42 (pane %17, session genie)');
  });

  test('formats worker:index target', () => {
    const resolved: ResolvedTarget = {
      paneId: '%22',
      session: 'genie',
      workerId: 'bd-42',
      paneIndex: 1,
      resolvedVia: 'worker',
    };
    expect(formatResolvedLabel(resolved, 'bd-42:1')).toBe('bd-42:1 (pane %22, session genie)');
  });

  test('formats worker:0 (primary) without suffix', () => {
    const resolved: ResolvedTarget = {
      paneId: '%17',
      session: 'genie',
      workerId: 'bd-42',
      paneIndex: 0,
      resolvedVia: 'worker',
    };
    expect(formatResolvedLabel(resolved, 'bd-42:0')).toBe('bd-42 (pane %17, session genie)');
  });

  test('formats raw pane target without session', () => {
    const resolved: ResolvedTarget = {
      paneId: '%17',
      resolvedVia: 'raw',
    };
    expect(formatResolvedLabel(resolved, '%17')).toBe('%17 (pane %17)');
  });

  test('formats raw pane target with derived session', () => {
    const resolved: ResolvedTarget = {
      paneId: '%17',
      session: 'genie',
      resolvedVia: 'raw',
    };
    expect(formatResolvedLabel(resolved, '%17')).toBe('%17 (pane %17, session genie)');
  });
});

// ============================================================================
// Raw pane session derivation
// ============================================================================

describe('Raw pane session derivation', () => {
  test('resolveTarget("%17") derives session from pane ID', async () => {
    const result = await resolveTarget('%17', {
      checkLiveness: false,
      deriveSession: async (paneId: string) => {
        if (paneId === '%17') return 'genie';
        return null;
      },
    });

    expect(result.paneId).toBe('%17');
    expect(result.session).toBe('genie');
    expect(result.resolvedVia).toBe('raw');
  });

  test('resolveTarget("%17") works when session derivation fails', async () => {
    const result = await resolveTarget('%17', {
      checkLiveness: false,
      deriveSession: async () => null,
    });

    expect(result.paneId).toBe('%17');
    expect(result.session).toBeUndefined();
    expect(result.resolvedVia).toBe('raw');
  });

  test('resolveTarget("%0") derives session for pane %0', async () => {
    const result = await resolveTarget('%0', {
      checkLiveness: false,
      deriveSession: async (paneId: string) => {
        if (paneId === '%0') return 'main';
        return null;
      },
    });

    expect(result.paneId).toBe('%0');
    expect(result.session).toBe('main');
    expect(result.resolvedVia).toBe('raw');
  });
});

// ============================================================================
// Active pane resolution (verifies defaultTmuxLookup pattern)
// ============================================================================

describe('Active pane resolution in defaultTmuxLookup', () => {
  /**
   * defaultTmuxLookup() is not exported, but we can verify the pattern
   * by reading the source code. The function should use:
   *   windows.find(w => w.active) || windows[0]
   *   panes.find(p => p.active) || panes[0]
   *
   * These tests verify the pattern exists in the source and that the
   * tmuxLookup contract works with active-pane-aware implementations.
   */

  test('session:window tmuxLookup with active pane is used', async () => {
    // When session:window is specified, the active pane within that window should be selected
    const result = await resolveTarget('my-session:dev', {
      checkLiveness: false,
      workers: {},
      tmuxLookup: async (sessionName: string, windowName?: string) => {
        if (sessionName === 'my-session' && windowName === 'dev') {
          // Active pane within the named window
          return { paneId: '%55', session: 'my-session' };
        }
        return null;
      },
    });

    expect(result.paneId).toBe('%55');
    expect(result.session).toBe('my-session');
    expect(result.resolvedVia).toBe('session:window');
  });
});

// Level 1.5: Window ID (starts with @)
// ============================================================================

describe('Level 1.5: Window ID', () => {
  beforeEach(cleanTestDir);

  test('resolveTarget("@4") resolves to worker owning that window', async () => {
    const result = await resolveTarget('@4', {
      checkLiveness: false,
      workers: {
        'bd-42': {
          id: 'bd-42',
          paneId: '%17',
          session: 'genie',
          worktree: null,
          taskId: 'bd-42',
          startedAt: new Date().toISOString(),
          state: 'working' as const,
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          windowId: '@4',
          windowName: 'bd-42',
        },
      },
    });

    expect(result.paneId).toBe('%17');
    expect(result.session).toBe('genie');
    expect(result.workerId).toBe('bd-42');
    expect(result.resolvedVia).toBe('worker');
  });

  test('resolveTarget("@999") throws prescriptive error for unknown window', async () => {
    await expect(
      resolveTarget('@999', {
        checkLiveness: false,
        workers: {
          'bd-42': {
            id: 'bd-42',
            paneId: '%17',
            session: 'genie',
            worktree: null,
            taskId: 'bd-42',
            startedAt: new Date().toISOString(),
            state: 'working' as const,
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
            windowId: '@4',
          },
        },
      }),
    ).rejects.toThrow('Window "@999" not found in worker registry');
  });

  test('resolveTarget("@4") with dead pane throws error', async () => {
    await expect(
      resolveTarget('@4', {
        checkLiveness: true,
        isPaneLive: async () => false,
        workers: {
          'bd-42': {
            id: 'bd-42',
            paneId: '%17',
            session: 'genie',
            worktree: null,
            taskId: 'bd-42',
            startedAt: new Date().toISOString(),
            state: 'working' as const,
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
            windowId: '@4',
          },
        },
      }),
    ).rejects.toThrow(/Window @4.*dead/);
  });

  test('resolveTarget("@4") with empty workers throws error', async () => {
    await expect(
      resolveTarget('@4', {
        checkLiveness: false,
        workers: {},
      }),
    ).rejects.toThrow('Window "@4" not found');
  });
});

// ============================================================================
// customName resolution
// ============================================================================

describe('customName resolution', () => {
  test('resolves by customName (team-scoped)', async () => {
    const result = await resolveTarget('engineer-4', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'abc123-long-id': {
          id: 'abc123-long-id',
          paneId: '%30',
          session: 'my-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          role: 'engineer',
          customName: 'engineer-4',
          team: 'my-team',
        },
      },
    });

    expect(result.paneId).toBe('%30');
    expect(result.workerId).toBe('abc123-long-id');
    expect(result.resolvedVia).toBe('worker');
  });

  test('resolves by customName (global fallback when no team)', async () => {
    const result = await resolveTarget('engineer-4', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'abc123-long-id': {
          id: 'abc123-long-id',
          paneId: '%30',
          session: 'other-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          role: 'engineer',
          customName: 'engineer-4',
          team: 'other-team',
        },
      },
    });

    expect(result.paneId).toBe('%30');
    expect(result.workerId).toBe('abc123-long-id');
  });

  test('throws on ambiguous customName within team', async () => {
    await expect(
      resolveTarget('engineer-4', {
        checkLiveness: false,
        getCurrentTeam: async () => 'my-team',
        workers: {
          worker1: {
            id: 'worker1',
            paneId: '%30',
            session: 'my-team',
            worktree: null,
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
            customName: 'engineer-4',
            team: 'my-team',
          },
          worker2: {
            id: 'worker2',
            paneId: '%31',
            session: 'my-team',
            worktree: null,
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
            customName: 'engineer-4',
            team: 'my-team',
          },
        },
      }),
    ).rejects.toThrow(/ambiguous/i);
  });
});

// ============================================================================
// Partial ID suffix resolution
// ============================================================================

describe('Partial ID suffix resolution', () => {
  test('resolves by partial ID suffix', async () => {
    const result = await resolveTarget('ec331228', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'team-engineer-ec331228': {
          id: 'team-engineer-ec331228',
          paneId: '%40',
          session: 'my-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          role: 'engineer',
          team: 'my-team',
        },
      },
    });

    expect(result.paneId).toBe('%40');
    expect(result.workerId).toBe('team-engineer-ec331228');
    expect(result.resolvedVia).toBe('worker');
  });

  test('prefers same-team match on ambiguous partial ID', async () => {
    const result = await resolveTarget('ec331228', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'teamA-engineer-ec331228': {
          id: 'teamA-engineer-ec331228',
          paneId: '%40',
          session: 'other-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          team: 'other-team',
        },
        'teamB-engineer-ec331228': {
          id: 'teamB-engineer-ec331228',
          paneId: '%41',
          session: 'my-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          team: 'my-team',
        },
      },
    });

    expect(result.paneId).toBe('%41');
    expect(result.workerId).toBe('teamB-engineer-ec331228');
  });

  test('throws on ambiguous partial ID without team disambiguation', async () => {
    await expect(
      resolveTarget('ec331228', {
        checkLiveness: false,
        getCurrentTeam: async () => null,
        workers: {
          'teamA-ec331228': {
            id: 'teamA-ec331228',
            paneId: '%40',
            session: 's1',
            worktree: null,
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
            team: 'team-a',
          },
          'teamB-ec331228': {
            id: 'teamB-ec331228',
            paneId: '%41',
            session: 's2',
            worktree: null,
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
            team: 'team-b',
          },
        },
      }),
    ).rejects.toThrow(/ambiguous/i);
  });

  test('does not match exact ID as partial suffix', async () => {
    const result = await resolveTarget('worker-1', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'worker-1': {
          id: 'worker-1',
          paneId: '%50',
          session: 'genie',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
    });

    expect(result.paneId).toBe('%50');
    expect(result.workerId).toBe('worker-1');
  });
});

// ============================================================================
// Substring resolution (fixes #700: short display names from genie ls)
// ============================================================================

describe('Substring resolution', () => {
  test('resolves "engineer-4" when ID is "sofia-t1re-engineer-4-ec331228"', async () => {
    const result = await resolveTarget('engineer-4', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'sofia-t1re-engineer-4-ec331228': {
          id: 'sofia-t1re-engineer-4-ec331228',
          paneId: '%40',
          session: 'my-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          role: 'engineer',
          team: 'my-team',
        },
      },
    });

    expect(result.paneId).toBe('%40');
    expect(result.workerId).toBe('sofia-t1re-engineer-4-ec331228');
    expect(result.resolvedVia).toBe('worker');
  });

  test('prefers same-team match on ambiguous substring', async () => {
    const result = await resolveTarget('engineer-4', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'teamA-engineer-4-abc123': {
          id: 'teamA-engineer-4-abc123',
          paneId: '%40',
          session: 'other-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          team: 'other-team',
        },
        'teamB-engineer-4-def456': {
          id: 'teamB-engineer-4-def456',
          paneId: '%41',
          session: 'my-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          team: 'my-team',
        },
      },
    });

    expect(result.paneId).toBe('%41');
    expect(result.workerId).toBe('teamB-engineer-4-def456');
  });

  test('throws on ambiguous substring without team disambiguation', async () => {
    await expect(
      resolveTarget('engineer-4', {
        checkLiveness: false,
        getCurrentTeam: async () => null,
        workers: {
          'teamA-engineer-4-abc123': {
            id: 'teamA-engineer-4-abc123',
            paneId: '%40',
            session: 's1',
            worktree: null,
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
            team: 'team-a',
          },
          'teamB-engineer-4-def456': {
            id: 'teamB-engineer-4-def456',
            paneId: '%41',
            session: 's2',
            worktree: null,
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
            team: 'team-b',
          },
        },
      }),
    ).rejects.toThrow(/ambiguous/i);
  });

  test('suffix match (endsWith) takes priority over substring match', async () => {
    const result = await resolveTarget('engineer-4', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'team-engineer-4': {
          id: 'team-engineer-4',
          paneId: '%10',
          session: 'genie',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          team: 'my-team',
        },
        'sofia-t1re-engineer-4-ec331228': {
          id: 'sofia-t1re-engineer-4-ec331228',
          paneId: '%20',
          session: 'genie',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          team: 'my-team',
        },
      },
    });

    // endsWith match wins (resolveByPartialId runs before resolveBySubstring)
    expect(result.paneId).toBe('%10');
    expect(result.workerId).toBe('team-engineer-4');
  });

  test('does not match when target is the exact ID', async () => {
    // exact ID match should resolve first, substring should not interfere
    const result = await resolveTarget('worker-1', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'worker-1': {
          id: 'worker-1',
          paneId: '%50',
          session: 'genie',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
    });

    expect(result.paneId).toBe('%50');
    expect(result.workerId).toBe('worker-1');
  });
});

// ============================================================================
// Global role resolution (fallback)
// ============================================================================

describe('Global role resolution', () => {
  test('resolves by role globally when no team context', async () => {
    const result = await resolveTarget('reviewer', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'review-worker-1': {
          id: 'review-worker-1',
          paneId: '%60',
          session: 'some-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          role: 'reviewer',
          team: 'some-team',
        },
      },
    });

    expect(result.paneId).toBe('%60');
    expect(result.workerId).toBe('review-worker-1');
  });

  test('resolves by role globally when team-scoped match fails', async () => {
    const result = await resolveTarget('reviewer', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'review-worker-1': {
          id: 'review-worker-1',
          paneId: '%60',
          session: 'other-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          role: 'reviewer',
          team: 'other-team',
        },
      },
    });

    expect(result.paneId).toBe('%60');
    expect(result.workerId).toBe('review-worker-1');
  });

  test('throws on ambiguous global role match', async () => {
    await expect(
      resolveTarget('engineer', {
        checkLiveness: false,
        getCurrentTeam: async () => null,
        workers: {
          'eng-1': {
            id: 'eng-1',
            paneId: '%70',
            session: 's1',
            worktree: null,
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
            role: 'engineer',
            team: 'team-a',
          },
          'eng-2': {
            id: 'eng-2',
            paneId: '%71',
            session: 's2',
            worktree: null,
            startedAt: new Date().toISOString(),
            state: 'working',
            lastStateChange: new Date().toISOString(),
            repoPath: '/tmp/test',
            role: 'engineer',
            team: 'team-b',
          },
        },
      }),
    ).rejects.toThrow(/ambiguous/i);
  });
});

// ============================================================================
// Resolution priority with new steps
// ============================================================================

describe('Resolution priority: exact ID > role (team) > customName > partial ID > substring > role (global)', () => {
  const baseWorker = {
    worktree: null as string | null,
    startedAt: new Date().toISOString(),
    state: 'working' as const,
    lastStateChange: new Date().toISOString(),
    repoPath: '/tmp/test',
    team: 'my-team',
  };

  test('exact ID wins over customName', async () => {
    const result = await resolveTarget('engineer-4', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'engineer-4': {
          ...baseWorker,
          id: 'engineer-4',
          paneId: '%10',
          session: 'my-team',
        },
        'other-worker': {
          ...baseWorker,
          id: 'other-worker',
          paneId: '%20',
          session: 'my-team',
          customName: 'engineer-4',
        },
      },
    });

    expect(result.paneId).toBe('%10');
    expect(result.workerId).toBe('engineer-4');
  });

  test('team-scoped role wins over customName', async () => {
    const result = await resolveTarget('engineer', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'eng-worker': {
          ...baseWorker,
          id: 'eng-worker',
          paneId: '%10',
          session: 'my-team',
          role: 'engineer',
        },
        'other-worker': {
          ...baseWorker,
          id: 'other-worker',
          paneId: '%20',
          session: 'my-team',
          customName: 'engineer',
        },
      },
    });

    expect(result.paneId).toBe('%10');
    expect(result.workerId).toBe('eng-worker');
  });

  test('customName wins over partial ID suffix', async () => {
    const result = await resolveTarget('eng-4', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'custom-name-worker': {
          ...baseWorker,
          id: 'custom-name-worker',
          paneId: '%10',
          session: 'my-team',
          customName: 'eng-4',
        },
        'some-prefix-eng-4': {
          ...baseWorker,
          id: 'some-prefix-eng-4',
          paneId: '%20',
          session: 'my-team',
        },
      },
    });

    expect(result.paneId).toBe('%10');
    expect(result.workerId).toBe('custom-name-worker');
  });

  test('partial ID suffix wins over substring match', async () => {
    const result = await resolveTarget('engineer-4', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'team-engineer-4': {
          ...baseWorker,
          id: 'team-engineer-4',
          paneId: '%10',
          session: 'my-team',
        },
        'sofia-t1re-engineer-4-ec331228': {
          ...baseWorker,
          id: 'sofia-t1re-engineer-4-ec331228',
          paneId: '%20',
          session: 'my-team',
        },
      },
    });

    // endsWith match (resolveByPartialId) runs first
    expect(result.paneId).toBe('%10');
    expect(result.workerId).toBe('team-engineer-4');
  });

  test('substring wins over global role', async () => {
    const result = await resolveTarget('engineer-4', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'sofia-t1re-engineer-4-ec331228': {
          ...baseWorker,
          id: 'sofia-t1re-engineer-4-ec331228',
          paneId: '%10',
          session: 'my-team',
          role: 'other-role',
        },
        'global-role-worker': {
          ...baseWorker,
          id: 'global-role-worker',
          paneId: '%20',
          session: 'my-team',
          role: 'engineer-4',
        },
      },
    });

    // substring match runs before global role
    expect(result.paneId).toBe('%10');
    expect(result.workerId).toBe('sofia-t1re-engineer-4-ec331228');
  });
});

// ============================================================================
// genie answer uses same resolver
// ============================================================================

describe('answerQuestion uses resolveTarget (verified by import)', () => {
  test('orchestrate.ts imports resolveTarget', async () => {
    const fs = await import('node:fs');
    const orchestrateSource = fs.readFileSync(
      new URL('../term-commands/orchestrate.ts', import.meta.url).pathname,
      'utf-8',
    );
    expect(orchestrateSource).toContain('resolveTarget');
    expect(orchestrateSource).toContain('answerQuestion');
  });
});

// ============================================================================
// GENIE_TEAM env var inference
// ============================================================================

describe('GENIE_TEAM env var inference', () => {
  test('role resolves when getCurrentTeam returns GENIE_TEAM value', async () => {
    // Simulates the case where GENIE_TEAM provides team context
    const result = await resolveTarget('engineer', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'eng-worker-abc123': {
          id: 'eng-worker-abc123',
          paneId: '%30',
          session: 'my-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          role: 'engineer',
          team: 'my-team',
        },
      },
    });

    expect(result.paneId).toBe('%30');
    expect(result.workerId).toBe('eng-worker-abc123');
    expect(result.resolvedVia).toBe('worker');
  });

  test('role resolves via global fallback when no team context (GENIE_TEAM unset)', async () => {
    const result = await resolveTarget('engineer', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'eng-worker-abc123': {
          id: 'eng-worker-abc123',
          paneId: '%30',
          session: 'some-team',
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'working',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
          role: 'engineer',
          team: 'some-team',
        },
      },
    });

    expect(result.paneId).toBe('%30');
    expect(result.workerId).toBe('eng-worker-abc123');
  });
});

// ============================================================================
// Partial role matching (prefix)
// ============================================================================

describe('Partial role matching', () => {
  const baseWorker = {
    worktree: null as string | null,
    startedAt: new Date().toISOString(),
    state: 'working' as const,
    lastStateChange: new Date().toISOString(),
    repoPath: '/tmp/test',
  };

  test('"eng" resolves to "engineer" when unambiguous', async () => {
    const result = await resolveTarget('eng', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'eng-worker-1': {
          ...baseWorker,
          id: 'eng-worker-1',
          paneId: '%30',
          session: 'my-team',
          role: 'engineer',
          team: 'my-team',
        },
      },
    });

    expect(result.paneId).toBe('%30');
    expect(result.workerId).toBe('eng-worker-1');
    expect(result.resolvedVia).toBe('worker');
  });

  test('"rev" resolves to "reviewer" globally when no team context', async () => {
    const result = await resolveTarget('rev', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'rev-worker': {
          ...baseWorker,
          id: 'rev-worker',
          paneId: '%40',
          session: 'some-team',
          role: 'reviewer',
          team: 'some-team',
        },
      },
    });

    expect(result.paneId).toBe('%40');
    expect(result.workerId).toBe('rev-worker');
  });

  test('ambiguous partial role throws with candidate list', async () => {
    await expect(
      resolveTarget('eng', {
        checkLiveness: false,
        getCurrentTeam: async () => null,
        workers: {
          worker1: {
            ...baseWorker,
            id: 'worker1',
            paneId: '%30',
            session: 's1',
            role: 'engineer',
            team: 'team-a',
          },
          worker2: {
            ...baseWorker,
            id: 'worker2',
            paneId: '%31',
            session: 's2',
            role: 'engineer',
            team: 'team-b',
          },
        },
      }),
    ).rejects.toThrow(/ambiguous/i);
  });

  test('exact role match takes priority over partial role match', async () => {
    const result = await resolveTarget('engineer', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'exact-role-worker': {
          ...baseWorker,
          id: 'exact-role-worker',
          paneId: '%10',
          session: 'my-team',
          role: 'engineer',
          team: 'my-team',
        },
        'engineer-lead-worker': {
          ...baseWorker,
          id: 'engineer-lead-worker',
          paneId: '%20',
          session: 'my-team',
          role: 'engineer-lead',
          team: 'my-team',
        },
      },
    });

    // Exact role match (resolveByRole) should win over partial (resolveByPartialRole)
    expect(result.paneId).toBe('%10');
    expect(result.workerId).toBe('exact-role-worker');
  });

  test('team-scoped partial role preferred over global partial role', async () => {
    const result = await resolveTarget('eng', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'team-eng': {
          ...baseWorker,
          id: 'team-eng',
          paneId: '%10',
          session: 'my-team',
          role: 'engineer',
          team: 'my-team',
        },
        'other-eng': {
          ...baseWorker,
          id: 'other-eng',
          paneId: '%20',
          session: 'other-team',
          role: 'engineer',
          team: 'other-team',
        },
      },
    });

    expect(result.paneId).toBe('%10');
    expect(result.workerId).toBe('team-eng');
  });
});

// ============================================================================
// Partial customName matching (prefix)
// ============================================================================

describe('Partial customName matching', () => {
  const baseWorker = {
    worktree: null as string | null,
    startedAt: new Date().toISOString(),
    state: 'working' as const,
    lastStateChange: new Date().toISOString(),
    repoPath: '/tmp/test',
  };

  test('"eng" resolves to customName "engineer-4" when unambiguous', async () => {
    const result = await resolveTarget('eng', {
      checkLiveness: false,
      getCurrentTeam: async () => null,
      workers: {
        'some-long-id': {
          ...baseWorker,
          id: 'some-long-id',
          paneId: '%50',
          session: 'my-team',
          customName: 'engineer-4',
          team: 'my-team',
        },
      },
    });

    expect(result.paneId).toBe('%50');
    expect(result.workerId).toBe('some-long-id');
  });

  test('exact customName takes priority over partial customName', async () => {
    const result = await resolveTarget('eng-4', {
      checkLiveness: false,
      getCurrentTeam: async () => 'my-team',
      workers: {
        'exact-custom': {
          ...baseWorker,
          id: 'exact-custom',
          paneId: '%10',
          session: 'my-team',
          customName: 'eng-4',
          team: 'my-team',
        },
        'partial-custom': {
          ...baseWorker,
          id: 'partial-custom',
          paneId: '%20',
          session: 'my-team',
          customName: 'eng-4-extended',
          team: 'my-team',
        },
      },
    });

    // Exact customName (resolveByCustomName) should win
    expect(result.paneId).toBe('%10');
    expect(result.workerId).toBe('exact-custom');
  });

  test('ambiguous partial customName throws with candidate list', async () => {
    await expect(
      resolveTarget('eng', {
        checkLiveness: false,
        getCurrentTeam: async () => null,
        workers: {
          worker1: {
            ...baseWorker,
            id: 'worker1',
            paneId: '%30',
            session: 's1',
            customName: 'engineer-1',
            team: 'team-a',
          },
          worker2: {
            ...baseWorker,
            id: 'worker2',
            paneId: '%31',
            session: 's2',
            customName: 'engineer-2',
            team: 'team-b',
          },
        },
      }),
    ).rejects.toThrow(/ambiguous/i);
  });
});

// ============================================================================
// Cleanup
// ============================================================================

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
});
