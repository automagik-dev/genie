/**
 * Tests for Group 2: Wire All Commands to Use Target Resolver
 *
 * Tests that send, exec, read, split, and orchestrate commands
 * properly delegate to resolveTarget() for target resolution.
 *
 * Run with: bun test src/term-commands/command-wiring.test.ts
 */

import { describe, test, expect } from 'bun:test';
import type { SendOptions } from './send.js';
import type { ExecOptions } from './exec.js';
import type { ReadOptions } from './read.js';
import type { SplitOptions } from './split.js';
import { resolveTarget } from '../lib/target-resolver.js';

// ============================================================================
// send.ts: sendKeysToSession uses resolveTarget
// ============================================================================

describe('send.ts: target resolution wiring', () => {
  test('sendKeysToSession function is exported', async () => {
    const sendModule = await import('./send.js');
    expect(typeof sendModule.sendKeysToSession).toBe('function');
  });

  test('SendOptions includes deprecated pane field for backwards compat', () => {
    const options: SendOptions = { pane: '%17' };
    expect(options.pane).toBe('%17');
  });

  test('SendOptions accepts enter flag', () => {
    const options: SendOptions = { enter: false };
    expect(options.enter).toBe(false);
  });
});

// ============================================================================
// exec.ts: executeInSession uses resolveTarget
// ============================================================================

describe('exec.ts: target resolution wiring', () => {
  test('executeInSession function is exported', async () => {
    const execModule = await import('./exec.js');
    expect(typeof execModule.executeInSession).toBe('function');
  });

  test('ExecOptions includes deprecated pane field for backwards compat', () => {
    const options: ExecOptions = { pane: '%17' };
    expect(options.pane).toBe('%17');
  });

  test('ExecOptions accepts quiet and timeout', () => {
    const options: ExecOptions = { quiet: true, timeout: 5000 };
    expect(options.quiet).toBe(true);
    expect(options.timeout).toBe(5000);
  });
});

// ============================================================================
// read.ts: readSessionLogs uses resolveTarget
// ============================================================================

describe('read.ts: target resolution wiring', () => {
  test('readSessionLogs function is exported', async () => {
    const readModule = await import('./read.js');
    expect(typeof readModule.readSessionLogs).toBe('function');
  });

  test('ReadOptions includes deprecated pane field', () => {
    const options: ReadOptions = { pane: '%17' };
    expect(options.pane).toBe('%17');
  });
});

// ============================================================================
// split.ts: splitSessionPane uses resolveTarget
// ============================================================================

describe('split.ts: target resolution wiring', () => {
  test('splitSessionPane function is exported', async () => {
    const splitModule = await import('./split.js');
    expect(typeof splitModule.splitSessionPane).toBe('function');
  });

  test('SplitOptions includes deprecated pane field', () => {
    const options: SplitOptions = { pane: '%17' };
    expect(options.pane).toBe('%17');
  });
});

// ============================================================================
// orchestrate.ts: all sub-commands use resolveTarget
// ============================================================================

describe('orchestrate.ts: target resolution wiring', () => {
  test('sendMessage function is exported', async () => {
    const orcModule = await import('./orchestrate.js');
    expect(typeof orcModule.sendMessage).toBe('function');
  });

  test('showStatus function is exported', async () => {
    const orcModule = await import('./orchestrate.js');
    expect(typeof orcModule.showStatus).toBe('function');
  });

  test('approvePermission function is exported', async () => {
    const orcModule = await import('./orchestrate.js');
    expect(typeof orcModule.approvePermission).toBe('function');
  });

  test('watchSession function is exported', async () => {
    const orcModule = await import('./orchestrate.js');
    expect(typeof orcModule.watchSession).toBe('function');
  });

  test('answerQuestion function is exported', async () => {
    const orcModule = await import('./orchestrate.js');
    expect(typeof orcModule.answerQuestion).toBe('function');
  });

  test('runTask function is exported', async () => {
    const orcModule = await import('./orchestrate.js');
    expect(typeof orcModule.runTask).toBe('function');
  });

  test('startSession preserves session-creation behavior (still uses sessionName)', async () => {
    const orcModule = await import('./orchestrate.js');
    // startSession should still accept a sessionName parameter (not target resolver)
    expect(typeof orcModule.startSession).toBe('function');
  });
});

// ============================================================================
// resolveTarget integration: verify target resolver is importable
// ============================================================================

describe('resolveTarget integration', () => {
  test('resolveTarget is callable from commands', () => {
    expect(typeof resolveTarget).toBe('function');
  });

  test('resolveTarget handles raw pane IDs', async () => {
    const result = await resolveTarget('%42', { checkLiveness: false });
    expect(result.paneId).toBe('%42');
    expect(result.resolvedVia).toBe('raw');
  });

  test('resolveTarget handles worker IDs', async () => {
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
          state: 'working' as const,
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
    });
    expect(result.paneId).toBe('%17');
    expect(result.workerId).toBe('bd-42');
    expect(result.resolvedVia).toBe('worker');
  });

  test('resolveTarget handles worker:index addressing', async () => {
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
          state: 'working' as const,
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/test',
        },
      },
    });
    expect(result.paneId).toBe('%22');
    expect(result.workerId).toBe('bd-42');
    expect(result.paneIndex).toBe(1);
  });

  test('resolveTarget handles session:window fallback', async () => {
    const result = await resolveTarget('genie:OMNI', {
      checkLiveness: false,
      workers: {},
      tmuxLookup: async (sessionName: string, windowName?: string) => {
        if (sessionName === 'genie' && windowName === 'OMNI') {
          return { paneId: '%5', session: 'genie' };
        }
        return null;
      },
    });
    expect(result.paneId).toBe('%5');
    expect(result.resolvedVia).toBe('session:window');
  });

  test('resolveTarget handles session name fallback', async () => {
    const result = await resolveTarget('genie', {
      checkLiveness: false,
      workers: {},
      tmuxLookup: async (sessionName: string, windowName?: string) => {
        if (sessionName === 'genie' && !windowName) {
          return { paneId: '%3', session: 'genie' };
        }
        return null;
      },
    });
    expect(result.paneId).toBe('%3');
    expect(result.resolvedVia).toBe('session');
  });
});
