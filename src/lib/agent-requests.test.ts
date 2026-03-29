import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createRequest,
  followRequests,
  getRequest,
  listRequests,
  rejectRequest,
  resolveRequest,
} from './agent-requests.js';
import { DB_AVAILABLE, setupTestSchema } from './test-db.js';

let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  cleanup = await setupTestSchema();
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe.skipIf(!DB_AVAILABLE)('agent-requests', () => {
  test('creates and retrieves a request', async () => {
    const request = await createRequest({
      agentId: 'engineer-1',
      type: 'env',
      payload: { key: 'STRIPE_API_KEY', reason: 'Payment processing' },
      team: 'test-team',
      taskId: 'task-123',
    });

    expect(request.id).toBeTruthy();
    expect(request.agentId).toBe('engineer-1');
    expect(request.type).toBe('env');
    expect(request.status).toBe('pending');
    expect(request.payload).toEqual({ key: 'STRIPE_API_KEY', reason: 'Payment processing' });
    expect(request.team).toBe('test-team');
    expect(request.taskId).toBe('task-123');
    expect(request.resolvedBy).toBeNull();
    expect(request.resolvedValue).toBeNull();
    expect(request.resolvedAt).toBeNull();

    const fetched = await getRequest(request.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(request.id);
  });

  test('lists requests with filters', async () => {
    await createRequest({
      agentId: 'eng-a',
      type: 'confirm',
      payload: { question: 'Deploy?' },
      team: 'filter-team',
    });
    await createRequest({
      agentId: 'eng-b',
      type: 'choice',
      payload: { question: 'Which model?', options: ['opus', 'sonnet'] },
      team: 'filter-team',
    });
    await createRequest({
      agentId: 'eng-a',
      type: 'input',
      payload: { prompt: 'Client name?' },
      team: 'other-team',
    });

    const byTeam = await listRequests({ team: 'filter-team' });
    expect(byTeam.length).toBeGreaterThanOrEqual(2);

    const byAgent = await listRequests({ agentId: 'eng-a' });
    expect(byAgent.length).toBeGreaterThanOrEqual(2);

    const byType = await listRequests({ type: 'confirm' });
    expect(byType.length).toBeGreaterThanOrEqual(1);
    expect(byType.every((r) => r.type === 'confirm')).toBe(true);
  });

  test('resolves a pending request', async () => {
    const request = await createRequest({
      agentId: 'eng-resolve',
      type: 'env',
      payload: { key: 'DB_URL' },
    });

    const resolved = await resolveRequest(request.id, 'human:felipe', { value: 'postgres://...' });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toBe('human:felipe');
    expect(resolved.resolvedValue).toEqual({ value: 'postgres://...' });
    expect(resolved.resolvedAt).toBeTruthy();
  });

  test('rejects a pending request', async () => {
    const request = await createRequest({
      agentId: 'eng-reject',
      type: 'approve',
      payload: { action: 'delete_branch' },
    });

    const rejected = await rejectRequest(request.id, 'human:felipe', 'Too risky');
    expect(rejected.status).toBe('rejected');
    expect(rejected.resolvedBy).toBe('human:felipe');
    expect(rejected.resolvedValue).toEqual({ reason: 'Too risky' });
  });

  test('resolve fails on non-pending request', async () => {
    const request = await createRequest({
      agentId: 'eng-double',
      type: 'confirm',
      payload: { question: 'OK?' },
    });

    await resolveRequest(request.id, 'human:felipe', { confirmed: true });

    // Second resolve should fail
    expect(resolveRequest(request.id, 'human:felipe', { confirmed: false })).rejects.toThrow(
      /not found or not pending/,
    );
  });

  test('getPendingRequests returns only pending', async () => {
    const pending = await createRequest({
      agentId: 'eng-pending-check',
      type: 'input',
      payload: { prompt: 'Name?' },
      team: 'pending-team',
    });
    const resolved = await createRequest({
      agentId: 'eng-pending-check',
      type: 'confirm',
      payload: { question: 'OK?' },
      team: 'pending-team',
    });
    await resolveRequest(resolved.id, 'human', { confirmed: true });

    const { getPendingRequests } = await import('./agent-requests.js');
    const pendingList = await getPendingRequests('pending-team');
    const ids = pendingList.map((r) => r.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(resolved.id);
  });

  test('followRequests receives NOTIFY on creation', async () => {
    const received: string[] = [];
    const handle = await followRequests((requestId, _agentId, type, status) => {
      received.push(`${requestId}:${type}:${status}`);
    });

    try {
      const req = await createRequest({
        agentId: 'eng-follow',
        type: 'env',
        payload: { key: 'API_KEY' },
      });

      // Wait for the NOTIFY to propagate
      const started = Date.now();
      while (Date.now() - started < 2000) {
        if (received.some((r) => r.includes(req.id))) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(received.some((r) => r.includes(req.id) && r.includes('pending'))).toBe(true);
    } finally {
      await handle.stop();
    }
  });
});
