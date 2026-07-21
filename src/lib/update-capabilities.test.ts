import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_ACTIVATION_PROTOCOL,
  type ProbeOutcome,
  type UpdateCapabilityReport,
  buildUpdateCapabilityReport,
  capabilitySidecarPath,
  enforceRollbackCapabilityFloor,
  parseUpdateCapabilityReport,
  printUpdateCapabilities,
  publishBackupCapabilitySidecar,
  runBackupCapabilityProbe,
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

const HEX128 = 'a'.repeat(32);

function goodProbe(report: UpdateCapabilityReport): (path: string) => ProbeOutcome {
  return () => ({ status: 'ok', report, detail: 'probe ok' });
}

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

  test('parse rejects extra keys, wrong schema, and malformed fields', () => {
    const base = serializeUpdateCapabilityReport(
      buildUpdateCapabilityReport({ binaryPath: writeFakeBinary('g').path }),
    );
    const withExtra = JSON.stringify({ ...JSON.parse(base), rogue: 1 });
    expect(parseUpdateCapabilityReport(withExtra)).toBeNull();
    expect(parseUpdateCapabilityReport('{"schemaVersion":2}')).toBeNull();
    expect(parseUpdateCapabilityReport('not json')).toBeNull();
    expect(
      parseUpdateCapabilityReport(
        '{"schemaVersion":1,"reportedVersion":"1","binarySha256":"x","codexActivationProtocol":1,"readableIntentSchemas":[1]}',
      ),
    ).toBeNull();
  });
});

describe('capability sidecar', () => {
  test('publishes a sidecar bound to the backup, delivery id, and expected version', () => {
    const bin = writeFakeBinary('genie-5.260711.6');
    const sidecar = publishBackupCapabilitySidecar({
      backupBinaryPath: bin.path,
      expectedPreviousVersion: '5.260711.6',
      deliveryId: HEX128,
    });
    expect(sidecar).toEqual({
      schemaVersion: 1,
      deliveryId: HEX128,
      backupSlot: 'genie-5.260711.6',
      expectedPreviousVersion: '5.260711.6',
      binarySha256: bin.digest,
      codexActivationProtocol: CODEX_ACTIVATION_PROTOCOL,
      readableIntentSchemas: [1],
    });
    const onDisk = JSON.parse(readFileSync(capabilitySidecarPath(bin.path), 'utf8'));
    expect(onDisk).toEqual(sidecar);
  });

  test('rejects a relative backup path', () => {
    expect(() =>
      publishBackupCapabilitySidecar({ backupBinaryPath: 'genie', expectedPreviousVersion: '1', deliveryId: HEX128 }),
    ).toThrow(/absolute/);
  });
});

