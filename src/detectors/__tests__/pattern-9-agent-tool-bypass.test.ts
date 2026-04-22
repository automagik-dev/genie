/**
 * Pattern 9 — Agent-tool bypass detector tests.
 *
 * DI capture pattern: inject `listTranscripts`, `checkAgentIds`, `now` per
 * test; avoid `mock.module` (Bun-global, cannot be undone across files).
 *
 * Issue: #1233.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { start as startScheduler } from '../../serve/detector-scheduler.js';
import { type DetectorModule, __clearDetectorsForTests } from '../index.js';
import {
  type AgentToolBypassState,
  type TranscriptInfo,
  makeAgentToolBypassDetector,
} from '../pattern-9-agent-tool-bypass.js';

interface CapturedEmit {
  type: string;
  payload: Record<string, unknown>;
  opts: Record<string, unknown>;
}

function makeCapture(): {
  captured: CapturedEmit[];
  emit: (t: string, p: Record<string, unknown>, o?: Record<string, unknown>) => void;
} {
  const captured: CapturedEmit[] = [];
  return {
    captured,
    emit(type, payload, opts = {}) {
      captured.push({ type, payload, opts });
    },
  };
}

/** Fixed "now" used by every fixture — 2026-04-22T12:00:00Z. */
const NOW_MS = Date.UTC(2026, 3, 22, 12, 0, 0);

function transcript(overrides: Partial<TranscriptInfo> = {}): TranscriptInfo {
  return {
    agent_id: 'a82478ea1305a8c1c',
    transcript_path: '/tmp/claude-session-xyz/tasks/a82478ea1305a8c1c.output',
    size_bytes: 150_000,
    // One minute ago — well inside the default 10-minute active window.
    mtime_ms: NOW_MS - 60_000,
    ...overrides,
  };
}

function runOnce(detector: DetectorModule<AgentToolBypassState>): Promise<CapturedEmit[]> {
  const { captured, emit } = makeCapture();
  const scheduler = startScheduler({
    tickIntervalMs: 1_000_000,
    jitterMs: 0,
    now: () => NOW_MS,
    detectorSource: () => [detector as DetectorModule<unknown>],
    emitFn: emit,
    setTimeoutFn: () => ({ id: Symbol('test') }),
    clearTimeoutFn: () => {},
  });
  return scheduler.tickNow().then(() => {
    scheduler.stop();
    return captured;
  });
}

