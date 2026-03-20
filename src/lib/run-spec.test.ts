/**
 * Tests for run-spec — State transition validation.
 * Run with: bun test src/lib/run-spec.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { RUN_STATE_TRANSITIONS, isValidTransition } from './run-spec.js';

describe('RUN_STATE_TRANSITIONS', () => {
  test('failed state includes spawning as valid transition', () => {
    expect(RUN_STATE_TRANSITIONS.failed).toContain('spawning');
  });

  test('done state is terminal (no transitions)', () => {
    expect(RUN_STATE_TRANSITIONS.done).toHaveLength(0);
  });

  test('suspended state can transition to spawning', () => {
    expect(RUN_STATE_TRANSITIONS.suspended).toContain('spawning');
  });

  test('error state can transition to spawning', () => {
    expect(RUN_STATE_TRANSITIONS.error).toContain('spawning');
  });

  test('spawning state can transition to working', () => {
    expect(RUN_STATE_TRANSITIONS.spawning).toContain('working');
  });
});

describe('isValidTransition', () => {
  test('failed → spawning is valid', () => {
    expect(isValidTransition('failed', 'spawning')).toBe(true);
  });

  test('failed → working is invalid', () => {
    expect(isValidTransition('failed', 'working')).toBe(false);
  });

  test('done → spawning is invalid (terminal)', () => {
    expect(isValidTransition('done', 'spawning')).toBe(false);
  });

  test('suspended → spawning is valid', () => {
    expect(isValidTransition('suspended', 'spawning')).toBe(true);
  });

  test('working → done is valid', () => {
    expect(isValidTransition('working', 'done')).toBe(true);
  });

  test('working → spawning is invalid', () => {
    expect(isValidTransition('working', 'spawning')).toBe(false);
  });
});
