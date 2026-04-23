import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ALERTS_YAML, SYSTEMD_SERVICE_CONTENTS, SYSTEMD_TIMER_CONTENTS, install } from '../src/install.ts';

describe('watchdog install', () => {
  test('dry run does not write files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-install-'));
    try {
      const res = install({ dryRun: true, targetRoot: dir });
      expect(res.dry_run).toBe(true);
      expect(res.files_written).toHaveLength(0);
      expect(res.files_skipped.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writes three files under target root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-install-'));
    try {
      const res = install({ targetRoot: dir });
      const timerPath = join(dir, 'etc/systemd/system/genie-watchdog.timer');
      const servicePath = join(dir, 'etc/systemd/system/genie-watchdog.service');
      const alertsPath = join(dir, 'etc/genie-watchdog/alerts.yaml');
      expect(existsSync(timerPath)).toBe(true);
      expect(existsSync(servicePath)).toBe(true);
      expect(existsSync(alertsPath)).toBe(true);
      expect(readFileSync(timerPath, 'utf8')).toBe(SYSTEMD_TIMER_CONTENTS);
      expect(readFileSync(servicePath, 'utf8')).toBe(SYSTEMD_SERVICE_CONTENTS);
      expect(readFileSync(alertsPath, 'utf8')).toBe(DEFAULT_ALERTS_YAML);
      expect(res.files_written.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('re-running install is idempotent when contents match', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-install-'));
    try {
      install({ targetRoot: dir });
      const second = install({ targetRoot: dir });
      expect(second.files_written).toHaveLength(0);
      expect(second.files_skipped.length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
