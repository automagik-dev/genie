import { describe, expect, test } from 'bun:test';
import { formatAlert } from '../src/alert.ts';
import type { ProbeResult } from '../src/probe.ts';

describe('watchdog alert', () => {
  test('pg_unreachable is critical', () => {
    const result: ProbeResult = {
      ok: false,
      stale_seconds: null,
      reason: 'pg_unreachable',
      detail: 'ECONNREFUSED',
      probed_at: '2026-04-19T00:00:00.000Z',
    };
    const payload = formatAlert(result, 'host-A');
    expect(payload.severity).toBe('critical');
    expect(payload.reason).toBe('pg_unreachable');
    expect(payload.host).toBe('host-A');
  });

  test('fresh stream is warn', () => {
    const result: ProbeResult = {
      ok: false,
      stale_seconds: 310,
      reason: 'stream_stale',
      probed_at: '2026-04-19T00:00:00.000Z',
    };
    const payload = formatAlert(result, 'host-B');
    expect(payload.severity).toBe('warn');
    expect(payload.stale_seconds).toBe(310);
  });

  test('very stale stream upgrades to critical', () => {
    const result: ProbeResult = {
      ok: false,
      stale_seconds: 1200,
      reason: 'stream_stale',
      probed_at: '2026-04-19T00:00:00.000Z',
    };
    const payload = formatAlert(result, 'host-C');
    expect(payload.severity).toBe('critical');
  });
});
