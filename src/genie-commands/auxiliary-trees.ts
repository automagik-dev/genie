import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export type AuxiliaryTreeStage =
  | 'inspect'
  | 'remove-identical-source'
  | 'copy-fresh'
  | 'verify-copy'
  | 'park-live'
  | 'promote-fresh'
  | 'restore-live'
  | 'remove-source'
  | 'remove-previous';

export type AuxiliaryTreeOutcome =
  | {
      label: string;
      status: 'skipped';
      source: string;
      destination: string;
    }
  | {
      label: string;
      status: 'unchanged' | 'refreshed';
      source: string;
      destination: string;
      digest: string;
      warnings: string[];
      previousArtifact?: string;
    }
  | {
      label: string;
      status: 'failed';
      source: string;
      destination: string;
      stage: AuxiliaryTreeStage;
      error: string;
      /** Present only when its digest was verified against the desired payload. */
      freshArtifact?: string;
      freshArtifactDigest?: string;
      previousArtifact?: string;
      rollbackError?: string;
    };

export interface AuxiliaryTreeOperations {
  exists(path: string): boolean;
  digest(path: string, excludedEntryNames: ReadonlySet<string>): string;
  copyTree(source: string, destination: string, excludedEntryNames: ReadonlySet<string>): void;
  rename(source: string, destination: string): void;
  remove(path: string): void;
}

export interface ConvergeAuxiliaryTreeOptions {
  label: string;
  source: string;
  destination: string;
  /** Install removes its persistent bin/ extraction after convergence. */
  removeSourceOnSuccess?: boolean;
  /** Framework cache markers are intentionally never promoted from payloads. */
  excludedEntryNames?: ReadonlySet<string>;
  /** Deterministic seam for failure-path tests; production ids are collision-resistant. */
  transactionId?: string;
  operations?: Partial<AuxiliaryTreeOperations>;
}

let transactionSequence = 0;

