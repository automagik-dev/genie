import { describe, expect, test } from 'bun:test';
import { computeNextCronDue, parseDuration } from './cron.js';

describe('parseDuration', () => {
  test('parses common durations', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  test('rejects invalid input', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
  });
});

describe('computeNextCronDue', () => {
  test('midnight cron does not fire immediately', () => {
    // Bug 3 regression: "0 0 * * *" (midnight) should NOT fire within 1 minute of creation
    const midday = new Date('2026-03-20T12:00:00Z');
    const next = computeNextCronDue('0 0 * * *', midday);

    // Next midnight is at least 12 hours away, not 1 minute
    const diffMs = next.getTime() - midday.getTime();
    expect(diffMs).toBeGreaterThan(11 * 60 * 60 * 1000); // > 11 hours
    expect(next.getUTCHours()).toBe(0);
    expect(next.getUTCMinutes()).toBe(0);
  });

  test('every-5-minutes cron fires at next 5-min boundary', () => {
    const base = new Date('2026-03-20T12:03:00Z');
    const next = computeNextCronDue('*/5 * * * *', base);

    expect(next.getUTCMinutes()).toBe(5);
    expect(next.getUTCHours()).toBe(12);
  });

  test('hourly cron fires at next hour boundary', () => {
    const base = new Date('2026-03-20T12:30:00Z');
    const next = computeNextCronDue('0 * * * *', base);

    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getUTCHours()).toBe(13);
  });

  test('weekday-only cron skips weekends', () => {
    // 2026-03-21 is a Saturday
    const friday = new Date('2026-03-20T18:00:00Z'); // Friday
    const next = computeNextCronDue('0 9 * * 1-5', friday);

    // Should be Monday 2026-03-23 at 09:00
    expect(next.getUTCDay()).toBeGreaterThanOrEqual(1);
    expect(next.getUTCDay()).toBeLessThanOrEqual(5);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
  });

  test('first-of-month cron fires on day 1', () => {
    const midMonth = new Date('2026-03-15T12:00:00Z');
    const next = computeNextCronDue('0 0 1 * *', midMonth);

    expect(next.getUTCDate()).toBe(1);
    expect(next.getUTCHours()).toBe(0);
    // Should be April 1st since we're past March 1
    expect(next.getUTCMonth()).toBe(3); // April (0-indexed)
  });

  test('does not return current time if exactly on boundary', () => {
    const onBoundary = new Date('2026-03-20T12:00:00Z');
    const next = computeNextCronDue('0 * * * *', onBoundary);

    // Should return 13:00, not 12:00
    expect(next.getTime()).toBeGreaterThan(onBoundary.getTime());
  });

  test('rejects invalid cron expression', () => {
    expect(() => computeNextCronDue('bad')).toThrow('Invalid cron expression');
  });
});
