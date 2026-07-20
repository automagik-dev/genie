import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIFECYCLE_LEASE_OWNER_ENV, LIFECYCLE_LEASE_PATH_ENV, lifecycleLockPath } from '../lib/agent-sync.js';
import { type InstallPromotionDependencies, recoverPendingInstallPromotions } from '../lib/install-promotion.js';
import { InstallPromoteCommandError, installPromoteCommand } from './install-promote.js';

const roots: string[] = [];
const originalLeasePath = process.env[LIFECYCLE_LEASE_PATH_ENV];
const originalLeaseOwner = process.env[LIFECYCLE_LEASE_OWNER_ENV];
const originalGenieHome = process.env.GENIE_HOME;

afterEach(() => {
  // `process.env[X] = undefined` would store the literal string "undefined";
  // delete restores the genuinely-unset state for later test files.
  if (originalLeasePath === undefined) delete process.env[LIFECYCLE_LEASE_PATH_ENV];
  else process.env[LIFECYCLE_LEASE_PATH_ENV] = originalLeasePath;
  if (originalLeaseOwner === undefined) delete process.env[LIFECYCLE_LEASE_OWNER_ENV];
  else process.env[LIFECYCLE_LEASE_OWNER_ENV] = originalLeaseOwner;
  if (originalGenieHome === undefined) {
    // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
    delete process.env.GENIE_HOME;
  } else process.env.GENIE_HOME = originalGenieHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writePayload(root: string, version: string): void {
  for (const name of ['.agents', '.claude-plugin', 'plugins', 'skills', 'templates']) {
    mkdirSync(join(root, name), { recursive: true, mode: 0o755 });
    writeFileSync(join(root, name, 'generation.txt'), `${version}:${name}\n`, { mode: 0o644 });
  }
  writeFileSync(join(root, 'LICENSE'), `${version}:license\n`, { mode: 0o644 });
  writeFileSync(join(root, 'VERSION'), `${version}\n`, { mode: 0o644 });
  writeFileSync(join(root, 'genie'), `#!/bin/sh\necho genie ${version}\n`);
  chmodSync(join(root, 'genie'), 0o755);
}

function fixture(withLive = true) {
  const root = mkdtempSync(join(tmpdir(), 'genie-install-promote-command-'));
  roots.push(root);
  const userHome = join(root, 'user');
  const genieHome = join(userHome, '.genie');
  const bin = join(genieHome, 'bin');
  const staging = join(root, 'release-payload');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  if (withLive) writePayload(bin, '1.0.0');
  writePayload(staging, '2.0.0');
  const owner = `12345:${'a'.repeat(32)}:unknown`;
  const ownerFile = join(userHome, '.installer-owner');
  const leasePath = lifecycleLockPath(genieHome);
  writeFileSync(ownerFile, `${owner}\n`, { mode: 0o600 });
  linkSync(ownerFile, leasePath);
  process.env.GENIE_HOME = genieHome;
  process.env[LIFECYCLE_LEASE_PATH_ENV] = leasePath;
  process.env[LIFECYCLE_LEASE_OWNER_ENV] = owner;
  return { root, userHome, genieHome, bin, staging, owner, ownerFile, leasePath };
}

function run(
  f: ReturnType<typeof fixture>,
  emit: string[] = [],
  promotionOverrides: Omit<InstallPromotionDependencies, 'randomId'> = {},
): void {
  installPromoteCommand(
    { stagingRoot: f.staging, expectedVersion: '2.0.0' },
    {
      runtimeExecutable: join(f.staging, 'genie'),
      runtimeVersion: '2.0.0',
      userHome: f.userHome,
      emit: (line) => emit.push(line),
      promotion: {
        randomId: () =>
          f.staging.endsWith('second')
            ? '33333333-3333-4333-8333-333333333333'
            : '22222222-2222-4222-8222-222222222222',
        ...promotionOverrides,
      },
    },
  );
}

describe('hidden installer promoter command', () => {
  test('borrows the exact shell lease, promotes, and publishes one canonical no-clobber link', () => {
    const f = fixture();
    const output: string[] = [];

    run(f, output);

    expect(readFileSync(join(f.bin, 'VERSION'), 'utf8')).toBe('2.0.0\n');
    const canonicalLink = join(f.userHome, '.local', 'bin', 'genie');
    expect(lstatSync(canonicalLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(canonicalLink)).toBe(join(f.bin, 'genie'));
    expect(lstatSync(f.leasePath).nlink).toBe(2);
    expect(readFileSync(f.leasePath, 'utf8')).toBe(`${f.owner}\n`);
    expect(JSON.parse(output[0] as string)).toMatchObject({ outcome: 'committed', canonicalLink });
  });

  test('missing borrowed authority fails before any live or link mutation', () => {
    const f = fixture();
    delete process.env[LIFECYCLE_LEASE_OWNER_ENV];

    expect(() => run(f)).toThrow(InstallPromoteCommandError);
    expect(readFileSync(join(f.bin, 'VERSION'), 'utf8')).toBe('1.0.0\n');
    expect(existsSync(join(f.userHome, '.local'))).toBe(false);
  });

  test('a symlinked lease path is rejected without following or mutating its target', () => {
    const f = fixture();
    const victim = join(f.root, 'lease-victim');
    writeFileSync(victim, `${f.owner}\n`);
    unlinkSync(f.leasePath);
    symlinkSync(victim, f.leasePath);

    expect(() => run(f)).toThrow('physical regular file');
    expect(readFileSync(victim, 'utf8')).toBe(`${f.owner}\n`);
    expect(readFileSync(join(f.bin, 'VERSION'), 'utf8')).toBe('1.0.0\n');
  });

  test('an owner-record replacement is rejected and the shell owner link remains', () => {
    const f = fixture();
    writeFileSync(f.ownerFile, 'foreign-owner\n');

    expect(() => run(f)).toThrow('owner changed');
    expect(lstatSync(f.leasePath).nlink).toBe(2);
    expect(readFileSync(join(f.bin, 'VERSION'), 'utf8')).toBe('1.0.0\n');
  });

  test('a foreign canonical pathname is preserved and blocks promotion', () => {
    const f = fixture();
    const link = join(f.userHome, '.local', 'bin', 'genie');
    mkdirSync(join(f.userHome, '.local', 'bin'), { recursive: true, mode: 0o755 });
    writeFileSync(link, 'foreign canonical file');

    expect(() => run(f)).toThrow();
    expect(readFileSync(link, 'utf8')).toBe('foreign canonical file');
    expect(readFileSync(join(f.bin, 'VERSION'), 'utf8')).toBe('1.0.0\n');
  });

  test('an incomplete staged payload fails without publishing a dangling canonical link', () => {
    const f = fixture(false);
    rmSync(join(f.staging, 'templates'), { recursive: true });
    const canonicalLink = join(f.userHome, '.local', 'bin', 'genie');

    expect(() => run(f)).toThrow('exact installer member allowlist');
    expect(existsSync(join(f.bin, 'genie'))).toBe(false);
    expect(existsSync(canonicalLink)).toBe(false);
  });

  test('same-byte but different-inode mutation authority is rejected', () => {
    const f = fixture();
    const impostor = join(f.root, 'impostor');
    writeFileSync(impostor, readFileSync(join(f.staging, 'genie')));
    chmodSync(impostor, 0o755);

    expect(() =>
      installPromoteCommand(
        { stagingRoot: f.staging, expectedVersion: '2.0.0' },
        { runtimeExecutable: impostor, runtimeVersion: '2.0.0', userHome: f.userHome },
      ),
    ).toThrow('exact verified staged executable');
    expect(readFileSync(join(f.bin, 'VERSION'), 'utf8')).toBe('1.0.0\n');
  });

  test('native self-test is isolated from production lease authority', () => {
    delete process.env[LIFECYCLE_LEASE_PATH_ENV];
    delete process.env[LIFECYCLE_LEASE_OWNER_ENV];
    const output: string[] = [];

    installPromoteCommand({ selfTest: true }, { emit: (line) => output.push(line) });

    expect(JSON.parse(output[0] as string)).toMatchObject({ schemaVersion: 1, ok: true });
  });

  test('a second invocation converges idempotently with the existing canonical link', () => {
    const f = fixture();
    run(f);
    const secondStaging = join(f.root, 'release-payload-second');
    mkdirSync(secondStaging, { mode: 0o700 });
    writePayload(secondStaging, '2.0.0');
    f.staging = secondStaging;

    run(f);

    expect(readFileSync(join(f.bin, 'VERSION'), 'utf8')).toBe('2.0.0\n');
    expect(readdirSync(join(f.bin, '.previous')).filter((name) => name.startsWith('genie-prior-'))).toHaveLength(2);
  });

  test('the injected final-boundary seam runs before lease authority is rechecked', () => {
    const f = fixture();
    let replaced = false;

    expect(() =>
      run(f, [], {
        beforeRename: () => {
          if (replaced) return;
          replaced = true;
          unlinkSync(f.leasePath);
          writeFileSync(f.leasePath, `${f.owner}\n`, { mode: 0o600 });
        },
      }),
    ).toThrow();
    expect(replaced).toBe(true);
    expect(readFileSync(join(f.bin, 'VERSION'), 'utf8')).toBe('1.0.0\n');
    expect(readFileSync(f.leasePath, 'utf8')).toBe(`${f.owner}\n`);
  });

  test('post-admission payload mutation cannot reach the live generation', () => {
    const f = fixture();
    const internalStage = join(f.bin, '.install-staging-22222222-2222-4222-8222-222222222222');
    let mutated = false;

    expect(() =>
      run(f, [], {
        beforeRename: () => {
          if (mutated) return;
          mutated = true;
          writeFileSync(join(internalStage, 'plugins', 'generation.txt'), 'foreign\n');
        },
      }),
    ).toThrow();
    expect(mutated).toBe(true);
    expect(readFileSync(join(f.bin, 'VERSION'), 'utf8')).toBe('1.0.0\n');
    expect(readFileSync(join(f.bin, 'plugins', 'generation.txt'), 'utf8')).toBe('1.0.0:plugins\n');
  });

  test('an interrupted final publish retains the exact empty stage required for rollback recovery', () => {
    const f = fixture();
    const internalStage = join(f.bin, '.install-staging-22222222-2222-4222-8222-222222222222');

    expect(() =>
      run(f, [], {
        interruptAfterRename: (event) => event.operation === 'publish-incoming' && event.member === 'genie',
      }),
    ).toThrow();
    expect(existsSync(internalStage)).toBe(true);
    expect(readdirSync(internalStage)).toEqual([]);

    recoverPendingInstallPromotions({
      genieHome: f.genieHome,
      dependencies: { randomId: () => '99999999-9999-4999-8999-999999999999' },
    });
    expect(readFileSync(join(f.bin, 'VERSION'), 'utf8')).toBe('1.0.0\n');
    expect(readFileSync(join(internalStage, 'VERSION'), 'utf8')).toBe('2.0.0\n');
  });
});