const DEFAULT_OPERATIONS: AuxiliaryTreeOperations = {
  exists: pathExists,
  digest: fingerprintAuxiliaryTree,
  copyTree,
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

const NO_EXCLUSIONS = new Set<string>();

/**
 * Converge one verified payload tree without ever renaming across filesystems.
 * The fresh tree is copied to a unique sibling of the live destination, then
 * promoted with same-filesystem renames. Until promotion succeeds, the source
 * remains a complete recovery artifact. A failed promotion restores the prior
 * live tree and retains both fresh and previous artifacts for a retry.
 */
export function convergeAuxiliaryTree(options: ConvergeAuxiliaryTreeOptions): AuxiliaryTreeOutcome {
  const ops: AuxiliaryTreeOperations = { ...DEFAULT_OPERATIONS, ...options.operations };
  const excluded = options.excludedEntryNames ?? new Set<string>();
  const transactionId = resolveTransactionId(options.transactionId);
  const context: AuxiliaryTreeTransaction = {
    options,
    ops,
    excluded,
    staging: `${options.destination}.new-${transactionId}`,
    previous: `${options.destination}.old-${transactionId}`,
  };
  const inspection = inspectTree(context);
  if ('outcome' in inspection) return inspection.outcome;
  const stageFailure = stageFreshTree(context, inspection.digest);
  if (stageFailure) return stageFailure;
  const promotion = promoteFreshTree(context, inspection.digest);
  if ('failure' in promotion) return promotion.failure;
  return finishPromotedTree(context, inspection.digest, promotion.hadLive);
}

interface AuxiliaryTreeTransaction {
  options: ConvergeAuxiliaryTreeOptions;
  ops: AuxiliaryTreeOperations;
  excluded: ReadonlySet<string>;
  staging: string;
  previous: string;
}

function resolveTransactionId(explicit: string | undefined): string {
  if (explicit) return explicit;
  transactionSequence += 1;
  return `${process.pid}-${Date.now()}-${transactionSequence.toString(36)}`;
}

function inspectTree(context: AuxiliaryTreeTransaction): { digest: string } | { outcome: AuxiliaryTreeOutcome } {
  const { options, ops, excluded } = context;
  if (!ops.exists(options.source)) {
    return {
      outcome: {
        label: options.label,
        status: 'skipped',
        source: options.source,
        destination: options.destination,
      },
    };
  }
  let digest: string;
  try {
    digest = ops.digest(options.source, excluded);
    // Exclusions describe what must be removed from the desired payload, not
    // what may remain live. Digest the destination exactly so root or nested
    // framework markers force a transactional refresh.
    if (!ops.exists(options.destination) || ops.digest(options.destination, NO_EXCLUSIONS) !== digest) {
      return { digest };
    }
  } catch (error) {
    return { outcome: failure(options, 'inspect', error) };
  }
  try {
    if (options.removeSourceOnSuccess) ops.remove(options.source);
  } catch (error) {
    return {
      outcome: failure(
        options,
        'remove-identical-source',
        error,
        verifiedArtifact(ops, options.source, digest, excluded),
      ),
    };
  }
  return {
    outcome: {
      label: options.label,
      status: 'unchanged',
      source: options.source,
      destination: options.destination,
      digest,
      warnings: [],
    },
  };
}

function stageFreshTree(context: AuxiliaryTreeTransaction, sourceDigest: string): AuxiliaryTreeOutcome | null {
  const { options, ops, excluded, staging } = context;
  try {
    mkdirSync(dirname(options.destination), { recursive: true });
    ops.copyTree(options.source, staging, excluded);
  } catch (error) {
    return failure(options, 'copy-fresh', error, verifiedArtifact(ops, options.source, sourceDigest, excluded));
  }
  try {
    const stagedDigest = ops.digest(staging, NO_EXCLUSIONS);
    if (stagedDigest !== sourceDigest) {
      throw new Error(`staged digest ${stagedDigest} did not match source digest ${sourceDigest}`);
    }
    return null;
  } catch (error) {
    return failure(options, 'verify-copy', error, verifiedArtifact(ops, options.source, sourceDigest, excluded));
  }
}

function promoteFreshTree(
  context: AuxiliaryTreeTransaction,
  sourceDigest: string,
): { hadLive: boolean } | { failure: AuxiliaryTreeOutcome } {
  const { options, ops, excluded, staging, previous } = context;
  const hadLive = ops.exists(options.destination);
  if (hadLive) {
    try {
      ops.rename(options.destination, previous);
    } catch (error) {
      return {
        failure: failure(options, 'park-live', error, verifiedArtifact(ops, staging, sourceDigest, NO_EXCLUSIONS)),
      };
    }
  }
  try {
    ops.rename(staging, options.destination);
    return { hadLive };
  } catch (error) {
    const restored = hadLive ? restorePreviousTree(ops, previous, options.destination) : {};
    const verifiedFresh =
      verifiedArtifact(ops, staging, sourceDigest, NO_EXCLUSIONS) ??
      verifiedArtifact(ops, options.source, sourceDigest, excluded);
    return {
      failure: failure(options, 'promote-fresh', error, verifiedFresh, {
        previousArtifact: hadLive && ops.exists(previous) ? previous : undefined,
        rollbackError: restored.error,
      }),
    };
  }
}

function finishPromotedTree(
  context: AuxiliaryTreeTransaction,
  sourceDigest: string,
  hadLive: boolean,
): AuxiliaryTreeOutcome {
  const { options, ops, previous } = context;
  if (options.removeSourceOnSuccess) {
    try {
      ops.remove(options.source);
    } catch (error) {
      const verifiedFresh =
        verifiedArtifact(ops, options.source, sourceDigest, context.excluded) ??
        verifiedArtifact(ops, options.destination, sourceDigest, NO_EXCLUSIONS);
      return failure(options, 'remove-source', error, verifiedFresh, {
        previousArtifact: hadLive && ops.exists(previous) ? previous : undefined,
      });
    }
  }
  const warnings: string[] = [];
  let previousArtifact: string | undefined;
  if (hadLive && ops.exists(previous)) {
    try {
      ops.remove(previous);
    } catch (error) {
      previousArtifact = previous;
      warnings.push(`could not remove previous tree ${previous}: ${errorMessage(error)}`);
    }
  }
  return {
    label: options.label,
    status: 'refreshed',
    source: options.source,
    destination: options.destination,
    digest: sourceDigest,
    warnings,
    previousArtifact,
  };
}

function restorePreviousTree(ops: AuxiliaryTreeOperations, previous: string, destination: string): { error?: string } {
  if (!ops.exists(previous)) return { error: `previous tree missing at ${previous}` };
  try {
    ops.rename(previous, destination);
    return {};
  } catch (renameError) {
    try {
      if (ops.exists(destination)) {
        throw new Error(`rollback destination is occupied at ${destination}`);
      }
      // A rename seam or unexpected filesystem boundary must not strand the
      // prior tree. Copying keeps the parked artifact as an extra recovery path.
      ops.copyTree(previous, destination, NO_EXCLUSIONS);
      if (ops.digest(previous, NO_EXCLUSIONS) !== ops.digest(destination, NO_EXCLUSIONS)) {
        throw new Error('copied rollback tree failed digest verification');
      }
      return {};
    } catch (copyError) {
      return {
        error: `rename rollback failed (${errorMessage(renameError)}); copy rollback failed (${errorMessage(copyError)})`,
      };
    }
  }
}

function failure(
  options: ConvergeAuxiliaryTreeOptions,
  stage: AuxiliaryTreeStage,
  error: unknown,
  freshArtifact?: { path: string; digest: string },
  recovery: { previousArtifact?: string; rollbackError?: string } = {},
): AuxiliaryTreeOutcome {
  return {
    label: options.label,
    status: 'failed',
    source: options.source,
    destination: options.destination,
    stage,
    error: errorMessage(error),
    freshArtifact: freshArtifact?.path,
    freshArtifactDigest: freshArtifact?.digest,
    ...recovery,
  };
}

function verifiedArtifact(
  ops: AuxiliaryTreeOperations,
  path: string,
  expectedDigest: string,
  excluded: ReadonlySet<string>,
): { path: string; digest: string } | undefined {
  try {
    return ops.exists(path) && ops.digest(path, excluded) === expectedDigest
      ? { path, digest: expectedDigest }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Physical fingerprint shared by auxiliary convergence and the durable update
 * journal. Symlinks and unsupported entries are rejected; executable identity
 * participates alongside relative paths and file bytes.
 */
export function fingerprintAuxiliaryTree(
  root: string,
  excludedEntryNames: ReadonlySet<string> = NO_EXCLUSIONS,
): string {
  const entries: Array<{ path: string; kind: 'directory' | 'file'; executable: boolean; digest?: string }> = [];
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`managed auxiliary tree must be a physical directory: ${root}`);
  }
  collectTreeEntries(root, root, excludedEntryNames, entries);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(entry.kind);
    digest.update('\0');
    digest.update(entry.path);
    digest.update('\0');
    digest.update(entry.executable ? 'x' : '-');
    digest.update('\0');
    if (entry.digest) digest.update(entry.digest);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function collectTreeEntries(
  root: string,
  current: string,
  excludedEntryNames: ReadonlySet<string>,
  entries: Array<{ path: string; kind: 'directory' | 'file'; executable: boolean; digest?: string }>,
): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (excludedEntryNames.has(entry.name)) continue;
    const absolute = join(current, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`managed auxiliary tree contains a symlink: ${absolute}`);
    const path = relative(root, absolute);
    if (stat.isDirectory()) {
      entries.push({ path, kind: 'directory', executable: (stat.mode & 0o111) !== 0 });
      collectTreeEntries(root, absolute, excludedEntryNames, entries);
    } else if (stat.isFile()) {
      entries.push({
        path,
        kind: 'file',
        executable: (stat.mode & 0o111) !== 0,
        digest: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      });
    } else {
      throw new Error(`managed auxiliary tree contains an unsupported entry: ${absolute}`);
    }
  }
}

function copyTree(source: string, destination: string, excludedEntryNames: ReadonlySet<string>): void {
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`managed auxiliary tree must be a physical directory: ${source}`);
  }
  mkdirSync(destination, { recursive: true, mode: sourceStat.mode & 0o777 });
  chmodSync(destination, sourceStat.mode & 0o777);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (excludedEntryNames.has(entry.name)) continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new Error(`managed auxiliary tree contains a symlink: ${sourcePath}`);
    if (stat.isDirectory()) copyTree(sourcePath, destinationPath, excludedEntryNames);
    else if (stat.isFile()) {
      copyFileSync(sourcePath, destinationPath);
      chmodSync(destinationPath, stat.mode & 0o777);
    } else {
      throw new Error(`managed auxiliary tree contains an unsupported entry: ${sourcePath}`);
    }
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
