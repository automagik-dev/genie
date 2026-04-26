/**
 * Tests for `detectRecoveryAnchorAtRisk`.
 *
 * Covers both fingerprints (legacy `session.reconciled` overwrite on a
 * terminal-state executor; post-fix `session.divergence_preserved`),
 * and verifies that benign reconciliations (first capture, active rotation)
 * do NOT fire the signal — false positives would erode operator trust.
 */

import { describe, expect, test } from 'bun:test';
import type { AuditEventRow } from '../audit.js';
import type { Executor } from '../executor-types.js';
import { detectRecoveryAnchorAtRisk } from './recovery-anchor.js';

function fakeExecutor(state: Executor['state']): Executor {
  return {
    id: 'exec-1',
    agentId: 'agent-1',
    provider: 'claude',
    transport: 'tmux',
    pid: 1234,
    tmuxSession: 'genie',
    tmuxPaneId: '%1',
    tmuxWindow: 'win',
    tmuxWindowId: '@1',
    claudeSessionId: 'new-uuid',
    state,
    metadata: {},
    worktree: null,
    repoPath: '/tmp/repo',
    paneColor: null,
    startedAt: '2026-04-25T10:00:00.000Z',
    endedAt: null,
    createdAt: '2026-04-25T10:00:00.000Z',
    updatedAt: '2026-04-25T10:00:00.000Z',
    turnId: null,
    outcome: null,
    closedAt: null,
    closeReason: null,
  };
}

function row(overrides: Partial<AuditEventRow>): AuditEventRow {
  return {
    id: 1,
    entity_type: 'executor',
    entity_id: 'exec-1',
    event_type: 'session.reconciled',
    actor: 'session-sync',
    details: {},
    created_at: '2026-04-25T11:00:00.000Z',
    ...overrides,
  };
}

describe('detectRecoveryAnchorAtRisk', () => {
  test('legacy fingerprint: session.reconciled overwriting terminal executor → fires', async () => {
    const sig = await detectRecoveryAnchorAtRisk(
      row({
        event_type: 'session.reconciled',
        details: { old_session_id: 'old-uuid', new_session_id: 'new-uuid' },
      }),
      { getExecutor: async () => fakeExecutor('terminated') },
    );
    expect(sig?.type).toBe('observability.recovery_anchor_at_risk');
    expect(sig?.subject).toBe('exec-1');
    expect(sig?.details.fingerprint).toBe('legacy_reconciled');
    expect(sig?.severity).toBe('critical');
  });

  test('first capture (oldId null) → does NOT fire', async () => {
    const sig = await detectRecoveryAnchorAtRisk(
      row({
        details: { old_session_id: null, new_session_id: 'new-uuid' },
      }),
      { getExecutor: async () => fakeExecutor('terminated') },
    );
    expect(sig).toBeNull();
  });

  test('same UUID (no actual rotation) → does NOT fire', async () => {
    const sig = await detectRecoveryAnchorAtRisk(
      row({
        details: { old_session_id: 'same-uuid', new_session_id: 'same-uuid' },
      }),
      { getExecutor: async () => fakeExecutor('terminated') },
    );
    expect(sig).toBeNull();
  });

  test('active executor rotation → does NOT fire (benign rotation)', async () => {
    const sig = await detectRecoveryAnchorAtRisk(
      row({
        details: { old_session_id: 'old-uuid', new_session_id: 'new-uuid' },
      }),
      { getExecutor: async () => fakeExecutor('working') },
    );
    expect(sig).toBeNull();
  });

  test('executor lookup fails → does NOT fire (cannot prove fingerprint)', async () => {
    const sig = await detectRecoveryAnchorAtRisk(
      row({
        details: { old_session_id: 'old-uuid', new_session_id: 'new-uuid' },
      }),
      { getExecutor: async () => null },
    );
    expect(sig).toBeNull();
  });

  test('post-fix fingerprint: session.divergence_preserved → fires', async () => {
    const sig = await detectRecoveryAnchorAtRisk(
      row({
        event_type: 'session.divergence_preserved',
        details: {
          stored_session_id: 'old-uuid',
          live_session_id: 'new-uuid',
          executor_state: 'terminated',
        },
      }),
      { getExecutor: async () => fakeExecutor('terminated') },
    );
    expect(sig?.type).toBe('observability.recovery_anchor_at_risk');
    expect(sig?.details.fingerprint).toBe('divergence_preserved');
    expect(sig?.details.stored_session_id).toBe('old-uuid');
  });

  test('non-executor entity type → ignored', async () => {
    const sig = await detectRecoveryAnchorAtRisk(
      row({
        entity_type: 'agent',
        event_type: 'session.reconciled',
        details: { old_session_id: 'old', new_session_id: 'new' },
      }),
      { getExecutor: async () => fakeExecutor('terminated') },
    );
    expect(sig).toBeNull();
  });

  test('unrelated event type → ignored', async () => {
    const sig = await detectRecoveryAnchorAtRisk(row({ event_type: 'state_changed', details: { state: 'error' } }), {
      getExecutor: async () => fakeExecutor('terminated'),
    });
    expect(sig).toBeNull();
  });

  test('signal triggeredAt mirrors the source row created_at', async () => {
    const sig = await detectRecoveryAnchorAtRisk(
      row({
        created_at: '2026-04-25T13:14:15.000Z',
        details: { old_session_id: 'old', new_session_id: 'new' },
      }),
      { getExecutor: async () => fakeExecutor('done') },
    );
    expect(sig?.triggeredAt).toBe('2026-04-25T13:14:15.000Z');
  });
});
