import { describe, expect, test } from 'bun:test';
import { isCronExpression, parseAbsoluteTime, parseDuration } from './schedule.js';

// ============================================================================
// parseDuration
// ============================================================================

describe('parseDuration', () => {
  test('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1s')).toBe(1_000);
    expect(parseDuration('90sec')).toBe(90_000);
  });

  test('parses minutes', () => {
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('1min')).toBe(60_000);
    expect(parseDuration('5m')).toBe(300_000);
  });

  test('parses hours', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('1hr')).toBe(3_600_000);
  });

  test('parses days', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('7day')).toBe(604_800_000);
    expect(parseDuration('7days')).toBe(604_800_000);
  });

  test('parses fractional values', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('0.5d')).toBe(43_200_000);
  });

  test('handles whitespace', () => {
    expect(parseDuration('  10m  ')).toBe(600_000);
  });

  test('rejects invalid durations', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration');
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('10x')).toThrow('Invalid duration');
    expect(() => parseDuration('m10')).toThrow('Invalid duration');
  });
});

// ============================================================================
// parseAbsoluteTime
// ============================================================================

describe('parseAbsoluteTime', () => {
  test('parses ISO 8601 strings', () => {
    const date = parseAbsoluteTime('2026-03-21T09:00:00Z');
    expect(date.getTime()).toBe(new Date('2026-03-21T09:00:00Z').getTime());
  });

  test('parses date-only strings', () => {
    const date = parseAbsoluteTime('2026-03-21');
    expect(date).toBeInstanceOf(Date);
    expect(Number.isNaN(date.getTime())).toBe(false);
  });

  test('rejects invalid time strings', () => {
    expect(() => parseAbsoluteTime('not-a-date')).toThrow('Invalid time');
    expect(() => parseAbsoluteTime('yesterday')).toThrow('Invalid time');
  });
});

// ============================================================================
// isCronExpression
// ============================================================================

describe('isCronExpression', () => {
  test('recognizes 5-field cron', () => {
    expect(isCronExpression('0 0 * * *')).toBe(true);
    expect(isCronExpression('*/5 * * * *')).toBe(true);
    expect(isCronExpression('0 9 * * 1-5')).toBe(true);
  });

  test('recognizes 6-field cron', () => {
    expect(isCronExpression('0 0 0 * * *')).toBe(true);
  });

  test('rejects non-cron strings', () => {
    expect(isCronExpression('10m')).toBe(false);
    expect(isCronExpression('24h')).toBe(false);
    expect(isCronExpression('hello')).toBe(false);
    expect(isCronExpression('* *')).toBe(false);
  });
});
