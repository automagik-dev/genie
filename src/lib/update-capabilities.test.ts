import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_ACTIVATION_PROTOCOL,
  buildUpdateCapabilityReport,
  parseUpdateCapabilityReport,
  printUpdateCapabilities,
  resolveSelfBinaryPath,
  serializeUpdateCapabilityReport,
} from './update-capabilities.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-update-capabilities-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A physical "binary" file with fixed bytes; returns its path and sha256. */
function writeFakeBinary(name: string, bytes = 'fake-genie-binary'): { path: string; digest: string } {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode: 0o755 });
  return { path, digest: sha256File(path) };
}

describe('resolveSelfBinaryPath (interpreted vs compiled self-hash target)', () => {
  const savedArgv1 = process.argv[1];
  const savedExecPath = process.execPath;

  function withProcess(argv1: string | undefined, execPath: string, run: () => void) {
    try {
      if (argv1 === undefined) process.argv.length = 1;
      else process.argv[1] = argv1;
      process.execPath = execPath;
      run();
    } finally {
      process.argv[1] = savedArgv1;
      process.execPath = savedExecPath;
    }
  }

  test('interpreted mode: a real on-disk argv[1] script is the hash target', () => {
    const script = writeFakeBinary('genie.js').path; // a real file on disk
    const exec = writeFakeBinary('bun-interpreter').path;
    withProcess(script, exec, () => {
      expect(resolveSelfBinaryPath()).toBe(script);
    });
  });

  test('compiled mode: a virtual /$bunfs argv[1] falls back to execPath', () => {
    const exec = writeFakeBinary('genie-compiled').path; // the real single-file binary
    withProcess('/$bunfs/root/genie', exec, () => {
      expect(resolveSelfBinaryPath()).toBe(exec);
    });
  });

  test('compiled mode (Windows): a B:\\~BUN entry falls back to execPath', () => {
    const exec = writeFakeBinary('genie-compiled-win').path;
    withProcess('B:\\~BUN\\root\\genie', exec, () => {
      expect(resolveSelfBinaryPath()).toBe(exec);
    });
  });

  test('absent argv[1] falls back to execPath', () => {
    const exec = writeFakeBinary('genie-execpath').path;
    withProcess(undefined, exec, () => {
      expect(resolveSelfBinaryPath()).toBe(exec);
    });
  });

  test('an argv[1] that is not on disk falls back to execPath', () => {
    const exec = writeFakeBinary('genie-fallback').path;
    withProcess(join(root, 'does-not-exist-on-disk'), exec, () => {
      expect(resolveSelfBinaryPath()).toBe(exec);
    });
  });
});

describe('capability report', () => {
  test('build/serialize/parse round-trips and self-hashes the given binary', () => {
    const bin = writeFakeBinary('genie');
    const report = buildUpdateCapabilityReport({ binaryPath: bin.path, version: '5.260712.1' });
    expect(report).toEqual({
      schemaVersion: 1,
      reportedVersion: '5.260712.1',
      binarySha256: bin.digest,
      codexActivationProtocol: CODEX_ACTIVATION_PROTOCOL,
      readableIntentSchemas: [1],
    });
    const parsed = parseUpdateCapabilityReport(serializeUpdateCapabilityReport(report));
    expect(parsed).toEqual(report);
  });

  test('printUpdateCapabilities emits exactly one JSON object and nothing else', () => {
    const chunks: string[] = [];
    printUpdateCapabilities((text) => chunks.push(text));
    expect(chunks.length).toBe(1);
    const text = chunks[0];
    expect(text.endsWith('\n')).toBe(true);
    const parsed = parseUpdateCapabilityReport(text);
    expect(parsed).not.toBeNull();
    // Exactly one JSON value: trailing content would fail whole-string parse.
    expect(() => JSON.parse(text.trim())).not.toThrow();
  });
});
