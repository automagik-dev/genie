/**
 * Tests for session.ts — registerSessionInRegistry session-id propagation.
 *
 * Regression test for #212: the operator's interactive `genie session start`
 * launches claude with `--session-id <uuid>` but did not persist the UUID on
 * the executor row, so session-capture's filewatch never associated the JSONL
 * with any agent. The leader's transcript became orphaned and `genie agent
 * show <leader>` reported "No active executor" while claude was live.
 *
 * Uses _deps injection (no mock.module) to avoid bun shared-module-cache leaks.
 *
 * Run with: bun test src/genie-commands/session.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CreateExecutorOpts } from '../lib/executor-registry.js';

import { _deps, registerSessionInRegistry } from './session.js';

interface CreateExecutorCall {
  agentId: string;
  provider: string;
  transport: string;
  opts: CreateExecutorOpts;
}

describe('registerSessionInRegistry — session-id propagation (#212)', () => {
  let origDeps: typeof _deps;
  let createCalls: CreateExecutorCall[];

  beforeEach(() => {
    origDeps = { ...(_deps as typeof _deps) };
    createCalls = [];

    _deps.executeTmux = mock(async (cmd: string) => {
      if (cmd.includes("'#{pane_id}'")) return '%999';
      if (cmd.includes("'#{pane_pid}'")) return '12345';
      return '';
    });
    _deps.registerWorker = mock(async () => {});
    _deps.resolveLeaderName = mock(async () => 'leader');
    _deps.findOrCreateAgent = mock(async () => ({
      id: 'agent-uuid',
      name: 'leader',
      team: 'leader',
      role: 'leader',
      currentExecutorId: null,
    })) as unknown as typeof _deps.findOrCreateAgent;
    _deps.createAndLinkExecutor = mock(
      async (agentId: string, provider: string, transport: string, opts: CreateExecutorOpts) => {
        createCalls.push({ agentId, provider, transport, opts });
        return {} as never;
      },
    ) as unknown as typeof _deps.createAndLinkExecutor;
  });

  afterEach(() => {
    Object.assign(_deps, origDeps);
  });

  test('persists claude_session_id on executor row when sessionId is provided', async () => {
    const sessionId = 'cafef00d-1234-5678-9abc-def012345678';

    await registerSessionInRegistry('test-session', 'test-window', '/tmp/test-workspace', sessionId);

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].opts.claudeSessionId).toBe(sessionId);
    expect(createCalls[0].provider).toBe('claude');
    expect(createCalls[0].transport).toBe('tmux');
  });

  test('falls back to null claudeSessionId when sessionId is omitted (back-compat)', async () => {
    await registerSessionInRegistry('test-session', 'test-window', '/tmp/test-workspace');

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].opts.claudeSessionId).toBeNull();
  });
});
