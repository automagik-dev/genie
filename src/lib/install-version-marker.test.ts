import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALL_VERSION_MARKER_NAME,
  readInstallVersionMarker,
  resolveInstallVersionMarkerPath,
  retireInstallVersionMarker,
  uninstallInstallVersionMarker,
} from './install-version-marker.js';

let genieHome: string;

beforeEach(() => {
  genieHome = mkdtempSync(join(tmpdir(), 'genie-install-marker-'));
});

afterEach(() => {
  rmSync(genieHome, { recursive: true, force: true });
});

function markerPath(): string {
  return join(genieHome, INSTALL_VERSION_MARKER_NAME);
}

function writeMarker(content: string): void {
  writeFileSync(markerPath(), content);
}

function backupSidecars(): string[] {
  return readdirSync(genieHome).filter((name) => name.startsWith(`${INSTALL_VERSION_MARKER_NAME}.genie-backup-`));
}

describe('resolveInstallVersionMarkerPath', () => {
  test('resolves the stable .install-version path under the given home', () => {
    expect(resolveInstallVersionMarkerPath(genieHome)).toBe(join(genieHome, '.install-version'));
  });
});

describe('readInstallVersionMarker — never a version authority, only diagnostics', () => {
  test('absent when no marker exists', () => {
    expect(readInstallVersionMarker(genieHome)).toEqual({ status: 'absent' });
  });

  test('present returns the trimmed legacy value', () => {
    writeMarker('  5.260500.3\n');
    expect(readInstallVersionMarker(genieHome)).toEqual({ status: 'present', value: '5.260500.3' });
  });

  test('a symlink marker is unsafe (never followed)', () => {
    writeFileSync(join(genieHome, 'real-version'), '9.9.9');
    symlinkSync(join(genieHome, 'real-version'), markerPath());
    const read = readInstallVersionMarker(genieHome);
    expect(read.status).toBe('unsafe');
  });

  test('an oversized marker is unsafe drift', () => {
    writeMarker('x'.repeat(5 * 1024));
    const read = readInstallVersionMarker(genieHome);
    expect(read.status).toBe('unsafe');
  });
});

describe('retireInstallVersionMarker — retire only after success, preserve on unsafe, idempotent', () => {
  test('already-absent is a no-op success', () => {
    expect(retireInstallVersionMarker(genieHome)).toEqual({ status: 'already-absent' });
  });

  test('a present regular marker is backed up then removed, reporting its prior value', () => {
    writeMarker('5.260500.3\n');
    const result = retireInstallVersionMarker(genieHome);
    expect(result).toEqual({ status: 'retired', previousValue: '5.260500.3' });
    // Marker gone.
    expect(readInstallVersionMarker(genieHome)).toEqual({ status: 'absent' });
    // Prior bytes preserved in exactly one backup sidecar.
    expect(backupSidecars()).toHaveLength(1);
  });

  test('retirement is idempotent — a second call after retirement is already-absent with no new backup', () => {
    writeMarker('5.260500.3');
    retireInstallVersionMarker(genieHome);
    const before = backupSidecars().length;
    expect(retireInstallVersionMarker(genieHome)).toEqual({ status: 'already-absent' });
    expect(backupSidecars()).toHaveLength(before);
  });

  test('an unsafe (symlink) marker is preserved exactly in place, never followed or deleted', () => {
    writeFileSync(join(genieHome, 'real-version'), '9.9.9');
    symlinkSync(join(genieHome, 'real-version'), markerPath());
    const result = retireInstallVersionMarker(genieHome);
    expect(result.status).toBe('preserved');
    // The symlink survives untouched (still an unsafe read), and its target still holds its bytes.
    expect(readInstallVersionMarker(genieHome).status).toBe('unsafe');
    expect(readInstallVersionMarker(genieHome).status).not.toBe('absent');
  });

  test('an empty marker retires with a null previous value', () => {
    writeMarker('   \n');
    expect(retireInstallVersionMarker(genieHome)).toEqual({ status: 'retired', previousValue: null });
  });
});

describe('uninstallInstallVersionMarker — tolerates either layout, idempotent, dry-run safe', () => {
  test('absent marker uninstalls cleanly (post-convergence layout)', () => {
    expect(uninstallInstallVersionMarker(genieHome)).toEqual({ status: 'absent' });
  });

  test('present regular marker is removed (legacy layout)', () => {
    writeMarker('5.260500.3');
    expect(uninstallInstallVersionMarker(genieHome)).toEqual({ status: 'removed', path: markerPath() });
    expect(readInstallVersionMarker(genieHome)).toEqual({ status: 'absent' });
  });

  test('dry-run reports would-remove and mutates nothing', () => {
    writeMarker('5.260500.3');
    expect(uninstallInstallVersionMarker(genieHome, { dryRun: true })).toEqual({
      status: 'would-remove',
      path: markerPath(),
    });
    expect(readInstallVersionMarker(genieHome)).toEqual({ status: 'present', value: '5.260500.3' });
  });

  test('a symlink marker is unlinked (never its target)', () => {
    const target = join(genieHome, 'real-version');
    writeFileSync(target, '9.9.9');
    symlinkSync(target, markerPath());
    expect(uninstallInstallVersionMarker(genieHome)).toEqual({ status: 'removed', path: markerPath() });
    // Marker link gone; the target it pointed at is preserved on disk.
    expect(readInstallVersionMarker(genieHome)).toEqual({ status: 'absent' });
    expect(existsSync(target)).toBe(true);
  });

  test('uninstall is idempotent — a second removal is a benign absent', () => {
    writeMarker('5.260500.3');
    uninstallInstallVersionMarker(genieHome);
    expect(uninstallInstallVersionMarker(genieHome)).toEqual({ status: 'absent' });
  });

  test('a directory in the marker slot is reported, never recursively removed', () => {
    mkdirSync(markerPath());
    const result = uninstallInstallVersionMarker(genieHome);
    expect(result.status).toBe('error');
  });
});

describe('retire → uninstall interplay proves both layouts are safe to rerun', () => {
  test('successful convergence retires the marker so a later uninstall sees no marker', () => {
    writeMarker('5.260500.3');
    expect(retireInstallVersionMarker(genieHome).status).toBe('retired');
    // Post-convergence machine: uninstall tolerates the already-retired layout.
    expect(uninstallInstallVersionMarker(genieHome)).toEqual({ status: 'absent' });
  });

  test('a machine that never retired still uninstalls the legacy marker', () => {
    writeMarker('4.260428.19');
    // Interrupted/failed convergence never called retire — the legacy marker persists.
    expect(readInstallVersionMarker(genieHome)).toEqual({ status: 'present', value: '4.260428.19' });
    expect(uninstallInstallVersionMarker(genieHome)).toEqual({ status: 'removed', path: markerPath() });
  });
});
