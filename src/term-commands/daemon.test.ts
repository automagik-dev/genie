import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSystemdUnit, isProcessAlive, readPid, removePid, writePid } from './daemon.js';

// ============================================================================
// PID file operations
// ============================================================================

describe('PID file operations', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = join('/tmp', `genie-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    origHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = tmpDir;
  });

  afterEach(() => {
    process.env.GENIE_HOME = origHome;
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {}
  });

  test('writePid creates PID file', () => {
    writePid(12345);
    const pidPath = join(tmpDir, 'scheduler.pid');
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, 'utf-8').trim()).toBe('12345');
  });

  test('readPid reads stored PID', () => {
    writePid(99999);
    expect(readPid()).toBe(99999);
  });

  test('readPid returns null when no PID file exists', () => {
    expect(readPid()).toBeNull();
  });

  test('readPid returns null for invalid PID content', () => {
    writeFileSync(join(tmpDir, 'scheduler.pid'), 'not-a-number', 'utf-8');
    expect(readPid()).toBeNull();
  });

  test('removePid cleans up PID file', () => {
    writePid(12345);
    const pidPath = join(tmpDir, 'scheduler.pid');
    expect(existsSync(pidPath)).toBe(true);
    removePid();
    expect(existsSync(pidPath)).toBe(false);
  });

  test('removePid is safe when no PID file exists', () => {
    // Should not throw
    removePid();
  });
});

// ============================================================================
// isProcessAlive
// ============================================================================

describe('isProcessAlive', () => {
  test('returns true for current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test('returns false for non-existent PID', () => {
    // PID 99999999 is extremely unlikely to be in use
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

// ============================================================================
// generateSystemdUnit
// ============================================================================

describe('generateSystemdUnit', () => {
  test('produces valid unit file structure', () => {
    const unit = generateSystemdUnit();

    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Type=simple');
    // Now points to genie serve --headless --foreground
    expect(unit).toContain('serve start --headless --foreground');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  test('includes GENIE_HOME environment variable', () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain('Environment=GENIE_HOME=');
  });

  test('includes description and documentation', () => {
    const unit = generateSystemdUnit();
    // Updated description reflects unified serve
    expect(unit).toContain('Description=Genie Serve (headless)');
    expect(unit).toContain('SyslogIdentifier=genie-scheduler');
  });

  test('sets restart policy', () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain('RestartSec=5');
  });
});
