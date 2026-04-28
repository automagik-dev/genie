import { afterEach, describe, expect, test } from 'bun:test';
import { start as startScheduler } from '../../serve/detector-scheduler.js';
import { type DetectorModule, __clearDetectorsForTests } from '../index.js';
import {
  type DispatchSilentDropRow,
  type DispatchSilentDropState,
  extractDeliveredBroadcastRecipients,
  makeDispatchSilentDropDetector,
} from '../pattern-7-dispatch-silent-drop.js';

interface CapturedEmit {
  type: string;
  payload: Record<string, unknown>;
}

function drop(overrides: Partial<DispatchSilentDropRow> = {}): DispatchSilentDropRow {
  return {
    team: 'fix-team',
    broadcast_id: '12345',
    broadcast_at: '2026-04-28T12:00:00.000Z',
    idle_member_ids: ['engineer'],
    expected_prompt_count: 1,
    actual_prompt_count: 0,
    ...overrides,
  };
}

async function runDetector(state: DispatchSilentDropState): Promise<CapturedEmit[]> {
  const captured: CapturedEmit[] = [];
  const detector = makeDispatchSilentDropDetector({ loadState: async () => state });
  const scheduler = startScheduler({
    tickIntervalMs: 1_000_000,
    jitterMs: 0,
    now: () => Date.UTC(2026, 3, 28, 12, 2, 0),
    detectorSource: () => [detector as DetectorModule<unknown>],
    emitFn: (type, payload) => captured.push({ type, payload }),
    setTimeoutFn: () => ({ id: Symbol('test') }),
    clearTimeoutFn: () => {},
  });
  await scheduler.tickNow();
  scheduler.stop();
  return captured;
}

describe('rot.dispatch-silent-drop broadcast fan-out audit', () => {
  afterEach(() => {
    __clearDetectorsForTests();
  });

  test('pre-fix broadcast shape has no recipient audit and still fires via roster fallback', async () => {
    expect(extractDeliveredBroadcastRecipients({ messageId: 1, team: 'fix-team' })).toBeNull();

    const captured = await runDetector({ drops: [drop()] });

    const fires = captured.filter((event) => event.type === 'rot.detected');
    expect(fires.length).toBe(1);
    expect(fires[0].payload.pattern_id).toBe('pattern-7-dispatch-silent-drop');
  });

  test('post-fix broadcast shape with delivered recipients and prompt evidence stays silent', async () => {
    const delivered = extractDeliveredBroadcastRecipients({
      messageId: 1,
      team: 'fix-team',
      recipients: [
        { agent: 'engineer', delivered: true },
        { agent: 'reviewer', delivered: true },
        { agent: 'offline-worker', delivered: false, reason: 'offline' },
      ],
    });
    const prompted = new Set(['engineer', 'reviewer']);

    expect(delivered).toEqual(['engineer', 'reviewer']);
    expect(delivered?.filter((agent) => !prompted.has(agent))).toEqual([]);

    const captured = await runDetector({ drops: [] });
    expect(captured.filter((event) => event.type === 'rot.detected')).toEqual([]);
  });

  test('self-broadcast recipient audit is a clean no-op snapshot', () => {
    expect(extractDeliveredBroadcastRecipients({ recipients: [] })).toEqual([]);
  });
});
