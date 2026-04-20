/**
 * Detector Plugin API — interface contract + register/list round-trip.
 *
 * Wish: Observability B1 — rot-pattern detectors (Group 2 / Phase 0).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  type DetectorModule,
  __clearDetectorsForTests,
  listDetectors,
  registerDetector,
  unregisterDetector,
} from '../index.js';

const okModule: DetectorModule<{ n: number }> = {
  id: 'test.plugin-api.round-trip',
  version: '1.0.0',
  riskClass: 'low',
  query: () => ({ n: 1 }),
  shouldFire: (s) => s.n > 0,
  render: () => ({
    type: 'runbook.triggered',
    subject: 'round-trip',
    payload: { rule: 'R1', evidence_count: 1 },
  }),
};

describe('DetectorModule interface', () => {
  afterEach(() => {
    __clearDetectorsForTests();
  });

  test('all five fields compile and are read-only', () => {
    // TypeScript compilation is the assertion here. The fact that the module
    // above type-checks against DetectorModule is the test — runtime only
    // confirms the shape propagated.
    expect(typeof okModule.id).toBe('string');
    expect(typeof okModule.version).toBe('string');
    expect(okModule.riskClass).toBe('low');
    expect(typeof okModule.query).toBe('function');
    expect(typeof okModule.shouldFire).toBe('function');
    expect(typeof okModule.render).toBe('function');
  });

  test('register + list round-trip returns the same module', () => {
    registerDetector(okModule);
    const listed = listDetectors();
    expect(listed.length).toBe(1);
    expect(listed[0].id).toBe(okModule.id);
    expect(listed[0].version).toBe('1.0.0');
  });

  test('re-registering the same id replaces (not duplicates)', () => {
    registerDetector(okModule);
    registerDetector({ ...okModule, version: '2.0.0' });
    const listed = listDetectors();
    expect(listed.length).toBe(1);
    expect(listed[0].version).toBe('2.0.0');
  });

  test('unregister removes a detector', () => {
    registerDetector(okModule);
    expect(listDetectors().length).toBe(1);
    expect(unregisterDetector(okModule.id)).toBe(true);
    expect(listDetectors().length).toBe(0);
    // second call is a no-op
    expect(unregisterDetector(okModule.id)).toBe(false);
  });

  test('registration order is preserved', () => {
    const a: DetectorModule = { ...okModule, id: 'test.plugin-api.a' };
    const b: DetectorModule = { ...okModule, id: 'test.plugin-api.b' };
    const c: DetectorModule = { ...okModule, id: 'test.plugin-api.c' };
    registerDetector(a);
    registerDetector(b);
    registerDetector(c);
    const ids = listDetectors().map((m) => m.id);
    expect(ids).toEqual(['test.plugin-api.a', 'test.plugin-api.b', 'test.plugin-api.c']);
  });

  test('invalid id is rejected', () => {
    expect(() => registerDetector({ ...okModule, id: 'Bad ID With Spaces' })).toThrow();
  });

  test('non-semver version is rejected', () => {
    expect(() => registerDetector({ ...okModule, version: 'not-semver' })).toThrow();
  });

  test('invalid riskClass is rejected', () => {
    expect(() =>
      registerDetector({ ...okModule, riskClass: 'critical' as unknown as DetectorModule['riskClass'] }),
    ).toThrow();
  });
});
