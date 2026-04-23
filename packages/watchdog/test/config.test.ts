import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseYamlSubset } from '../src/config.ts';

describe('watchdog config', () => {
  test('returns defaults when file missing', () => {
    const cfg = loadConfig('/nonexistent/path.yaml');
    expect(cfg.staleness_seconds).toBe(300);
    expect(cfg.alerts.webhook).toBeUndefined();
  });

  test('parses basic yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
    try {
      const path = join(dir, 'alerts.yaml');
      writeFileSync(
        path,
        'pg:\n  dsn: postgres://override/genie\nstaleness_seconds: 120\nalerts:\n  webhook: https://paging.example/hook\n',
      );
      const cfg = loadConfig(path);
      expect(cfg.pg.dsn).toBe('postgres://override/genie');
      expect(cfg.staleness_seconds).toBe(120);
      expect(cfg.alerts.webhook).toBe('https://paging.example/hook');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parses arrays of recipients', () => {
    const parsed = parseYamlSubset(
      `alerts:\n  email:\n    - ops@example.com\n    - sre@example.com\n  sms:\n    - "+15551234"\n`,
    );
    expect(parsed.alerts?.email as unknown as string[]).toEqual(['ops@example.com', 'sre@example.com']);
    expect(parsed.alerts?.sms as unknown as string[]).toEqual(['+15551234']);
  });

  test('falls back to JSON when file starts with {', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
    try {
      const path = join(dir, 'alerts.json');
      writeFileSync(path, JSON.stringify({ pg: { dsn: 'json://' }, staleness_seconds: 99 }));
      const cfg = loadConfig(path);
      expect(cfg.pg.dsn).toBe('json://');
      expect(cfg.staleness_seconds).toBe(99);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
