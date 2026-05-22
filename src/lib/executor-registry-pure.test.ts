import { describe, expect, test } from 'bun:test';
import { initialEndedAtForState } from './executor-registry.js';

describe('executor-registry pure helpers', () => {
  test('initialEndedAtForState stamps terminal executor states at creation time', () => {
    const before = new Date().toISOString();
    const endedAt = initialEndedAtForState('terminated');
    const after = new Date().toISOString();

    expect(endedAt).not.toBeNull();
    expect(endedAt! >= before).toBe(true);
    expect(endedAt! <= after).toBe(true);
  });

  test('initialEndedAtForState leaves live executor states open', () => {
    expect(initialEndedAtForState('spawning')).toBeNull();
    expect(initialEndedAtForState('running')).toBeNull();
    expect(initialEndedAtForState('idle')).toBeNull();
  });
});
