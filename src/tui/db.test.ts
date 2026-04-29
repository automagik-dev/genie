import { describe, expect, test } from 'bun:test';
import { mergeWorkState } from './db.js';
import type { WorkState } from './types.js';

describe('mergeWorkState', () => {
  test('keeps an active duplicate from being overwritten by a stale directory row', () => {
    const states = new Map<string, WorkState>();

    mergeWorkState(states, 'genie', 'in_flight');
    mergeWorkState(states, 'genie', 'stuck');

    expect(states.get('genie')).toBe('in_flight');
  });

  test('allows a stronger later state to replace a weaker earlier state', () => {
    const states = new Map<string, WorkState>();

    mergeWorkState(states, 'genie', 'stuck');
    mergeWorkState(states, 'genie', 'paused');

    expect(states.get('genie')).toBe('paused');
  });
});
