import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convergeAuxiliaryTree } from '../genie-commands/auxiliary-trees.js';
import {
  INSTALL_PAYLOAD_COMPAT_MEMBERS,
  INSTALL_PAYLOAD_MEMBERS,
  type InstallPayloadMember,
  type InstallPromotionDependencies,
  InstallPromotionError,
  InstallPromotionInterruptedError,
  type InstallPromotionRenameEvent,
  admitExternalInstallStaging,
  closeInstallStagingDirectory,
  createInstallStagingDirectory,
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
  // Real tarballs ship `.agents` and `.claude-plugin` as empty compat dirs.
  for (const name of INSTALL_PAYLOAD_COMPAT_MEMBERS) mkdirSync(join(root, name), { recursive: true, mode: 0o755 });
  for (const name of ['plugins', 'skills', 'templates']) {
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
  const path = join(transactionRoot, 'receipts', `${sequence.toString().padStart(12, '0')}.json`);
  writeFileSync(path, `${JSON.stringify(body)}\n`, { mode });
  chmodSync(path, mode); // the create mode is umask-filtered; tests need the exact bits they asked for
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('installer payload member contract', () => {
  test('the top-level member set is frozen for cross-release update compatibility', () => {
    // `genie update` runs the PREVIOUS release's promoter against the NEW
    // tarball. Changing this set breaks update on every already-installed host
    // (5.260901.1 vs 5.260831.x). Do not edit without a shape-tolerant promoter.
    expect([...INSTALL_PAYLOAD_MEMBERS]).toEqual([
      '.agents',
      '.claude-plugin',
      'LICENSE',
      'VERSION',
      'genie',
      'plugins',
      'skills',
      'templates',
    ]);
    expect([...INSTALL_PAYLOAD_COMPAT_MEMBERS]).toEqual(['.agents', '.claude-plugin']);
  });

  test('empty compat directories are accepted and published as payload members', () => {
    const fixture = makeFixture();
    for (const name of INSTALL_PAYLOAD_COMPAT_MEMBERS) expect(readdirSync(join(fixture.staging, name))).toEqual([]);
    expect(promote(fixture).outcome).toBe('committed');
    for (const name of INSTALL_PAYLOAD_COMPAT_MEMBERS) expect(readdirSync(join(fixture.bin, name))).toEqual([]);
    assertGeneration(fixture.bin, '2.0.0');
  });

  test('genie-rs rides plugins/ at mode 0755 through promotion and convergence, with the 8 members unchanged', () => {
    // genie-v7-tasks T8: build-binary.sh stages plugins/genie-rs/bin/genie-rs at 0755 inside the
    // frozen `plugins` member; promotion and the <GENIE_HOME>/plugins convergence must keep the bit,
    // because that converged path is the one the TS front door resolves.
    const fixture = makeFixture();
    const staged = join(fixture.staging, 'plugins', 'genie-rs', 'bin', 'genie-rs');
    mkdirSync(join(fixture.staging, 'plugins', 'genie-rs', 'bin'), { recursive: true, mode: 0o755 });
    chmodSync(join(fixture.staging, 'plugins', 'genie-rs'), 0o755);
    chmodSync(join(fixture.staging, 'plugins', 'genie-rs', 'bin'), 0o755);
    writeFileSync(staged, '#!/bin/sh\necho genie-rs\n');
    chmodSync(staged, 0o755); // the create mode is umask-filtered; the test needs exactly 0755
    expect(readdirSync(fixture.staging).sort()).toEqual([...INSTALL_PAYLOAD_MEMBERS]);

    expect(promote(fixture).outcome).toBe('committed');

    const promoted = join(fixture.bin, 'plugins', 'genie-rs', 'bin', 'genie-rs');
    expect(lstatSync(promoted).isFile()).toBe(true);
    expect(lstatSync(promoted).mode & 0o777).toBe(0o755);
    expect(readFileSync(promoted, 'utf8')).toBe('#!/bin/sh\necho genie-rs\n');
    for (const name of INSTALL_PAYLOAD_MEMBERS) expect(existsSync(join(fixture.bin, name))).toBe(true);

    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source: join(fixture.bin, 'plugins'),
      destination: join(fixture.home, 'plugins'),
    });
    expect(outcome.status).toBe('refreshed');
    expect(lstatSync(join(fixture.home, 'plugins', 'genie-rs', 'bin', 'genie-rs')).mode & 0o777).toBe(0o755);
  });
});

