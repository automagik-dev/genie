import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HeldLifecycleLease, LifecycleLeaseResult } from '../lib/codex-lifecycle-lease.js';
import type { RollbackFloorResult } from '../lib/update-capabilities.js';
import { capabilitySidecarPath, publishBackupCapabilitySidecar } from '../lib/update-capabilities.js';
import { discoverRollbackBackup, exchangeBinaryAtomically, performProtocolSafeRollback } from './codex-rollback.js';

let work: string;
let genieBin: string;
let genieHome: string;
let previousDir: string;
let livePath: string;

const HEX128 = 'a'.repeat(32);
const BACKUP_VERSION = '5.260711.6';

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A self-hashing genie whose `update --print-update-capabilities` prints a protocol-1 report. */
function writeSelfHashingBinary(path: string, version: string): void {
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
}

function heldLease(): { lease: LifecycleLeaseResult; released: () => boolean } {
  let released = false;
  const lease: HeldLifecycleLease = {
    ok: true,
    operationId: 'b'.repeat(32),
    kind: 'rollback',
    assertOperation() {},
    release() {
      released = true;
    },
  };
  return { lease, released: () => released };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'genie-rollback-'));
  genieBin = join(work, 'bin');
  genieHome = work;
  previousDir = join(genieBin, '.previous');
  livePath = join(genieBin, 'genie');
  mkdirSync(previousDir, { recursive: true });
  // Live binary = the "new" generation being rolled back FROM.
  writeFileSync(livePath, 'new-generation-live-bytes', { mode: 0o755 });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Stage a protocol-1+ backup with a valid sidecar under .previous/. */
function stageProtocolBackup(): { backupPath: string; digest: string } {
  const backupPath = join(previousDir, `genie-${BACKUP_VERSION}`);
  writeSelfHashingBinary(backupPath, BACKUP_VERSION);
  publishBackupCapabilitySidecar({
    backupBinaryPath: backupPath,
    expectedPreviousVersion: BACKUP_VERSION,
    deliveryId: HEX128,
  });
  return { backupPath, digest: sha256File(backupPath) };
}

describe('discoverRollbackBackup', () => {
  test('finds a .previous/genie-* backup that carries a sidecar', () => {
    const { backupPath } = stageProtocolBackup();
    expect(discoverRollbackBackup(genieBin)).toBe(backupPath);
  });
  test('returns null when the backup has no sidecar (legacy)', () => {
    writeFileSync(join(previousDir, 'genie-5.260710.2'), 'legacy', { mode: 0o755 });
    expect(discoverRollbackBackup(genieBin)).toBeNull();
  });
  test('returns null when .previous is absent', () => {
    rmSync(previousDir, { recursive: true, force: true });
    expect(discoverRollbackBackup(genieBin)).toBeNull();
  });
});

describe('performProtocolSafeRollback — successful fixed→fixed', () => {
  test('swaps the live binary to the confirmed backup and revalidates, lease released', () => {
    const { backupPath, digest } = stageProtocolBackup();
    const gate = heldLease();
    const result = performProtocolSafeRollback({
      genieBin,
      genieHome,
      acquireLease: () => gate.lease,
    });
    expect(result).toEqual({ status: 'rolled-back', restoredVersion: BACKUP_VERSION, binarySha256: digest });
    // The live binary is now byte-identical to the confirmed backup.
    expect(sha256File(livePath)).toBe(digest);
    // The backup and its sidecar are preserved.
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(capabilitySidecarPath(backupPath))).toBe(true);
    // No rollback staging leftovers.
    expect(readdirSync(genieBin).filter((n) => n.includes('rollback-'))).toHaveLength(0);
    expect(gate.released()).toBe(true);
  });
});

describe('performProtocolSafeRollback — every refusal leaves state byte-identical', () => {
  function snapshotState(backupPath: string) {
    return {
      live: sha256File(livePath),
      backup: sha256File(backupPath),
      sidecar: sha256File(capabilitySidecarPath(backupPath)),
    };
  }

  test('no digest-bound backup ⇒ no-backup, live untouched', () => {
    writeFileSync(join(previousDir, 'genie-legacy'), 'legacy', { mode: 0o755 });
    const before = sha256File(livePath);
    const result = performProtocolSafeRollback({ genieBin, genieHome, acquireLease: () => heldLease().lease });
    expect(result.status).toBe('no-backup');
    expect(sha256File(livePath)).toBe(before);
  });

  test('floor refusal (pre-contract) ⇒ refused, live/backup/sidecar byte-identical', () => {
    const { backupPath } = stageProtocolBackup();
    const before = snapshotState(backupPath);
    const refused: RollbackFloorResult = { ok: false, reason: 'refusing to restore a pre-contract binary' };
    const result = performProtocolSafeRollback({
      genieBin,
      genieHome,
      enforceFloor: () => refused,
      acquireLease: () => heldLease().lease,
    });
    expect(result.status).toBe('refused');
    expect(snapshotState(backupPath)).toEqual(before);
  });

  test('busy lease ⇒ busy, live/backup/sidecar byte-identical, refused before staging', () => {
    const { backupPath, digest } = stageProtocolBackup();
    const before = snapshotState(backupPath);
    const busy: LifecycleLeaseResult = {
      ok: false,
      reason: 'codex-lifecycle-busy',
      holderKind: 'setup-activation',
      detail: 'held',
    };
    const result = performProtocolSafeRollback({
      genieBin,
      genieHome,
      enforceFloor: () => ({ ok: true, restoredVersion: BACKUP_VERSION, binarySha256: digest }),
      acquireLease: () => busy,
    });
    expect(result).toEqual({ status: 'busy', holderKind: 'setup-activation' });
    expect(snapshotState(backupPath)).toEqual(before);
  });

  test('TOCTOU digest change between confirmation and exchange ⇒ aborted, live untouched', () => {
    const { backupPath, digest } = stageProtocolBackup();
    const before = snapshotState(backupPath);
    let call = 0;
    const result = performProtocolSafeRollback({
      genieBin,
      genieHome,
      // First floor call confirms; the re-check under the lease returns a different digest.
      enforceFloor: () => {
        call += 1;
        return { ok: true, restoredVersion: BACKUP_VERSION, binarySha256: call === 1 ? digest : 'f'.repeat(64) };
      },
      acquireLease: () => heldLease().lease,
    });
    expect(result.status).toBe('aborted');
    if (result.status === 'aborted') expect(result.detail).toMatch(/changed between confirmation and exchange/);
    expect(snapshotState(backupPath)).toEqual(before);
  });
});

describe('exchangeBinaryAtomically — identity discipline', () => {
  test('a staged copy whose digest disagrees aborts and leaves the live binary untouched', () => {
    const backupPath = join(previousDir, 'genie-x');
    writeFileSync(backupPath, 'backup-bytes', { mode: 0o755 });
    const before = sha256File(livePath);
    // Pass a WRONG expected digest: the pre-commit verification must abort.
    expect(() => exchangeBinaryAtomically(backupPath, livePath, 'e'.repeat(64))).toThrow(/staged rollback copy digest/);
    expect(sha256File(livePath)).toBe(before);
    // No staging leftover.
    expect(readdirSync(genieBin).filter((n) => n.includes('rollback-'))).toHaveLength(0);
  });

  test('rejects a relative path', () => {
    expect(() => exchangeBinaryAtomically('backup', livePath, 'a'.repeat(64))).toThrow(/absolute/);
  });
});
