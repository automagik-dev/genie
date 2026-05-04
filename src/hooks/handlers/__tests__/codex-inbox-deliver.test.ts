/**
 * codex-inbox-deliver handler — unit tests (mocked deps; no PG, no codex).
 *
 * Run with: bun test src/hooks/handlers/__tests__/codex-inbox-deliver.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MailboxMessage } from '../../../lib/mailbox.js';
import type { HookPayload } from '../../types.js';
import { type CodexAgentRef, _deps, codexInboxDeliver } from '../codex-inbox-deliver.js';

const ENV_KEYS = ['GENIE_AGENT_ID', 'GENIE_AGENT_NAME', 'GENIE_TEAM', 'NODE_ENV', 'BUN_ENV'] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function resetDeps(): void {
  _deps.findCodexAgent = null;
  _deps.fetchUnread = null;
  _deps.markReadBatch = null;
}

function makeAgent(over: Partial<CodexAgentRef> = {}): CodexAgentRef {
  return {
    id: 'agent-uuid-1',
    role: 'codex-eng',
    customName: 'codex-eng',
    repoPath: '/repo',
    provider: 'codex',
    ...over,
  };
}

function makeMsg(over: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    from: 'operator',
    to: 'codex-eng',
    body: 'hello codex',
    createdAt: new Date().toISOString(),
    read: false,
    deliveredAt: null,
    source: 'agent',
    meta: {},
    ...over,
  };
}

function basePayload(): HookPayload {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-1',
    cwd: '/repo',
    prompt: 'do the thing',
  };
}

describe('codex-inbox-deliver handler', () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    // Tests bypass the test-env short-circuit by installing dep overrides;
    // clear the literal vars so resolveContext doesn't return null on
    // missing GENIE_AGENT_NAME. GENIE_AGENT_ID stays cleared by default —
    // legacy tests want the (name, team) path; tests for the env-id flip
    // set it explicitly.
    process.env.GENIE_AGENT_ID = undefined;
    process.env.GENIE_AGENT_NAME = 'codex-eng';
    process.env.GENIE_TEAM = 'genie';
    process.env.NODE_ENV = undefined;
    process.env.BUN_ENV = undefined;
    resetDeps();
  });

  afterEach(() => {
    resetDeps();
    restoreEnv(envSnapshot);
  });

  test('returns undefined when no agent name is resolvable', async () => {
    process.env.GENIE_AGENT_NAME = undefined;
    _deps.findCodexAgent = async () => makeAgent();
    _deps.fetchUnread = async () => [makeMsg()];
    _deps.markReadBatch = async () => 1;

    const result = await codexInboxDeliver(basePayload());
    expect(result).toBeUndefined();
  });

  test('returns undefined when matched agent is not codex provider', async () => {
    _deps.findCodexAgent = async () => makeAgent({ provider: 'claude' });
    _deps.fetchUnread = async () => [makeMsg()];
    _deps.markReadBatch = async () => 1;

    const result = await codexInboxDeliver(basePayload());
    expect(result).toBeUndefined();
  });

  test('returns undefined when no codex agent matches', async () => {
    _deps.findCodexAgent = async () => null;
    _deps.fetchUnread = async () => [makeMsg()];
    _deps.markReadBatch = async () => 1;

    const result = await codexInboxDeliver(basePayload());
    expect(result).toBeUndefined();
  });

  test('returns undefined when mailbox is empty', async () => {
    let fetched = false;
    _deps.findCodexAgent = async () => makeAgent();
    _deps.fetchUnread = async (_repo, _keys) => {
      fetched = true;
      return [];
    };
    _deps.markReadBatch = async () => 0;

    const result = await codexInboxDeliver(basePayload());
    expect(result).toBeUndefined();
    expect(fetched).toBe(true);
  });

  test('renders N pending messages as newline-joined envelopes in fetch order', async () => {
    const agent = makeAgent();
    const msgs = [
      makeMsg({ id: 'msg-a', from: 'operator', body: 'first', createdAt: '2026-04-28T00:00:00Z' }),
      makeMsg({
        id: 'msg-b',
        from: '+5511999999999',
        body: 'second',
        createdAt: '2026-04-28T00:00:01Z',
        source: 'whatsapp',
        meta: { phone: '+5511999999999', conversationId: 'wa-1' },
      }),
      makeMsg({ id: 'msg-c', from: 'system', body: 'third', createdAt: '2026-04-28T00:00:02Z', source: 'system' }),
    ];

    _deps.findCodexAgent = async () => agent;
    _deps.fetchUnread = async () => msgs;
    _deps.markReadBatch = async () => msgs.length;

    const result = await codexInboxDeliver(basePayload());
    expect(result).toBeDefined();
    expect(result?.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    const ctx = result?.hookSpecificOutput?.additionalContext ?? '';
    const lines = ctx.split('\n');
    expect(lines).toHaveLength(3);
    // Default-source body passes through verbatim; non-default wraps as <channel ...>.
    expect(lines[0]).toBe('first');
    expect(lines[1]).toMatch(/^<channel source="whatsapp"/);
    expect(lines[1]).toContain('phone="+5511999999999"');
    expect(lines[1]).toContain('>second</channel>');
    expect(lines[2]).toBe('<channel source="system" from="system">third</channel>');
  });

  test('marks delivered rows read with the exact id batch', async () => {
    const agent = makeAgent();
    const msgs = [makeMsg({ id: 'msg-1' }), makeMsg({ id: 'msg-2' })];
    const captured: { ids: string[] } = { ids: [] };

    _deps.findCodexAgent = async () => agent;
    _deps.fetchUnread = async () => msgs;
    _deps.markReadBatch = async (ids) => {
      captured.ids = ids.slice();
      return ids.length;
    };

    await codexInboxDeliver(basePayload());
    expect(captured.ids).toEqual(['msg-1', 'msg-2']);
  });

  test('skips delivery when mark-read returns 0 (atomic guard against double-injection)', async () => {
    const agent = makeAgent();
    _deps.findCodexAgent = async () => agent;
    _deps.fetchUnread = async () => [makeMsg(), makeMsg()];
    _deps.markReadBatch = async () => 0; // PG transient or row vanished

    const result = await codexInboxDeliver(basePayload());
    expect(result).toBeUndefined();
  });

  test('queries mailbox using all keys the agent may be addressed by', async () => {
    const agent = makeAgent({ id: 'uuid-x', role: 'codex-eng', customName: 'pr-b-codex' });
    const captured: { keys: string[] } = { keys: [] };
    _deps.findCodexAgent = async () => agent;
    _deps.fetchUnread = async (_repo, keys) => {
      captured.keys = keys.slice();
      return [];
    };
    _deps.markReadBatch = async () => 0;

    await codexInboxDeliver(basePayload());
    const set = new Set(captured.keys);
    // Includes id, role, customName, AND the GENIE_AGENT_NAME fallback.
    expect(set.has('uuid-x')).toBe(true);
    expect(set.has('codex-eng')).toBe(true);
    expect(set.has('pr-b-codex')).toBe(true);
  });

  test('returns empty additionalContext (undefined) when fetch exceeds 500ms timeout', async () => {
    _deps.findCodexAgent = async () => makeAgent();
    _deps.fetchUnread = () => new Promise((resolve) => setTimeout(() => resolve([makeMsg()]), 5_000));
    _deps.markReadBatch = async () => 1;

    const start = Date.now();
    const result = await codexInboxDeliver(basePayload());
    const elapsed = Date.now() - start;
    expect(result).toBeUndefined();
    // Timeout budget is 500ms — give a generous CI fudge factor.
    expect(elapsed).toBeLessThan(2_000);
  });

  test('does not mark rows read when a timed-out fetch resolves later', async () => {
    let markReadCalls = 0;
    _deps.findCodexAgent = async () => makeAgent();
    _deps.fetchUnread = () => new Promise((resolve) => setTimeout(() => resolve([makeMsg({ id: 'late-msg' })]), 650));
    _deps.markReadBatch = async () => {
      markReadCalls += 1;
      return 1;
    };

    const result = await codexInboxDeliver(basePayload());
    expect(result).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(markReadCalls).toBe(0);
  });

  test('swallows fetch errors and returns undefined (never crashes the dispatcher)', async () => {
    _deps.findCodexAgent = async () => makeAgent();
    _deps.fetchUnread = async () => {
      throw new Error('PG unreachable');
    };
    _deps.markReadBatch = async () => 0;

    const result = await codexInboxDeliver(basePayload());
    expect(result).toBeUndefined();
  });

  test('respects team scoping when GENIE_TEAM is set', async () => {
    let observedTeam: string | undefined;
    _deps.findCodexAgent = async (_name, team) => {
      observedTeam = team;
      return makeAgent();
    };
    _deps.fetchUnread = async () => [];
    _deps.markReadBatch = async () => 0;

    process.env.GENIE_TEAM = 'sprint-team';
    await codexInboxDeliver(basePayload());
    expect(observedTeam).toBe('sprint-team');
  });
});
