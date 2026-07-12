'use strict';

/**
 * council-stamp: stamp the /council workflow template into ~/.claude/workflows.
 *
 * Plugins cannot ship Claude Code workflows directly, so the template lives in
 * the plugin (plugins/genie/workflows/council.js) with a `__GENIE_LENS_ROOT__`
 * placeholder. Explicit install/setup/update convergence may stamp it into
 * ~/.claude/workflows/council.js; lifecycle hooks never call this mutator.
 *
 * Pure and dependency-injectable: all paths are arguments, so the unit test can
 * drive it entirely inside a tmpdir. CommonJS (.cjs) so it is requireable from
 * explicit integration convergence code and from bun:test.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const PLACEHOLDER = '__GENIE_LENS_ROOT__';
const TARGET_NAME = 'council.js';
const WORKFLOW_MANIFEST_NAME = `${TARGET_NAME}.genie-sync.json`;
const MANAGED_BY = 'genie-agent-sync';
const WORKFLOW_FILE_MODE = 0o644;
const PHYSICAL_FILE_IDENTITY_VERSION = 2;
const TRANSACTION_PREFIX = '.council.genie-txn-';
const TRANSACTION_STAGING_PREFIX = '.council.genie-txn-staging-';
const TRANSACTION_CONFLICT_PREFIX = '.council.genie-conflict-';

/** @param {string} filePath @returns {import('node:fs').Stats|null} */
function lstatSafe(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return null;
  }
}

/** @typedef {{kind:'absent'}|{kind:'regular',mode:number,digest:string}|{kind:'directory',mode:number}|{kind:'symlink',mode:number,target:string}|{kind:'other',mode:number,entry:string}|{kind:'unreadable',code:string}} PhysicalFileIdentity */

/** @typedef {{managedBy:string,version:string|null,digest:string,syncedAt:string,identityVersion?:number,targetMode?:number}} WorkflowOwnershipManifest */
/** @typedef {{status:'missing'}|{status:'corrupt'}|{status:'valid',manifest:WorkflowOwnershipManifest,fileDigest:string}} WorkflowManifestReadResult */

/** @param {unknown} error @returns {string} */
function errorCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
}

/** @param {import('node:fs').Stats} stat @returns {string} */
function physicalEntryKind(stat) {
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  return 'other';
}

/** @param {string} filePath @returns {PhysicalFileIdentity} */
function physicalFileIdentity(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', code };
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    try {
      return { kind: 'symlink', mode, target: fs.readlinkSync(filePath) };
    } catch (error) {
      return { kind: 'unreadable', code: errorCode(error) };
    }
  }
  if (stat.isDirectory()) return { kind: 'directory', mode };
  if (!stat.isFile()) return { kind: 'other', mode, entry: physicalEntryKind(stat) };
  try {
    return {
      kind: 'regular',
      mode,
      digest: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    };
  } catch (error) {
    const code = errorCode(error);
    return { kind: 'unreadable', code };
  }
}

/** @param {PhysicalFileIdentity} left @param {PhysicalFileIdentity} right @returns {boolean} */
function physicalIdentityEquals(left, right) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'regular') {
    return right.kind === 'regular' && left.mode === right.mode && left.digest === right.digest;
  }
  if (left.kind === 'directory') return right.kind === 'directory' && left.mode === right.mode;
  if (left.kind === 'symlink') {
    return right.kind === 'symlink' && left.mode === right.mode && left.target === right.target;
  }
  if (left.kind === 'other') {
    return right.kind === 'other' && left.mode === right.mode && left.entry === right.entry;
  }
  if (left.kind === 'unreadable') return right.kind === 'unreadable' && left.code === right.code;
  return left.kind === 'absent';
}

/** @param {string|null} digest @param {number|null} mode @returns {PhysicalFileIdentity} */
function expectedPhysicalFile(digest, mode) {
  return digest === null || mode === null ? { kind: 'absent' } : { kind: 'regular', mode, digest };
}

class NoClobberPublishError extends Error {}

/**
 * Publish a regular file only when the destination is absent. The disposable
 * hard-link candidate can be changed through the live name without mutating
 * the original staged evidence retained in the transaction.
 * @param {string} stagedPath
 * @param {string} targetPath
 */
