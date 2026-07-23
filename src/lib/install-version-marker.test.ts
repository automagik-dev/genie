import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALL_VERSION_MARKER_NAME,
  readInstallVersionMarker,
  resolveInstallVersionMarkerPath,
  retireInstallVersionMarker,
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
