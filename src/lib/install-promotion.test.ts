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
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALL_PAYLOAD_MEMBERS,
  type InstallPayloadMember,
  type InstallPromotionDependencies,
  InstallPromotionError,
  InstallPromotionInterruptedError,
  type InstallPromotionRenameEvent,
  admitExternalInstallStaging,
  closeInstallStagingDirectory,
  createInstallStagingDirectory,
  installPromotionCapability,
  promoteStagedInstall,
  recoverPendingInstallPromotions,
  removeInstallStagingDirectory,
  verifyAdmittedInstallStagingPayload,
} from './install-promotion.js';
import { inspectPhysicalPath, physicalPathIdentitiesEqual } from './install-transaction.js';

const TEST_TRANSACTION_ID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

interface Fixture {
  root: string;
  home: string;
  bin: string;
  staging: string;
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-install-promotion-'));
  roots.push(root);
  return root;
}

function writePayload(root: string, generation: string): void {
  for (const name of ['.agents', '.claude-plugin', 'plugins', 'skills', 'templates']) {
    // Explicit 0o755 so the payload member dirs never inherit a group/other
    // write bit under a loose caller umask (umask 002 → 0o775), which the
    // promotion guards reject. Mirrors the modes real release tarballs ship.
    mkdirSync(join(root, name), { recursive: true, mode: 0o755 });
    writeFileSync(join(root, name, 'generation.txt'), `${generation}:${name}\n`, { mode: 0o644 });
  }
  writeFileSync(join(root, 'LICENSE'), `${generation}:license\n`, { mode: 0o644 });
  writeFileSync(join(root, 'VERSION'), `${generation}\n`, { mode: 0o644 });
  writeFileSync(join(root, 'genie'), `#!/bin/sh\necho genie ${generation}\n`);
  chmodSync(join(root, 'genie'), 0o755);
}

function makeFixture(withLive = true): Fixture {
  const root = makeRoot();
  const home = join(root, 'home');
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  if (withLive) writePayload(bin, '1.0.0');
  const staging = join(bin, '.install-staging-test');
  mkdirSync(staging, { mode: 0o700 });
  writePayload(staging, '2.0.0');
  return { root, home, bin, staging };
}

function dependencies(overrides: Omit<InstallPromotionDependencies, 'randomId'> = {}): InstallPromotionDependencies {
  return { randomId: () => TEST_TRANSACTION_ID, ...overrides };
}

function promote(
  fixture: Fixture,
  extra: {
    dependencies?: InstallPromotionDependencies;
    verifyVersion?: (phase: 'staged' | 'live') => boolean | undefined;
  } = {},
) {
  return promoteStagedInstall({
    genieHome: fixture.home,
    stagingRoot: fixture.staging,
    expectedVersion: '2.0.0',
    verifyVersion: ({ phase }) => extra.verifyVersion?.(phase),
    dependencies: extra.dependencies ?? dependencies(),
  });
}

function pendingRoots(fixture: Fixture): string[] {
  return readdirSync(fixture.home)
    .filter((name) => name.startsWith('.install-transaction-') && !name.startsWith('.install-transaction-preparing-'))
    .map((name) => join(fixture.home, name));
}

function assertGeneration(path: string, generation: string): void {
  expect(readFileSync(join(path, 'VERSION'), 'utf8')).toBe(`${generation}\n`);
  expect(readFileSync(join(path, 'plugins', 'generation.txt'), 'utf8')).toBe(`${generation}:plugins\n`);
}

function interruption(operation: InstallPromotionRenameEvent['operation'], member: InstallPayloadMember | null) {
  return dependencies({
    interruptAfterRename: (event) => event.operation === operation && event.member === member,
  });
}

