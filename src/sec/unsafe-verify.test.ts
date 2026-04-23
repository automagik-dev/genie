import { describe, expect, test } from 'bun:test';
import {
  INCIDENT_ID_REGEX,
  LEGITIMATE_CONTEXTS,
  TYPED_ACK_PREFIX,
  buildTypedAck,
  describeUnsafeUnverifiedContract,
  validateUnsafeUnverified,
} from './unsafe-verify.js';

describe('INCIDENT_ID_REGEX', () => {
  test.each([
    'BURNED_KEY_2026_04_23',
    'CI_PRE_SIGNING_2026_04_23',
    'CI_PRE_SIGNING_2026_04_23_TEST_HARNESS',
    'TEST_HARNESS_2026_04_23_JOB_ABC',
    'TEST_HARNESS_2026_04_23_JOB_abc123',
    'A_2026_04_23',
  ])('accepts %p', (value) => {
    expect(INCIDENT_ID_REGEX.test(value)).toBe(true);
  });

  test.each([
    '',
    'foo',
    'burned-key-2026-04-23',
    'burned_key_2026_04_23',
    'BURNED_KEY_26_04_23',
    'BURNED_KEY_2026-04-23',
    'BURNED_KEY_2026_04',
    'BURNED_KEY_2026_04_23-TEST',
    '2026_04_23_BURNED_KEY',
    'BURNED_KEY_2026_04_23_',
    ' BURNED_KEY_2026_04_23',
    'BURNED_KEY_2026_04_23 ',
  ])('rejects %p', (value) => {
    expect(INCIDENT_ID_REGEX.test(value)).toBe(false);
  });
});

describe('buildTypedAck', () => {
  test('builds the documented shape for BURNED_KEY_2026_04_23', () => {
    expect(buildTypedAck('BURNED_KEY_2026_04_23')).toBe('I_ACKNOWLEDGE_UNSIGNED_GENIE_BURNED_KEY_2026_04_23');
  });

  test('uses the exported prefix (no hard-coded drift)', () => {
    const id = 'TEST_HARNESS_2026_04_23_JOB_ABC';
    expect(buildTypedAck(id)).toBe(`${TYPED_ACK_PREFIX}${id}`);
  });

  test('is deterministic for identical input', () => {
    const id = 'CI_PRE_SIGNING_2026_04_23';
    expect(buildTypedAck(id)).toBe(buildTypedAck(id));
  });
});

describe('validateUnsafeUnverified', () => {
  test('returns ok for a correctly-typed ack matching a valid INCIDENT_ID', () => {
    const id = 'BURNED_KEY_2026_04_23';
    const ack = buildTypedAck(id);
    const result = validateUnsafeUnverified(id, ack);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.incidentId).toBe(id);
      expect(result.typedAck).toBe(ack);
      expect(result.expectedTypedAck).toBe(ack);
    }
  });

  test('rejects when flag is undefined', () => {
    const result = validateUnsafeUnverified(undefined, 'anything');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-flag');
  });

  test('rejects when flag is empty string', () => {
    const result = validateUnsafeUnverified('', 'anything');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-flag');
  });

  test('rejects when flag fails the regex', () => {
    const result = validateUnsafeUnverified('nope', buildTypedAck('nope'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-incident-id');
  });

  test('rejects when typed ack is missing', () => {
    const id = 'BURNED_KEY_2026_04_23';
    const result = validateUnsafeUnverified(id, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing-typed-ack');
      expect(result.expectedTypedAck).toBe(buildTypedAck(id));
    }
  });

  test('rejects when typed ack is empty string', () => {
    const id = 'BURNED_KEY_2026_04_23';
    const result = validateUnsafeUnverified(id, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-typed-ack');
  });

  test('rejects when typed ack is a partial match', () => {
    const id = 'BURNED_KEY_2026_04_23';
    const result = validateUnsafeUnverified(id, 'I_ACKNOWLEDGE_UNSIGNED_GENIE_BURNED_KEY');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('typed-ack-mismatch');
      expect(result.expectedTypedAck).toBe(buildTypedAck(id));
    }
  });

  test('rejects when typed ack swaps case', () => {
    const id = 'BURNED_KEY_2026_04_23';
    const result = validateUnsafeUnverified(id, buildTypedAck(id).toLowerCase());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('typed-ack-mismatch');
  });

  test('rejects when typed ack has trailing whitespace', () => {
    const id = 'BURNED_KEY_2026_04_23';
    const result = validateUnsafeUnverified(id, `${buildTypedAck(id)} `);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('typed-ack-mismatch');
  });

  test('round-trip: build then validate always succeeds for every legitimate context', () => {
    for (const { prefix } of LEGITIMATE_CONTEXTS) {
      const id = `${prefix}2026_04_23`;
      expect(INCIDENT_ID_REGEX.test(id)).toBe(true);
      const result = validateUnsafeUnverified(id, buildTypedAck(id));
      expect(result.ok).toBe(true);
    }
  });
});

describe('LEGITIMATE_CONTEXTS', () => {
  test('every documented prefix ends with underscore so it concatenates cleanly', () => {
    for (const { prefix } of LEGITIMATE_CONTEXTS) {
      expect(prefix.endsWith('_')).toBe(true);
    }
  });

  test('every prefix yields a regex-matching INCIDENT_ID when a date is appended', () => {
    for (const { prefix } of LEGITIMATE_CONTEXTS) {
      const id = `${prefix}2026_04_23`;
      expect(INCIDENT_ID_REGEX.test(id)).toBe(true);
    }
  });

  test('LEGITIMATE_CONTEXTS is frozen (no runtime mutation)', () => {
    expect(Object.isFrozen(LEGITIMATE_CONTEXTS)).toBe(true);
  });
});

describe('describeUnsafeUnverifiedContract', () => {
  test('mentions regex, typed-ack prefix, and every documented legitimate context', () => {
    const text = describeUnsafeUnverifiedContract();
    expect(text).toContain(String(INCIDENT_ID_REGEX));
    expect(text).toContain(TYPED_ACK_PREFIX);
    for (const { prefix } of LEGITIMATE_CONTEXTS) {
      expect(text).toContain(prefix);
    }
  });
});