function publishRegularFileNoClobber(stagedPath, targetPath) {
  const stat = fs.lstatSync(stagedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`publish source is not a physical regular file: ${stagedPath}`);
  }
  const candidate = `${stagedPath}.publish-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.copyFileSync(stagedPath, candidate, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(candidate, stat.mode & 0o7777);
  try {
    fs.linkSync(candidate, targetPath);
  } catch (error) {
    throw new NoClobberPublishError(
      `exclusive publish failed (${errorCode(error)}); target was preserved: ${targetPath}`,
    );
  } finally {
    fs.rmSync(candidate, { force: true });
  }
}

/** @param {string} manifestPath @returns {WorkflowManifestReadResult} */
function readWorkflowManifest(manifestPath) {
  const stat = lstatSafe(manifestPath);
  if (stat === null) return { status: 'missing' };
  if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'corrupt' };
  try {
    const content = fs.readFileSync(manifestPath);
    const parsed = JSON.parse(content.toString('utf8'));
    if (
      parsed.managedBy !== MANAGED_BY ||
      typeof parsed.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.digest) ||
      (parsed.version !== null && parsed.version !== undefined && typeof parsed.version !== 'string') ||
      typeof parsed.syncedAt !== 'string' ||
      (parsed.identityVersion !== undefined && parsed.identityVersion !== PHYSICAL_FILE_IDENTITY_VERSION) ||
      (parsed.identityVersion === PHYSICAL_FILE_IDENTITY_VERSION && !isPhysicalMode(parsed.targetMode))
    ) {
      return { status: 'corrupt' };
    }
    return {
      status: 'valid',
      manifest: {
        managedBy: MANAGED_BY,
        version: parsed.version ?? null,
        digest: parsed.digest,
        syncedAt: parsed.syncedAt,
        ...(parsed.identityVersion === PHYSICAL_FILE_IDENTITY_VERSION
          ? { identityVersion: PHYSICAL_FILE_IDENTITY_VERSION, targetMode: parsed.targetMode }
          : {}),
      },
      fileDigest: crypto.createHash('sha256').update(content).digest('hex'),
    };
  } catch {
    return { status: 'corrupt' };
  }
}

/** Classify council.js using only its sidecar ownership grant and recorded digest. */
/** @param {string} targetDir */
function inspectManagedWorkflow(targetDir) {
  const targetPath = path.join(targetDir, TARGET_NAME);
  const manifestPath = path.join(targetDir, WORKFLOW_MANIFEST_NAME);
  const ownership = readWorkflowManifest(manifestPath);
  if (ownership.status === 'missing') return { targetPath, manifestPath, state: 'unmanaged' };
  if (ownership.status === 'corrupt') return { targetPath, manifestPath, state: 'corrupt-metadata' };
  const manifest = ownership.manifest;
  const targetIdentity = physicalFileIdentity(targetPath);
  const manifestIdentity = physicalFileIdentity(manifestPath);
  const expectedTargetMode =
    manifest.identityVersion === PHYSICAL_FILE_IDENTITY_VERSION && isPhysicalMode(manifest.targetMode)
      ? manifest.targetMode
      : WORKFLOW_FILE_MODE;
  const clean =
    targetIdentity.kind === 'regular' &&
    targetIdentity.digest === manifest.digest &&
    targetIdentity.mode === expectedTargetMode &&
    manifestIdentity.kind === 'regular' &&
    manifestIdentity.digest === ownership.fileDigest &&
    manifestIdentity.mode === WORKFLOW_FILE_MODE;
  return {
    targetPath,
    manifestPath,
    state: clean ? 'managed-clean' : 'managed-modified',
    ...(clean && targetIdentity.kind === 'regular' && manifestIdentity.kind === 'regular'
      ? {
          targetDigest: targetIdentity.digest,
          manifestDigest: manifestIdentity.digest,
          targetMode: targetIdentity.mode,
          manifestMode: manifestIdentity.mode,
        }
      : {}),
  };
}

/**
 * Stamp the template's LENS_ROOT placeholder with the absolute plugin path and
 * write it to <targetDir>/council.js.
 *
 * Idempotent and ownership-safe: only a target whose digest matches a valid
 * Genie sidecar may be skipped or updated. Existing files without metadata,
 * user-modified files, and corrupt metadata are preserved byte-identically.
 *
 * @param {{templatePath: string, pluginRoot: string, targetDir: string, version?: string|null, now?: () => Date, beforePromotion?: () => void, afterAuthorization?: () => void, beforePublish?: () => void}} opts
 * @returns {{action: 'written'|'skipped'|'kept-unmanaged'|'kept-modified'|'metadata-corrupt', targetPath: string}}
 */
function stampCouncilWorkflow(opts) {
  const { templatePath, pluginRoot, targetDir, version = null, now = () => new Date(), beforePromotion, afterAuthorization, beforePublish } = opts || {};
  if (!templatePath || !pluginRoot || !targetDir) {
    throw new Error('stampCouncilWorkflow requires templatePath, pluginRoot, and targetDir');
  }

  const template = fs.readFileSync(templatePath, 'utf8');
  const quotedPlaceholder = `'${PLACEHOLDER}'`;
  if (!template.includes(quotedPlaceholder)) {
    throw new Error(`council workflow template is missing quoted placeholder ${quotedPlaceholder}`);
  }
  const stamped = template.split(quotedPlaceholder).join(JSON.stringify(pluginRoot));
  recoverTransactions(targetDir);
  const ownership = inspectManagedWorkflow(targetDir);
  const targetExists = lstatSafe(ownership.targetPath) !== null;
  if (ownership.state === 'corrupt-metadata') {
    return { action: 'metadata-corrupt', targetPath: ownership.targetPath };
  }
  if (ownership.state === 'managed-modified') {
    return { action: 'kept-modified', targetPath: ownership.targetPath };
  }
  if (ownership.state === 'unmanaged' && targetExists) {
    return { action: 'kept-unmanaged', targetPath: ownership.targetPath };
  }
  if (ownership.state === 'managed-clean' && fs.readFileSync(ownership.targetPath, 'utf8') === stamped) {
    return { action: 'skipped', targetPath: ownership.targetPath };
  }

  const manifest = {
    managedBy: MANAGED_BY,
    version,
    digest: crypto.createHash('sha256').update(stamped).digest('hex'),
    syncedAt: now().toISOString(),
    identityVersion: PHYSICAL_FILE_IDENTITY_VERSION,
    targetMode: WORKFLOW_FILE_MODE,
  };
  const expected =
    ownership.state === 'managed-clean'
      ? {
          targetDigest: ownership.targetDigest || null,
          manifestDigest: ownership.manifestDigest || null,
          targetMode: ownership.targetMode ?? null,
          manifestMode: ownership.manifestMode ?? null,
        }
      : { targetDigest: null, manifestDigest: null, targetMode: null, manifestMode: null };
  if (
    ownership.state === 'managed-clean' &&
    (expected.targetDigest === null ||
      expected.manifestDigest === null ||
      expected.targetMode === null ||
      expected.manifestMode === null)
  ) {
    return { action: 'kept-modified', targetPath: ownership.targetPath };
  }
  publishTransaction(targetDir, stamped, manifest, expected, beforePromotion, afterAuthorization, beforePublish);
  return { action: 'written', targetPath: ownership.targetPath };
}

/**
 * @param {string} targetDir
 * @param {string} stamped
 * @param {{managedBy:string,version:string|null,digest:string,syncedAt:string,identityVersion:number,targetMode:number}} manifest
 * @param {{targetDigest:string|null,manifestDigest:string|null,targetMode:number|null,manifestMode:number|null}} expected
 * @param {(()=>void)|undefined} beforePromotion
 * @param {(()=>void)|undefined} afterAuthorization
 * @param {(()=>void)|undefined} beforePublish
 */
function publishTransaction(targetDir, stamped, manifest, expected, beforePromotion, afterAuthorization, beforePublish) {
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, TARGET_NAME);
  const manifestPath = path.join(targetDir, WORKFLOW_MANIFEST_NAME);
  const targetDigest = crypto.createHash('sha256').update(stamped).digest('hex');
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestDigest = crypto.createHash('sha256').update(manifestContent).digest('hex');
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const working = path.join(targetDir, `${TRANSACTION_STAGING_PREFIX}${token}`);
  const transactionDir = path.join(targetDir, `${TRANSACTION_PREFIX}${token}`);
  const staged = path.join(working, 'staged');
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, TARGET_NAME), stamped, 'utf8');
  fs.writeFileSync(path.join(staged, WORKFLOW_MANIFEST_NAME), manifestContent, 'utf8');
  fs.chmodSync(path.join(staged, TARGET_NAME), WORKFLOW_FILE_MODE);
  fs.chmodSync(path.join(staged, WORKFLOW_MANIFEST_NAME), WORKFLOW_FILE_MODE);
  const stagedTarget = physicalFileIdentity(path.join(staged, TARGET_NAME));
  const stagedManifest = physicalFileIdentity(path.join(staged, WORKFLOW_MANIFEST_NAME));
  if (stagedTarget.kind !== 'regular' || stagedManifest.kind !== 'regular') {
    throw new Error('council workflow staging did not produce physical regular files');
  }
  fs.writeFileSync(
    path.join(working, 'journal.json'),
    `${JSON.stringify({
      version: 2,
      targetDigest,
      manifestDigest,
      hadTarget: expected.targetDigest !== null,
      hadManifest: expected.manifestDigest !== null,
      beforeTargetDigest: expected.targetDigest,
      beforeManifestDigest: expected.manifestDigest,
      identityVersion: PHYSICAL_FILE_IDENTITY_VERSION,
      targetMode: stagedTarget.mode,
      manifestMode: stagedManifest.mode,
      beforeTargetMode: expected.targetMode,
      beforeManifestMode: expected.manifestMode,
    })}\n`,
    'utf8',
  );
  fs.renameSync(working, transactionDir);
  const publishedStaged = path.join(transactionDir, 'staged');
  const before = path.join(transactionDir, 'before');
  fs.mkdirSync(before, { recursive: true });
  try {
    if (beforePromotion) beforePromotion();
    const expectedTarget = expectedPhysicalFile(expected.targetDigest, expected.targetMode);
    const expectedManifest = expectedPhysicalFile(expected.manifestDigest, expected.manifestMode);
    if (
      !physicalIdentityEquals(physicalFileIdentity(targetPath), expectedTarget) ||
      !physicalIdentityEquals(physicalFileIdentity(manifestPath), expectedManifest)
    ) {
      const conflict = preserveConflict(transactionDir);
      throw new Error(`council workflow changed before promotion; kept live and incoming versions at ${conflict}`);
    }
    if (afterAuthorization) afterAuthorization();
    if (expected.targetDigest !== null) fs.renameSync(targetPath, path.join(before, TARGET_NAME));
    if (expected.manifestDigest !== null) fs.renameSync(manifestPath, path.join(before, WORKFLOW_MANIFEST_NAME));
    if (
      !physicalIdentityEquals(physicalFileIdentity(path.join(before, TARGET_NAME)), expectedTarget) ||
      !physicalIdentityEquals(physicalFileIdentity(path.join(before, WORKFLOW_MANIFEST_NAME)), expectedManifest) ||
      physicalFileIdentity(targetPath).kind !== 'absent' ||
      physicalFileIdentity(manifestPath).kind !== 'absent'
    ) {
      restoreWorkflowPreimagesNoClobber(targetDir, transactionDir);
      const conflict = preserveConflict(transactionDir);
      throw new Error(`council workflow changed during promotion; kept both versions at ${conflict}`);
    }
    if (beforePublish) beforePublish();
    try {
      publishRegularFileNoClobber(path.join(publishedStaged, TARGET_NAME), targetPath);
      publishRegularFileNoClobber(path.join(publishedStaged, WORKFLOW_MANIFEST_NAME), manifestPath);
    } catch (error) {
      const conflict = preserveConflict(transactionDir);
      throw new Error(
        `exclusive council publish failed (${errorCode(error)}); kept live, prior, and incoming versions at ${conflict}`,
      );
    }
    if (
      !physicalIdentityEquals(physicalFileIdentity(targetPath), stagedTarget) ||
      !physicalIdentityEquals(physicalFileIdentity(manifestPath), stagedManifest)
    ) {
      throw new Error('council workflow changed before transaction commit');
    }
    fs.writeFileSync(path.join(transactionDir, 'COMMITTED'), 'ok\n');
    fs.rmSync(transactionDir, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(transactionDir)) throw error;
    try {
      rollbackTransaction(targetDir, transactionDir);
    } catch (rollbackError) {
      throw new Error(`${errorMessage(error)}; council workflow rollback failed: ${errorMessage(rollbackError)}`);
    }
    throw error;
  }
}

/** @param {string} transactionDir @returns {string} */
function preserveConflict(transactionDir) {
  const conflict = transactionDir.replace(TRANSACTION_PREFIX, TRANSACTION_CONFLICT_PREFIX);
  fs.renameSync(transactionDir, conflict);
  return conflict;
}

/** @param {string} transactionDir */
function readTransactionJournal(transactionDir) {
  const parsed = JSON.parse(fs.readFileSync(path.join(transactionDir, 'journal.json'), 'utf8'));
  if (
    parsed.version !== 2 ||
    typeof parsed.targetDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.targetDigest) ||
    typeof parsed.manifestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.manifestDigest) ||
    typeof parsed.hadTarget !== 'boolean' ||
    typeof parsed.hadManifest !== 'boolean' ||
    !isOptionalDigest(parsed.beforeTargetDigest) ||
    !isOptionalDigest(parsed.beforeManifestDigest) ||
    parsed.hadTarget !== (parsed.beforeTargetDigest !== null) ||
    parsed.hadManifest !== (parsed.beforeManifestDigest !== null) ||
    (parsed.identityVersion !== undefined && parsed.identityVersion !== PHYSICAL_FILE_IDENTITY_VERSION) ||
    (parsed.identityVersion === PHYSICAL_FILE_IDENTITY_VERSION &&
      (!isPhysicalMode(parsed.targetMode) ||
        !isPhysicalMode(parsed.manifestMode) ||
        !isOptionalPhysicalMode(parsed.beforeTargetMode) ||
        !isOptionalPhysicalMode(parsed.beforeManifestMode) ||
        parsed.hadTarget !== (parsed.beforeTargetMode !== null) ||
        parsed.hadManifest !== (parsed.beforeManifestMode !== null)))
  ) {
    throw new Error(`invalid council workflow transaction: ${transactionDir}`);
  }
  return parsed;
}

/** @param {string} targetDir */
function recoverTransactions(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  for (const name of fs.readdirSync(targetDir)) {
    if (name.startsWith(TRANSACTION_STAGING_PREFIX)) {
      quarantinePreparation(targetDir, path.join(targetDir, name));
      continue;
    }
    if (!name.startsWith(TRANSACTION_PREFIX)) continue;
    const transactionDir = path.join(targetDir, name);
    const journal = readTransactionJournal(transactionDir);
    if (fs.existsSync(path.join(transactionDir, 'COMMITTED'))) {
      const targetIdentity = journaledWorkflowIdentity(
        transactionDir,
        TARGET_NAME,
        journal.targetDigest,
        journal.targetMode,
        path.join(transactionDir, 'staged', TARGET_NAME),
      );
      const manifestIdentity = journaledWorkflowIdentity(
        transactionDir,
        WORKFLOW_MANIFEST_NAME,
        journal.manifestDigest,
        journal.manifestMode,
        path.join(transactionDir, 'staged', WORKFLOW_MANIFEST_NAME),
      );
      if (
        !physicalIdentityEquals(physicalFileIdentity(path.join(targetDir, TARGET_NAME)), targetIdentity) ||
        !physicalIdentityEquals(physicalFileIdentity(path.join(targetDir, WORKFLOW_MANIFEST_NAME)), manifestIdentity)
      ) {
        const conflict = preserveConflict(transactionDir);
        throw new Error(`committed council workflow transaction is inconsistent; preserved at ${conflict}`);
      }
      fs.rmSync(transactionDir, { recursive: true, force: true });
    } else {
      rollbackTransaction(targetDir, transactionDir);
    }
  }
}

/** @param {string} targetDir @param {string} sourceDir @returns {boolean} */
function publishWorkflowPreimagesNoClobber(targetDir, sourceDir) {
  let complete = true;
  for (const name of [TARGET_NAME, WORKFLOW_MANIFEST_NAME]) {
    const parked = path.join(sourceDir, name);
    const target = path.join(targetDir, name);
    if (lstatSafe(parked) === null) continue;
    if (physicalFileIdentity(target).kind !== 'absent') {
      complete = false;
      continue;
    }
    try {
      publishRegularFileNoClobber(parked, target);
    } catch (error) {
      if (!(error instanceof NoClobberPublishError)) throw error;
      complete = false;
    }
  }
  return complete;
}

/** @param {string} targetDir @param {string} transactionDir @returns {boolean} */
function restoreWorkflowPreimagesNoClobber(targetDir, transactionDir) {
  return publishWorkflowPreimagesNoClobber(targetDir, path.join(transactionDir, 'before'));
}

/**
 * @param {string} transactionDir
 * @param {string} name
 * @param {string} digest
 * @param {number|null|undefined} mode
 * @param {string} evidencePath
 * @param {number} [referenceMode]
 * @returns {{kind:'regular',mode:number,digest:string}}
 */
function journaledWorkflowIdentity(transactionDir, name, digest, mode, evidencePath, referenceMode) {
  if (isPhysicalMode(mode)) return { kind: 'regular', mode, digest };
  const evidence = physicalFileIdentity(evidencePath);
  if (
    evidence.kind !== 'regular' ||
    evidence.digest !== digest ||
    (referenceMode !== undefined && evidence.mode !== referenceMode)
  ) {
    throw new Error(
      `legacy council transaction cannot safely upgrade physical authority for ${name}: ${transactionDir}`,
    );
  }
  return evidence;
}

/**
 * @param {string} transactionDir
 * @param {string} name
 * @param {string} target
 * @param {{kind:'regular',mode:number,digest:string}} expected
 */
function parkWorkflowRollbackTarget(transactionDir, name, target, expected) {
  const current = physicalFileIdentity(target);
  if (current.kind === 'absent') return;
  if (!physicalIdentityEquals(current, expected)) {
    throw new Error(`council transaction target changed: ${target}`);
  }
  const publishedDir = path.join(transactionDir, 'published');
  fs.mkdirSync(publishedDir, { recursive: true });
  const parked = path.join(publishedDir, name);
  fs.renameSync(target, parked);
  if (!physicalIdentityEquals(physicalFileIdentity(parked), expected)) {
    if (physicalFileIdentity(target).kind === 'absent') {
      try {
        publishRegularFileNoClobber(parked, target);
      } catch {
        // Both the moved object and any racing live object remain as evidence.
      }
    }
    throw new Error(`council transaction target changed while being parked: ${target}`);
  }
}

/** @param {string} targetDir @param {string} transactionDir */
function rollbackTransaction(targetDir, transactionDir) {
  try {
    const journal = readTransactionJournal(transactionDir);
    const entries = [
      [
        TARGET_NAME,
        journal.targetDigest,
        journal.targetMode,
        journal.hadTarget,
        journal.beforeTargetDigest,
        journal.beforeTargetMode,
      ],
      [
        WORKFLOW_MANIFEST_NAME,
        journal.manifestDigest,
        journal.manifestMode,
        journal.hadManifest,
        journal.beforeManifestDigest,
        journal.beforeManifestMode,
      ],
    ];
    const resolved = entries.map(([name, digest, mode, had, beforeDigest, beforeMode]) => {
      const target = path.join(targetDir, name);
      const before = path.join(transactionDir, 'before', name);
      const staged = journaledWorkflowIdentity(
        transactionDir,
        name,
        digest,
        mode,
        path.join(transactionDir, 'staged', name),
      );
      let prior = null;
      if (lstatSafe(before) !== null) {
        if (beforeDigest === null) throw new Error(`council transaction has an unexpected prior target: ${before}`);
        prior = journaledWorkflowIdentity(
          transactionDir,
          name,
          beforeDigest,
          beforeMode,
          before,
          mode === undefined ? staged.mode : undefined,
        );
        if (!physicalIdentityEquals(physicalFileIdentity(before), prior)) {
          throw new Error(`council transaction prior target changed: ${before}`);
        }
      } else if (!had) {
        prior = null;
      } else {
        if (beforeDigest === null) throw new Error(`council transaction lost prior target: ${target}`);
        prior = journaledWorkflowIdentity(
          transactionDir,
          name,
          beforeDigest,
          beforeMode,
          target,
          mode === undefined ? staged.mode : undefined,
        );
        if (!physicalIdentityEquals(physicalFileIdentity(target), prior)) {
          throw new Error(`council transaction lost prior target: ${target}`);
        }
      }
      return { name, target, before, staged, prior, had };
    });

    for (const entry of resolved) {
      if (lstatSafe(entry.before) !== null || !entry.had) {
        parkWorkflowRollbackTarget(transactionDir, entry.name, entry.target, entry.staged);
      }
    }
    if (!restoreWorkflowPreimagesNoClobber(targetDir, transactionDir)) {
      throw new Error('council transaction restore raced with new live data');
    }
    for (const entry of resolved) {
      const expected = entry.prior ?? { kind: 'absent' };
      if (!physicalIdentityEquals(physicalFileIdentity(entry.target), expected)) {
        throw new Error(`council transaction restore changed before cleanup: ${entry.target}`);
      }
    }
    fs.rmSync(transactionDir, { recursive: true, force: true });
  } catch (error) {
    if (lstatSafe(transactionDir) === null) throw error;
    const conflict = preserveConflict(transactionDir);
    throw new Error(`${errorMessage(error)}; preserved workflow evidence at ${conflict}`);
  }
}

/** @param {unknown} value @returns {boolean} */
function isOptionalDigest(value) {
  return value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
}

/** @param {unknown} value @returns {value is number} */
function isPhysicalMode(value) {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0o7777;
}

/** @param {unknown} value @returns {boolean} */
function isOptionalPhysicalMode(value) {
  return value === null || isPhysicalMode(value);
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} targetDir @param {string} preparation */
function quarantinePreparation(targetDir, preparation) {
  const quarantine = path.join(targetDir, '.genie-sync-quarantine');
  fs.mkdirSync(quarantine, { recursive: true });
  fs.renameSync(preparation, path.join(quarantine, `${path.basename(preparation)}-${crypto.randomBytes(6).toString('hex')}`));
}

/**
 * Resolve which plugin root to stamp from. Prefers the STABLE canonical source
 * `<genieHome>/plugins/genie` whenever it actually carries the workflow template
 * (`workflows/council.js`), because that path never changes across plugin
 * versions — using it kills the stale-cache downgrade ping-pong where the
 * marketplace `CLAUDE_PLUGIN_ROOT` (which changes on every plugin update) stamps
 * an older-then-newer LENS_ROOT. Falls back to `claudePluginRoot` when the
 * stable template is absent (plugin-only machines with no genie CLI install).
 *
 * `exists` is injectable (default fs.existsSync) so the preference logic is
 * unit-testable without touching the real filesystem.
 *
 * @param {{claudePluginRoot: string, genieHome: string, exists?: (p: string) => boolean}} opts
 * @returns {{pluginRoot: string, templatePath: string}}
 */
function resolveStampInputs(opts) {
  const { claudePluginRoot, genieHome, exists = fs.existsSync } = opts || {};
  if (!claudePluginRoot || !genieHome) throw new Error('resolveStampInputs requires claudePluginRoot and genieHome');
  const stableRoot = path.join(genieHome, 'plugins', 'genie');
  const stableTemplate = path.join(stableRoot, 'workflows', TARGET_NAME);
  if (exists(stableTemplate)) {
    return { pluginRoot: stableRoot, templatePath: stableTemplate };
  }
  return {
    pluginRoot: claudePluginRoot,
    templatePath: path.join(claudePluginRoot, 'workflows', TARGET_NAME),
  };
}

module.exports = {
  stampCouncilWorkflow,
  inspectManagedWorkflow,
  recoverTransactions,
  resolveStampInputs,
  PLACEHOLDER,
  TARGET_NAME,
  WORKFLOW_MANIFEST_NAME,
  MANAGED_BY,
};
