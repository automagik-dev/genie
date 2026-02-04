/**
 * Event Aggregator Tests
 *
 * Tests for the event aggregator that maintains per-worker state
 * from the wish-21 NormalizedEvent stream.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createEventAggregator,
  type WorkerDashboardState,
  type EventAggregator,
} from './event-aggregator.js';
import type { NormalizedEvent } from '../term-commands/events.js';

// ============================================================================
// Helpers
// ============================================================================

function makeEvent(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId: 'sess-1',
    cwd: '/tmp/test',
    paneId: '%42',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('EventAggregator', () => {
  let aggregator: EventAggregator;

  beforeEach(() => {
    aggregator = createEventAggregator();
  });

  // --------------------------------------------------------------------------
  // Basic state tracking
  // --------------------------------------------------------------------------

  describe('processEvent', () => {
    test('creates worker state on first event for a pane', () => {
      const event = makeEvent({
        type: 'tool_call',
        paneId: '%42',
        toolName: 'Read',
        timestamp: '2026-02-03T10:00:00.000Z',
      });

      aggregator.processEvent(event);
      const states = aggregator.getWorkerStates();

      expect(states).toHaveLength(1);
      expect(states[0].paneId).toBe('%42');
      expect(states[0].status).toBe('running');
      expect(states[0].lastEvent).toBeDefined();
      expect(states[0].lastEvent!.type).toBe('tool_call');
      expect(states[0].lastEvent!.toolName).toBe('Read');
      expect(states[0].eventCount).toBe(1);
    });

    test('updates existing worker state on subsequent events', () => {
      aggregator.processEvent(makeEvent({
        type: 'tool_call',
        paneId: '%42',
        toolName: 'Read',
        timestamp: '2026-02-03T10:00:00.000Z',
      }));

      aggregator.processEvent(makeEvent({
        type: 'tool_call',
        paneId: '%42',
        toolName: 'Write',
        timestamp: '2026-02-03T10:00:05.000Z',
      }));

      const states = aggregator.getWorkerStates();

      expect(states).toHaveLength(1);
      expect(states[0].lastEvent!.toolName).toBe('Write');
      expect(states[0].eventCount).toBe(2);
    });

    test('tracks multiple workers independently', () => {
      aggregator.processEvent(makeEvent({
        paneId: '%42',
        toolName: 'Read',
      }));

      aggregator.processEvent(makeEvent({
        paneId: '%43',
        toolName: 'Bash',
      }));

      const states = aggregator.getWorkerStates();
      expect(states).toHaveLength(2);

      const worker42 = states.find(s => s.paneId === '%42');
      const worker43 = states.find(s => s.paneId === '%43');
      expect(worker42).toBeDefined();
      expect(worker43).toBeDefined();
      expect(worker42!.lastEvent!.toolName).toBe('Read');
      expect(worker43!.lastEvent!.toolName).toBe('Bash');
    });

    test('ignores events without paneId', () => {
      aggregator.processEvent(makeEvent({
        paneId: undefined,
        toolName: 'Read',
      }));

      expect(aggregator.getWorkerStates()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  describe('session lifecycle', () => {
    test('session_start sets status to running', () => {
      aggregator.processEvent(makeEvent({
        type: 'session_start',
        paneId: '%42',
      }));

      const states = aggregator.getWorkerStates();
      expect(states[0].status).toBe('running');
    });

    test('session_end sets status to stopped', () => {
      aggregator.processEvent(makeEvent({
        type: 'session_start',
        paneId: '%42',
      }));

      aggregator.processEvent(makeEvent({
        type: 'session_end',
        paneId: '%42',
      }));

      const states = aggregator.getWorkerStates();
      expect(states[0].status).toBe('stopped');
    });

    test('tool_call sets status to running', () => {
      aggregator.processEvent(makeEvent({
        type: 'tool_call',
        paneId: '%42',
        toolName: 'Read',
      }));

      const states = aggregator.getWorkerStates();
      expect(states[0].status).toBe('running');
    });
  });

  // --------------------------------------------------------------------------
  // Permission request tracking
  // --------------------------------------------------------------------------

  describe('permission requests', () => {
    test('permission_request sets status to waiting', () => {
      aggregator.processEvent(makeEvent({
        type: 'permission_request',
        paneId: '%42',
        toolName: 'Bash',
      }));

      const states = aggregator.getWorkerStates();
      expect(states[0].status).toBe('waiting');
    });

    test('tool_call after permission_request resets to running', () => {
      aggregator.processEvent(makeEvent({
        type: 'permission_request',
        paneId: '%42',
        toolName: 'Bash',
      }));

      aggregator.processEvent(makeEvent({
        type: 'tool_call',
        paneId: '%42',
        toolName: 'Read',
      }));

      const states = aggregator.getWorkerStates();
      expect(states[0].status).toBe('running');
    });
  });

  // --------------------------------------------------------------------------
  // Wish ID tracking
  // --------------------------------------------------------------------------

  describe('wish ID tracking', () => {
    test('captures wishId from events', () => {
      aggregator.processEvent(makeEvent({
        paneId: '%42',
        wishId: 'wish-21',
      }));

      const states = aggregator.getWorkerStates();
      expect(states[0].wishId).toBe('wish-21');
    });

    test('updates wishId when it changes', () => {
      aggregator.processEvent(makeEvent({
        paneId: '%42',
        wishId: 'wish-21',
      }));

      aggregator.processEvent(makeEvent({
        paneId: '%42',
        wishId: 'wish-24',
      }));

      const states = aggregator.getWorkerStates();
      expect(states[0].wishId).toBe('wish-24');
    });
  });

  // --------------------------------------------------------------------------
  // Timestamp tracking
  // --------------------------------------------------------------------------

  describe('timestamp tracking', () => {
    test('lastActivityAt updates with each event', () => {
      const t1 = '2026-02-03T10:00:00.000Z';
      const t2 = '2026-02-03T10:00:30.000Z';

      aggregator.processEvent(makeEvent({
        paneId: '%42',
        timestamp: t1,
      }));

      const states1 = aggregator.getWorkerStates();
      const firstActivity = states1[0].lastActivityAt;

      aggregator.processEvent(makeEvent({
        paneId: '%42',
        timestamp: t2,
      }));

      const states2 = aggregator.getWorkerStates();
      expect(states2[0].lastActivityAt).toBeGreaterThan(firstActivity);
    });

    test('lastEvent.timestamp reflects the event timestamp', () => {
      const ts = '2026-02-03T10:00:00.000Z';

      aggregator.processEvent(makeEvent({
        paneId: '%42',
        timestamp: ts,
      }));

      const states = aggregator.getWorkerStates();
      expect(states[0].lastEvent!.timestamp).toBe(new Date(ts).getTime());
    });
  });

  // --------------------------------------------------------------------------
  // getWorkerState (single worker)
  // --------------------------------------------------------------------------

  describe('getWorkerState', () => {
    test('returns state for a specific pane', () => {
      aggregator.processEvent(makeEvent({ paneId: '%42', toolName: 'Read' }));
      aggregator.processEvent(makeEvent({ paneId: '%43', toolName: 'Bash' }));

      const state = aggregator.getWorkerState('%42');
      expect(state).toBeDefined();
      expect(state!.paneId).toBe('%42');
    });

    test('returns undefined for unknown pane', () => {
      const state = aggregator.getWorkerState('%99');
      expect(state).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Reset / clear
  // --------------------------------------------------------------------------

  describe('reset', () => {
    test('clears all worker states', () => {
      aggregator.processEvent(makeEvent({ paneId: '%42' }));
      aggregator.processEvent(makeEvent({ paneId: '%43' }));

      aggregator.reset();

      expect(aggregator.getWorkerStates()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Fallback mode
  // --------------------------------------------------------------------------

  describe('getFallbackWorkerStates', () => {
    test('returns worker states from registry data', async () => {
      // Test fallback with mock registry workers
      const mockWorkers = [
        {
          id: 'bd-1',
          paneId: '%42',
          session: 'test',
          worktree: null,
          taskId: 'bd-1',
          taskTitle: 'Test task',
          wishSlug: 'wish-21',
          startedAt: '2026-02-03T10:00:00.000Z',
          state: 'working' as const,
          lastStateChange: '2026-02-03T10:00:00.000Z',
          repoPath: '/tmp/test',
        },
        {
          id: 'bd-2',
          paneId: '%43',
          session: 'test',
          worktree: null,
          taskId: 'bd-2',
          wishSlug: 'wish-24',
          startedAt: '2026-02-03T09:00:00.000Z',
          state: 'permission' as const,
          lastStateChange: '2026-02-03T09:30:00.000Z',
          repoPath: '/tmp/test',
        },
      ];

      const states = aggregator.buildFallbackStates(mockWorkers);

      expect(states).toHaveLength(2);

      const w1 = states.find(s => s.paneId === '%42');
      const w2 = states.find(s => s.paneId === '%43');

      expect(w1).toBeDefined();
      expect(w1!.status).toBe('running');
      expect(w1!.wishId).toBe('wish-21');

      expect(w2).toBeDefined();
      expect(w2!.status).toBe('waiting');
      expect(w2!.wishId).toBe('wish-24');
    });

    test('maps registry states to dashboard statuses correctly', () => {
      const testCases: Array<{ registryState: string; expectedStatus: string }> = [
        { registryState: 'working', expectedStatus: 'running' },
        { registryState: 'spawning', expectedStatus: 'running' },
        { registryState: 'idle', expectedStatus: 'idle' },
        { registryState: 'permission', expectedStatus: 'waiting' },
        { registryState: 'question', expectedStatus: 'waiting' },
        { registryState: 'done', expectedStatus: 'stopped' },
        { registryState: 'error', expectedStatus: 'stopped' },
      ];

      for (const tc of testCases) {
        const states = aggregator.buildFallbackStates([{
          id: 'test',
          paneId: '%50',
          session: 'test',
          worktree: null,
          taskId: 'test',
          startedAt: '2026-02-03T10:00:00.000Z',
          state: tc.registryState as any,
          lastStateChange: '2026-02-03T10:00:00.000Z',
          repoPath: '/tmp/test',
        }]);

        expect(states[0].status).toBe(tc.expectedStatus);
      }
    });
  });
});