describe('installer promotion transaction', () => {
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
    const prior = inspectPhysicalPath(join(fixture.bin, 'plugins'));

    expect(() => promote(fixture, { dependencies: interruption('capture-prior', 'plugins') })).toThrow(
      InstallPromotionInterruptedError,
    );
    expect(pendingRoots(fixture)).toHaveLength(1);
    expect(existsSync(join(fixture.bin, 'plugins'))).toBe(false);

    const reports = recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });
    expect(reports.map((report) => report.outcome)).toEqual(['rolledback']);
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(join(fixture.bin, 'plugins')), prior)).toBe(true);
    assertGeneration(fixture.staging, '2.0.0');
    expect(recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() })).toEqual([]);
  });

  test('recovers a crash after publishing an originally absent member back into staging', () => {
    const fixture = makeFixture(false);
    const incoming = inspectPhysicalPath(join(fixture.staging, 'plugins'));

    expect(() => promote(fixture, { dependencies: interruption('publish-incoming', 'plugins') })).toThrow(
      InstallPromotionInterruptedError,
    );
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(join(fixture.bin, 'plugins')), incoming)).toBe(true);

    const [report] = recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() });
    expect(report?.outcome).toBe('rolledback');
    expect(existsSync(join(fixture.bin, 'plugins'))).toBe(false);
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(join(fixture.staging, 'plugins')), incoming)).toBe(true);
  });

  test('a final-boundary foreign target is preserved and keeps the transaction pending', () => {
    const fixture = makeFixture(false);
    const foreign = join(fixture.bin, 'plugins');
    let injected = false;
    const deps = dependencies({
      beforeRename: (event) => {
        if (!injected && event.operation === 'publish-incoming' && event.member === 'plugins') {
          injected = true;
          writeFileSync(foreign, 'foreign target\n');
        }
      },
    });

    expect(() => promote(fixture, { dependencies: deps })).toThrow('rollback retained a transaction');
    expect(readFileSync(foreign, 'utf8')).toBe('foreign target\n');
    expect(lstatSync(join(fixture.staging, 'plugins')).isDirectory()).toBe(true);
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
    const incoming = inspectPhysicalPath(join(fixture.staging, 'plugins'));
    expect(() => promote(fixture, { dependencies: interruption('publish-incoming', 'plugins') })).toThrow(
      InstallPromotionInterruptedError,
    );
    mkdirSync(join(fixture.staging, 'plugins'), { mode: 0o755 });
    writeFileSync(join(fixture.staging, 'plugins', 'foreign.txt'), 'foreign\n', { mode: 0o644 });

    expect(() => recoverPendingInstallPromotions({ genieHome: fixture.home, dependencies: dependencies() })).toThrow(
      'could not be recovered safely',
    );
    expect(readFileSync(join(fixture.staging, 'plugins', 'foreign.txt'), 'utf8')).toBe('foreign\n');
    expect(physicalPathIdentitiesEqual(inspectPhysicalPath(join(fixture.bin, 'plugins')), incoming)).toBe(true);
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
    chmodSync(previous, 0o755); // the create mode is umask-filtered; the test needs exactly 0755

    const report = promote(fixture);

    expect(report.outcome).toBe('committed');
    expect(lstatSync(previous).mode & 0o777).toBe(0o755);
    expect(existsSync(report.priorBinaryPath as string)).toBe(true);
  });

  test('a nested symlink inserted after stable member inspection is identity-mismatched and never committed', () => {
    const fixture = makeFixture(false);
    const outside = join(fixture.root, 'outside-race');
    writeFileSync(outside, 'outside\n');
    let pluginsInspections = 0;
    const deps = dependencies({
      afterPayloadMemberInspected: (member) => {
        if (member === 'plugins' && ++pluginsInspections === 2) {
          symlinkSync(outside, join(fixture.staging, 'plugins', 'late-link'));
        }
      },
    });

    expect(() => promote(fixture, { dependencies: deps })).toThrow('rollback retained a transaction');
    expect(existsSync(join(fixture.bin, 'plugins'))).toBe(false);
    expect(lstatSync(join(fixture.staging, 'plugins', 'late-link')).isSymbolicLink()).toBe(true);
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
        if (!injected && event.operation === 'publish-incoming' && event.member === 'plugins') {
          injected = true;
          symlinkSync(outside, join(fixture.staging, 'plugins', 'late-link'));
        }
      },
    });

    expect(() => promote(fixture, { dependencies: deps })).toThrow('rollback retained a transaction');
    expect(existsSync(join(fixture.bin, 'plugins'))).toBe(false);
    expect(lstatSync(join(fixture.staging, 'plugins', 'late-link')).isSymbolicLink()).toBe(true);
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
    // `.agents` is the first published member, so exactly one receipt precedes the forged pair.
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

  test('admission normalizes a umask-restricted external binary mode before authenticating content', () => {
    // Regression: `tar -xzf` under umask 077 extracts `genie` as 0700. Admission
    // used to digest the external payload (mode 0700), copy it, then fchmod the
    // copy to 0755 — so the mode-bearing digests could never agree and every
    // update on such a host failed with "does not match the authenticated source".
    const root = makeRoot();
    const home = join(root, 'home');
    const external = join(root, 'external');
    mkdirSync(join(home, 'bin'), { recursive: true, mode: 0o700 });
    mkdirSync(external, { mode: 0o700 });
    writePayload(external, '2.0.0');
    chmodSync(join(external, 'genie'), 0o700);
    const guard = admitExternalInstallStaging({
      genieHome: home,
      externalStagingRoot: external,
      expectedVersion: '2.0.0',
      randomId: () => '99999999-9999-4999-8999-999999999999',
    });
    try {
      expect(Number(lstatSync(join(guard.stagingRoot, 'genie')).mode & 0o777)).toBe(0o755);
      expect(Number(lstatSync(join(external, 'genie')).mode & 0o777)).toBe(0o755);
      expect(() => verifyAdmittedInstallStagingPayload(guard)).not.toThrow();
    } finally {
      closeInstallStagingDirectory(guard);
    }
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

// Bun 1.4 caches process.cwd() lazily and does not see the libc fchdir that binds the payload copy to
// the held stage, so its cached cwd could stay inside the stage after the kernel cwd was restored
// (#3194). Each case runs admission in a FRESH child process: the runner's own cwd cache is never
// touched (no afterEach(process.chdir) papering over a leak), the child's cache starts empty, and
// the child never reads process.cwd() before admission. process.execPath keeps the child on the
// same Bun that runs this file, so the 1.3.x and 1.4.x legs each prove their own runtime.
const ADMISSION_CHILD = `
const { admitExternalInstallStaging, closeInstallStagingDirectory, removeInstallStagingDirectory } = await import(process.env.INSTALL_PROMOTION_MODULE);
import { fstatSync, lstatSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const [mode, home, external, randomId, extra1, extra2] = process.argv.slice(2);
const stage = join(home, 'bin', '.install-staging-' + randomId);
const identity = (s) => s.dev + ':' + s.ino;
const cwdNow = () => { try { return process.cwd(); } catch (error) { return 'THROW:' + error.code; } };
const options = { genieHome: home, externalStagingRoot: external, expectedVersion: '2.0.0', randomId: () => randomId, verifyVersion: () => true };
const out = { mode };
if (mode === 'cwd-renamed') renameSync(extra1, extra2);
if (mode === 'cwd-deleted') rmSync(extra1, { recursive: true });
if (mode === 'swap') {
  options.afterPayloadMemberCopied = (member) => {
    if (member !== 'VERSION') return;
    out.inWindowCwd = cwdNow();
    renameSync(stage, extra1);
    symlinkSync(extra2, stage);
  };
  try { admitExternalInstallStaging(options); out.admitted = true; } catch (error) { out.error = error.name + ': ' + error.message; }
  out.cwd = cwdNow();
  console.log(JSON.stringify(out));
  process.exit(0);
}
const guard = admitExternalInstallStaging(options);
out.cwd = cwdNow();
out.dotIdentity = identity(statSync('.', { bigint: true }));
if (mode === 'landing') {
  out.stageBinding = identity(fstatSync(guard.directoryFd, { bigint: true })) === identity(lstatSync(guard.stagingRoot, { bigint: true }));
  out.stageMembers = readdirSync(guard.stagingRoot).sort();
  writeFileSync(join(process.cwd(), 'caller-sentinel'), 'caller\\n');
  out.stageMembersAfterCallerWrite = readdirSync(guard.stagingRoot).sort();
}
if (mode === 'spawn') {
  closeInstallStagingDirectory(guard);
  rmSync(stage, { recursive: true });
  const child = spawnSync(process.execPath, ['--version'], { cwd: process.cwd(), encoding: 'utf8' });
  out.spawn = child.error ? String(child.error) : child.status;
} else {
  removeInstallStagingDirectory(guard);
  closeInstallStagingDirectory(guard);
}
console.log(JSON.stringify(out));
`;

interface AdmissionChildFixture {
  root: string;
  home: string;
  external: string;
  cwd: string;
  child: string;
}

function admissionChildFixture(): AdmissionChildFixture {
  const root = realpathSync(makeRoot());
  const home = join(root, 'home');
  const external = join(root, 'external');
  const cwd = join(root, 'caller-cwd');
  mkdirSync(join(home, 'bin'), { recursive: true, mode: 0o700 });
  mkdirSync(external, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  writePayload(external, '2.0.0');
  const child = join(root, 'admission-child.mjs');
  writeFileSync(child, ADMISSION_CHILD);
  return { root, home, external, cwd, child };
}

function runAdmissionChild(
  fixture: AdmissionChildFixture,
  mode: string,
  randomId: string,
  extra: string[] = [],
): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [fixture.child, mode, fixture.home, fixture.external, randomId, ...extra],
    {
      cwd: fixture.cwd,
      encoding: 'utf8',
      env: { ...process.env, INSTALL_PROMOTION_MODULE: join(import.meta.dir, 'install-promotion.ts') },
    },
  );
  if (result.status !== 0) throw new Error(`admission child failed (${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
}

describe('admission leaves the runtime cwd where the caller had it (Bun 1.3 and 1.4)', () => {
  test('(a) process.cwd() after admission is the caller cwd, read first in a fresh process', () => {
    const fixture = admissionChildFixture();
    const out = runAdmissionChild(fixture, 'cwd', 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1');
    expect(out.cwd).toBe(fixture.cwd);
  });

  test('(b) members land under the held stage and a process.cwd()-derived write lands in the caller cwd', () => {
    const fixture = admissionChildFixture();
    const out = runAdmissionChild(fixture, 'landing', 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2');
    const members = [...INSTALL_PAYLOAD_MEMBERS].sort();
    expect(out.stageBinding).toBe(true);
    expect(out.stageMembers).toEqual(members);
    expect(out.stageMembersAfterCallerWrite).toEqual(members);
    expect(readdirSync(fixture.cwd)).toEqual(['caller-sentinel']);
  });

  test('(c) a stage swapped mid-copy for a symlink never receives a write; later members follow the held fd', () => {
    const fixture = admissionChildFixture();
    const randomId = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
    const quarantined = join(fixture.home, 'bin', '.quarantined-held-stage');
    const victim = join(fixture.root, 'victim');
    mkdirSync(victim, { mode: 0o700 });
    writeFileSync(join(victim, 'sentinel'), 'safe\n');
    const out = runAdmissionChild(fixture, 'swap', randomId, [quarantined, victim]);
    expect(out.admitted).toBeUndefined();
    expect(String(out.error)).toStartWith('InstallPromotionError: ');
    expect(readdirSync(victim)).toEqual(['sentinel']);
    expect(readFileSync(join(victim, 'sentinel'), 'utf8')).toBe('safe\n');
    expect(readdirSync(quarantined).sort()).toEqual([...INSTALL_PAYLOAD_MEMBERS].sort());
    expect(readFileSync(join(quarantined, 'plugins', 'generation.txt'), 'utf8')).toBe('2.0.0:plugins\n');
    expect(readdirSync(fixture.cwd)).toEqual([]);
    expect(out.cwd).toBe(fixture.cwd);
  });

  test('(d) admission run from a renamed caller cwd succeeds and stays in that directory', () => {
    const fixture = admissionChildFixture();
    const renamed = join(fixture.root, 'caller-cwd-renamed');
    const out = runAdmissionChild(fixture, 'cwd-renamed', 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4', [
      fixture.cwd,
      renamed,
    ]);
    // Bun 1.3.11 keeps reporting the path it last saw; either name is the caller's directory, never the stage.
    expect([fixture.cwd, renamed]).toContain(String(out.cwd));
    expect(out.dotIdentity).toBe(`${lstatSync(renamed).dev}:${lstatSync(renamed).ino}`);
  });

  test('(d) admission run from a deleted caller cwd succeeds without re-resolving a path', () => {
    const fixture = admissionChildFixture();
    const before = lstatSync(fixture.cwd);
    const out = runAdmissionChild(fixture, 'cwd-deleted', 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5', [fixture.cwd]);
    // The kernel cwd, proven by the descriptor, is the authority. process.cwd() is not asserted: a
    // directory with no name left cannot be re-entered, so Bun 1.4 keeps whatever its view last held
    // (1.3.11 keeps the deleted path). This guards against a path-based restore that would throw.
    expect(out.dotIdentity).toBe(`${before.dev}:${before.ino}`);
  });

  test('(e) a spawn using process.cwd() after the stage is removed succeeds', () => {
    const fixture = admissionChildFixture();
    const out = runAdmissionChild(fixture, 'spawn', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5');
    expect(out.spawn).toBe(0);
    expect(out.cwd).toBe(fixture.cwd);
  });
});