describe('rot.agent-tool-bypass (Pattern 9)', () => {
  afterEach(() => {
    __clearDetectorsForTests();
  });

  test('positive fixture: orphan transcript → 1 rot.detected event', async () => {
    const detector = makeAgentToolBypassDetector({
      listTranscripts: async () => [transcript()],
      checkAgentIds: async () => new Set<string>(), // PG says: no such agent
      now: () => NOW_MS,
    });

    const captured = await runOnce(detector);
    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);

    const payload = fires[0].payload as Record<string, unknown>;
    expect(payload.pattern_id).toBe('pattern-9-agent-tool-bypass');
    const obs = payload.observed_state_json as Record<string, unknown>;
    expect(obs.agent_id).toBe('a82478ea1305a8c1c');
    expect(obs.transcript_path).toBe('/tmp/claude-session-xyz/tasks/a82478ea1305a8c1c.output');
    expect(obs.size_bytes).toBe(150_000);
    expect(obs.orphan_count).toBe(1);
    expect(obs.scanned_count).toBe(1);
    expect(obs.agent_ids).toEqual(['a82478ea1305a8c1c']);
    expect(fires[0].opts.detector_version).toBe('1.0.0');
  });

  test('negative: transcript belongs to a known genie agent → 0 events', async () => {
    const detector = makeAgentToolBypassDetector({
      listTranscripts: async () => [transcript({ agent_id: 'known-agent' })],
      checkAgentIds: async () => new Set(['known-agent']),
      now: () => NOW_MS,
    });
    const captured = await runOnce(detector);
    expect(captured.filter((c) => c.type === 'rot.detected').length).toBe(0);
  });

  test('negative: stale transcript (older than active window) → 0 events', async () => {
    const detector = makeAgentToolBypassDetector({
      listTranscripts: async () => [
        // 15 minutes old — outside the 10-minute default window.
        transcript({ mtime_ms: NOW_MS - 15 * 60_000 }),
      ],
      checkAgentIds: async () => new Set<string>(),
      now: () => NOW_MS,
    });
    const captured = await runOnce(detector);
    expect(captured.filter((c) => c.type === 'rot.detected').length).toBe(0);
  });

  test('negative: no transcripts discovered → 0 events, no PG query', async () => {
    let pgCalls = 0;
    const detector = makeAgentToolBypassDetector({
      listTranscripts: async () => [],
      checkAgentIds: async () => {
        pgCalls += 1;
        return new Set();
      },
      now: () => NOW_MS,
    });
    const captured = await runOnce(detector);
    expect(captured.filter((c) => c.type === 'rot.detected').length).toBe(0);
    expect(pgCalls).toBe(0);
  });

  test('aggregate: multiple orphans produce one event with orphan_count', async () => {
    const orphans = [
      transcript({ agent_id: 'orphan-a', transcript_path: '/tmp/claude-s1/tasks/orphan-a.output' }),
      transcript({
        agent_id: 'orphan-b',
        transcript_path: '/tmp/claude-s1/tasks/orphan-b.output',
        size_bytes: 42,
      }),
      transcript({
        agent_id: 'orphan-c',
        transcript_path: '/tmp/claude-s2/tasks/orphan-c.output',
        size_bytes: 2_048,
      }),
    ];
    const detector = makeAgentToolBypassDetector({
      listTranscripts: async () => orphans,
      checkAgentIds: async () => new Set<string>(),
      now: () => NOW_MS,
    });

    const captured = await runOnce(detector);
    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    const obs = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(obs.orphan_count).toBe(3);
    expect(obs.scanned_count).toBe(3);
    expect(obs.agent_ids).toEqual(['orphan-a', 'orphan-b', 'orphan-c']);
    expect(obs.sizes_bytes).toEqual([150_000, 42, 2_048]);
  });

  test('mixed: known + orphan → only orphan reported', async () => {
    const detector = makeAgentToolBypassDetector({
      listTranscripts: async () => [
        transcript({ agent_id: 'known' }),
        transcript({
          agent_id: 'orphan-x',
          transcript_path: '/tmp/claude-s1/tasks/orphan-x.output',
        }),
      ],
      checkAgentIds: async () => new Set(['known']),
      now: () => NOW_MS,
    });
    const captured = await runOnce(detector);
    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    const obs = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(obs.orphan_count).toBe(1);
    expect(obs.scanned_count).toBe(2);
    expect(obs.agent_id).toBe('orphan-x');
  });

  test('payload parses against rot.detected schema', async () => {
    const detector = makeAgentToolBypassDetector({
      listTranscripts: async () => [transcript()],
      checkAgentIds: async () => new Set<string>(),
      now: () => NOW_MS,
    });
    const event = detector.render(await detector.query());
    const { getEntry } = await import('../../lib/events/registry.js');
    const entry = getEntry('rot.detected');
    expect(entry).not.toBeNull();
    const parsed = entry!.schema.safeParse(event.payload);
    if (!parsed.success) {
      console.error('schema parse failed', parsed.error.issues);
    }
    expect(parsed.success).toBe(true);
  });

  test('detector metadata matches contract', () => {
    const detector = makeAgentToolBypassDetector({
      listTranscripts: async () => [],
      checkAgentIds: async () => new Set(),
      now: () => NOW_MS,
    });
    expect(detector.id).toBe('rot.agent-tool-bypass');
    expect(detector.version).toBe('1.0.0');
    expect(detector.riskClass).toBe('medium');
  });
});
