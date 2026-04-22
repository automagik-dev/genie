/**
 * Broadcast fan-out regression tests (#1218).
 *
 * Before this fix, `genie broadcast --team <name>` wrote only to the team's
 * group conversation. Idle members received no pane-side prompt, so at most
 * one of N members would wake. `deliverBroadcastToMembers` fans the broadcast
 * out through protocolRouter.sendMessage — the same delivery primitive DMs
 * use — so every team member's pane gets the UserPromptSubmit.
 *
 * Tests inject stubs rather than exercising real protocol-router / team
 * manager (those have their own test suites) so this file stays deterministic
 * and free of tmux/PG dependencies.
 */

import { describe, expect, test } from 'bun:test';
import { type BroadcastFanoutDeps, type BroadcastFanoutResult, deliverBroadcastToMembers } from './send.js';

type SendCall = {
  repo: string;
  from: string;
  to: string;
  body: string;
  teamName?: string;
};

function buildDeps(opts: {
  members: string[] | null;
  onSend?: (call: SendCall) => { delivered: boolean; reason?: string };
}): { deps: BroadcastFanoutDeps; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const deps: BroadcastFanoutDeps = {
    listMembers: async (_teamName) => opts.members,
    sendMessage: async (repo, from, to, body, teamName) => {
      const call = { repo, from, to, body, teamName };
      calls.push(call);
      const outcome = opts.onSend?.(call) ?? { delivered: true };
      return {
        messageId: `msg-${to}`,
        workerId: to,
        delivered: outcome.delivered,
        reason: outcome.reason,
      };
    },
  };
  return { deps, calls };
}

describe('deliverBroadcastToMembers (#1218)', () => {
  test('fires sendMessage for every team member — regression for 4-member council', async () => {
    const { deps, calls } = buildDeps({
      members: ['council--questioner', 'council--simplifier', 'council--architect', 'council--measurer'],
    });
    const results: BroadcastFanoutResult[] = await deliverBroadcastToMembers(
      deps,
      '/repo',
      'cli',
      'council-1218',
      'ROUND 1 — topic ...',
    );

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.delivered)).toBe(true);
    expect(calls.map((c) => c.to).sort()).toEqual([
      'council--architect',
      'council--measurer',
      'council--questioner',
      'council--simplifier',
    ]);
    expect(calls.every((c) => c.body === 'ROUND 1 — topic ...')).toBe(true);
    expect(calls.every((c) => c.from === 'cli')).toBe(true);
    expect(calls.every((c) => c.teamName === 'council-1218')).toBe(true);
  });

  test('elides the sender when the sender is a member of the team', async () => {
    const { deps, calls } = buildDeps({ members: ['alpha', 'beta', 'gamma'] });
    await deliverBroadcastToMembers(deps, '/repo', 'beta', 'team', 'msg');

    expect(calls.map((c) => c.to)).toEqual(['alpha', 'gamma']);
  });

  test('records reason when a single recipient is not delivered', async () => {
    const { deps } = buildDeps({
      members: ['live', 'dead'],
      onSend: ({ to }) => (to === 'dead' ? { delivered: false, reason: 'pane died' } : { delivered: true }),
    });

    const results = await deliverBroadcastToMembers(deps, '/repo', 'cli', 'team', 'x');

    expect(results).toEqual([
      { member: 'live', delivered: true, reason: undefined },
      { member: 'dead', delivered: false, reason: 'pane died' },
    ]);
  });

  test('returns empty array when listMembers returns null (team not found)', async () => {
    const { deps, calls } = buildDeps({ members: null });
    const results = await deliverBroadcastToMembers(deps, '/repo', 'cli', 'ghost', 'x');

    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('catches thrown errors from sendMessage and continues fan-out', async () => {
    // One recipient throws; the rest still receive the broadcast. Guard
    // against the obvious failure mode where a single crashed pane aborts
    // delivery for every subsequent member.
    const { deps, calls } = buildDeps({
      members: ['a', 'b', 'c'],
      onSend: ({ to }) => {
        if (to === 'b') throw new Error('boom');
        return { delivered: true };
      },
    });

    const results = await deliverBroadcastToMembers(deps, '/repo', 'cli', 'team', 'x');

    expect(calls.map((c) => c.to)).toEqual(['a', 'b', 'c']);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ member: 'a', delivered: true, reason: undefined });
    expect(results[1]).toEqual({ member: 'b', delivered: false, reason: 'boom' });
    expect(results[2]).toEqual({ member: 'c', delivered: true, reason: undefined });
  });

  test('preserves member order (important for deterministic CLI output)', async () => {
    const { deps, calls } = buildDeps({ members: ['zeta', 'alpha', 'beta'] });
    const results = await deliverBroadcastToMembers(deps, '/repo', 'cli', 'team', 'x');

    expect(results.map((r) => r.member)).toEqual(['zeta', 'alpha', 'beta']);
    expect(calls.map((c) => c.to)).toEqual(['zeta', 'alpha', 'beta']);
  });
});
