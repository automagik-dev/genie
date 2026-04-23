/**
 * Pattern 8 — Session Reuse Ghost Detector tests.
 *
 * DI capture pattern. Additional unit coverage for the topic-token +
 * Jaccard helpers since the heuristic is the weakest link in V1 and will
 * be tuned post-evidence-gate.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3c).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { start as startScheduler } from '../../serve/detector-scheduler.js';
import { type DetectorModule, __clearDetectorsForTests } from '../index.js';
import {
  type SessionReuseGhostRow,
  type SessionReuseGhostState,
  TOPIC_MISMATCH_THRESHOLD,
  TOPIC_SEED_TOKEN_CAP,
  jaccard,
  makeSessionReuseGhostDetector,
  topicTokens,
} from '../pattern-8-session-reuse-ghost.js';

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

function ghost(overrides: Partial<SessionReuseGhostRow> = {}): SessionReuseGhostRow {
  return {
    new_agent_id: 'fresh-42',
    new_team: 'wish-42',
    new_topic_seed: 'fix router timeout regression',
    conflicting_archived_agent_id: 'old-17',
    conflicting_archived_team: 'wish-17',
    conflicting_archived_last_transcript_preview: 'refactor payment gateway integration',
    jaccard_similarity: 0.0,
    ...overrides,
  };
}

describe('topic heuristic helpers', () => {
  test('topicTokens normalizes case, strips punctuation, caps length', () => {
    expect(topicTokens('Fix: Bug #1215 in router!!')).toEqual(['fix', 'bug', '1215', 'in', 'router']);
  });

  test('topicTokens caps at TOPIC_SEED_TOKEN_CAP', () => {
    const tokens = topicTokens('one two three four five six seven eight nine ten');
    expect(tokens.length).toBe(TOPIC_SEED_TOKEN_CAP);
    expect(tokens[0]).toBe('one');
    expect(tokens[tokens.length - 1]).toBe('eight');
  });

  test('jaccard of identical sets is 1', () => {
    expect(jaccard(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
  });

  test('jaccard of disjoint sets is 0', () => {
    expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  test('jaccard of empty sets is 0', () => {
    expect(jaccard([], [])).toBe(0);
  });

  test('heuristic fires below threshold: different topics', () => {
    const a = topicTokens('fix router timeout regression');
    const b = topicTokens('refactor payment gateway integration');
    expect(jaccard(a, b)).toBeLessThan(TOPIC_MISMATCH_THRESHOLD);
  });

  test('heuristic suppresses above threshold: related topics', () => {
    const a = topicTokens('fix router timeout in module router-lite');
    const b = topicTokens('fix router timeout path in router-lite');
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(TOPIC_MISMATCH_THRESHOLD);
  });
});

describe('rot.session-reuse-ghost (Pattern 8)', () => {
  afterEach(() => {
    __clearDetectorsForTests();
  });

  test('positive fixture: topic seed mismatch → 1 event', async () => {
    const state: SessionReuseGhostState = { ghosts: [ghost()] };
    const detector = makeSessionReuseGhostDetector({ loadState: async () => state });
    const { captured, emit } = makeCapture();

    const scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      now: () => Date.UTC(2026, 3, 20, 10, 30, 0),
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: emit,
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });
    await scheduler.tickNow();
    scheduler.stop();

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    const obs = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(fires[0].payload.pattern_id).toBe('pattern-8-session-reuse-ghost');
    expect(obs.new_agent_id).toBe('fresh-42');
    expect(obs.new_team).toBe('wish-42');
    expect(obs.new_topic_seed).toBe('fix router timeout regression');
    expect(obs.conflicting_archived_agent_id).toBe('old-17');
    expect(obs.conflicting_archived_team).toBe('wish-17');
    expect(obs.conflicting_archived_last_transcript_preview).toBe('refactor payment gateway integration');
    expect(obs.jaccard_similarity).toBe(0);
    expect(obs.ghost_count).toBe(1);
    expect(fires[0].opts.detector_version).toBe('1.0.0');
  });

  test('negative fixture: no ghosts → 0 events', async () => {
    const detector = makeSessionReuseGhostDetector({ loadState: async () => ({ ghosts: [] }) });
    const { captured, emit } = makeCapture();
    const scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      now: () => Date.UTC(2026, 3, 20, 10, 30, 0),
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: emit,
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });
    await scheduler.tickNow();
    scheduler.stop();
    expect(captured.filter((c) => c.type === 'rot.detected').length).toBe(0);
  });

  test('payload parses against rot.detected schema', async () => {
    const state: SessionReuseGhostState = { ghosts: [ghost()] };
    const detector = makeSessionReuseGhostDetector({ loadState: async () => state });
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
    const detector = makeSessionReuseGhostDetector({ loadState: async () => ({ ghosts: [] }) });
    expect(detector.id).toBe('rot.session-reuse-ghost');
    expect(detector.version).toBe('1.0.0');
    expect(detector.riskClass).toBe('high');
  });
});
