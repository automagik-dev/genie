/**
 * omni-approval PreToolUse handler — resolves allow/deny/ask against a real
 * global genie.db (in-memory, no network). Drives the poll loop deterministically
 * by injecting a `sleep` that plays the "phone" once, mid-wait.
 */
import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_APPROVAL_POLL_BUDGET_MS, type OmniRuntimeConfig, normalizeApprovalTiming } from '../../lib/omni-config.js';
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
  test('normalizes approval timing inside the 115s child / 125s host safety ladder', () => {
    expect(normalizeApprovalTiming(999_999, 999_999)).toEqual({
      pollBudgetMs: MAX_APPROVAL_POLL_BUDGET_MS,
      pollIntervalMs: MAX_APPROVAL_POLL_BUDGET_MS,
    });
    expect(normalizeApprovalTiming(10_000, 0)).toEqual({ pollBudgetMs: 10_000, pollIntervalMs: 400 });
    expect(normalizeApprovalTiming(-1, -1)).toEqual({
      pollBudgetMs: MAX_APPROVAL_POLL_BUDGET_MS,
      pollIntervalMs: 400,
    });
    expect(normalizeApprovalTiming(0.5, 0.25)).toEqual({ pollBudgetMs: 1, pollIntervalMs: 1 });
  });

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

  test('redacts sensitive fields and command assignments before queueing the preview', async () => {
    const db = freshDb();
    const secrets = [
      'super-secret',
      'aws-secret',
      'cli-secret',
      'bearer-secret',
      'basic-secret',
      'digest-secret',
      'negotiate-secret',
      'proxy-secret',
      'session-secret',
      'quoted-cookie-secret',
      'set-cookie-secret',
      'plain-secret',
    ];
    await omniApproval(
      {
        ...PAYLOAD,
        tool_input: {
          command:
            'API_KEY=super-secret AWS_SECRET_ACCESS_KEY=aws-secret tool --token cli-secret ' +
            '-H "Authorization: Bearer bearer-secret" ' +
            "-H 'Authorization: Basic basic-secret' " +
            '--header="Authorization: Digest digest-secret" ' +
            'Authorization: "Negotiate negotiate-secret" ' +
            '-H "Proxy-Authorization: Custom proxy-secret" ' +
            '-H "Cookie: session=session-secret" ' +
            "-H 'Cookie: session=quoted-cookie-secret; theme=dark' " +
            '-H "Set-Cookie: session=set-cookie-secret; HttpOnly" example.test',
          password: 'plain-secret',
        },
      },
      {
        openDb: () => db,
        loadConfig: async () => rt(),
        sleep: async () => {
          const [pending] = listPendingApprovals(db);
          const summary = getApproval(db, pending.id)?.inputSummary ?? '';
          for (const secret of secrets) expect(summary).not.toContain(secret);
          expect(summary).toContain('[REDACTED]');
          resolveApproval(db, pending.id, 'approved', 'boss');
        },
      },
    );
  });

  test('uses allowlisted structural previews instead of serializing edit content or unknown values', async () => {
    const cases = [
      {
        tool_name: 'Write',
        tool_input: { file_path: 'src/safe.ts', content: 'write-content-secret', authorization: 'field-secret' },
        visible: 'src/safe.ts',
        hidden: ['write-content-secret', 'field-secret'],
      },
      {
        tool_name: 'apply_patch',
        tool_input: {
          command: '*** Begin Patch\n*** Update File: src/patched.ts\n@@\n+patch-content-secret\n*** End Patch',
        },
        visible: 'src/patched.ts',
        hidden: ['patch-content-secret'],
      },
      {
        tool_name: 'mcp__private__custom',
        tool_input: { prompt: 'unknown-value-secret', token: 'unknown-token-secret' },
        visible: '"inputFieldCount":2',
        hidden: ['unknown-value-secret', 'unknown-token-secret'],
      },
    ];

    for (const fixture of cases) {
      const db = freshDb();
      await omniApproval(
        { ...PAYLOAD, tool_name: fixture.tool_name, tool_input: fixture.tool_input },
        {
          openDb: () => db,
          loadConfig: async () => rt(),
          sleep: async () => {
            const [pending] = listPendingApprovals(db);
            const summary = getApproval(db, pending.id)?.inputSummary ?? '';
            expect(summary).toContain(fixture.visible);
            for (const secret of fixture.hidden) expect(summary).not.toContain(secret);
            resolveApproval(db, pending.id, 'approved', 'boss');
          },
        },
      );
    }
  });

  test('caps multibyte approval previews by UTF-8 bytes', async () => {
    const db = freshDb();
    await omniApproval(
      { ...PAYLOAD, tool_input: { command: `echo ${'🙂'.repeat(400)}` } },
      {
        openDb: () => db,
        loadConfig: async () => rt(),
        sleep: async () => {
          const [pending] = listPendingApprovals(db);
          const summary = getApproval(db, pending.id)?.inputSummary ?? '';
          expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(500);
          expect(summary).not.toContain('\uFFFD');
          resolveApproval(db, pending.id, 'approved', 'boss');
        },
      },
    );
  });

  test('process interruption cleanup expires this request and unregisters', async () => {
    const db = freshDb();
    let interrupt: (() => void) | undefined;
    let unregistered = false;
    const res = await omniApproval(PAYLOAD, {
      openDb: () => db,
      loadConfig: async () => rt(),
      registerInterruptCleanup: (cleanup) => {
        interrupt = cleanup;
        return () => {
          unregistered = true;
        };
      },
      sleep: async () => interrupt?.(),
    });
    expect(res?.hookSpecificOutput?.permissionDecision).toBe('ask');
    expect(unregistered).toBe(true);
    const rows = db.query('SELECT status FROM approvals').all() as Array<{ status: string }>;
    expect(rows).toEqual([{ status: 'expired' }]);
  });

  test('a poll failure cannot strand a pending approval row', async () => {
    const db = freshDb();
    const res = await omniApproval(PAYLOAD, {
      openDb: () => db,
      loadConfig: async () => rt(),
      sleep: async () => {
        throw new Error('poll interrupted');
      },
    });
    expect(res?.hookSpecificOutput?.permissionDecision).toBe('ask');
    const rows = db.query('SELECT status FROM approvals').all() as Array<{ status: string }>;
    expect(rows).toEqual([{ status: 'expired' }]);
  });
});
