/**
 * `genie done` command dispatch — agent-session path vs wish-group path
 * vs the Group 6 permanent-agent rejection guard.
 *
 * Uses injected deps (no DB) to isolate routing behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TurnCloseResult } from '../lib/turn-close.js';
import { PermanentAgentDoneRejected, doneAction } from './done.js';

describe('doneAction dispatch', () => {
  const originalAgent = process.env.GENIE_AGENT_NAME;

  beforeEach(() => {
    process.env.GENIE_AGENT_NAME = undefined;
  });

  afterEach(() => {
    process.env.GENIE_AGENT_NAME = originalAgent;
  });

  test('agent session + no ref → calls turnClose(outcome=done)', async () => {
    process.env.GENIE_AGENT_NAME = 'engineer-g2';
    const calls: Array<{ outcome: string }> = [];
    const turnCloseFn = async (opts: { outcome: string }): Promise<TurnCloseResult> => {
      calls.push({ outcome: opts.outcome });
      return { noop: false, executorId: 'exec-1', outcome: 'done', closedAt: new Date().toISOString() };
    };
    let wishCalls = 0;
    const wishDone = async () => {
      wishCalls++;
    };
    const lookupCallingAgent = async () => ({ id: 'agent-task', kind: 'task' as const });

    await doneAction(undefined, { turnCloseFn: turnCloseFn as never, wishDone, lookupCallingAgent });

    expect(calls).toEqual([{ outcome: 'done' }]);
    expect(wishCalls).toBe(0);
  });

  test('positional ref → delegates to wish-group doneCommand', async () => {
    process.env.GENIE_AGENT_NAME = 'engineer-g2';
    let turnCalls = 0;
    const turnCloseFn = async (): Promise<TurnCloseResult> => {
      turnCalls++;
      return { noop: false, executorId: 'x', outcome: 'done', closedAt: null };
    };
    const wishRefs: string[] = [];
    const wishDone = async (ref: string) => {
      wishRefs.push(ref);
    };

    await doneAction('my-wish#2', { turnCloseFn: turnCloseFn as never, wishDone });

    expect(turnCalls).toBe(0);
    expect(wishRefs).toEqual(['my-wish#2']);
  });

  test('positional ref without GENIE_AGENT_NAME → still delegates to wish path', async () => {
    let turnCalls = 0;
    const turnCloseFn = async (): Promise<TurnCloseResult> => {
      turnCalls++;
      return { noop: false, executorId: 'x', outcome: 'done', closedAt: null };
    };
    const wishRefs: string[] = [];
    const wishDone = async (ref: string) => {
      wishRefs.push(ref);
    };

    await doneAction('other-wish#1', { turnCloseFn: turnCloseFn as never, wishDone });

    expect(turnCalls).toBe(0);
    expect(wishRefs).toEqual(['other-wish#1']);
  });

  test('no ref + no GENIE_AGENT_NAME → exits with error', async () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('process.exit stub');
    }) as never;

    try {
      await expect(doneAction(undefined)).rejects.toThrow(/process.exit stub/);
      expect(exitCode).toBe(2);
    } finally {
      process.exit = originalExit;
    }
  });

  test('turnClose noop result is reported to user, not treated as error', async () => {
    process.env.GENIE_AGENT_NAME = 'engineer-g2';
    const turnCloseFn = async (): Promise<TurnCloseResult> => ({
      noop: true,
      executorId: 'exec-already-closed',
      outcome: 'done',
      closedAt: null,
    });
    const lookupCallingAgent = async () => ({ id: 'agent-task', kind: 'task' as const });

    // Should complete without throwing
    await doneAction(undefined, { turnCloseFn: turnCloseFn as never, lookupCallingAgent });
  });

  // ==========================================================================
  // Permanent-agent rejection (Group 6)
  // ==========================================================================

  describe('permanent-agent rejection', () => {
    test('permanent calling agent → throws PermanentAgentDoneRejected, exit code 4', async () => {
      process.env.GENIE_AGENT_NAME = 'team-lead';
      const originalExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error('process.exit stub');
      }) as never;

      let turnCalls = 0;
      const turnCloseFn = async (): Promise<TurnCloseResult> => {
        turnCalls++;
        return { noop: false, executorId: 'x', outcome: 'done', closedAt: null };
      };
      const lookupCallingAgent = async () => ({ id: 'team-lead-uuid', kind: 'permanent' as const });

      try {
        await expect(doneAction(undefined, { turnCloseFn: turnCloseFn as never, lookupCallingAgent })).rejects.toThrow(
          /process.exit stub/,
        );
        expect(exitCode).toBe(4);
        // turnClose must NOT be reached on rejection — the side effects
        // (state='done', current_executor_id=NULL) are exactly what the
        // permanent-agent guard prevents.
        expect(turnCalls).toBe(0);
      } finally {
        process.exit = originalExit;
      }
    });

    test('task calling agent → succeeds, turnClose invoked', async () => {
      process.env.GENIE_AGENT_NAME = 'engineer-g6';
      let turnCalls = 0;
      const turnCloseFn = async (): Promise<TurnCloseResult> => {
        turnCalls++;
        return { noop: false, executorId: 'exec-1', outcome: 'done', closedAt: null };
      };
      const lookupCallingAgent = async () => ({ id: 'engineer-g6-uuid', kind: 'task' as const });

      await doneAction(undefined, { turnCloseFn: turnCloseFn as never, lookupCallingAgent });
      expect(turnCalls).toBe(1);
    });

    test('lookup returns null (no executor context) → falls through to turnClose', async () => {
      process.env.GENIE_AGENT_NAME = 'engineer-no-exec';
      let turnCalls = 0;
      const turnCloseFn = async (): Promise<TurnCloseResult> => {
        turnCalls++;
        return { noop: false, executorId: 'exec-1', outcome: 'done', closedAt: null };
      };
      const lookupCallingAgent = async () => null;

      await doneAction(undefined, { turnCloseFn: turnCloseFn as never, lookupCallingAgent });
      // We could not prove permanence, so the existing turnClose path runs;
      // its own ghost-executor recovery / error reporting takes over.
      expect(turnCalls).toBe(1);
    });

    test('lookup returns kind=null (degraded row) → falls through to turnClose (safer default)', async () => {
      process.env.GENIE_AGENT_NAME = 'engineer-degraded';
      let turnCalls = 0;
      const turnCloseFn = async (): Promise<TurnCloseResult> => {
        turnCalls++;
        return { noop: false, executorId: 'exec-2', outcome: 'done', closedAt: null };
      };
      const lookupCallingAgent = async () => ({ id: 'agent-degraded', kind: null });

      await doneAction(undefined, { turnCloseFn: turnCloseFn as never, lookupCallingAgent });
      // kind=null defaults to "let it through" — same posture as the
      // shouldResume chokepoint, which treats unknown kind as task-bound.
      expect(turnCalls).toBe(1);
    });

    test('PermanentAgentDoneRejected carries agentId + reason', () => {
      const err = new PermanentAgentDoneRejected({ agentId: 'team-lead-1' });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('PermanentAgentDoneRejected');
      expect(err.agentId).toBe('team-lead-1');
      expect(err.reason).toBe('permanent_agents_never_call_done');
      expect(err.message).toContain('team-lead-1');
      expect(err.message).toContain('genie agent stop');
    });

    test('PermanentAgentDoneRejected accepts custom reason override', () => {
      const err = new PermanentAgentDoneRejected({ agentId: 'dir:scout', reason: 'dir_placeholder_not_a_task' });
      expect(err.reason).toBe('dir_placeholder_not_a_task');
    });

    test('positional wish ref skips the permanent-agent guard (wish path is unconditional)', async () => {
      process.env.GENIE_AGENT_NAME = 'team-lead';
      let lookupCalls = 0;
      const lookupCallingAgent = async () => {
        lookupCalls++;
        return { id: 'team-lead-uuid', kind: 'permanent' as const };
      };
      const wishRefs: string[] = [];
      const wishDone = async (ref: string) => {
        wishRefs.push(ref);
      };

      await doneAction('my-wish#3', { wishDone, lookupCallingAgent });
      expect(lookupCalls).toBe(0);
      expect(wishRefs).toEqual(['my-wish#3']);
    });
  });
});
