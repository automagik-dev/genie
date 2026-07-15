import { execFileSync } from 'node:child_process';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LIFECYCLE_LEASE_OWNER_ENV,
  LIFECYCLE_LEASE_PATH_ENV,
  type LifecycleLease,
  acquireLifecycleLease,
  lifecycleLockPath,
} from '../lib/agent-sync.js';
import {
  type CanonicalInstallLinkGuard,
  preflightCanonicalInstallLink,
  prepareCanonicalInstallLink,
  verifyCanonicalInstallLink,
} from '../lib/install-link.js';
import {
  type InstallPromotionDependencies,
  type InstallStagingDirectoryGuard,
  admitExternalInstallStaging,
  closeInstallStagingDirectory,
  installPromotionCapability,
  promoteStagedInstall,
  recoverPendingInstallPromotions,
  removeInstallStagingDirectory,
  verifyAdmittedInstallStagingPayload,
  verifyInstallStagingDirectory,
} from '../lib/install-promotion.js';
import {
  type PhysicalPathIdentity,
  inspectPhysicalPath,
  physicalPathIdentitiesEqual,
  renamePathNoClobber,
} from '../lib/install-transaction.js';
import { VERSION } from '../lib/version.js';

const VERSION_PATTERN = /(?:^|[^0-9A-Za-z.+-])v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)(?:[^0-9A-Za-z.+-]|$)/;

export interface InstallPromoteCommandOptions {
  stagingRoot?: string;
  expectedVersion?: string;
  selfTest?: boolean;
}

interface BorrowedLeaseGuard {
  path: string;
  owner: string;
  identity: PhysicalPathIdentity;
  release: () => void;
}

export interface InstallPromoteCommandDependencies {
  acquireLease?: (genieHome: string) => LifecycleLease | { skipped: string };
  runtimeExecutable?: string;
  runtimeVersion?: string;
  userHome?: string;
  promotion?: InstallPromotionDependencies;
  emit?: (line: string) => void;
}

export class InstallPromoteCommandError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstallPromoteCommandError';
  }
}

function versionToken(value: string): string | null {
  return value.match(VERSION_PATTERN)?.[1] ?? null;
}

function exactLeaseBytes(path: string): { bytes: string; stat: ReturnType<typeof fstatSync> } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 4096) {
      throw new InstallPromoteCommandError('borrowed lifecycle lease is not a bounded physical file');
    }
    const bytes = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    const atPath = lstatSync(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== atPath.dev ||
      after.ino !== atPath.ino ||
      after.mode !== atPath.mode ||
      after.size !== atPath.size ||
      after.mtimeMs !== atPath.mtimeMs
    ) {
      throw new InstallPromoteCommandError('borrowed lifecycle lease changed while it was read');
    }
    return { bytes, stat: after };
  } finally {
    closeSync(fd);
  }
}

function assertBorrowedLeaseUnchanged(guard: BorrowedLeaseGuard): void {
  const actual = inspectPhysicalPath(guard.path);
  if (!physicalPathIdentitiesEqual(actual, guard.identity)) {
    throw new InstallPromoteCommandError('borrowed lifecycle lease physical identity changed');
  }
  const { bytes, stat } = exactLeaseBytes(guard.path);
  if (bytes !== `${guard.owner}\n`) throw new InstallPromoteCommandError('borrowed lifecycle lease owner changed');
  if (stat.nlink !== 2) throw new InstallPromoteCommandError('borrowed lifecycle lease lost its shell owner link');
  if (process.getuid !== undefined && stat.uid !== process.getuid()) {
    throw new InstallPromoteCommandError('borrowed lifecycle lease is owned by a different user');
  }
}

/** Require the exact shell-owned hard-link lease; this command never acquires an independent production lease. */
export function acquireExactBorrowedInstallLease(
  genieHome: string,
  acquireLease: NonNullable<InstallPromoteCommandDependencies['acquireLease']> = acquireLifecycleLease,
): BorrowedLeaseGuard {
  const expectedPath = lifecycleLockPath(genieHome);
  const path = process.env[LIFECYCLE_LEASE_PATH_ENV];
  const owner = process.env[LIFECYCLE_LEASE_OWNER_ENV];
  if (
    path !== expectedPath ||
    owner === undefined ||
    owner.length === 0 ||
    owner.includes('\n') ||
    owner.includes('\r')
  ) {
    throw new InstallPromoteCommandError('installer promotion requires the exact borrowed shell lifecycle lease');
  }
  const initial = inspectPhysicalPath(path);
  if (initial === null || initial.kind !== 'file') {
    throw new InstallPromoteCommandError('borrowed lifecycle lease is not a physical regular file');
  }
  const provisional: BorrowedLeaseGuard = { path, owner, identity: initial, release: () => undefined };
  assertBorrowedLeaseUnchanged(provisional);
  const lease = acquireLease(genieHome);
  if ('skipped' in lease || lease.path !== path) {
    throw new InstallPromoteCommandError(
      `borrowed lifecycle lease was rejected: ${'skipped' in lease ? lease.skipped : 'path mismatch'}`,
    );
  }
  const guard = { ...provisional, release: lease.release };
  assertBorrowedLeaseUnchanged(guard);
  return guard;
}

function assertRunningVerifiedStage(stagingBinary: string, runtimeExecutable: string): PhysicalPathIdentity {
  const staged = inspectPhysicalPath(stagingBinary);
  const running = inspectPhysicalPath(runtimeExecutable);
  if (staged === null || staged.kind !== 'file' || !physicalPathIdentitiesEqual(staged, running)) {
    throw new InstallPromoteCommandError('installer mutation authority is not the exact verified staged executable');
  }
  return staged;
}

