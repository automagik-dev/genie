/**
 * `genie done` command dispatch — agent-session path vs wish-group path.
 *
 * Uses injected deps (no DB) to isolate routing behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TurnCloseResult } from '../lib/turn-close.js';
import { doneAction } from './done.js';

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

    await doneAction(undefined, { turnCloseFn: turnCloseFn as never, wishDone });

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

    // Should complete without throwing
    await doneAction(undefined, { turnCloseFn: turnCloseFn as never });
  });
});
