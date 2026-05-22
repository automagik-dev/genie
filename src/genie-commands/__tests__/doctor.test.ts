import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSetupEffectivelyComplete, resolveBinaryInteractive, resolveBinaryNonInteractive } from '../doctor.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFakeBin(name: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'genie-doctor-path-'));
  tmpDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return { dir, path };
}

describe('doctor PATH detection', () => {
  test('resolves binaries through a POSIX shell builtin instead of Bun shell external command lookup', async () => {
    const fake = makeFakeBin('fake-genie-bin');
    const env = { PATH: fake.dir };

    await expect(resolveBinaryInteractive('fake-genie-bin', env)).resolves.toBe(fake.path);
    await expect(resolveBinaryNonInteractive('fake-genie-bin', env)).resolves.toBe(fake.path);
  });

  test('returns null for invalid binary names and missing PATH entries', async () => {
    const env = { PATH: tmpdir() };

    await expect(resolveBinaryInteractive('missing-genie-bin', env)).resolves.toBeNull();
    await expect(resolveBinaryNonInteractive('bad;name', env)).resolves.toBeNull();
  });
});

describe('setup completion diagnostics', () => {
  test('treats an existing modern v2 config as effectively complete even if the legacy setup flag is false', () => {
    expect(isSetupEffectivelyComplete(false, { version: 2 })).toBe(true);
  });

  test('still honors explicit setup completion and missing configs', () => {
    expect(isSetupEffectivelyComplete(true, { version: 2 })).toBe(true);
    expect(isSetupEffectivelyComplete(true, null)).toBe(true);
    expect(isSetupEffectivelyComplete(false, null)).toBe(false);
  });

  test('rejects pre-v2 and missing-version configs', () => {
    expect(isSetupEffectivelyComplete(false, { version: 1 })).toBe(false);
    expect(isSetupEffectivelyComplete(false, {})).toBe(false);
  });
});