function verifyExecutableVersion(binaryPath: string, expectedVersion: string): boolean {
  try {
    const output = execFileSync(binaryPath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return versionToken(output) === expectedVersion;
  } catch {
    return false;
  }
}

function runNativeSelfTest(emit: (line: string) => void): void {
  const capability = installPromotionCapability();
  if (!capability.available)
    throw new InstallPromoteCommandError('native installer transaction capability is unavailable');
  const root = mkdtempSync(join(tmpdir(), 'genie-install-self-test-'));
  try {
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'self-test');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new InstallPromoteCommandError('self-test source disappeared');
    const result = renamePathNoClobber(source, target, expected);
    if (!result.durable || !result.parentPathsStable || result.sourcePathOccupied) {
      throw new InstallPromoteCommandError('native installer transaction self-test was not durable and exact');
    }
    writeFileSync(source, 'foreign');
    let collisionRefused = false;
    try {
      renamePathNoClobber(source, target, inspectPhysicalPath(source) as PhysicalPathIdentity);
    } catch {
      collisionRefused = true;
    }
    if (
      !collisionRefused ||
      readFileSync(source, 'utf8') !== 'foreign' ||
      readFileSync(target, 'utf8') !== 'self-test'
    ) {
      throw new InstallPromoteCommandError('native installer transaction self-test did not preserve a collision');
    }
    emit(JSON.stringify({ schemaVersion: 1, ok: true, platform: capability.platform }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Hidden entrypoint used only by the verified release binary invoked from install.sh. */
export function installPromoteCommand(
  options: InstallPromoteCommandOptions,
  dependencies: InstallPromoteCommandDependencies = {},
): void {
  const emit = dependencies.emit ?? console.log;
  if (options.selfTest) {
    runNativeSelfTest(emit);
    return;
  }
  if (options.stagingRoot === undefined || options.expectedVersion === undefined) {
    throw new InstallPromoteCommandError('promotion requires --staging-root and --expected-version');
  }
  const expectedVersion = versionToken(options.expectedVersion);
  const runtimeVersion = versionToken(dependencies.runtimeVersion ?? VERSION);
  if (expectedVersion === null || runtimeVersion !== expectedVersion) {
    throw new InstallPromoteCommandError('running staged promoter version does not match the requested release');
  }
  const genieHome = resolve(process.env.GENIE_HOME || join(dependencies.userHome ?? homedir(), '.genie'));
  const stagingRoot = resolve(options.stagingRoot);
  const runtimeExecutable = resolve(dependencies.runtimeExecutable ?? process.execPath);
  const stagingBinary = join(stagingRoot, 'genie');
  const stagedIdentity = assertRunningVerifiedStage(stagingBinary, runtimeExecutable);
  const lease = acquireExactBorrowedInstallLease(genieHome, dependencies.acquireLease);
  let linkGuard: CanonicalInstallLinkGuard | null = null;
  let admitted: InstallStagingDirectoryGuard | null = null;
  let promotionComplete = false;
  const assertAuthority = (): void => {
    assertBorrowedLeaseUnchanged(lease);
    if (linkGuard !== null) verifyCanonicalInstallLink(linkGuard);
    if (admitted !== null) verifyInstallStagingDirectory(admitted);
  };
  const promotionDependencies: InstallPromotionDependencies = {
    ...(dependencies.promotion ?? {}),
    beforeRename: (event) => {
      dependencies.promotion?.beforeRename?.(event);
      assertAuthority();
    },
  };
  try {
    recoverPendingInstallPromotions({ genieHome, dependencies: promotionDependencies });
    assertAuthority();
    const userHome = resolve(dependencies.userHome ?? homedir());
    const linkPath = join(userHome, '.local', 'bin', 'genie');
    const targetPath = join(genieHome, 'bin', 'genie');
    linkGuard = preflightCanonicalInstallLink({
      trustedHome: userHome,
      linkPath,
      targetPath,
    });
    assertAuthority();
    admitted = admitExternalInstallStaging({
      genieHome,
      externalStagingRoot: stagingRoot,
      expectedVersion,
      randomId: promotionDependencies.randomId,
      dependencies: promotionDependencies,
      verifyVersion: ({ binaryPath }) => {
        assertAuthority();
        if (
          binaryPath === stagingBinary &&
          !physicalPathIdentitiesEqual(inspectPhysicalPath(binaryPath), stagedIdentity)
        ) {
          return false;
        }
        return verifyExecutableVersion(binaryPath, expectedVersion);
      },
    });
    assertAuthority();
    verifyAdmittedInstallStagingPayload(admitted);
    const report = promoteStagedInstall({
      genieHome,
      stagingRoot: admitted.stagingRoot,
      expectedVersion,
      dependencies: promotionDependencies,
      verifyVersion: ({ binaryPath, phase }) => {
        assertAuthority();
        if (phase === 'staged' && admitted !== null) verifyAdmittedInstallStagingPayload(admitted);
        return verifyExecutableVersion(binaryPath, expectedVersion);
      },
    });
    promotionComplete = true;
    assertAuthority();
    linkGuard = prepareCanonicalInstallLink({
      trustedHome: userHome,
      linkPath,
      targetPath,
      nativeRename: {
        ...(promotionDependencies.nativeRename ?? {}),
        beforeInvoke: assertAuthority,
      },
    });
    assertAuthority();
    emit(JSON.stringify({ ...report, canonicalLink: linkGuard.linkPath }));
  } finally {
    try {
      if (admitted !== null) {
        try {
          if (promotionComplete) removeInstallStagingDirectory(admitted);
        } finally {
          closeInstallStagingDirectory(admitted);
        }
      }
    } finally {
      lease.release();
    }
  }
}