describe('rollback capability floor', () => {
  function publishGoodSidecar(bin: { path: string; digest: string }, version: string) {
    publishBackupCapabilitySidecar({
      backupBinaryPath: bin.path,
      expectedPreviousVersion: version,
      deliveryId: HEX128,
    });
  }

  function reportFor(bin: { path: string; digest: string }, version: string): UpdateCapabilityReport {
    return {
      schemaVersion: 1,
      reportedVersion: version,
      binarySha256: bin.digest,
      codexActivationProtocol: CODEX_ACTIVATION_PROTOCOL,
      readableIntentSchemas: [1],
    };
  }

  test('fixed→fixed passes when sidecar, rehash, and probe all agree', () => {
    const bin = writeFakeBinary('genie-5.260711.6');
    publishGoodSidecar(bin, '5.260711.6');
    const result = enforceRollbackCapabilityFloor({
      backupBinaryPath: bin.path,
      runProbe: goodProbe(reportFor(bin, '5.260711.6')),
    });
    expect(result).toEqual({ ok: true, restoredVersion: '5.260711.6', binarySha256: bin.digest });
  });

  test('first-fixed→pre-contract backup with no sidecar is refused before mutation', () => {
    const bin = writeFakeBinary('genie-precontract');
    const result = enforceRollbackCapabilityFloor({
      backupBinaryPath: bin.path,
      runProbe: goodProbe(reportFor(bin, '5.260711.6')),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/pre-contract|sidecar/i);
  });

  test('tampered backup (hash mismatch vs sidecar) is refused', () => {
    const bin = writeFakeBinary('genie-5.260711.6', 'original');
    publishGoodSidecar(bin, '5.260711.6');
    // Replace the backup bytes after the sidecar was sealed.
    writeFileSync(bin.path, 'tampered', { mode: 0o755 });
    const result = enforceRollbackCapabilityFloor({
      backupBinaryPath: bin.path,
      runProbe: goodProbe(reportFor(bin, '5.260711.6')),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/tamper|hash|match/i);
  });

  test('probe failure (timeout/spawn) is refused', () => {
    const bin = writeFakeBinary('genie-5.260711.6');
    publishGoodSidecar(bin, '5.260711.6');
    const result = enforceRollbackCapabilityFloor({
      backupBinaryPath: bin.path,
      runProbe: () => ({ status: 'timeout', detail: 'timed out' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/probe/i);
  });

  test('probe version disagreeing with sidecar is refused', () => {
    const bin = writeFakeBinary('genie-5.260711.6');
    publishGoodSidecar(bin, '5.260711.6');
    const result = enforceRollbackCapabilityFloor({
      backupBinaryPath: bin.path,
      runProbe: goodProbe(reportFor(bin, '5.260711.7')),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/version/i);
  });

  test('probe reporting protocol below the floor is refused', () => {
    const bin = writeFakeBinary('genie-5.260711.6');
    publishGoodSidecar(bin, '5.260711.6');
    const belowFloor: UpdateCapabilityReport = { ...reportFor(bin, '5.260711.6'), codexActivationProtocol: 0 };
    const result = enforceRollbackCapabilityFloor({
      backupBinaryPath: bin.path,
      runProbe: goodProbe(belowFloor),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/protocol|floor/i);
  });

  test('replacement between probe and exchange (TOCTOU) is refused', () => {
    const bin = writeFakeBinary('genie-5.260711.6', 'v1');
    publishGoodSidecar(bin, '5.260711.6');
    const report = reportFor(bin, '5.260711.6');
    const result = enforceRollbackCapabilityFloor({
      backupBinaryPath: bin.path,
      runProbe: () => {
        // Swap the backup bytes AFTER the initial hash but during the probe window.
        writeFileSync(bin.path, 'swapped-in-place', { mode: 0o755 });
        return { status: 'ok', report, detail: 'probe ok' };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/changed|exchange/i);
  });

  test('symlinked backup path is refused (no-follow)', () => {
    const real = writeFakeBinary('real-genie');
    publishGoodSidecar(real, '5.260711.6');
    const link = join(root, 'genie-link');
    symlinkSync(real.path, link);
    const result = enforceRollbackCapabilityFloor({
      backupBinaryPath: link,
      runProbe: goodProbe(reportFor(real, '5.260711.6')),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/symlink|regular/i);
  });
});

describe('real no-shell probe', () => {
  /** Write a self-hashing executable that ignores argv and prints a valid report. */
  function writeSelfHashingBinary(name: string, version: string): { path: string; digest: string } {
    const path = join(root, name);
    const script = [
      `#!${process.execPath}`,
      "const { createHash } = require('node:crypto');",
      "const { readFileSync } = require('node:fs');",
      'const digest = createHash("sha256").update(readFileSync(__filename)).digest("hex");',
      `const report = { schemaVersion: 1, reportedVersion: ${JSON.stringify(version)}, binarySha256: digest, codexActivationProtocol: 1, readableIntentSchemas: [1] };`,
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      '',
    ].join('\n');
    writeFileSync(path, script, { mode: 0o755 });
    return { path, digest: sha256File(path) };
  }

  test('spawns the backup no-shell and parses exactly one JSON report', () => {
    const bin = writeSelfHashingBinary('genie-real', '5.260711.6');
    const outcome = runBackupCapabilityProbe(bin.path);
    expect(outcome.status).toBe('ok');
    expect(outcome.report?.binarySha256).toBe(bin.digest);
    expect(outcome.report?.reportedVersion).toBe('5.260711.6');
  });

  test('end-to-end floor passes with a real self-hashing backup and its sidecar', () => {
    const bin = writeSelfHashingBinary('genie-real', '5.260711.6');
    publishBackupCapabilitySidecar({
      backupBinaryPath: bin.path,
      expectedPreviousVersion: '5.260711.6',
      deliveryId: HEX128,
    });
    const result = enforceRollbackCapabilityFloor({ backupBinaryPath: bin.path });
    expect(result).toEqual({ ok: true, restoredVersion: '5.260711.6', binarySha256: bin.digest });
  });

  test('real probe reports nonzero exit as a refusal', () => {
    const path = join(root, 'genie-fail');
    writeFileSync(path, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const outcome = runBackupCapabilityProbe(path);
    expect(outcome.status).toBe('nonzero');
  });

  test('real probe rejects stderr output', () => {
    const path = join(root, 'genie-noisy');
    writeFileSync(path, `#!/bin/sh\necho '{"schemaVersion":1}' \necho oops 1>&2\n`, { mode: 0o755 });
    const outcome = runBackupCapabilityProbe(path);
    expect(outcome.status).toBe('stderr');
  });

  test('real probe rejects non-JSON output', () => {
    const path = join(root, 'genie-garbage');
    writeFileSync(path, '#!/bin/sh\necho not-json\n', { mode: 0o755 });
    const outcome = runBackupCapabilityProbe(path);
    expect(outcome.status).toBe('unparsable');
  });

  test('real probe refuses a relative path without spawning', () => {
    const outcome = runBackupCapabilityProbe('genie');
    expect(outcome.status).toBe('spawn-failed');
  });
});
