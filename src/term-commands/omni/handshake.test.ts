/**
 * Unit tests for `genie omni handshake` keypair + filesystem helpers.
 *
 * Covers:
 *   - keyPaths() respects $GENIE_HOME so tests can isolate.
 *   - assertNotInsideGitRepo throws when the target path lives under a .git dir.
 *   - generateAndPersistKeypair creates 0600 perms on the private key and
 *     writes a base64url-encoded 32-byte public key (44 chars unpadded
 *     since 32 bytes / 3 * 4 = 42.67 → 43 chars + maybe padding).
 *   - loadHostJson + writeHostJson round-trip a HostRecord.
 *
 * The HTTP path (callTrustEndpoint → omni's POST /trust/handshake) is
 * exercised indirectly by the omni-side endpoint tests in
 * automagik-dev/omni#556 and #558. We don't re-test the omni contract
 * here; we just pin the local filesystem invariants.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__ } from './handshake';

const ORIGINAL_GENIE_HOME = process.env.GENIE_HOME;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'genie-handshake-test-'));
  process.env.GENIE_HOME = workDir;
});

afterEach(() => {
  if (ORIGINAL_GENIE_HOME === undefined) {
    process.env.GENIE_HOME = undefined;
  } else {
    process.env.GENIE_HOME = ORIGINAL_GENIE_HOME;
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('keyPaths', () => {
  test('respects $GENIE_HOME', () => {
    const paths = __test__.keyPaths();
    expect(paths.dir).toBe(join(workDir, 'keys'));
    expect(paths.privateKey).toBe(join(workDir, 'keys', 'genie-host.ed25519'));
    expect(paths.publicKey).toBe(join(workDir, 'keys', 'genie-host.ed25519.pub'));
    expect(paths.hostJson).toBe(join(workDir, 'keys', 'host.json'));
  });
});

describe('assertNotInsideGitRepo', () => {
  test('throws when the path lives inside a git working tree', () => {
    // Bare init avoids needing user.name/email config.
    execSync(`git -C ${workDir} init --quiet`);
    const inside = join(workDir, 'subdir', 'keys');
    expect(() => __test__.assertNotInsideGitRepo(inside)).toThrow(/git working tree/i);
  });

  test('does not throw when the path is outside any git tree', () => {
    // workDir is a fresh tmpdir with no .git; no parent has one either
    // (assuming /tmp isn't itself a git repo, which it isn't on real systems).
    const outside = join(workDir, 'keys');
    expect(() => __test__.assertNotInsideGitRepo(outside)).not.toThrow();
  });
});

describe('generateAndPersistKeypair', () => {
  test('writes the private key with 0600 perms', () => {
    const paths = __test__.keyPaths();
    mkdirSync(paths.dir, { recursive: true });
    const { pubkeyB64Url } = __test__.generateAndPersistKeypair(paths);

    const privStat = statSync(paths.privateKey);
    // Mask out the file-type bits and assert the perm bits.
    expect(privStat.mode & 0o777).toBe(0o600);

    expect(pubkeyB64Url).toMatch(/^[A-Za-z0-9_-]{43}=?$/);
  });

  test('public key file matches the returned base64url', () => {
    const paths = __test__.keyPaths();
    mkdirSync(paths.dir, { recursive: true });
    const { pubkeyB64Url } = __test__.generateAndPersistKeypair(paths);
    const onDisk = readFileSync(paths.publicKey, 'utf-8').trim();
    expect(onDisk).toBe(pubkeyB64Url);
  });

  test('regenerating overwrites the keypair', () => {
    const paths = __test__.keyPaths();
    mkdirSync(paths.dir, { recursive: true });
    const first = __test__.generateAndPersistKeypair(paths);
    const second = __test__.generateAndPersistKeypair(paths);
    // ed25519 keys are 32 random bytes — collision odds are astronomically low.
    expect(second.pubkeyB64Url).not.toBe(first.pubkeyB64Url);
  });
});

describe('host.json round-trip', () => {
  test('loadHostJson returns null when missing', () => {
    const paths = __test__.keyPaths();
    expect(__test__.loadHostJson(paths)).toBeNull();
  });

  test('write then load returns the same record', () => {
    const paths = __test__.keyPaths();
    mkdirSync(paths.dir, { recursive: true });
    const record = {
      hostId: 'host-uuid-1',
      pubkey: 'A'.repeat(43),
      hostname: 'genie.local',
      registeredAt: new Date().toISOString(),
    };
    __test__.writeHostJson(paths, record);
    const loaded = __test__.loadHostJson(paths);
    expect(loaded).toEqual(record);
  });

  test('loadHostJson returns null when the file is malformed JSON', () => {
    const paths = __test__.keyPaths();
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.hostJson, 'not json at all');
    expect(__test__.loadHostJson(paths)).toBeNull();
  });
});
