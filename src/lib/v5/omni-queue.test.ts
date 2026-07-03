import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGlobalDb } from './global-db.js';
import {
  ApprovalConflictError,
  UnknownApprovalError,
  UnknownInboundError,
  attachOmniMessageId,
  enqueueApproval,
  expireStale,
  getApproval,
  listInbox,
  listPendingApprovals,
  markHandled,
  recordInbound,
  resolveApproval,
} from './omni-queue.js';

let dir: string;
let db: Database;
const originalGenieHome = process.env.GENIE_HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-omniq-'));
  process.env.GENIE_HOME = dir;
  db = openGlobalDb({ path: join(dir, 'genie.db') });
});

afterEach(() => {
  db.close();
  // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
  if (originalGenieHome === undefined) delete process.env.GENIE_HOME;
  else process.env.GENIE_HOME = originalGenieHome;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------
describe('approvals', () => {
  test('enqueue creates a pending row and round-trips via getApproval', () => {
    const id = enqueueApproval(db, {
      repo: '/home/me/genie',
      tool: 'Bash',
      inputSummary: 'rm -rf build',
      sessionHint: 'sess-1',
      requestedBy: 'agent-a',
      now: 1000,
    });
    const row = getApproval(db, id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('pending');
    expect(row?.repo).toBe('/home/me/genie');
    expect(row?.tool).toBe('Bash');
    expect(row?.inputSummary).toBe('rm -rf build');
    expect(row?.sessionHint).toBe('sess-1');
    expect(row?.requestedBy).toBe('agent-a');
    expect(row?.omniMessageId).toBeNull();
    expect(row?.resolvedBy).toBeNull();
    expect(row?.resolvedAt).toBeNull();
    expect(row?.createdAt).toBe(1000);
  });

  test('optional fields default to null', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Read', inputSummary: 'x' });
    const row = getApproval(db, id);
    expect(row?.sessionHint).toBeNull();
    expect(row?.requestedBy).toBeNull();
  });

  test('getApproval returns null for an unknown id', () => {
    expect(getApproval(db, 'appr_missing')).toBeNull();
  });

  test('attachOmniMessageId tags a pending approval', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x' });
    attachOmniMessageId(db, id, 'wamid.ABC');
    expect(getApproval(db, id)?.omniMessageId).toBe('wamid.ABC');
  });

  test('attachOmniMessageId throws UnknownApprovalError for a missing id', () => {
    expect(() => attachOmniMessageId(db, 'appr_nope', 'm')).toThrow(UnknownApprovalError);
  });

  test('resolveApproval transitions pending -> approved and records resolver/time', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x', now: 100 });
    const resolved = resolveApproval(db, id, 'approved', 'human-1', 500);
    expect(resolved.status).toBe('approved');
    expect(resolved.resolvedBy).toBe('human-1');
    expect(resolved.resolvedAt).toBe(500);
    expect(getApproval(db, id)?.status).toBe('approved');
  });

  test('resolveApproval supports denial (v4 deny -> denied)', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x' });
    expect(resolveApproval(db, id, 'denied', 'human-2').status).toBe('denied');
  });

  test('resolveApproval is single-shot: a second resolve conflicts (in-process)', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x' });
    resolveApproval(db, id, 'approved', 'first');
    expect(() => resolveApproval(db, id, 'denied', 'second')).toThrow(ApprovalConflictError);
    // Winner's decision stands.
    expect(getApproval(db, id)?.status).toBe('approved');
    expect(getApproval(db, id)?.resolvedBy).toBe('first');
  });

  test('resolveApproval throws UnknownApprovalError for a missing id', () => {
    expect(() => resolveApproval(db, 'appr_nope', 'approved', 'x')).toThrow(UnknownApprovalError);
  });

  test('listPendingApprovals returns only pending rows, oldest first', () => {
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'a', now: 1 });
    const b = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'b', now: 2 });
    const c = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'c', now: 3 });
    resolveApproval(db, b, 'approved', 'x');
    const pending = listPendingApprovals(db);
    expect(pending.map((p) => p.id)).toEqual([a, c]);
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------
describe('expireStale', () => {
  test('expires only pending rows older than the horizon', () => {
    const old1 = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'old1', now: 1000 });
    const old2 = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'old2', now: 1500 });
    const fresh = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'fresh', now: 9000 });

    // Horizon: expire anything created at/before now(10000) - olderThanMs(8000) = 2000.
    const expired = expireStale(db, 8000, 10000);
    expect(expired).toBe(2);
    expect(getApproval(db, old1)?.status).toBe('expired');
    expect(getApproval(db, old2)?.status).toBe('expired');
    expect(getApproval(db, fresh)?.status).toBe('pending');
    expect(getApproval(db, old1)?.resolvedAt).toBe(10000);
  });

  test('does not touch already-resolved rows and is idempotent', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x', now: 1000 });
    resolveApproval(db, id, 'approved', 'human', 1100);
    expect(expireStale(db, 0, 10000)).toBe(0);
    expect(getApproval(db, id)?.status).toBe('approved');
    // Second call over an empty pending set is a no-op.
    expect(expireStale(db, 0, 10000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------
describe('inbox', () => {
  test('recordInbound round-trips and starts unhandled', () => {
    const id = recordInbound(db, {
      instance: 'wa-1',
      chat: 'chat-42',
      sender: '+15550001111',
      body: 'approve please',
      now: 200,
    });
    const [row] = listInbox(db);
    expect(row.id).toBe(id);
    expect(row.instance).toBe('wa-1');
    expect(row.chat).toBe('chat-42');
    expect(row.sender).toBe('+15550001111');
    expect(row.body).toBe('approve please');
    expect(row.receivedAt).toBe(200);
    expect(row.handledAt).toBeNull();
  });

  test('markHandled stamps handled_at and filters split correctly', () => {
    const a = recordInbound(db, { instance: 'i', chat: 'c', sender: 's', body: 'a', now: 1 });
    const b = recordInbound(db, { instance: 'i', chat: 'c', sender: 's', body: 'b', now: 2 });
    markHandled(db, a, 500);

    expect(listInbox(db, { handled: false }).map((r) => r.id)).toEqual([b]);
    const handled = listInbox(db, { handled: true });
    expect(handled.map((r) => r.id)).toEqual([a]);
    expect(handled[0].handledAt).toBe(500);
  });

  test('listInbox filters by instance and chat', () => {
    recordInbound(db, { instance: 'i1', chat: 'c1', sender: 's', body: 'x', now: 1 });
    recordInbound(db, { instance: 'i2', chat: 'c1', sender: 's', body: 'y', now: 2 });
    recordInbound(db, { instance: 'i1', chat: 'c2', sender: 's', body: 'z', now: 3 });
    expect(listInbox(db, { instance: 'i1' }).map((r) => r.body)).toEqual(['x', 'z']);
    expect(listInbox(db, { instance: 'i1', chat: 'c1' }).map((r) => r.body)).toEqual(['x']);
  });

  test('markHandled throws UnknownInboundError for a missing id', () => {
    expect(() => markHandled(db, 'inb_nope')).toThrow(UnknownInboundError);
  });
});

// ---------------------------------------------------------------------------
// Multi-PROCESS resolution race: N concurrent bun processes resolve the same
// pending approval against one shared on-disk WAL database. Exactly one must
// win with 'approved'; every loser must get a typed ApprovalConflictError. This
// is the real proof the conditional-UPDATE-in-a-transaction is atomic across
// processes. Mirrors task-state.test.ts's checkout-race pattern.
// ---------------------------------------------------------------------------
describe('multi-process resolution race', () => {
  test('exactly one of N concurrent resolvers wins', async () => {
    const dbPath = join(dir, 'race.db');
    const seed = openGlobalDb({ path: dbPath });
    const id = enqueueApproval(seed, { repo: '/r', tool: 'Bash', inputSummary: 'contended' });
    seed.close(); // checkpoint so child processes see the committed row

    const gdbPath = join(import.meta.dir, 'global-db.ts');
    const queuePath = join(import.meta.dir, 'omni-queue.ts');
    const workerPath = join(dir, 'resolve-worker.ts');
    writeFileSync(
      workerPath,
      `
import { openGlobalDb } from ${JSON.stringify(gdbPath)};
import { resolveApproval, ApprovalConflictError } from ${JSON.stringify(queuePath)};
const [dbPath, id, resolver] = process.argv.slice(2);
const db = openGlobalDb({ path: dbPath });
try {
  resolveApproval(db, id, 'approved', resolver);
  process.stdout.write('WON');
} catch (e) {
  if (e instanceof ApprovalConflictError) process.stdout.write('CONFLICT');
  else { process.stdout.write('ERR:' + (e && e.message)); process.exitCode = 3; }
} finally {
  db.close();
}
`,
    );

    const N = 8;
    const runs = Array.from({ length: N }, (_, i) => {
      const proc = Bun.spawn(['bun', 'run', workerPath, dbPath, id, `resolver-${i}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return (async () => {
        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        return { out, err, code };
      })();
    });

    const settled = await Promise.allSettled(runs);
    const outcomes = settled.map((s) =>
      s.status === 'fulfilled' ? `${s.value.out}(exit ${s.value.code})` : `REJECTED:${s.reason}`,
    );

    const wins = outcomes.filter((o) => o.startsWith('WON')).length;
    const conflicts = outcomes.filter((o) => o.startsWith('CONFLICT')).length;

    if (wins !== 1 || conflicts !== N - 1) {
      console.error('race outcomes:', JSON.stringify(outcomes));
      for (const s of settled) {
        if (s.status === 'fulfilled' && !s.value.out.startsWith('WON') && !s.value.out.startsWith('CONFLICT')) {
          console.error('straggler stderr:', s.value.err);
        }
      }
    }

    expect(wins).toBe(1);
    expect(conflicts).toBe(N - 1);

    // Final state: exactly one resolver owns the decision, status approved.
    const verify = openGlobalDb({ path: dbPath });
    const final = getApproval(verify, id);
    verify.close();
    expect(final?.status).toBe('approved');
    expect(final?.resolvedBy).toMatch(/^resolver-\d+$/);
  }, 60_000);
});
