/**
 * omni-approval PreToolUse handler — resolves allow/deny/ask against a real
 * global genie.db (in-memory, no network). Drives the poll loop deterministically
 * by injecting a `sleep` that plays the "phone" once, mid-wait.
 */
import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type { OmniRuntimeConfig } from '../../lib/omni-config.js';
import { openGlobalDb } from '../../lib/v5/global-db.js';
import { getApproval, listPendingApprovals, resolveApproval } from '../../lib/v5/omni-queue.js';
import { omniApproval } from '../handlers/omni-approval.js';

function rt(overrides: Partial<OmniRuntimeConfig> = {}): OmniRuntimeConfig {
  return {
    natsUrl: 'localhost:4222',
    instance: 'inst',
    approvalChat: 'chat-1',
    approveTokens: ['y', 'yes'],
    denyTokens: ['n', 'no'],
    approveReactions: ['\u{1F44D}'],
    denyReactions: ['\u{1F44E}'],
    approvals: { enabled: true, toolMatcher: '^Bash$', pollBudgetMs: 10_000, pollIntervalMs: 1 },
    ...overrides,
  };
}

const PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
  session_id: 'sess-1',
  cwd: '/repo',
  permission_mode: 'default',
};

let dbs: Database[] = [];
function freshDb(): Database {
  const db = openGlobalDb({ path: ':memory:' });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs) db.close();
  dbs = [];
});

describe('omniApproval handler', () => {
  test('approved → permissionDecision:"allow"', async () => {
    const db = freshDb();
    let phoned = false;
    const res = await omniApproval(PAYLOAD, {
      openDb: () => db,
      loadConfig: async () => rt(),
      sleep: async () => {
        if (phoned) return;
        phoned = true;
        const [pending] = listPendingApprovals(db);
        resolveApproval(db, pending.id, 'approved', 'boss');
      },
    });
    expect(res?.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  test('denied → permissionDecision:"deny" with resolver in reason', async () => {
    const db = freshDb();
    let phoned = false;
    const res = await omniApproval(PAYLOAD, {
      openDb: () => db,
      loadConfig: async () => rt(),
      sleep: async () => {
        if (phoned) return;
        phoned = true;
        const [pending] = listPendingApprovals(db);
        resolveApproval(db, pending.id, 'denied', 'boss');
      },
    });
    expect(res?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(res?.hookSpecificOutput?.permissionDecisionReason).toContain('boss');
  });

  test('timeout → permissionDecision:"ask" and the row is expired', async () => {
    const db = freshDb();
    const res = await omniApproval(PAYLOAD, {
      openDb: () => db,
      loadConfig: async () =>
        rt({ approvals: { enabled: true, toolMatcher: '^Bash$', pollBudgetMs: 0, pollIntervalMs: 1 } }),
    });
    expect(res?.hookSpecificOutput?.permissionDecision).toBe('ask');
    // The one row we enqueued must be expired, not left pending for the phone.
    const rows = db.query('SELECT status FROM approvals').all() as Array<{ status: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('expired');
  });

  test('no-op (undefined) under permission_mode auto — nothing enqueued', async () => {
    const db = freshDb();
    const res = await omniApproval(
      { ...PAYLOAD, permission_mode: 'auto' },
      { openDb: () => db, loadConfig: async () => rt() },
    );
    expect(res).toBeUndefined();
    expect(listPendingApprovals(db).length).toBe(0);
  });

  test('no-op (undefined) when the feature is disabled — nothing enqueued', async () => {
    const db = freshDb();
    const res = await omniApproval(PAYLOAD, {
      openDb: () => db,
      loadConfig: async () =>
        rt({ approvals: { enabled: false, toolMatcher: '^Bash$', pollBudgetMs: 10_000, pollIntervalMs: 1 } }),
    });
    expect(res).toBeUndefined();
    expect(listPendingApprovals(db).length).toBe(0);
  });

  test('enqueues a row carrying the tool + repo + session hint', async () => {
    const db = freshDb();
    let seen = false;
    await omniApproval(PAYLOAD, {
      openDb: () => db,
      loadConfig: async () => rt(),
      sleep: async () => {
        if (seen) return;
        seen = true;
        const [pending] = listPendingApprovals(db);
        expect(pending.tool).toBe('Bash');
        expect(pending.repo).toBe('/repo');
        expect(pending.sessionHint).toBe('sess-1');
        expect(getApproval(db, pending.id)?.inputSummary).toContain('rm -rf build');
        resolveApproval(db, pending.id, 'approved', 'boss');
      },
    });
    expect(seen).toBe(true);
  });
});