function writeReceipt(
  transactionRoot: string,
  sequence: number,
  phase: 'committed' | 'created' | 'published' | 'rollback-started' | 'rolledback' | 'verified',
  mode = 0o600,
  member: InstallPayloadMember | null = null,
): void {
  const body = {
    schemaVersion: 1,
    transactionId: TEST_TRANSACTION_ID,
    sequence,
    phase,
    member,
  };
  writeFileSync(
    join(transactionRoot, 'receipts', `${sequence.toString().padStart(12, '0')}.json`),
    `${JSON.stringify(body)}\n`,
    {
      mode,
    },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('installer promotion transaction', () => {
  test('reports native capability and the exact release payload allowlist', () => {
    const result = installPromotionCapability();
    expect(result.available).toBe(true);
    expect(result.members).toEqual([...INSTALL_PAYLOAD_MEMBERS]);
  });

  test('promotes one physical generation, retains staging, and archives every prior object without copying', () => {
    const fixture = makeFixture();
    const priorLicense = inspectPhysicalPath(join(fixture.bin, 'LICENSE'));
    const priorBinary = inspectPhysicalPath(join(fixture.bin, 'genie'));

    const report = promote(fixture);

    expect(report.outcome).toBe('committed');
    expect(lstatSync(report.archivePath).isDirectory()).toBe(true);
    expect(lstatSync(fixture.staging).isDirectory()).toBe(true);
    expect(readdirSync(fixture.staging)).toEqual([]);
    assertGeneration(fixture.bin, '2.0.0');
    for (const name of INSTALL_PAYLOAD_MEMBERS) expect(lstatSync(join(fixture.bin, name)).isSymbolicLink()).toBe(false);
    expect(
      physicalPathIdentitiesEqual(inspectPhysicalPath(join(report.archivePath, 'prior', 'LICENSE')), priorLicense),
    ).toBe(true);
    expect(report.priorBinaryPath).toBe(join(fixture.bin, '.previous', `genie-prior-${TEST_TRANSACTION_ID}`));
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(report.priorBinaryPath as string), priorBinary)).toBe(true);
    expect(recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() })).toEqual([]);
  });

  test('rejects a stale VERSION stamp without changing the current or staged generation', () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.staging, 'VERSION'), '1.9.9\n');
    const liveBefore = inspectPhysicalPath(fixture.bin);
    const stagedBefore = inspectPhysicalPath(fixture.staging);

    expect(() => promote(fixture)).toThrow('staged VERSION does not exactly match 2.0.0');

    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(fixture.bin), liveBefore)).toBe(true);
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(fixture.staging), stagedBefore)).toBe(true);
    expect(pendingRoots(fixture)).toEqual([]);
  });

  test('rejects a multiply linked VERSION stamp without changing the current or staged generation', () => {
    const fixture = makeFixture();
    const versionAlias = join(fixture.root, 'VERSION-alias');
    linkSync(join(fixture.staging, 'VERSION'), versionAlias);
    const liveBefore = inspectPhysicalPath(fixture.bin);
    const stagedBefore = inspectPhysicalPath(fixture.staging);

    expect(() => promote(fixture)).toThrow('staged VERSION is not a bounded owned regular file');

    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(fixture.bin), liveBefore)).toBe(true);
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(fixture.staging), stagedBefore)).toBe(true);
    expect(readFileSync(versionAlias, 'utf8')).toBe('2.0.0\n');
    expect(pendingRoots(fixture)).toEqual([]);
  });

  const malformedVersionStamps: Array<{ label: string; contents: string }> = [
    { label: 'missing terminal LF', contents: '2.0.0' },
    { label: 'CRLF', contents: '2.0.0\r\n' },
    { label: 'extra whitespace', contents: ' 2.0.0\n' },
    { label: 'extra lines', contents: '2.0.0\nforeign\n' },
    { label: 'oversized content', contents: '2.0.0\n'.padEnd(257, 'x') },
  ];
  for (const { label, contents } of malformedVersionStamps) {
    test(`rejects ${label} in VERSION without changing the current install`, () => {
      const fixture = makeFixture();
      writeFileSync(join(fixture.staging, 'VERSION'), contents);
      const liveBefore = inspectPhysicalPath(fixture.bin);
      const stagedBefore = inspectPhysicalPath(fixture.staging);

      expect(() => promote(fixture)).toThrow(InstallPromotionError);

      expect(physicalPathIdentitiesEqual(inspectPhysicalPath(fixture.bin), liveBefore)).toBe(true);
      expect(physicalPathIdentitiesEqual(inspectPhysicalPath(fixture.staging), stagedBefore)).toBe(true);
      expect(pendingRoots(fixture)).toEqual([]);
    });
  }

  test('a live verification failure restores the exact prior generation and archives a rolled-back journal', () => {
    const fixture = makeFixture();
    const prior = inspectPhysicalPath(join(fixture.bin, 'plugins'));
    let failure: unknown;

    try {
      promote(fixture, { verifyVersion: (phase) => (phase === 'live' ? false : undefined) });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(InstallPromotionError);
    expect((failure as InstallPromotionError).rolledBack).toBe(true);
    expect((failure as InstallPromotionError).archivePath).toContain('.rolledback');
    assertGeneration(fixture.bin, '1.0.0');
    assertGeneration(fixture.staging, '2.0.0');
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(join(fixture.bin, 'plugins')), prior)).toBe(true);
    expect(pendingRoots(fixture)).toEqual([]);
  });

  test('a rollback failure before returning VERSION has already removed the incoming executable', () => {
    const fixture = makeFixture();
    let rollbackStarted = false;
    const observed: { binary: boolean | null; version: string | null } = { binary: null, version: null };
    const deps = dependencies({
      beforeRename: (event) => {
        if (rollbackStarted && event.operation === 'return-incoming' && event.member === 'VERSION') {
          observed.binary = existsSync(join(fixture.bin, 'genie'));
          observed.version = readFileSync(join(fixture.bin, 'VERSION'), 'utf8');
          throw new Error('simulated rollback failure before returning VERSION');
        }
      },
    });

    expect(() =>
      promote(fixture, {
        dependencies: deps,
        verifyVersion: (phase) => {
          if (phase !== 'live') return undefined;
          rollbackStarted = true;
          return false;
        },
      }),
    ).toThrow('rollback retained a transaction');

    expect(observed.binary).toBe(false);
    expect(observed.version).toBe('2.0.0\n');
    expect(existsSync(join(fixture.bin, 'genie'))).toBe(false);
    expect(pendingRoots(fixture)).toHaveLength(1);

    const [report] = recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });
    expect(report?.outcome).toBe('rolledback');
    assertGeneration(fixture.bin, '1.0.0');
    assertGeneration(fixture.staging, '2.0.0');
  });

  test('a rollback crash after restoring VERSION leaves the executable absent until it is restored last', () => {
    const fixture = makeFixture();
    let rollbackStarted = false;
    const deps = dependencies({
      interruptAfterRename: (event) =>
        rollbackStarted && event.operation === 'restore-prior' && event.member === 'VERSION',
    });

    expect(() =>
      promote(fixture, {
        dependencies: deps,
        verifyVersion: (phase) => {
          if (phase !== 'live') return undefined;
          rollbackStarted = true;
          return false;
        },
      }),
    ).toThrow('rollback retained a transaction');

    expect(readFileSync(join(fixture.bin, 'VERSION'), 'utf8')).toBe('1.0.0\n');
    expect(existsSync(join(fixture.bin, 'genie'))).toBe(false);
    expect(pendingRoots(fixture)).toHaveLength(1);

    const observedBeforeRestore: { binary: boolean | null; version: string | null } = {
      binary: null,
      version: null,
    };
    const recoveryDependencies = dependencies({
      beforeRename: (event) => {
        if (event.operation === 'restore-prior' && event.member === 'genie') {
          observedBeforeRestore.version = readFileSync(join(fixture.bin, 'VERSION'), 'utf8');
          observedBeforeRestore.binary = existsSync(join(fixture.bin, 'genie'));
        }
      },
    });
    const [report] = recoverPendingInstallPromotions({
      genieHome: fixture.home,
      dependencies: recoveryDependencies,
    });

    expect(report?.outcome).toBe('rolledback');
    expect(observedBeforeRestore.version).toBe('1.0.0\n');
    expect(observedBeforeRestore.binary).toBe(false);
    assertGeneration(fixture.bin, '1.0.0');
    assertGeneration(fixture.staging, '2.0.0');
  });

  test('a crash after capturing the prior executable leaves its old VERSION visible without an executable', () => {
    const fixture = makeFixture();

    expect(() => promote(fixture, { dependencies: interruption('capture-prior', 'genie') })).toThrow(
      InstallPromotionInterruptedError,
    );

    expect(readFileSync(join(fixture.bin, 'VERSION'), 'utf8')).toBe('1.0.0\n');
    expect(existsSync(join(fixture.bin, 'genie'))).toBe(false);
    expect(pendingRoots(fixture)).toHaveLength(1);

    const observedBeforeRestore: { binary: boolean | null; version: string | null } = {
      binary: null,
      version: null,
    };
    const recoveryDependencies = dependencies({
      beforeRename: (event) => {
        if (event.operation === 'restore-prior' && event.member === 'genie') {
          observedBeforeRestore.version = readFileSync(join(fixture.bin, 'VERSION'), 'utf8');
          observedBeforeRestore.binary = existsSync(join(fixture.bin, 'genie'));
        }
      },
    });
    const [report] = recoverPendingInstallPromotions({
      genieHome: fixture.home,
      dependencies: recoveryDependencies,
    });

    expect(report?.outcome).toBe('rolledback');
    expect(observedBeforeRestore.version).toBe('1.0.0\n');
    expect(observedBeforeRestore.binary).toBe(false);
    assertGeneration(fixture.bin, '1.0.0');
    assertGeneration(fixture.staging, '2.0.0');
  });

  test('a failure before capturing VERSION observes the prior executable already absent and restores the pair', () => {
    const fixture = makeFixture();
    const observed: { binary: boolean | null; version: string | null } = { binary: null, version: null };
    const deps = dependencies({
      beforeRename: (event) => {
        if (event.operation === 'capture-prior' && event.member === 'VERSION') {
          observed.binary = existsSync(join(fixture.bin, 'genie'));
          observed.version = readFileSync(join(fixture.bin, 'VERSION'), 'utf8');
          throw new Error('simulated failure before capturing VERSION');
        }
      },
    });

    expect(() => promote(fixture, { dependencies: deps })).toThrow(
      'install promotion failed and the exact prior generation was restored',
    );

    expect(observed.binary).toBe(false);
    expect(observed.version).toBe('1.0.0\n');
    assertGeneration(fixture.bin, '1.0.0');
    assertGeneration(fixture.staging, '2.0.0');
    expect(pendingRoots(fixture)).toEqual([]);
  });

  test('recovers a crash immediately after capture by inferring the exact physical state', () => {
    const fixture = makeFixture();
    const prior = inspectPhysicalPath(join(fixture.bin, '.agents'));

    expect(() => promote(fixture, { dependencies: interruption('capture-prior', '.agents') })).toThrow(
      InstallPromotionInterruptedError,
    );
    expect(pendingRoots(fixture)).toHaveLength(1);
    expect(existsSync(join(fixture.bin, '.agents'))).toBe(false);

    const reports = recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });
    expect(reports.map((report) => report.outcome)).toEqual(['rolledback']);
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(join(fixture.bin, '.agents')), prior)).toBe(true);
    assertGeneration(fixture.staging, '2.0.0');
    expect(recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() })).toEqual([]);
  });

  test('recovers a crash after publishing an originally absent member back into staging', () => {
    const fixture = makeFixture(false);
    const incoming = inspectPhysicalPath(join(fixture.staging, '.agents'));

    expect(() => promote(fixture, { dependencies: interruption('publish-incoming', '.agents') })).toThrow(
      InstallPromotionInterruptedError,
    );
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(join(fixture.bin, '.agents')), incoming)).toBe(true);

    const [report] = recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });
    expect(report?.outcome).toBe('rolledback');
    expect(existsSync(join(fixture.bin, '.agents'))).toBe(false);
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(join(fixture.staging, '.agents')), incoming)).toBe(true);
  });

  test('a final-boundary foreign target is preserved and keeps the transaction pending', () => {
    const fixture = makeFixture(false);
    const foreign = join(fixture.bin, '.agents');
    let injected = false;
    const deps = dependencies({
      beforeRename: (event) => {
        if (!injected && event.operation === 'publish-incoming' && event.member === '.agents') {
          injected = true;
          writeFileSync(foreign, 'foreign target\n');
        }
      },
    });

    expect(() => promote(fixture, { dependencies: deps })).toThrow('rollback retained a transaction');
    expect(readFileSync(foreign, 'utf8')).toBe('foreign target\n');
    expect(lstatSync(join(fixture.staging, '.agents')).isDirectory()).toBe(true);
    expect(pendingRoots(fixture)).toHaveLength(1);
  });

  test('same-byte inode ABA at the native boundary is never mistaken for the journaled source', () => {
    const fixture = makeFixture();
    const live = join(fixture.bin, 'LICENSE');
    const originalPath = join(fixture.root, 'original-license');
    const original = inspectPhysicalPath(live);
    let injected = false;
    const deps = dependencies({
      beforeRename: (event) => {
        if (!injected && event.operation === 'capture-prior' && event.member === 'LICENSE') {
          injected = true;
          const bytes = readFileSync(live);
          renameSync(live, originalPath);
          writeFileSync(live, bytes, { mode: 0o644 });
        }
      },
    });

    expect(() => promote(fixture, { dependencies: deps })).toThrow('rollback retained a transaction');
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(originalPath), original)).toBe(true);
    expect(readFileSync(join(pendingRoots(fixture)[0] as string, 'prior', 'LICENSE'), 'utf8')).toBe('1.0.0:license\n');
    expect(pendingRoots(fixture)).toHaveLength(1);
  });

  test('rollback refuses an occupied staging name and preserves both foreign and published objects', () => {
    const fixture = makeFixture(false);
    const incoming = inspectPhysicalPath(join(fixture.staging, '.agents'));
    expect(() => promote(fixture, { dependencies: interruption('publish-incoming', '.agents') })).toThrow(
      InstallPromotionInterruptedError,
    );
    mkdirSync(join(fixture.staging, '.agents'), { mode: 0o755 });
    writeFileSync(join(fixture.staging, '.agents', 'foreign.txt'), 'foreign\n', { mode: 0o644 });

    expect(() => recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() })).toThrow(
      'could not be recovered safely',
    );
    expect(readFileSync(join(fixture.staging, '.agents', 'foreign.txt'), 'utf8')).toBe('foreign\n');
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(join(fixture.bin, '.agents')), incoming)).toBe(true);
    expect(pendingRoots(fixture)).toHaveLength(1);
  });

  test('a symlink prior is moved and restored as an object without touching its target', () => {
    const fixture = makeFixture();
    const victim = join(fixture.root, 'victim');
    const templates = join(fixture.bin, 'templates');
    rmSync(templates, { recursive: true });
    mkdirSync(victim);
    writeFileSync(join(victim, 'untouched.txt'), 'untouched\n');
    symlinkSync(victim, templates);
    const prior = inspectPhysicalPath(templates);

    expect(() => promote(fixture, { dependencies: interruption('publish-incoming', 'templates') })).toThrow(
      InstallPromotionInterruptedError,
    );
    recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });

    expect(lstatSync(templates).isSymbolicLink()).toBe(true);
    expect(readlinkSync(templates)).toBe(victim);
    expect(readFileSync(join(victim, 'untouched.txt'), 'utf8')).toBe('untouched\n');
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(templates), prior)).toBe(true);
  });

  test('an active transaction is rollback-only even after a committed receipt and prior backup publication', () => {
    const fixture = makeFixture();
    let failArchive = true;
    const deps = dependencies({
      beforeRename: (event) => {
        if (failArchive && event.operation === 'archive-transaction') {
          failArchive = false;
          throw new Error('simulated process death before archive');
        }
      },
    });

    expect(() => promote(fixture, { dependencies: deps })).toThrow('terminal decision');
    assertGeneration(fixture.bin, '2.0.0');
    expect(pendingRoots(fixture)).toHaveLength(1);

    const [report] = recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });
    expect(report?.outcome).toBe('rolledback');
    assertGeneration(fixture.bin, '1.0.0');
    assertGeneration(fixture.staging, '2.0.0');
    expect(pendingRoots(fixture)).toEqual([]);
  });

  test('an active committed receipt is rolled back before prior-binary backup publication', () => {
    const fixture = makeFixture();
    let stopBeforeBackup = true;
    const deps = dependencies({
      beforeRename: (event) => {
        if (stopBeforeBackup && event.operation === 'publish-prior-binary') {
          stopBeforeBackup = false;
          throw new Error('simulated death before prior-binary publication');
        }
      },
    });

    expect(() => promote(fixture, { dependencies: deps })).toThrow('terminal decision');
    assertGeneration(fixture.bin, '2.0.0');
    expect(existsSync(join(fixture.bin, '.previous', `genie-prior-${TEST_TRANSACTION_ID}`))).toBe(false);

    const [report] = recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });
    expect(report?.outcome).toBe('rolledback');
    expect(report?.priorBinaryPath).toBeUndefined();
    expect(existsSync(join(fixture.bin, '.previous', `genie-prior-${TEST_TRANSACTION_ID}`))).toBe(false);
    assertGeneration(fixture.bin, '1.0.0');
    assertGeneration(fixture.staging, '2.0.0');
  });

  test('accepts a current-user physical 0755 .previous directory without weakening no-clobber backup publication', () => {
    const fixture = makeFixture();
    const previous = join(fixture.bin, '.previous');
    mkdirSync(previous, { mode: 0o755 });

    const report = promote(fixture);

    expect(report.outcome).toBe('committed');
    expect(lstatSync(previous).mode & 0o777).toBe(0o755);
    expect(existsSync(report.priorBinaryPath as string)).toBe(true);
  });

  test('a nested symlink inserted after stable member inspection is identity-mismatched and never committed', () => {
    const fixture = makeFixture(false);
    const outside = join(fixture.root, 'outside-race');
    writeFileSync(outside, 'outside\n');
    let agentsInspections = 0;
    const deps = dependencies({
      afterPayloadMemberInspected: (member) => {
        if (member === '.agents' && ++agentsInspections === 2) {
          symlinkSync(outside, join(fixture.staging, '.agents', 'late-link'));
        }
      },
    });

    expect(() => promote(fixture, { dependencies: deps })).toThrow('rollback retained a transaction');
    expect(existsSync(join(fixture.bin, '.agents'))).toBe(false);
    expect(lstatSync(join(fixture.staging, '.agents', 'late-link')).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('outside\n');
    expect(pendingRoots(fixture)).toHaveLength(1);
  });

  test('a nested mutation at the final publish boundary is quarantined away from the public live name', () => {
    const fixture = makeFixture(false);
    const outside = join(fixture.root, 'outside-final-boundary');
    writeFileSync(outside, 'outside\n');
    let injected = false;
    const deps = dependencies({
      beforeRename: (event) => {
        if (!injected && event.operation === 'publish-incoming' && event.member === '.agents') {
          injected = true;
          symlinkSync(outside, join(fixture.staging, '.agents', 'late-link'));
        }
      },
    });

    expect(() => promote(fixture, { dependencies: deps })).toThrow('rollback retained a transaction');
    expect(existsSync(join(fixture.bin, '.agents'))).toBe(false);
    expect(lstatSync(join(fixture.staging, '.agents', 'late-link')).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('outside\n');
    expect(pendingRoots(fixture)).toHaveLength(1);
  });

  test('forged verified and committed receipts after the final binary publish cannot authorize activation', () => {
    const fixture = makeFixture();
    const priorBinary = inspectPhysicalPath(join(fixture.bin, 'genie'));
    expect(() => promote(fixture, { dependencies: interruption('publish-incoming', 'genie') })).toThrow(
      InstallPromotionInterruptedError,
    );
    const transactionRoot = pendingRoots(fixture)[0] as string;
    let sequence = readdirSync(join(transactionRoot, 'receipts')).length + 1;
    writeReceipt(transactionRoot, sequence++, 'published', 0o600, 'genie');
    writeReceipt(transactionRoot, sequence++, 'verified');
    writeReceipt(transactionRoot, sequence, 'committed');

    const [report] = recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });
    expect(report?.outcome).toBe('rolledback');
    assertGeneration(fixture.bin, '1.0.0');
    assertGeneration(fixture.staging, '2.0.0');
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(join(fixture.bin, 'genie')), priorBinary)).toBe(true);
    expect(pendingRoots(fixture)).toEqual([]);
  });

  for (const forgedTerminal of ['committed', 'rolledback'] as const) {
    test(`rejects a forged canonical ${forgedTerminal} receipt without an authorized receipt history`, () => {
      const fixture = makeFixture(false);
      expect(() => promote(fixture, { dependencies: interruption('activate-transaction', null) })).toThrow(
        InstallPromotionInterruptedError,
      );
      const transactionRoot = pendingRoots(fixture)[0] as string;
      writeReceipt(transactionRoot, 1, 'created');
      writeReceipt(transactionRoot, 2, forgedTerminal);

      expect(() => recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() })).toThrow(
        forgedTerminal === 'committed' ? 'not immediately authorized' : 'not authorized by rollback-started',
      );
      expect(readdirSync(fixture.staging).sort()).toEqual([...INSTALL_PAYLOAD_MEMBERS]);
      expect(INSTALL_PAYLOAD_MEMBERS.some((name) => existsSync(join(fixture.bin, name)))).toBe(false);
      expect(pendingRoots(fixture)).toEqual([transactionRoot]);
    });
  }

  test('an authorized-looking committed history is rollback-only in an active transaction', () => {
    const fixture = makeFixture(false);
    expect(() => promote(fixture, { dependencies: interruption('activate-transaction', null) })).toThrow(
      InstallPromotionInterruptedError,
    );
    const transactionRoot = pendingRoots(fixture)[0] as string;
    writeReceipt(transactionRoot, 1, 'created');
    writeReceipt(transactionRoot, 2, 'verified');
    writeReceipt(transactionRoot, 3, 'committed');

    const [report] = recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });
    expect(report?.outcome).toBe('rolledback');
    expect(readdirSync(fixture.staging).sort()).toEqual([...INSTALL_PAYLOAD_MEMBERS]);
    expect(INSTALL_PAYLOAD_MEMBERS.some((name) => existsSync(join(fixture.bin, name)))).toBe(false);
  });

  test('an authorized-looking rolledback history still infers and rolls back a published member', () => {
    const fixture = makeFixture(false);
    expect(() => promote(fixture, { dependencies: interruption('publish-incoming', '.agents') })).toThrow(
      InstallPromotionInterruptedError,
    );
    const transactionRoot = pendingRoots(fixture)[0] as string;
    writeReceipt(transactionRoot, 2, 'rollback-started');
    writeReceipt(transactionRoot, 3, 'rolledback');

    const [report] = recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });
    expect(report?.outcome).toBe('rolledback');
    expect(existsSync(join(fixture.bin, '.agents'))).toBe(false);
    expect(lstatSync(join(fixture.staging, '.agents')).isDirectory()).toBe(true);
  });

  test('rejects non-0600 receipts and unknown transaction-root objects without mutating payload paths', () => {
    const fixture = makeFixture(false);
    expect(() => promote(fixture, { dependencies: interruption('activate-transaction', null) })).toThrow(
      InstallPromotionInterruptedError,
    );
    const transactionRoot = pendingRoots(fixture)[0] as string;
    writeReceipt(transactionRoot, 1, 'created', 0o644);

    expect(() => recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() })).toThrow(
      'not a bounded regular file',
    );
    chmodSync(join(transactionRoot, 'receipts', '000000000001.json'), 0o600);
    writeFileSync(join(transactionRoot, 'foreign-root-object'), 'foreign\n');
    expect(() => recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() })).toThrow(
      'unknown or missing object',
    );
    expect(readFileSync(join(transactionRoot, 'foreign-root-object'), 'utf8')).toBe('foreign\n');
    expect(readdirSync(fixture.staging).sort()).toEqual([...INSTALL_PAYLOAD_MEMBERS]);
  });

  test('rejects nested staged symlinks before executing the version verifier or publishing a journal', () => {
    const fixture = makeFixture(false);
    const outside = join(fixture.root, 'outside');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(fixture.staging, 'plugins', 'escape'));
    let verifierCalled = false;

    expect(() =>
      promoteStagedInstall({
        genieHome: fixture.home,
        stagingRoot: fixture.staging,
        expectedVersion: '2.0.0',
        verifyVersion: () => {
          verifierCalled = true;
          return undefined;
        },
        dependencies: dependencies(),
      }),
    ).toThrow('staged payload contains a symlink');
    expect(verifierCalled).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('outside\n');
    expect(pendingRoots(fixture)).toEqual([]);
  });

  test('creates and removes an empty direct private stage through held descriptors', () => {
    const root = makeRoot();
    const home = join(root, 'home');
    mkdirSync(join(home, 'bin'), { recursive: true, mode: 0o700 });
    const guard = createInstallStagingDirectory({
      genieHome: home,
      randomId: () => '44444444-4444-4444-8444-444444444444',
    });
    try {
      expect(lstatSync(guard.stagingRoot).mode & 0o777).toBe(0o700);
      expect(removeInstallStagingDirectory(guard)).toBe(true);
      expect(existsSync(guard.stagingRoot)).toBe(false);
    } finally {
      closeInstallStagingDirectory(guard);
    }
  });

  test('a replacement directory at the cleanup name is preserved instead of unlinking the wrong object', () => {
    const root = makeRoot();
    const home = join(root, 'home');
    const bin = join(home, 'bin');
    const name = '.install-staging-55555555-5555-4555-8555-555555555555';
    const displaced = join(bin, '.held-stage');
    mkdirSync(bin, { recursive: true, mode: 0o700 });

    expect(() =>
      createInstallStagingDirectory({
        genieHome: home,
        randomId: () => '55555555-5555-4555-8555-555555555555',
        afterCreated: () => {
          renameSync(join(bin, name), displaced);
          mkdirSync(join(bin, name), { mode: 0o700 });
        },
      }),
    ).toThrow('changed after its physical directory was bound');
    expect(existsSync(join(bin, name))).toBe(true);
    expect(readdirSync(join(bin, name))).toEqual([]);
    expect(existsSync(displaced)).toBe(true);
  });

  test('bin replacement after validation never creates staging in the symlink victim', () => {
    const root = makeRoot();
    const home = join(root, 'home');
    const bin = join(home, 'bin');
    const heldBin = join(home, 'held-bin');
    const victim = join(root, 'victim');
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    mkdirSync(victim, { mode: 0o700 });
    writeFileSync(join(victim, 'sentinel'), 'safe\n');

    expect(() =>
      createInstallStagingDirectory({
        genieHome: home,
        randomId: () => '66666666-6666-4666-8666-666666666666',
        afterParentValidated: () => {
          renameSync(bin, heldBin);
          symlinkSync(victim, bin);
        },
      }),
    ).toThrow();
    expect(readdirSync(victim)).toEqual(['sentinel']);
    expect(readFileSync(join(victim, 'sentinel'), 'utf8')).toBe('safe\n');
  });

  test('admission copies only into the held stage and rejects visible-stage replacement', () => {
    const root = makeRoot();
    const home = join(root, 'home');
    const bin = join(home, 'bin');
    const external = join(root, 'external');
    const victim = join(root, 'victim');
    const name = '.install-staging-77777777-7777-4777-8777-777777777777';
    const quarantined = join(bin, '.quarantined-held-stage');
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    mkdirSync(external, { mode: 0o700 });
    mkdirSync(victim, { mode: 0o700 });
    writePayload(external, '2.0.0');
    writeFileSync(join(victim, 'sentinel'), 'safe\n');

    expect(() =>
      admitExternalInstallStaging({
        genieHome: home,
        externalStagingRoot: external,
        expectedVersion: '2.0.0',
        randomId: () => '77777777-7777-4777-8777-777777777777',
        afterCreated: () => {
          renameSync(join(bin, name), quarantined);
          symlinkSync(victim, join(bin, name));
        },
      }),
    ).toThrow();
    expect(readFileSync(join(quarantined, 'plugins', 'generation.txt'), 'utf8')).toBe('2.0.0:plugins\n');
    expect(readdirSync(victim)).toEqual(['sentinel']);
    expect(readFileSync(join(victim, 'sentinel'), 'utf8')).toBe('safe\n');
  });

  test('post-admission same-root mutation breaks the authenticated payload guard', () => {
    const root = makeRoot();
    const home = join(root, 'home');
    const external = join(root, 'external');
    mkdirSync(join(home, 'bin'), { recursive: true, mode: 0o700 });
    mkdirSync(external, { mode: 0o700 });
    writePayload(external, '2.0.0');
    const guard = admitExternalInstallStaging({
      genieHome: home,
      externalStagingRoot: external,
      expectedVersion: '2.0.0',
      randomId: () => '88888888-8888-4888-8888-888888888888',
    });
    try {
      writeFileSync(join(guard.stagingRoot, 'plugins', 'generation.txt'), 'foreign\n');
      expect(() => verifyAdmittedInstallStagingPayload(guard)).toThrow('authenticated content digest');
    } finally {
      closeInstallStagingDirectory(guard);
    }
  });
});
