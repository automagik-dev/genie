'use strict';

/**
 * council-stamp: stamp the /council workflow template into ~/.claude/workflows.
 *
 * Plugins cannot ship Claude Code workflows directly, so the template lives in
 * the plugin (plugins/genie/workflows/council.js) with a `__GENIE_LENS_ROOT__`
 * placeholder, and the SessionStart hook (smart-install.js) calls this on every
 * start to write the stamped file to ~/.claude/workflows/council.js.
 *
 * Pure and dependency-injectable: all paths are arguments, so the unit test can
 * drive it entirely inside a tmpdir. CommonJS (.cjs) so it is requireable from
 * the ESM smart-install.js via createRequire, and from bun:test.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const PLACEHOLDER = '__GENIE_LENS_ROOT__';
const TARGET_NAME = 'council.js';
const WORKFLOW_MANIFEST_NAME = `${TARGET_NAME}.genie-sync.json`;
const MANAGED_BY = 'genie-agent-sync';
const TRANSACTION_PREFIX = '.council.genie-txn-';

function lstatSafe(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

function regularFileDigest(filePath) {
  const stat = lstatSafe(filePath);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function readWorkflowManifest(manifestPath) {
  const stat = lstatSafe(manifestPath);
  if (stat === null) return { status: 'missing' };
  if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'corrupt' };
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (
      parsed.managedBy !== MANAGED_BY ||
      typeof parsed.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.digest) ||
      (parsed.version !== null && parsed.version !== undefined && typeof parsed.version !== 'string') ||
      typeof parsed.syncedAt !== 'string'
    ) {
      return { status: 'corrupt' };
    }
    return { status: 'valid', manifest: parsed };
  } catch {
    return { status: 'corrupt' };
  }
}

/** Classify council.js using only its sidecar ownership grant and recorded digest. */
function inspectManagedWorkflow(targetDir) {
  recoverTransactions(targetDir);
  const targetPath = path.join(targetDir, TARGET_NAME);
  const manifestPath = path.join(targetDir, WORKFLOW_MANIFEST_NAME);
  const ownership = readWorkflowManifest(manifestPath);
  if (ownership.status === 'missing') return { targetPath, manifestPath, state: 'unmanaged' };
  if (ownership.status === 'corrupt') return { targetPath, manifestPath, state: 'corrupt-metadata' };
  const digest = regularFileDigest(targetPath);
  return {
    targetPath,
    manifestPath,
    state: digest !== null && digest === ownership.manifest.digest ? 'managed-clean' : 'managed-modified',
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
 * @param {{templatePath: string, pluginRoot: string, targetDir: string, version?: string|null, now?: () => Date}} opts
 * @returns {{action: 'written'|'skipped'|'kept-unmanaged'|'kept-modified'|'metadata-corrupt', targetPath: string}}
 */
function stampCouncilWorkflow({ templatePath, pluginRoot, targetDir, version = null, now = () => new Date() } = {}) {
  if (!templatePath || !pluginRoot || !targetDir) {
    throw new Error('stampCouncilWorkflow requires templatePath, pluginRoot, and targetDir');
  }

  const template = fs.readFileSync(templatePath, 'utf8');
  const quotedPlaceholder = `'${PLACEHOLDER}'`;
  if (!template.includes(quotedPlaceholder)) {
    throw new Error(`council workflow template is missing quoted placeholder ${quotedPlaceholder}`);
  }
  const stamped = template.split(quotedPlaceholder).join(JSON.stringify(pluginRoot));
  const legacyStamped = template.split(PLACEHOLDER).join(pluginRoot);
  const ownership = inspectManagedWorkflow(targetDir);
  const targetExists = lstatSafe(ownership.targetPath) !== null;
  if (ownership.state === 'corrupt-metadata') {
    return { action: 'metadata-corrupt', targetPath: ownership.targetPath };
  }
  if (ownership.state === 'managed-modified') {
    return { action: 'kept-modified', targetPath: ownership.targetPath };
  }
  if (ownership.state === 'unmanaged' && targetExists) {
    if (regularFileDigest(ownership.targetPath) === crypto.createHash('sha256').update(legacyStamped).digest('hex')) {
      backupLegacyWorkflow(targetDir, ownership.targetPath);
    } else {
      return { action: 'kept-unmanaged', targetPath: ownership.targetPath };
    }
  }
  if (ownership.state === 'managed-clean' && fs.readFileSync(ownership.targetPath, 'utf8') === stamped) {
    return { action: 'skipped', targetPath: ownership.targetPath };
  }

  const manifest = {
    managedBy: MANAGED_BY,
    version,
    digest: crypto.createHash('sha256').update(stamped).digest('hex'),
    syncedAt: now().toISOString(),
  };
  publishTransaction(targetDir, stamped, manifest);
  return {
    action: ownership.state === 'unmanaged' && targetExists ? 'adopted-legacy' : 'written',
    targetPath: ownership.targetPath,
  };
}

function backupLegacyWorkflow(targetDir, targetPath) {
  const recovery = path.join(path.dirname(targetDir), '.genie-recovery', 'council-bootstrap');
  fs.mkdirSync(recovery, { recursive: true });
  const digest = regularFileDigest(targetPath);
  if (digest === null) throw new Error(`legacy council workflow is not a physical file: ${targetPath}`);
  const destination = path.join(recovery, `${TARGET_NAME}.${digest}`);
  if (!fs.existsSync(destination)) fs.copyFileSync(targetPath, destination);
}

function publishTransaction(targetDir, stamped, manifest) {
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, TARGET_NAME);
  const manifestPath = path.join(targetDir, WORKFLOW_MANIFEST_NAME);
  const targetDigest = crypto.createHash('sha256').update(stamped).digest('hex');
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestDigest = crypto.createHash('sha256').update(manifestContent).digest('hex');
  const transactionDir = path.join(
    targetDir,
    `${TRANSACTION_PREFIX}${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
  );
  const staged = path.join(transactionDir, 'staged');
  const before = path.join(transactionDir, 'before');
  fs.mkdirSync(staged, { recursive: true });
  fs.mkdirSync(before, { recursive: true });
  fs.writeFileSync(path.join(staged, TARGET_NAME), stamped, 'utf8');
  fs.writeFileSync(path.join(staged, WORKFLOW_MANIFEST_NAME), manifestContent, 'utf8');
  fs.writeFileSync(
    path.join(transactionDir, 'journal.json'),
    `${JSON.stringify({ version: 1, targetDigest, manifestDigest, hadTarget: lstatSafe(targetPath) !== null, hadManifest: lstatSafe(manifestPath) !== null })}\n`,
    'utf8',
  );
  try {
    if (lstatSafe(targetPath) !== null) fs.renameSync(targetPath, path.join(before, TARGET_NAME));
    if (lstatSafe(manifestPath) !== null) fs.renameSync(manifestPath, path.join(before, WORKFLOW_MANIFEST_NAME));
    fs.renameSync(path.join(staged, TARGET_NAME), targetPath);
    fs.renameSync(path.join(staged, WORKFLOW_MANIFEST_NAME), manifestPath);
    fs.writeFileSync(path.join(transactionDir, 'COMMITTED'), 'ok\n');
    fs.rmSync(transactionDir, { recursive: true, force: true });
  } catch (error) {
    rollbackTransaction(targetDir, transactionDir);
    throw error;
  }
}

function readTransactionJournal(transactionDir) {
  const parsed = JSON.parse(fs.readFileSync(path.join(transactionDir, 'journal.json'), 'utf8'));
  if (
    parsed.version !== 1 ||
    typeof parsed.targetDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.targetDigest) ||
    typeof parsed.manifestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.manifestDigest) ||
    typeof parsed.hadTarget !== 'boolean' ||
    typeof parsed.hadManifest !== 'boolean'
  ) {
    throw new Error(`invalid council workflow transaction: ${transactionDir}`);
  }
  return parsed;
}

function recoverTransactions(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  for (const name of fs.readdirSync(targetDir).filter((entry) => entry.startsWith(TRANSACTION_PREFIX))) {
    const transactionDir = path.join(targetDir, name);
    const journal = readTransactionJournal(transactionDir);
    if (fs.existsSync(path.join(transactionDir, 'COMMITTED'))) {
      if (
        regularFileDigest(path.join(targetDir, TARGET_NAME)) !== journal.targetDigest ||
        regularFileDigest(path.join(targetDir, WORKFLOW_MANIFEST_NAME)) !== journal.manifestDigest
      ) {
        throw new Error(`committed council workflow transaction is inconsistent: ${transactionDir}`);
      }
      fs.rmSync(transactionDir, { recursive: true, force: true });
    } else {
      rollbackTransaction(targetDir, transactionDir);
    }
  }
}

function rollbackTransaction(targetDir, transactionDir) {
  const journal = readTransactionJournal(transactionDir);
  for (const [name, digest, had] of [
    [TARGET_NAME, journal.targetDigest, journal.hadTarget],
    [WORKFLOW_MANIFEST_NAME, journal.manifestDigest, journal.hadManifest],
  ]) {
    const target = path.join(targetDir, name);
    const before = path.join(transactionDir, 'before', name);
    if (lstatSafe(before) !== null) {
      if (lstatSafe(target) !== null) {
        if (regularFileDigest(target) !== digest) throw new Error(`council transaction target changed: ${target}`);
        fs.rmSync(target, { force: true });
      }
      fs.renameSync(before, target);
    } else if (!had && lstatSafe(target) !== null) {
      if (regularFileDigest(target) !== digest) throw new Error(`council transaction target changed: ${target}`);
      fs.rmSync(target, { force: true });
    } else if (had && lstatSafe(target) === null) {
      throw new Error(`council transaction lost prior target: ${target}`);
    }
  }
  fs.rmSync(transactionDir, { recursive: true, force: true });
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
function resolveStampInputs({ claudePluginRoot, genieHome, exists = fs.existsSync } = {}) {
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
  resolveStampInputs,
  PLACEHOLDER,
  TARGET_NAME,
  WORKFLOW_MANIFEST_NAME,
  MANAGED_BY,
};
