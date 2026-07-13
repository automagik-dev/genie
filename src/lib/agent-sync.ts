/**
 * agent-sync engine — converge the genie skill set (and the /council workflow
 * stamp) into every detected coding agent from one canonical source root.
 *
 * The source of truth is `<genieHome>/plugins/genie` (fallback
 * `<genieHome>/bin/plugins/genie`), refreshed atomically by `genie update`.
 * This module is pure library: it takes injectable directories + seams and
 * returns a structured report; it wires into no command (that is G2's scope).
 *
 * Managed-dir contract: every skill dir this engine writes carries a
 * `.genie-sync.json` manifest recording the content digest it was synced from.
 * That manifest is what lets a re-run tell "unchanged" from "the user edited
 * this" from "we never shipped this name" — and it is what makes every
 * destructive step (update, remove) is limited to digest-clean managed trees.
 * Same-name unmanaged or user-modified trees are never adopted or overwritten.
 *
 * Everything is non-fatal: an adapter that throws is caught per-agent and
 * reported as an advisory; {@link runAgentSync} never throws for agent-level
 * failures.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  type Dirent,
  type Stats,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import historicalCodexFallbackAllowlist from '../fixtures/codex-fallback-allowlist.json';
import { resolveClaudeDir, resolveCodexDir, resolveGenieHome, resolveHermesHome } from './genie-home.js';
import { HermesConfigError, mergeMcpServersGenie } from './hermes-mcp-config.js';
import { mergeSkillsExternalDir } from './hermes-skills-config.js';

// ============================================================================
// Constants
// ============================================================================

/** Placeholder the /council template carries for its lens-card root. */
const PLACEHOLDER = '__GENIE_LENS_ROOT__';
/** Stamped/synced workflow filename. Exported: doctor/uninstall key their checks on it. */
export const TARGET_NAME = 'council.js';
/** Digest-backed ownership record for the stamped council workflow. */
export const WORKFLOW_MANIFEST_NAME = `${TARGET_NAME}.genie-sync.json`;
/** Deterministic physical mode for both stamped council artifacts. */
const WORKFLOW_FILE_MODE = 0o644;
/** Manifest marker written into every managed skill dir. Exported: single source of truth. */
export const MANIFEST_NAME = '.genie-sync.json';
/** `managedBy` value that certifies a dir as one this engine owns. Exported: single source of truth. */
export const MANAGED_BY = 'genie-agent-sync';
/**
 * Skills NOT synced to Claude Code. On CC, `/council` is the stamped native
 * WORKFLOW (council.js); the portable `council` SKILL exists for runtimes
 * without the workflow engine (Codex, Hermes). Shipping both to CC would
 * register a skill and a workflow under one name — undocumented precedence,
 * the exact collision council-workflow Decision 8 forbids. Excluded names are
 * also dropped from the orphan-protection set, so an already-synced managed
 * copy is backed up and removed on the next sync.
 *
 * Exported as the single source of truth for the excluded set: doctor's
 * freshness check subtracts these from Claude's expected source skills so it
 * never reports a legitimately-excluded skill as "missing/stale".
 */
export const CLAUDE_EXCLUDED_SKILLS = new Set(['council']);
/** Skill actions that represent an actual write to the target. */
const WRITE_ACTIONS = new Set<SkillAction>(['created', 'updated', 'removed']);
/**
 * Collision-proof staging suffixes for atomic managed-dir writes. Chosen so no
 * human backup convention (e.g. `mv review review.old`, or a `review.new`) can
 * ever collide with genie's staging tree — the pre-clean rmSync then only ever
 * removes genie's own crashed-run debris, never a user's sibling dir.
 */
const STAGING_SUFFIX = '.genie-sync.staging';
const PREV_SUFFIX = '.genie-sync.prev';
/** Hidden transaction root; agent skill discovery never sees staged SKILL.md files. */
const SKILL_TRANSACTION_ROOT = '.genie-sync-transactions';
const SKILL_TRANSACTION_STAGING_PREFIX = '.staging-';
const SKILL_TRANSACTION_PREFIX = 'txn-';
const SKILL_REMOVAL_PREFIX = 'delete-';
/** Physical-tree digest schema. Version 1 was the legacy regular-file content digest. */
export const PHYSICAL_TREE_IDENTITY_VERSION = 2;
/** Hidden retained transaction root used only by the explicit fallback-retirement primitive. */
export const CODEX_FALLBACK_RETIREMENT_ROOT = '.genie-codex-fallback-retirement';
/** Borrowed lifecycle-lease path passed from a shell owner to its child process. */
export const LIFECYCLE_LEASE_PATH_ENV = 'GENIE_LIFECYCLE_LEASE_PATH';
/** Exact on-disk owner record paired with {@link LIFECYCLE_LEASE_PATH_ENV}. */
export const LIFECYCLE_LEASE_OWNER_ENV = 'GENIE_LIFECYCLE_LEASE_OWNER';
/** Cross-process mutual-exclusion lockfile under genieHome — one sync writer per GENIE_HOME. */
const LOCK_NAME = '.agent-sync.lock';
/** A lock older than this is a crashed run's debris and may be stolen. */
const LOCK_STALE_MS = 10 * 60 * 1000;
/**
 * Live Codex user-skills tier — codex-rs loads `~/.agents/skills/<name>`
 * top-level. Exported so doctor/uninstall share the exact target agent-sync
 * writes. The env override exists for tests (all-tmpdir isolation), mirroring
 * the genie-home resolvers.
 */
export function resolveAgentsSkillsDir(): string {
  return process.env.GENIE_AGENTS_SKILLS_DIR || join(homedir(), '.agents', 'skills');
}

/**
 * Retired codex lane (pre-migration): `<codexDir>/skills/.curated`. Codex
 * provably never loaded it — codex-rs prunes hidden dirs from skill discovery
 * (`HiddenDirectoryPolicy::Skip`) and marks `$CODEX_HOME/skills` itself
 * deprecated. Exported so doctor/uninstall can keep checking/cleaning the
 * legacy location on machines that have not synced since the migration.
 */
export function codexLegacyCuratedDir(codexDir: string): string {
  return join(codexDir, 'skills', '.curated');
}

// ============================================================================
// Public types
// ============================================================================

export interface AgentSyncOptions {
  /** Global genie root; defaults to {@link resolveGenieHome}. */
  genieHome?: string;
  /**
   * Per-agent target dir overrides (tests inject tmpdirs here). `agentsSkills`
   * is the shared `~/.agents/skills` tier codex skills are synced INTO;
   * `codex` (`~/.codex`) stays the detection root + legacy-lane parent.
   */
  targets?: { claude?: string; codex?: string; hermes?: string; agentsSkills?: string };
  /**
   * Hermes binary override for enable-exec detection. A non-null string forces
   * "detected"; `null` explicitly skips exec; `undefined` probes PATH.
   */
  hermesBinary?: string | null;
  /** Injectable exec seam for `hermes plugins enable genie` (default execFileSync). */
  execHermesEnable?: (args: string[]) => void;
  /** Structured log sink (no console in src). */
  log?: (line: string) => void;
  /** Injectable clock for manifest + backup timestamps. */
  now?: () => Date;
  /** Bound client homes for explicit lifecycle commands. */
  selection?: AgentSyncSelection;
  /** Test seam for managed-directory promotion failures. Recovery always uses the real filesystem primitive. */
  renameManagedDir?: typeof renameSync;
  /** Test seam invoked before the final managed-directory CAS check. */
  beforeManagedDirPromotion?: (destDir: string) => void;
  /** Failure-injection seam after parking and immediately before exclusive publication. */
  beforeManagedDirPublish?: (destDir: string) => void;
  /** Failure-injection seam around managed-directory removal quarantine. */
  beforeManagedDirRemoval?: (destDir: string, stage: 'before-park' | 'before-delete') => void;
}

export type AgentSyncSelection = 'auto' | 'codex' | 'claude' | 'all' | 'none';

export type SkillAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  /** Retained for report compatibility with older releases; new syncs never adopt collisions. */
  | 'adopted'
  | 'removed'
  | 'skipped-unmanaged-kept'
  | 'kept-modified'
  | 'kept-modified-orphan';

export interface AgentReport {
  agent: 'claude' | 'codex' | 'hermes';
  detected: boolean;
  skills: Array<{ name: string; action: SkillAction; detail?: string }>;
  /** Non-skill outcomes: stamp / symlink / enable lines. */
  extras: Array<{ kind: string; action: string; detail?: string }>;
  advisories: string[];
  /** Adapter failures, distinct from preservation/restart advisories. */
  failures?: string[];
}

export interface AgentSyncReport {
  source: GenieSource;
  agents: AgentReport[];
  backupsDir: string | null;
  /**
   * Set when a concurrent sync held the cross-process lock and this run skipped
   * entirely (advisory, not an error — the holder converges the same targets).
   */
  skipped?: string;
}

export interface GenieSource {
  pluginRoot: string | null;
  hermesRoot: string | null;
  version: string | null;
}

// ============================================================================
// Internal types
// ============================================================================

interface SyncManifest {
  managedBy: 'genie-agent-sync';
  version: string | null;
  digest: string;
  syncedAt: string;
  /** Physical-identity schema for managed directories and stamped workflows. */
  identityVersion?: typeof PHYSICAL_TREE_IDENTITY_VERSION;
  /** Stamped workflow target mode; absent from managed-directory manifests. */
  targetMode?: number;
}

interface RunContext {
  genieHome: string;
  pluginRoot: string;
  hermesRoot: string | null;
  version: string | null;
  now: () => Date;
  targets: { claude: string; codex: string; hermes: string; agentsSkills: string };
  /** Copy `existingDir` into the run's backup root and return the backup path. */
  backupInto: (agent: string, name: string, existingDir: string) => string;
  /** The backup root path, or null when nothing has been backed up this run. */
  backupsDirIfCreated: () => string | null;
  renameManagedDir: typeof renameSync;
  beforeManagedDirPromotion?: (destDir: string) => void;
  beforeManagedDirPublish?: (destDir: string) => void;
  beforeManagedDirRemoval?: (destDir: string, stage: 'before-park' | 'before-delete') => void;
}

interface SourceSkill {
  name: string;
  dir: string;
}

interface SkillOutcome {
  action: SkillAction;
  detail?: string;
}

// ============================================================================
// Source resolution
// ============================================================================

/**
 * Resolve the canonical source roots under `genieHome`:
 *   - pluginRoot: first existing of `plugins/genie`, `bin/plugins/genie`,
 *   - hermesRoot: sibling `hermes-genie` in the same plugins layout,
 *   - version: trimmed `VERSION` file, else null.
 */
export function resolveGenieSource(genieHome: string): GenieSource {
  const pluginRoot = firstExisting([join(genieHome, 'plugins', 'genie'), join(genieHome, 'bin', 'plugins', 'genie')]);
  const hermesRoot = firstExisting([
    join(genieHome, 'plugins', 'hermes-genie'),
    join(genieHome, 'bin', 'plugins', 'hermes-genie'),
  ]);
  const version = readTrimmed(join(genieHome, 'VERSION')) || null;
  return { pluginRoot, hermesRoot, version };
}

function firstExisting(paths: string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) return path;
  }
  return null;
}

// ============================================================================
// Digest — a stable fingerprint of a physical directory tree
// ============================================================================

/**
 * Version-2 SHA-256 identity over the root and every physical entry. Each entry
 * contributes its normalized relative path, exact lstat kind, permission mode,
 * and kind-specific payload (regular-file content hash or raw symlink target).
 * Symlinks are never followed; FIFOs, sockets, devices, and other non-regular
 * entries are represented rather than silently skipped. The manifest is always
 * excluded because its digest field would otherwise be self-referential.
 */
export function computeDirDigest(dir: string, exclude?: Set<string>): string {
  const excluded = new Set([...(exclude ?? [])].map(normalizePhysicalRelPath));
  excluded.add(MANIFEST_NAME);
  return computePhysicalTreeDigest(dir, excluded);
}

function computeExactDirDigest(dir: string): string {
  return computePhysicalTreeDigest(dir, new Set());
}

function computePhysicalTreeDigest(dir: string, excluded: Set<string>): string {
  const rootStat = lstatSync(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`physical tree root is not a directory: ${dir}`);
  }
  const entries: PhysicalTreeEntry[] = [physicalTreeEntry('.', rootStat, dir)];
  collectPhysicalTreeEntries(dir, dir, excluded, entries);
  entries.sort(byRel);
  const digest = createHash('sha256');
  digest.update(`genie-physical-tree-v${PHYSICAL_TREE_IDENTITY_VERSION}\0`);
  for (const entry of entries) {
    updateLengthPrefixed(digest, entry.rel);
    updateLengthPrefixed(digest, entry.kind);
    updateLengthPrefixed(digest, entry.mode.toString(8));
    updateLengthPrefixed(digest, entry.payload);
  }
  return digest.digest('hex');
}

interface PhysicalTreeEntry {
  rel: string;
  kind: 'directory' | 'file' | 'symlink' | 'fifo' | 'socket' | 'block-device' | 'character-device' | 'other';
  mode: number;
  payload: string;
}

function byRel(a: { rel: string }, b: { rel: string }): number {
  if (a.rel < b.rel) return -1;
  if (a.rel > b.rel) return 1;
  return 0;
}

function normalizePhysicalRelPath(path: string): string {
  return path.split(sep).join('/');
}

function physicalEntryKind(stat: Stats): PhysicalTreeEntry['kind'] {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  return 'other';
}

function physicalTreeEntry(rel: string, stat: Stats, absolute: string): PhysicalTreeEntry {
  const kind = physicalEntryKind(stat);
  const payload = kind === 'file' ? hashFile(absolute) : kind === 'symlink' ? readlinkSync(absolute) : '';
  return { rel, kind, mode: stat.mode & 0o7777, payload };
}

function collectPhysicalTreeEntries(
  root: string,
  current: string,
  excluded: Set<string>,
  out: PhysicalTreeEntry[],
): void {
  for (const name of readdirSync(current)) {
    const abs = join(current, name);
    const rel = normalizePhysicalRelPath(relative(root, abs));
    if (excluded.has(rel)) continue;
    const stat = lstatSync(abs);
    const entry = physicalTreeEntry(rel, stat, abs);
    out.push(entry);
    if (entry.kind === 'directory') collectPhysicalTreeEntries(root, abs, excluded, out);
  }
}

function updateLengthPrefixed(digest: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value);
  digest.update(String(bytes.length));
  digest.update(':');
  digest.update(bytes);
  digest.update('\0');
}

/**
 * Legacy v1 digest, accepted only when every physical entry is a regular file
 * or directory. A symlink or special entry in an old tree therefore revokes
 * deletion/update authority instead of recreating the legacy follow/skip bug.
 */
function computeLegacyRegularTreeDigest(dir: string): string | null {
  const rootStat = lstatSync(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  const files: Array<{ rel: string; hash: string }> = [];
  const visit = (current: string): boolean => {
    for (const name of readdirSync(current)) {
      const absolute = join(current, name);
      const rel = relative(dir, absolute);
      if (rel === MANIFEST_NAME) continue;
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!visit(absolute)) return false;
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        files.push({ rel, hash: hashFile(absolute) });
      } else {
        return false;
      }
    }
    return true;
  };
  if (!visit(dir)) return null;
  files.sort(byRel);
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.rel);
    digest.update('\0');
    digest.update(file.hash);
    digest.update('\0');
  }
  return digest.digest('hex');
}

/** Resolve a dirent to file/dir/skip, following symlinks and dropping broken ones. */
function classifyEntry(abs: string, entry: Dirent): 'file' | 'dir' | 'skip' {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'dir';
  if (entry.isSymbolicLink()) {
    try {
      return statSync(abs).isDirectory() ? 'dir' : 'file';
    } catch {
      return 'skip';
    }
  }
  return 'skip';
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ============================================================================
// Manifest + atomic managed-dir writes
// ============================================================================

function readManifest(dir: string): { manifest: SyncManifest; fileDigest: string } | null {
  try {
    const content = readFileSync(join(dir, MANIFEST_NAME));
    const parsed = JSON.parse(content.toString('utf8')) as Partial<SyncManifest>;
    if (
      parsed.managedBy === MANAGED_BY &&
      typeof parsed.digest === 'string' &&
      /^[a-f0-9]{64}$/.test(parsed.digest) &&
      (parsed.identityVersion === undefined || parsed.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION)
    ) {
      return {
        manifest: {
          managedBy: MANAGED_BY,
          version: parsed.version ?? null,
          digest: parsed.digest,
          syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '',
          ...(parsed.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION
            ? { identityVersion: PHYSICAL_TREE_IDENTITY_VERSION }
            : {}),
        },
        fileDigest: createHash('sha256').update(content).digest('hex'),
      };
    }
  } catch {
    // absent, unreadable, or unparsable → treat as unmanaged
  }
  return null;
}

function writeManifest(dir: string, manifest: SyncManifest): void {
  writeFileSync(join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function buildManifest(ctx: RunContext, digest: string): SyncManifest {
  return {
    managedBy: MANAGED_BY,
    version: ctx.version,
    digest,
    syncedAt: ctx.now().toISOString(),
    identityVersion: PHYSICAL_TREE_IDENTITY_VERSION,
  };
}

interface ManagedDirTransactionJournal {
  version: 1 | 2;
  destName: string;
  hadLive: boolean;
  beforeContentDigest: string | null;
  beforeManifestDigest: string | null;
  stagedContentDigest: string;
  stagedManifestDigest: string;
  /** v1 journals used content-only digests; v2 hashes physical entry identity. */
  identityVersion?: 1 | typeof PHYSICAL_TREE_IDENTITY_VERSION;
}

interface ManagedDirExpectedIdentity {
  contentDigest: string | null;
  manifestDigest: string | null;
}

class ManagedArtifactConflictError extends Error {}

class NoClobberPublishError extends ManagedArtifactConflictError {}

/**
 * Atomically reserve an absent regular-file pathname with a hard link. The
 * linked candidate is a disposable copy, so the original staged bytes remain
 * immutable evidence if a concurrent writer changes the published inode.
 */
export function publishRegularFileNoClobber(stagedPath: string, targetPath: string): void {
  const stagedStat = lstatSync(stagedPath);
  if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
    throw new Error(`publish source is not a physical regular file: ${stagedPath}`);
  }
  const candidate = `${stagedPath}.publish-${process.pid}-${randomBytes(6).toString('hex')}`;
  copyFileSync(stagedPath, candidate, constants.COPYFILE_EXCL);
  chmodSync(candidate, stagedStat.mode & 0o7777);
  try {
    linkSync(candidate, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    throw new NoClobberPublishError(`exclusive publish failed (${code}); target was preserved: ${targetPath}`);
  } finally {
    rmSync(candidate, { force: true });
  }
}

/**
 * Reserve an absent directory root with mkdir(EEXIST), then populate it using
 * only exclusive child creates. This is the strongest portable Node primitive
 * for directories: it never replaces a competing root and retains the complete
 * staged tree in the journal if a child-level collision occurs.
 */
function publishPhysicalTreeNoClobber(stagedDir: string, targetDir: string): void {
  const stagedStat = lstatSync(stagedDir);
  if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink()) {
    throw new Error(`publish source is not a physical directory: ${stagedDir}`);
  }
  try {
    mkdirSync(targetDir, { mode: stagedStat.mode & 0o7777 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    throw new NoClobberPublishError(`exclusive directory publish failed (${code}); target was preserved: ${targetDir}`);
  }
  const visit = (source: string, destination: string): void => {
    for (const name of readdirSync(source)) {
      const from = join(source, name);
      const to = join(destination, name);
      const stat = lstatSync(from);
      try {
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          mkdirSync(to, { mode: stat.mode & 0o7777 });
          visit(from, to);
          chmodSync(to, stat.mode & 0o7777);
        } else if (stat.isFile() && !stat.isSymbolicLink()) {
          publishRegularFileNoClobber(from, to);
        } else if (stat.isSymbolicLink()) {
          symlinkSync(readlinkSync(from), to);
        } else {
          throw new Error(`unsupported physical entry during managed-tree publish: ${from}`);
        }
      } catch (error) {
        if (error instanceof NoClobberPublishError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          throw new NoClobberPublishError(`exclusive tree entry publish failed (EEXIST); target was preserved: ${to}`);
        }
        throw error;
      }
    }
  };
  visit(stagedDir, targetDir);
  chmodSync(targetDir, stagedStat.mode & 0o7777);
}

/**
 * Copy `sourceDir` into `destDir` through a journaled transaction. The complete
 * staged tree and journal are first built below a hidden working name; an
 * atomic rename publishes that transaction before the live tree is touched.
 * A crash therefore leaves either undiscoverable pre-journal debris or enough
 * information to restore the previous live tree on the next sync.
 */
function writeManagedDir(
  ctx: RunContext,
  sourceDir: string,
  destDir: string,
  manifest: SyncManifest,
  expected: ManagedDirExpectedIdentity,
): void {
  const targetParent = dirname(destDir);
  const destName = relative(targetParent, destDir);
  if (!isSafeEntryName(destName)) throw new Error(`invalid managed skill target name: ${destName}`);
  const transactionRoot = join(targetParent, SKILL_TRANSACTION_ROOT);
  const token = `${Buffer.from(destName).toString('hex')}-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const working = createExclusiveTransactionDir(transactionRoot, `${SKILL_TRANSACTION_STAGING_PREFIX}${token}`);
  const published = join(transactionRoot, `${SKILL_TRANSACTION_PREFIX}${token}`);
  const staged = join(working, 'staged');
  const before = join(published, 'before');
  try {
    cpSync(sourceDir, staged, { recursive: true });
    writeManifest(staged, manifest);
    const stagedIdentity = managedDirIdentity(staged);
    const journal: ManagedDirTransactionJournal = {
      version: 2,
      destName,
      hadLive: expected.contentDigest !== null,
      beforeContentDigest: expected.contentDigest,
      beforeManifestDigest: expected.manifestDigest,
      stagedContentDigest: stagedIdentity.contentDigest,
      stagedManifestDigest: stagedIdentity.manifestDigest,
      identityVersion: PHYSICAL_TREE_IDENTITY_VERSION,
    };
    writeFileSync(join(working, 'journal.json'), `${JSON.stringify(journal)}\n`, 'utf8');
    renameSync(working, published);
    try {
      ctx.beforeManagedDirPromotion?.(destDir);
      if (!matchesExpectedManagedDirIdentity(destDir, expected)) {
        const conflict = preserveManagedDirConflict(transactionRoot, published, token);
        throw new ManagedArtifactConflictError(
          `managed skill changed before promotion; kept live and incoming versions for review at ${conflict}`,
        );
      }
      if (expected.contentDigest !== null) {
        ctx.renameManagedDir(destDir, before);
        if (!matchesManagedDirIdentity(before, expected.contentDigest, expected.manifestDigest)) {
          if (lstatSafe(destDir) === null) {
            try {
              publishPhysicalTreeNoClobber(before, destDir);
            } catch {
              // Preserve both the parked object and any racing live object.
            }
          }
          const conflict = preserveManagedDirConflict(transactionRoot, published, token);
          throw new ManagedArtifactConflictError(
            `managed skill changed during promotion; kept both versions for review at ${conflict}`,
          );
        }
      }
      ctx.beforeManagedDirPublish?.(destDir);
      try {
        publishPhysicalTreeNoClobber(join(published, 'staged'), destDir);
      } catch (error) {
        if (error instanceof NoClobberPublishError) {
          const conflict = preserveManagedDirConflict(transactionRoot, published, token);
          throw new ManagedArtifactConflictError(
            `${error.message}; kept live and incoming versions for review at ${conflict}`,
          );
        }
        throw error;
      }
      if (!matchesManagedDirIdentity(destDir, journal.stagedContentDigest, journal.stagedManifestDigest)) {
        const conflict = preserveManagedDirConflict(transactionRoot, published, token);
        throw new ManagedArtifactConflictError(
          `managed skill changed during exclusive publication; kept live and incoming versions for review at ${conflict}`,
        );
      }
      writeFileSync(join(published, 'COMMITTED'), 'ok\n', 'utf8');
      rmSync(published, { recursive: true, force: true });
      removeEmptyDirSafe(transactionRoot);
    } catch (error) {
      if (error instanceof ManagedArtifactConflictError) throw error;
      try {
        rollbackManagedDirTransaction(targetParent, published, journal);
      } catch (rollbackError) {
        throw new Error(`${errMsg(error)}; managed skill rollback failed: ${errMsg(rollbackError)}`);
      }
      throw error;
    }
  } catch (error) {
    if (lstatSafe(working) !== null) rmSync(working, { recursive: true, force: true });
    removeEmptyDirSafe(transactionRoot);
    throw error;
  }
}

function matchesExpectedManagedDirIdentity(dir: string, expected: ManagedDirExpectedIdentity): boolean {
  const stat = lstatOrNull(dir);
  if (expected.contentDigest === null) return stat === null && expected.manifestDigest === null;
  return stat !== null && matchesManagedDirIdentity(dir, expected.contentDigest, expected.manifestDigest);
}

function preserveManagedDirConflict(transactionRoot: string, transactionDir: string, token: string): string {
  const conflict = join(transactionRoot, `.conflict-${token}`);
  renameSync(transactionDir, conflict);
  return conflict;
}

function preserveManagedDirTransactionConflict(transactionDir: string): string {
  const name = transactionDir.split(sep).at(-1) ?? '';
  if (!name.startsWith(SKILL_TRANSACTION_PREFIX)) {
    throw new Error(`invalid managed skill transaction name: ${transactionDir}`);
  }
  return preserveManagedDirConflict(
    dirname(transactionDir),
    transactionDir,
    name.slice(SKILL_TRANSACTION_PREFIX.length),
  );
}

interface ManagedDirRemovalJournal {
  version: 1 | 2;
  destName: string;
  contentDigest: string;
  manifestDigest: string;
  identityVersion?: 1 | typeof PHYSICAL_TREE_IDENTITY_VERSION;
}

function readManagedDirRemovalJournal(transactionDir: string): ManagedDirRemovalJournal {
  const parsed = JSON.parse(
    readFileSync(join(transactionDir, 'journal.json'), 'utf8'),
  ) as Partial<ManagedDirRemovalJournal>;
  if (
    ![1, 2].includes(Number(parsed.version)) ||
    typeof parsed.destName !== 'string' ||
    !isSafeEntryName(parsed.destName) ||
    !isDigest(parsed.contentDigest) ||
    !isDigest(parsed.manifestDigest) ||
    (parsed.version === 2 && parsed.identityVersion !== PHYSICAL_TREE_IDENTITY_VERSION)
  ) {
    throw new Error(`invalid managed skill removal transaction: ${transactionDir}`);
  }
  return parsed as ManagedDirRemovalJournal;
}

function preserveManagedRemovalConflict(transactionRoot: string, transactionDir: string, token: string): string {
  const conflict = join(transactionRoot, `.conflict-delete-${token}`);
  renameSync(transactionDir, conflict);
  return conflict;
}

/**
 * Remove one digest-clean managed tree by moving the accepted physical object
 * into a durable quarantine first. Backup bytes are copied from that parked
 * object, never from a pathname that can be replaced between check and unlink.
 */
function removeManagedDir(
  ctx: RunContext,
  agent: string,
  name: string,
  destDir: string,
  expected: ManagedDirExpectedIdentity,
): void {
  if (expected.contentDigest === null || expected.manifestDigest === null) {
    throw new Error(`managed skill removal requires a complete physical identity: ${destDir}`);
  }
  const targetParent = dirname(destDir);
  const transactionRoot = join(targetParent, SKILL_TRANSACTION_ROOT);
  const token = `${Buffer.from(name).toString('hex')}-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const working = createExclusiveTransactionDir(transactionRoot, `${SKILL_TRANSACTION_STAGING_PREFIX}delete-${token}`);
  const transactionDir = join(transactionRoot, `${SKILL_REMOVAL_PREFIX}${token}`);
  const parked = join(transactionDir, 'parked');
  const journal: ManagedDirRemovalJournal = {
    version: 2,
    destName: name,
    contentDigest: expected.contentDigest,
    manifestDigest: expected.manifestDigest,
    identityVersion: PHYSICAL_TREE_IDENTITY_VERSION,
  };
  writeFileSync(join(working, 'journal.json'), `${JSON.stringify(journal)}\n`, 'utf8');
  renameSync(working, transactionDir);
  try {
    ctx.beforeManagedDirRemoval?.(destDir, 'before-park');
    if (!matchesExpectedManagedDirIdentity(destDir, expected)) {
      const conflict = preserveManagedRemovalConflict(transactionRoot, transactionDir, token);
      throw new ManagedArtifactConflictError(
        `managed skill changed before removal; kept live removal transaction for review at ${conflict}`,
      );
    }
    ctx.renameManagedDir(destDir, parked);
    if (!matchesManagedDirIdentity(parked, expected.contentDigest, expected.manifestDigest)) {
      if (lstatOrNull(destDir) === null) {
        try {
          publishPhysicalTreeNoClobber(parked, destDir);
        } catch {
          // Preserve the parked object and any racing live object as evidence.
        }
      }
      const conflict = preserveManagedRemovalConflict(transactionRoot, transactionDir, token);
      throw new ManagedArtifactConflictError(
        `managed skill changed while being parked for removal; preserved it at ${conflict}`,
      );
    }
    ctx.backupInto(agent, name, parked);
    ctx.beforeManagedDirRemoval?.(destDir, 'before-delete');
    if (!matchesManagedDirIdentity(parked, expected.contentDigest, expected.manifestDigest)) {
      const conflict = preserveManagedRemovalConflict(transactionRoot, transactionDir, token);
      throw new ManagedArtifactConflictError(
        `managed skill changed after removal backup; preserved exact objects at ${conflict}`,
      );
    }
    writeFileSync(join(transactionDir, 'COMMITTED'), 'ok\n', 'utf8');
    rmSync(parked, { recursive: true, force: true });
    rmSync(transactionDir, { recursive: true, force: true });
    removeEmptyDirSafe(transactionRoot);
  } catch (error) {
    if (error instanceof ManagedArtifactConflictError) throw error;
    try {
      if (lstatSafe(transactionDir) !== null) {
        recoverManagedDirRemovalTransaction(targetParent, transactionRoot, transactionDir, token);
      }
    } catch (rollbackError) {
      throw new Error(`${errMsg(error)}; managed skill removal rollback failed: ${errMsg(rollbackError)}`);
    }
    throw error;
  }
}

function recoverManagedDirRemovalTransaction(
  targetParent: string,
  transactionRoot: string,
  transactionDir: string,
  token: string,
): void {
  const journal = readManagedDirRemovalJournal(transactionDir);
  const destDir = join(targetParent, journal.destName);
  const parked = join(transactionDir, 'parked');
  if (lstatSafe(parked) === null) {
    rmSync(transactionDir, { recursive: true, force: true });
    return;
  }
  if (!matchesManagedDirIdentity(parked, journal.contentDigest, journal.manifestDigest, journal.identityVersion ?? 1)) {
    preserveManagedRemovalConflict(transactionRoot, transactionDir, token);
    throw new Error(`managed skill removal quarantine changed: ${parked}`);
  }
  if (existsSync(join(transactionDir, 'COMMITTED'))) {
    rmSync(parked, { recursive: true, force: true });
    rmSync(transactionDir, { recursive: true, force: true });
    return;
  }
  if (lstatOrNull(destDir) !== null) {
    preserveManagedRemovalConflict(transactionRoot, transactionDir, token);
    throw new Error(`managed skill removal recovery found a new live target: ${destDir}`);
  }
  try {
    publishPhysicalTreeNoClobber(parked, destDir);
  } catch (error) {
    const conflict = preserveManagedRemovalConflict(transactionRoot, transactionDir, token);
    throw new Error(`${errMsg(error)}; preserved managed skill removal evidence at ${conflict}`);
  }
  if (
    !matchesManagedDirIdentity(destDir, journal.contentDigest, journal.manifestDigest, journal.identityVersion ?? 1)
  ) {
    const conflict = preserveManagedRemovalConflict(transactionRoot, transactionDir, token);
    throw new Error(`managed skill removal restore changed; preserved evidence at ${conflict}`);
  }
  rmSync(transactionDir, { recursive: true, force: true });
}

function managedDirIdentity(dir: string): { contentDigest: string; manifestDigest: string } {
  const stat = lstatSafe(dir);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`managed skill tree is not a physical directory: ${dir}`);
  }
  const manifestDigest = regularFileDigest(join(dir, MANIFEST_NAME));
  if (manifestDigest === null) throw new Error(`managed skill manifest is not a physical file: ${dir}`);
  return { contentDigest: computeDirDigest(dir), manifestDigest };
}

/**
 * Return the current v2 physical identity only when the tree still matches its
 * ownership manifest. An untagged v2 digest is an unambiguous transitional
 * record. A content-only v1 digest is accepted only when a caller also proves
 * that the complete current physical tree equals a trusted canonical tree;
 * destructive orphan/legacy-lane callers intentionally provide no such proof.
 */
function acceptedManagedDirPhysicalDigest(
  dir: string,
  manifest: SyncManifest,
  trustedPhysicalDigest?: string,
): string | null {
  const physicalDigest = computeDirDigest(dir);
  if (manifest.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION) {
    return physicalDigest === manifest.digest ? physicalDigest : null;
  }
  // Transitional fixtures/releases could write the v2 digest before adding the
  // explicit schema tag. Exact v2 equality is unambiguous and safe to accept.
  if (physicalDigest === manifest.digest) return physicalDigest;
  const legacyDigest = computeLegacyRegularTreeDigest(dir);
  return legacyDigest !== null && legacyDigest === manifest.digest && physicalDigest === trustedPhysicalDigest
    ? physicalDigest
    : null;
}

export type ManagedSkillTreeState = 'unmanaged' | 'managed-clean' | 'managed-modified' | 'corrupt-metadata';

export interface ManagedSkillTreeReport {
  path: string;
  state: ManagedSkillTreeState;
  /** Accepted v2 physical identity captured during classification. */
  contentDigest?: string;
  manifestDigest?: string;
}

/** One ownership classifier shared by sync, doctor-facing callers, and uninstall. */
export function inspectManagedSkillTree(dir: string): ManagedSkillTreeReport {
  const root = lstatSafe(dir);
  if (root === null || !root.isDirectory() || root.isSymbolicLink()) return { path: dir, state: 'unmanaged' };
  const manifestPath = join(dir, MANIFEST_NAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return lstatSafe(manifestPath) === null
      ? { path: dir, state: 'unmanaged' }
      : { path: dir, state: 'corrupt-metadata' };
  }
  if (typeof raw !== 'object' || raw === null || Reflect.get(raw, 'managedBy') !== MANAGED_BY) {
    return { path: dir, state: 'unmanaged' };
  }
  const manifest = readManifest(dir);
  if (manifest === null) return { path: dir, state: 'corrupt-metadata' };
  try {
    const contentDigest = acceptedManagedDirPhysicalDigest(dir, manifest.manifest);
    return contentDigest === null
      ? { path: dir, state: 'managed-modified' }
      : { path: dir, state: 'managed-clean', contentDigest, manifestDigest: manifest.fileDigest };
  } catch {
    return { path: dir, state: 'managed-modified' };
  }
}

// ============================================================================
// Retired Codex fallback ownership + batch retirement (deliberately unwired)
// ============================================================================

export interface CodexFallbackHistoricalTuple {
  /** Exact-content retirement policy only; this tuple is not authenticated provenance. */
  markerVersion: string;
  skillName: string;
  physicalDigest: string;
}

export interface VerifiedCodexSkillPayload {
  skillName: string;
  path: string;
  physicalDigest: string;
  /** Set only after the caller's canonical release verification succeeds. */
  canonicalVerified: true;
}

export type CodexFallbackOwnershipReason =
  | 'historical-tuple'
  | 'verified-target'
  | 'missing'
  | 'symlink'
  | 'not-physical-directory'
  | 'malformed-marker'
  | 'modified-tree'
  | 'ambiguous-ownership';

export interface CodexFallbackOwnership {
  skillName: string;
  path: string;
  accepted: boolean;
  reason: CodexFallbackOwnershipReason;
  markerVersion?: string;
  physicalDigest?: string;
  markerDigest?: string;
  targetDigest?: string;
}

export interface CodexFallbackRetirementPlan {
  version: 1;
  generation?: number;
  fallbackSkillsDir: string;
  transactionId: string;
  accepted: CodexFallbackAcceptedIdentity[];
  preserved: CodexFallbackOwnership[];
}

export interface CodexFallbackAcceptedIdentity {
  skillName: string;
  source: string;
  markerVersion: string;
  physicalDigest: string;
  markerDigest: string;
  targetDigest: string | null;
  ownership: 'historical-tuple' | 'verified-target';
}

export interface PlanCodexFallbackRetirementOptions {
  fallbackSkillsDir: string;
  skillNames: readonly string[];
  verifiedTargets?: readonly VerifiedCodexSkillPayload[];
}

interface StrictFallbackMarker {
  managedBy: typeof MANAGED_BY;
  version: string;
  digest: string;
  /** Informational timestamp only; never ownership or provenance authority. */
  syncedAt: string;
  identityVersion: typeof PHYSICAL_TREE_IDENTITY_VERSION;
}

function strictFallbackMarker(dir: string): { marker: StrictFallbackMarker; markerDigest: string } | null {
  const markerPath = join(dir, MANIFEST_NAME);
  const markerStat = lstatSafe(markerPath);
  if (markerStat === null || !markerStat.isFile() || markerStat.isSymbolicLink()) return null;
  try {
    const bytes = readFileSync(markerPath);
    const parsed = JSON.parse(bytes.toString('utf8')) as Partial<StrictFallbackMarker>;
    if (
      parsed.managedBy !== MANAGED_BY ||
      typeof parsed.version !== 'string' ||
      parsed.version.length === 0 ||
      !isDigest(parsed.digest) ||
      typeof parsed.syncedAt !== 'string' ||
      parsed.identityVersion !== PHYSICAL_TREE_IDENTITY_VERSION
    ) {
      return null;
    }
    return {
      marker: parsed as StrictFallbackMarker,
      markerDigest: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return null;
  }
}

function verifiedTargetByName(
  targets: readonly VerifiedCodexSkillPayload[],
): Map<string, VerifiedCodexSkillPayload | null> {
  const indexed = new Map<string, VerifiedCodexSkillPayload | null>();
  for (const target of targets) {
    const prior = indexed.get(target.skillName);
    indexed.set(target.skillName, prior === undefined ? target : null);
  }
  return indexed;
}

function verifiedTargetDigest(target: VerifiedCodexSkillPayload | null | undefined): string | null {
  if (
    target === null ||
    target === undefined ||
    target.canonicalVerified !== true ||
    !isDigest(target.physicalDigest)
  ) {
    return null;
  }
  const stat = lstatSafe(target.path);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  try {
    const canonical = realpathSync(target.path);
    return computeDirDigest(canonical) === target.physicalDigest ? target.physicalDigest : null;
  } catch {
    return null;
  }
}

function historicalTupleKey(tuple: CodexFallbackHistoricalTuple): string {
  return `${tuple.markerVersion}\0${tuple.skillName}\0${tuple.physicalDigest}`;
}

function classifyCodexFallback(
  path: string,
  skillName: string,
  target: VerifiedCodexSkillPayload | null | undefined,
  historical: ReadonlySet<string>,
): CodexFallbackOwnership {
  const stat = lstatSafe(path);
  if (stat === null) return { skillName, path, accepted: false, reason: 'missing' };
  if (stat.isSymbolicLink()) return { skillName, path, accepted: false, reason: 'symlink' };
  if (!stat.isDirectory()) return { skillName, path, accepted: false, reason: 'not-physical-directory' };
  const parsed = strictFallbackMarker(path);
  if (parsed === null) return { skillName, path, accepted: false, reason: 'malformed-marker' };
  let physicalDigest: string;
  try {
    physicalDigest = computeDirDigest(path);
  } catch {
    return { skillName, path, accepted: false, reason: 'modified-tree' };
  }
  const common = {
    skillName,
    path,
    markerVersion: parsed.marker.version,
    physicalDigest,
    markerDigest: parsed.markerDigest,
  };
  if (physicalDigest !== parsed.marker.digest) return { ...common, accepted: false, reason: 'modified-tree' };
  const targetDigest = verifiedTargetDigest(target);
  if (targetDigest === physicalDigest && target?.skillName === skillName) {
    return { ...common, targetDigest, accepted: true, reason: 'verified-target' };
  }
  if (historical.has(historicalTupleKey({ markerVersion: parsed.marker.version, skillName, physicalDigest }))) {
    return { ...common, accepted: true, reason: 'historical-tuple' };
  }
  return {
    ...common,
    ...(targetDigest === null ? {} : { targetDigest }),
    accepted: false,
    reason: 'ambiguous-ownership',
  };
}

function retirementTransactionId(accepted: readonly CodexFallbackAcceptedIdentity[], generation = 0): string {
  const stable = accepted.map((entry) => ({
    skillName: entry.skillName,
    markerVersion: entry.markerVersion,
    physicalDigest: entry.physicalDigest,
    markerDigest: entry.markerDigest,
    targetDigest: entry.targetDigest,
  }));
  return createHash('sha256').update(JSON.stringify({ generation, stable })).digest('hex').slice(0, 32);
}

/**
 * Build a closed, deterministic ownership decision without changing disk.
 * Ambiguous names are reported under `preserved` and never enter the apply set.
 * No active install/update/setup path calls this boundary.
 */
export function planCodexFallbackRetirement(options: PlanCodexFallbackRetirementOptions): CodexFallbackRetirementPlan {
  const fallbackSkillsDir = canonicalPhysicalFallbackRoot(options.fallbackSkillsDir);
  const names = [...new Set(options.skillNames)].sort();
  if (names.length !== options.skillNames.length || names.some((name) => !isSafeEntryName(name))) {
    throw new Error('fallback retirement skill names must be unique safe path entries');
  }
  const targets = verifiedTargetByName(options.verifiedTargets ?? []);
  const tuples = historicalCodexFallbackAllowlist as CodexFallbackHistoricalTuple[];
  const historical = new Set(tuples.map(historicalTupleKey));
  const classified = names.map((skillName) =>
    classifyCodexFallback(join(fallbackSkillsDir, skillName), skillName, targets.get(skillName), historical),
  );
  const accepted = classified
    .filter((entry) => entry.accepted)
    .map(
      (entry): CodexFallbackAcceptedIdentity => ({
        skillName: entry.skillName,
        source: entry.path,
        markerVersion: entry.markerVersion as string,
        physicalDigest: entry.physicalDigest as string,
        markerDigest: entry.markerDigest as string,
        targetDigest: entry.targetDigest ?? null,
        ownership: entry.reason as CodexFallbackAcceptedIdentity['ownership'],
      }),
    );
  return {
    version: 1,
    fallbackSkillsDir,
    transactionId: retirementTransactionId(accepted),
    accepted,
    preserved: classified.filter((entry) => !entry.accepted),
  };
}

type CodexFallbackRetirementPhase =
  | 'prepared'
  | 'moving'
  | 'verifying'
  | 'restoring'
  | 'restore-conflict'
  | 'restored'
  | 'committed';

type CodexFallbackRetirementEntryPhase =
  | 'planned'
  | 'moved'
  | 'verified'
  | 'restore-observed'
  | 'restore-conflict'
  | 'preserved-live'
  | 'restored';

interface CodexFallbackRetirementEntry extends CodexFallbackAcceptedIdentity {
  destination: string;
  phase: CodexFallbackRetirementEntryPhase;
  /** Exact physical identity, including the marker, captured after retirement authority was lost. */
  observedTreeDigest?: string;
}

interface CodexFallbackRetirementJournal extends CodexFallbackRetirementPlan {
  phase: CodexFallbackRetirementPhase;
  entries: CodexFallbackRetirementEntry[];
}

const CODEX_FALLBACK_RETIREMENT_PHASES = new Set<CodexFallbackRetirementPhase>([
  'prepared',
  'moving',
  'verifying',
  'restoring',
  'restore-conflict',
  'restored',
  'committed',
]);

const CODEX_FALLBACK_RETIREMENT_ENTRY_PHASES = new Set<CodexFallbackRetirementEntryPhase>([
  'planned',
  'moved',
  'verified',
  'restore-observed',
  'restore-conflict',
  'preserved-live',
  'restored',
]);

export type CodexFallbackRetirementFailpoint =
  | 'after-journal-temp-create'
  | 'before-journal-rename'
  | 'after-journal-rename'
  | 'after-journal-durable'
  | `before-move:${number}`
  | `after-move-boundary-identification:${number}`
  | `after-move-filesystem:${number}`
  | `after-move:${number}`
  | `before-destination-verification:${number}`
  | `after-verification:${number}`
  | `before-restore:${number}`
  | `after-restore-observation:${number}`
  | `after-restore-staging-create:${number}`
  | `after-restore-copy:${number}:${number}`
  | `after-restore-verification:${number}`
  | `after-restore-sync:${number}`
  | `before-restore-publication:${number}`
  | `after-restore-filesystem:${number}`
  | `before-restore-cleanup:${number}`
  | `after-restore:${number}`
  | 'before-commit'
  | 'after-commit-journal'
  | 'after-commit-durable';

export interface ApplyCodexFallbackRetirementOptions {
  failpoint?: (point: CodexFallbackRetirementFailpoint) => void;
}

export interface CodexFallbackRetirementResult {
  transactionId: string;
  transactionDir: string;
  status: 'committed' | 'already-committed';
  retired: string[];
}

function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeDurableRetirementJournal(
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  const journalPath = join(transactionDir, 'journal.json');
  const temporary = join(transactionDir, '.journal.next');
  // A temp journal is never authoritative. The durable journal always wins.
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    failpoint?.('after-journal-temp-create');
    writeSync(fd, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  failpoint?.('before-journal-rename');
  renameSync(temporary, journalPath);
  failpoint?.('after-journal-rename');
  fsyncPath(transactionDir);
}

function canonicalPhysicalFallbackRoot(path: string): string {
  const resolved = resolve(path);
  const stat = lstatSafe(resolved);
  if (stat?.isSymbolicLink()) throw new Error(`fallback skills root must be symlink-free: ${resolved}`);
  if (stat === null || !stat.isDirectory()) {
    throw new Error(`fallback skills root must be a physical directory: ${resolved}`);
  }
  const canonical = realpathSync(resolved);
  if (canonical !== resolved) throw new Error(`fallback skills root must be symlink-free: ${resolved}`);
  return canonical;
}

function assertCanonicalPhysicalDirectory(path: string, label: string): void {
  const stat = lstatSafe(path);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${label} must be a canonical physical directory: ${path}`);
  }
}

function validateQuarantineDirectory(fallbackSkillsDir: string, transactionDir: string, create = false): string {
  const fallback = canonicalPhysicalFallbackRoot(fallbackSkillsDir);
  if (fallback !== fallbackSkillsDir) throw new Error('fallback retirement root identity changed');
  const transactionRoot = join(fallback, CODEX_FALLBACK_RETIREMENT_ROOT);
  for (const [path, label] of [
    [transactionRoot, 'fallback retirement transaction root'],
    [transactionDir, 'fallback retirement transaction'],
  ] as const) {
    assertCanonicalPhysicalDirectory(path, label);
    if (!isInside(fallback, realpathSync(path))) throw new Error(`${label} escaped fallback root: ${path}`);
  }
  const quarantine = join(transactionDir, 'quarantine');
  if (create && lstatSafe(quarantine) === null) mkdirSync(quarantine, { mode: 0o700 });
  assertCanonicalPhysicalDirectory(quarantine, 'fallback retirement quarantine');
  if (!isInside(fallback, realpathSync(quarantine))) {
    throw new Error(`fallback retirement quarantine escaped fallback root: ${quarantine}`);
  }
  return quarantine;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..';
}

function validateRetirementPaths(
  fallbackSkillsDir: string,
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
): void {
  const transactionRoot = join(fallbackSkillsDir, CODEX_FALLBACK_RETIREMENT_ROOT);
  const expectedTransaction = join(transactionRoot, `txn-${journal.transactionId}`);
  if (transactionDir !== expectedTransaction || !isInside(transactionRoot, transactionDir)) {
    throw new Error(`invalid Codex fallback retirement transaction path: ${transactionDir}`);
  }
  if (
    journal.fallbackSkillsDir !== fallbackSkillsDir ||
    retirementTransactionId(journal.accepted, journal.generation ?? 0) !== journal.transactionId
  ) {
    throw new Error(`invalid Codex fallback retirement identity: ${transactionDir}`);
  }
  if (journal.entries.length !== journal.accepted.length)
    throw new Error(`invalid Codex fallback retirement journal: ${transactionDir}`);
  for (const [index, accepted] of journal.accepted.entries()) {
    const entry = journal.entries[index];
    if (entry === undefined || !isSafeEntryName(accepted.skillName) || entry.skillName !== accepted.skillName) {
      throw new Error(`invalid Codex fallback retirement entry: ${transactionDir}`);
    }
    const source = join(fallbackSkillsDir, accepted.skillName);
    const destination = join(transactionDir, 'quarantine', accepted.skillName);
    if (
      accepted.source !== source ||
      entry.source !== source ||
      entry.destination !== destination ||
      dirname(source) !== fallbackSkillsDir ||
      !isInside(transactionDir, destination)
    ) {
      throw new Error(`unconfined Codex fallback retirement entry: ${accepted.skillName}`);
    }
  }
}

function readRetirementJournal(fallbackSkillsDir: string, transactionDir: string): CodexFallbackRetirementJournal {
  const parsed = JSON.parse(
    readFileSync(join(transactionDir, 'journal.json'), 'utf8'),
  ) as CodexFallbackRetirementJournal;
  if (
    parsed.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(parsed.transactionId) ||
    !Array.isArray(parsed.accepted) ||
    !Array.isArray(parsed.entries) ||
    parsed.accepted.length !== parsed.entries.length ||
    !CODEX_FALLBACK_RETIREMENT_PHASES.has(parsed.phase) ||
    parsed.entries.some(
      (entry) =>
        !CODEX_FALLBACK_RETIREMENT_ENTRY_PHASES.has(entry.phase) ||
        (entry.observedTreeDigest !== undefined && !isDigest(entry.observedTreeDigest)),
    )
  ) {
    throw new Error(`invalid Codex fallback retirement journal: ${transactionDir}`);
  }
  validateRetirementPaths(fallbackSkillsDir, transactionDir, parsed);
  rmSync(join(transactionDir, '.journal.next'), { force: true });
  return parsed;
}

function sameRetirementBatch(plan: CodexFallbackRetirementPlan, journal: CodexFallbackRetirementJournal): boolean {
  return (
    plan.transactionId === journal.transactionId &&
    plan.fallbackSkillsDir === journal.fallbackSkillsDir &&
    JSON.stringify(plan.accepted) === JSON.stringify(journal.accepted)
  );
}

function matchesFallbackIdentity(path: string, expected: CodexFallbackAcceptedIdentity): boolean {
  try {
    const parsed = strictFallbackMarker(path);
    return (
      parsed !== null &&
      parsed.marker.version === expected.markerVersion &&
      parsed.marker.digest === expected.physicalDigest &&
      parsed.markerDigest === expected.markerDigest &&
      computeDirDigest(path) === expected.physicalDigest
    );
  } catch {
    return false;
  }
}

function fsyncPhysicalTree(path: string): void {
  const stat = lstatSafe(path);
  if (stat === null || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) fsyncPhysicalTree(join(path, name));
  }
  fsyncPath(path);
}

function exactPhysicalDirectoryDigest(path: string): string | null {
  const stat = lstatSafe(path);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  try {
    return computeExactDirDigest(path);
  } catch {
    return null;
  }
}

interface RetirementRestorePaths {
  quarantine: string;
  source: string;
  destination: string;
  stagingRoot: string;
  staging: string;
}

function retirementRestorePaths(
  fallbackSkillsDir: string,
  transactionDir: string,
  entry: CodexFallbackRetirementEntry,
): RetirementRestorePaths {
  const quarantine = validateQuarantineDirectory(fallbackSkillsDir, transactionDir);
  const stagingRoot = join(transactionDir, '.restore-staging');
  return {
    quarantine,
    source: join(fallbackSkillsDir, entry.skillName),
    destination: join(quarantine, entry.skillName),
    stagingRoot,
    staging: join(stagingRoot, entry.skillName),
  };
}

function matchesRestoreIdentity(
  path: string,
  entry: CodexFallbackRetirementEntry,
  observedTreeDigest?: string,
): boolean {
  return observedTreeDigest === undefined
    ? matchesFallbackIdentity(path, entry)
    : exactPhysicalDirectoryDigest(path) === observedTreeDigest;
}

function writeRestoreConflict(
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  entry: CodexFallbackRetirementEntry,
  reason: string,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): never {
  entry.phase = 'restore-conflict';
  journal.phase = 'restore-conflict';
  writeDurableRetirementJournal(transactionDir, journal, failpoint);
  throw new Error(`${reason}; both trees retained with recoverable status at ${transactionDir}`);
}

function markRetirementEntryRestored(
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  entry: CodexFallbackRetirementEntry,
  phase: 'preserved-live' | 'restored',
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  journal.phase = 'restoring';
  entry.phase = phase;
  writeDurableRetirementJournal(transactionDir, journal, failpoint);
}

function cleanupRestoredRetirementDestination(
  fallbackSkillsDir: string,
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  entry: CodexFallbackRetirementEntry,
  paths: RetirementRestorePaths,
  observedTreeDigest: string | undefined,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  fsyncPhysicalTree(paths.source);
  fsyncPath(fallbackSkillsDir);
  validateQuarantineDirectory(fallbackSkillsDir, transactionDir);
  if (!matchesRestoreIdentity(paths.destination, entry, observedTreeDigest)) {
    writeRestoreConflict(
      transactionDir,
      journal,
      entry,
      'fallback retirement quarantine changed during cleanup',
      failpoint,
    );
  }
  rmSync(paths.destination, { recursive: true });
  fsyncPath(paths.quarantine);
  markRetirementEntryRestored(transactionDir, journal, entry, 'restored', failpoint);
}

function stageRetirementRestore(
  paths: RetirementRestorePaths,
  entry: CodexFallbackRetirementEntry,
  index: number,
  observedTreeDigest: string | undefined,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  if (lstatSafe(paths.stagingRoot) === null) mkdirSync(paths.stagingRoot, { mode: 0o700 });
  assertCanonicalPhysicalDirectory(paths.stagingRoot, 'fallback retirement restore staging');
  if (lstatSafe(paths.staging) !== null) rmSync(paths.staging, { recursive: true });
  mkdirSync(paths.staging, { mode: lstatSync(paths.destination).mode & 0o7777 });
  failpoint?.(`after-restore-staging-create:${index}`);
  for (const [copyIndex, name] of readdirSync(paths.destination).entries()) {
    cpSync(join(paths.destination, name), join(paths.staging, name), { recursive: true, preserveTimestamps: true });
    failpoint?.(`after-restore-copy:${index}:${copyIndex}`);
  }
  chmodSync(paths.staging, lstatSync(paths.destination).mode & 0o7777);
  if (!matchesRestoreIdentity(paths.staging, entry, observedTreeDigest)) {
    throw new Error(`fallback retirement restore staging changed: ${paths.staging}`);
  }
  failpoint?.(`after-restore-verification:${index}`);
  fsyncPhysicalTree(paths.staging);
  fsyncPath(paths.stagingRoot);
  failpoint?.(`after-restore-sync:${index}`);
}

function publishRetirementRestore(
  fallbackSkillsDir: string,
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  entry: CodexFallbackRetirementEntry,
  paths: RetirementRestorePaths,
  index: number,
  observedTreeDigest: string | undefined,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  failpoint?.(`before-restore-publication:${index}`);
  validateQuarantineDirectory(fallbackSkillsDir, transactionDir);
  if (!matchesRestoreIdentity(paths.destination, entry, observedTreeDigest)) {
    throw new Error(`fallback retirement quarantine changed before republication: ${paths.destination}`);
  }
  if (lstatSafe(paths.source) !== null) {
    writeRestoreConflict(
      transactionDir,
      journal,
      entry,
      `fallback retirement restore conflict at ${paths.source}`,
      failpoint,
    );
  }
  try {
    publishPhysicalTreeNoClobber(paths.staging, paths.source);
  } catch (error) {
    if (lstatSafe(paths.source) !== null) {
      writeRestoreConflict(
        transactionDir,
        journal,
        entry,
        `fallback retirement restore conflict at ${paths.source}`,
        failpoint,
      );
    }
    throw error;
  }
  fsyncPhysicalTree(paths.source);
  fsyncPath(fallbackSkillsDir);
  failpoint?.(`after-restore-filesystem:${index}`);
  if (!matchesRestoreIdentity(paths.source, entry, observedTreeDigest)) {
    writeRestoreConflict(
      transactionDir,
      journal,
      entry,
      `fallback retirement restore verification failed at ${paths.source}`,
      failpoint,
    );
  }
  failpoint?.(`before-restore-cleanup:${index}`);
  cleanupRestoredRetirementDestination(
    fallbackSkillsDir,
    transactionDir,
    journal,
    entry,
    paths,
    observedTreeDigest,
    failpoint,
  );
  rmSync(paths.staging, { recursive: true, force: true });
  fsyncPath(paths.stagingRoot);
  failpoint?.(`after-restore:${index}`);
}

function restoreRetirementEntry(
  fallbackSkillsDir: string,
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  entry: CodexFallbackRetirementEntry,
  index: number,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  const paths = retirementRestorePaths(fallbackSkillsDir, transactionDir, entry);
  const sourceExists = lstatSafe(paths.source) !== null;
  const destinationExists = lstatSafe(paths.destination) !== null;
  const sourceMatches = matchesFallbackIdentity(paths.source, entry);
  const destinationMatches = matchesFallbackIdentity(paths.destination, entry);
  const observed = entry.observedTreeDigest;
  const sourceObserved = observed !== undefined && matchesRestoreIdentity(paths.source, entry, observed);
  const destinationObserved = observed !== undefined && matchesRestoreIdentity(paths.destination, entry, observed);

  if ((sourceMatches && destinationMatches) || (sourceObserved && destinationObserved)) {
    cleanupRestoredRetirementDestination(
      fallbackSkillsDir,
      transactionDir,
      journal,
      entry,
      paths,
      sourceObserved ? observed : undefined,
      failpoint,
    );
    return;
  }
  if ((sourceMatches || sourceObserved) && !destinationExists) {
    markRetirementEntryRestored(transactionDir, journal, entry, 'restored', failpoint);
    return;
  }
  if (sourceExists && destinationExists) {
    writeRestoreConflict(
      transactionDir,
      journal,
      entry,
      `fallback retirement restore conflict at ${paths.source}`,
      failpoint,
    );
  }
  if (sourceExists) {
    entry.observedTreeDigest = exactPhysicalDirectoryDigest(paths.source) ?? undefined;
    markRetirementEntryRestored(transactionDir, journal, entry, 'preserved-live', failpoint);
    return;
  }
  if (!destinationExists) {
    throw new Error(`fallback retirement restore has neither live nor quarantined tree: ${paths.source}`);
  }

  let restoreDigest: string | undefined;
  if (!destinationMatches) {
    restoreDigest = exactPhysicalDirectoryDigest(paths.destination) ?? undefined;
    if (restoreDigest === undefined) {
      throw new Error(`fallback retirement quarantine is not a recoverable physical tree: ${paths.destination}`);
    }
    entry.observedTreeDigest = restoreDigest;
    entry.phase = 'restore-observed';
    journal.phase = 'restoring';
    writeDurableRetirementJournal(transactionDir, journal, failpoint);
    failpoint?.(`after-restore-observation:${index}`);
  }
  failpoint?.(`before-restore:${index}`);
  stageRetirementRestore(paths, entry, index, restoreDigest, failpoint);
  publishRetirementRestore(fallbackSkillsDir, transactionDir, journal, entry, paths, index, restoreDigest, failpoint);
}

function restoreRetirementMoves(
  fallbackSkillsDir: string,
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  journal.phase = 'restoring';
  writeDurableRetirementJournal(transactionDir, journal, failpoint);
  for (let index = journal.entries.length - 1; index >= 0; index -= 1) {
    const entry = journal.entries[index];
    if (entry === undefined) continue;
    restoreRetirementEntry(fallbackSkillsDir, transactionDir, journal, entry, index, failpoint);
  }
  journal.phase = 'restored';
  writeDurableRetirementJournal(transactionDir, journal, failpoint);
}

function prepareRetirementJournal(
  plan: CodexFallbackRetirementPlan,
  transactionRoot: string,
  transactionDir: string,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): CodexFallbackRetirementJournal {
  mkdirSync(transactionRoot, { recursive: true, mode: 0o700 });
  assertCanonicalPhysicalDirectory(transactionRoot, 'fallback retirement transaction root');
  mkdirSync(transactionDir, { mode: 0o700 });
  assertCanonicalPhysicalDirectory(transactionDir, 'fallback retirement transaction');
  const quarantine = join(transactionDir, 'quarantine');
  mkdirSync(quarantine, { mode: 0o700 });
  validateQuarantineDirectory(plan.fallbackSkillsDir, transactionDir);
  const journal: CodexFallbackRetirementJournal = {
    ...plan,
    phase: 'prepared',
    entries: plan.accepted.map((entry) => ({
      ...entry,
      destination: join(quarantine, entry.skillName),
      phase: 'planned',
    })),
  };
  validateRetirementPaths(plan.fallbackSkillsDir, transactionDir, journal);
  writeDurableRetirementJournal(transactionDir, journal, failpoint);
  fsyncPath(transactionRoot);
  fsyncPath(dirname(transactionRoot));
  return journal;
}

function loadOrPrepareRetirementJournal(
  plan: CodexFallbackRetirementPlan,
  fallbackSkillsDir: string,
  transactionRoot: string,
  transactionDir: string,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): CodexFallbackRetirementJournal {
  if (lstatSafe(transactionRoot) !== null) {
    assertCanonicalPhysicalDirectory(transactionRoot, 'fallback retirement transaction root');
  }
  if (lstatSafe(transactionDir) !== null) {
    assertCanonicalPhysicalDirectory(transactionDir, 'fallback retirement transaction');
  }
  if (lstatSafe(transactionDir) !== null && lstatSafe(join(transactionDir, 'journal.json')) === null) {
    const quarantine = join(transactionDir, 'quarantine');
    if (lstatSafe(quarantine) !== null && readdirSync(quarantine).length > 0) {
      throw new Error(`unconstrained Codex fallback retirement debris: ${transactionDir}`);
    }
    rmSync(transactionDir, { recursive: true });
    fsyncPath(transactionRoot);
  }
  return lstatSafe(transactionDir) === null
    ? prepareRetirementJournal(plan, transactionRoot, transactionDir, failpoint)
    : readRetirementJournal(fallbackSkillsDir, transactionDir);
}

function committedRetirementResult(
  plan: CodexFallbackRetirementPlan,
  journal: CodexFallbackRetirementJournal,
  transactionRoot: string,
  transactionDir: string,
  options: ApplyCodexFallbackRetirementOptions,
): CodexFallbackRetirementResult {
  const resurrected = journal.entries.filter((entry) =>
    matchesFallbackIdentity(join(plan.fallbackSkillsDir, entry.skillName), entry),
  );
  if (resurrected.length > 0) {
    let generation = (plan.generation ?? 0) + 1;
    let generationId = retirementTransactionId(resurrected, generation);
    while (lstatSafe(join(transactionRoot, `txn-${generationId}`)) !== null) {
      generation += 1;
      generationId = retirementTransactionId(resurrected, generation);
    }
    const generationPlan = {
      ...plan,
      generation,
      transactionId: generationId,
      accepted: resurrected.map(
        ({ destination: _destination, phase: _phase, observedTreeDigest: _observed, ...entry }) => entry,
      ),
    };
    return applyCodexFallbackRetirement(generationPlan, options);
  }
  return {
    transactionId: plan.transactionId,
    transactionDir,
    status: 'already-committed',
    retired: journal.accepted.map((entry) => entry.skillName),
  };
}

function validateRetirementSources(
  fallbackSkillsDir: string,
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
): void {
  for (const entry of journal.entries) {
    const quarantine = validateQuarantineDirectory(fallbackSkillsDir, transactionDir);
    const source = join(fallbackSkillsDir, entry.skillName);
    const destination = join(quarantine, entry.skillName);
    entry.phase = 'planned';
    if (!matchesFallbackIdentity(source, entry)) {
      throw new Error(`fallback retirement source changed after planning: ${source}`);
    }
    if (lstatSafe(destination) !== null) throw new Error(`fallback retirement quarantine collision: ${destination}`);
  }
}

function moveRetirementEntries(
  fallbackSkillsDir: string,
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  journal.phase = 'moving';
  writeDurableRetirementJournal(transactionDir, journal, failpoint);
  failpoint?.('after-journal-durable');
  for (const [index, entry] of journal.entries.entries()) {
    failpoint?.(`before-move:${index}`);
    const quarantine = validateQuarantineDirectory(fallbackSkillsDir, transactionDir);
    const source = join(fallbackSkillsDir, entry.skillName);
    const destination = join(quarantine, entry.skillName);
    if (!matchesFallbackIdentity(source, entry)) {
      throw new Error(`fallback retirement source changed at move boundary: ${source}`);
    }
    if (lstatSafe(destination) !== null) throw new Error(`fallback retirement quarantine collision: ${destination}`);
    failpoint?.(`after-move-boundary-identification:${index}`);
    // This narrows the mutation window; Node exposes no atomic identity-CAS rename, so verification after rename remains required.
    renameSync(source, destination);
    fsyncPath(fallbackSkillsDir);
    fsyncPath(quarantine);
    failpoint?.(`after-move-filesystem:${index}`);
    entry.phase = 'moved';
    writeDurableRetirementJournal(transactionDir, journal, failpoint);
    failpoint?.(`after-move:${index}`);
  }
}

function verifyRetirementDestinations(
  fallbackSkillsDir: string,
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  journal.phase = 'verifying';
  writeDurableRetirementJournal(transactionDir, journal, failpoint);
  for (const [index, entry] of journal.entries.entries()) {
    failpoint?.(`before-destination-verification:${index}`);
    const quarantine = validateQuarantineDirectory(fallbackSkillsDir, transactionDir);
    const source = join(fallbackSkillsDir, entry.skillName);
    const destination = join(quarantine, entry.skillName);
    if (!matchesFallbackIdentity(destination, entry) || lstatSafe(source) !== null) {
      throw new Error(`fallback retirement destination verification failed: ${destination}`);
    }
    entry.phase = 'verified';
    writeDurableRetirementJournal(transactionDir, journal, failpoint);
    failpoint?.(`after-verification:${index}`);
  }
}

function commitRetirementJournal(
  transactionRoot: string,
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  failpoint?.('before-commit');
  journal.phase = 'committed';
  writeDurableRetirementJournal(transactionDir, journal, failpoint);
  failpoint?.('after-commit-journal');
  fsyncPath(transactionRoot);
  failpoint?.('after-commit-durable');
}

/**
 * Retire one already-planned batch into a retained hidden quarantine. The
 * complete journal is durable before the first rename. Pre-commit failures
 * restore moved trees in reverse without replacing a competing live path.
 */
export function applyCodexFallbackRetirement(
  plan: CodexFallbackRetirementPlan,
  options: ApplyCodexFallbackRetirementOptions = {},
): CodexFallbackRetirementResult {
  const fallbackSkillsDir = canonicalPhysicalFallbackRoot(plan.fallbackSkillsDir);
  if (
    fallbackSkillsDir !== plan.fallbackSkillsDir ||
    retirementTransactionId(plan.accepted, plan.generation ?? 0) !== plan.transactionId
  ) {
    throw new Error('fallback retirement plan identity changed after planning');
  }
  const transactionRoot = join(fallbackSkillsDir, CODEX_FALLBACK_RETIREMENT_ROOT);
  const transactionDir = join(transactionRoot, `txn-${plan.transactionId}`);
  validateRetirementPaths(fallbackSkillsDir, transactionDir, {
    ...plan,
    phase: 'prepared',
    entries: plan.accepted.map((entry) => ({
      ...entry,
      destination: join(transactionDir, 'quarantine', entry.skillName),
      phase: 'planned',
    })),
  });
  let journal = loadOrPrepareRetirementJournal(
    plan,
    fallbackSkillsDir,
    transactionRoot,
    transactionDir,
    options.failpoint,
  );
  if (!sameRetirementBatch(plan, journal))
    throw new Error(`fallback retirement transaction identity conflict: ${transactionDir}`);
  if (journal.phase === 'committed') {
    return committedRetirementResult(plan, journal, transactionRoot, transactionDir, options);
  }
  try {
    if (journal.entries.some((entry) => lstatSafe(entry.destination) !== null)) {
      restoreRetirementMoves(fallbackSkillsDir, transactionDir, journal, options.failpoint);
      journal = readRetirementJournal(fallbackSkillsDir, transactionDir);
    }
    validateRetirementSources(fallbackSkillsDir, transactionDir, journal);
    moveRetirementEntries(fallbackSkillsDir, transactionDir, journal, options.failpoint);
    verifyRetirementDestinations(fallbackSkillsDir, transactionDir, journal, options.failpoint);
    commitRetirementJournal(transactionRoot, transactionDir, journal, options.failpoint);
    return {
      transactionId: plan.transactionId,
      transactionDir,
      status: 'committed',
      retired: journal.accepted.map((entry) => entry.skillName),
    };
  } catch (error) {
    journal = readRetirementJournal(fallbackSkillsDir, transactionDir);
    if (journal.phase !== 'committed') {
      try {
        restoreRetirementMoves(fallbackSkillsDir, transactionDir, journal, options.failpoint);
      } catch (restoreError) {
        throw new Error(`${errMsg(error)}; fallback retirement restore failed: ${errMsg(restoreError)}`);
      }
    }
    throw error;
  }
}

export interface ManagedSkillTreeRemovalOptions {
  genieHome?: string;
  agent?: string;
  renameManagedDir?: typeof renameSync;
  beforeManagedDirRemoval?: AgentSyncOptions['beforeManagedDirRemoval'];
  /**
   * Recorded uninstall-batch physical identity. When supplied, the tree is
   * removed only if its live identity still equals this exact record; otherwise
   * removal is refused so a replacement installed at the same path between plan
   * and retry is never deleted under stale path authority (F43).
   */
  expectedIdentity?: { contentDigest: string; manifestDigest: string };
}

/**
 * Recover, reclassify, park, reverify, back up, and remove one managed skill.
 * Callers receive a disposition and never perform their own recursive delete.
 */
export function removeManagedSkillTree(
  dir: string,
  options: ManagedSkillTreeRemovalOptions = {},
): 'removed' | 'unmanaged' | 'kept-modified' | 'kept-identity-mismatch' {
  const report = emptyReport(options.agent === 'codex' ? 'codex' : 'claude');
  const blocked = recoverManagedDirTransactions(dirname(dir), report);
  const name = relative(dirname(dir), dir);
  if (blocked.has('*') || blocked.has(name) || (report.failures?.length ?? 0) > 0) {
    throw new Error(report.failures?.join('; ') ?? `managed skill recovery blocked removal: ${dir}`);
  }
  const inspected = inspectManagedSkillTree(dir);
  if (inspected.state === 'unmanaged') return 'unmanaged';
  if (
    inspected.state !== 'managed-clean' ||
    inspected.contentDigest === undefined ||
    inspected.manifestDigest === undefined
  ) {
    return 'kept-modified';
  }
  // Bind removal to the batch identity BEFORE parking. A digest-clean tree whose
  // identity differs from the record is a distinct object the batch never
  // observed; refuse it as an identity mismatch rather than overloading
  // kept-modified so the caller can report the swap actionably.
  if (
    options.expectedIdentity !== undefined &&
    (inspected.contentDigest !== options.expectedIdentity.contentDigest ||
      inspected.manifestDigest !== options.expectedIdentity.manifestDigest)
  ) {
    return 'kept-identity-mismatch';
  }
  const expected = options.expectedIdentity ?? {
    contentDigest: inspected.contentDigest,
    manifestDigest: inspected.manifestDigest,
  };
  const genieHome = options.genieHome ?? resolveGenieHome();
  const ctx = createRunContext(
    genieHome,
    '',
    { pluginRoot: null, hermesRoot: null, version: null },
    {
      genieHome,
      renameManagedDir: options.renameManagedDir,
      beforeManagedDirRemoval: options.beforeManagedDirRemoval,
    },
  );
  // Thread the batch identity into removeManagedDir so its park-and-reverify
  // guards re-check the recorded identity on the quarantined object, closing the
  // window between this inspection and the physical rename.
  removeManagedDir(ctx, options.agent ?? 'uninstall', name, dir, {
    contentDigest: expected.contentDigest,
    manifestDigest: expected.manifestDigest,
  });
  return 'removed';
}

function matchesManagedDirIdentity(
  dir: string,
  contentDigest: string | null,
  manifestDigest: string | null,
  _identityVersion: 1 | typeof PHYSICAL_TREE_IDENTITY_VERSION = PHYSICAL_TREE_IDENTITY_VERSION,
): boolean {
  if (contentDigest === null || manifestDigest === null) return false;
  try {
    const identity = managedDirIdentity(dir);
    // Legacy journals occasionally carried an already-v2 digest before the
    // schema tag shipped. Exact v2 equality upgrades that authority safely.
    // A genuine content-only v1 digest cannot prove modes, entry kinds, or raw
    // link targets and therefore never authorizes a destructive recovery.
    return identity.contentDigest === contentDigest && identity.manifestDigest === manifestDigest;
  } catch {
    return false;
  }
}

function readManagedDirTransactionJournal(transactionDir: string): ManagedDirTransactionJournal {
  const parsed = JSON.parse(
    readFileSync(join(transactionDir, 'journal.json'), 'utf8'),
  ) as Partial<ManagedDirTransactionJournal>;
  if (
    ![1, 2].includes(Number(parsed.version)) ||
    typeof parsed.destName !== 'string' ||
    !isSafeEntryName(parsed.destName) ||
    typeof parsed.hadLive !== 'boolean' ||
    !isOptionalDigest(parsed.beforeContentDigest) ||
    !isOptionalDigest(parsed.beforeManifestDigest) ||
    !isDigest(parsed.stagedContentDigest) ||
    !isDigest(parsed.stagedManifestDigest) ||
    (parsed.hadLive && (parsed.beforeContentDigest === null || parsed.beforeManifestDigest === null)) ||
    (!parsed.hadLive && (parsed.beforeContentDigest !== null || parsed.beforeManifestDigest !== null)) ||
    (parsed.version === 2 && parsed.identityVersion !== PHYSICAL_TREE_IDENTITY_VERSION)
  ) {
    throw new Error(`invalid managed skill transaction: ${transactionDir}`);
  }
  return parsed as ManagedDirTransactionJournal;
}

function matchesJournalStagedDir(path: string, journal: ManagedDirTransactionJournal): boolean {
  return matchesManagedDirIdentity(
    path,
    journal.stagedContentDigest,
    journal.stagedManifestDigest,
    journal.identityVersion ?? 1,
  );
}

function matchesJournalPriorDir(path: string, journal: ManagedDirTransactionJournal): boolean {
  return matchesManagedDirIdentity(
    path,
    journal.beforeContentDigest,
    journal.beforeManifestDigest,
    journal.identityVersion ?? 1,
  );
}

function republishParkedManagedDir(published: string, destDir: string): void {
  if (lstatSafe(destDir) !== null) return;
  try {
    publishPhysicalTreeNoClobber(published, destDir);
  } catch {
    // Preserve the parked tree and any racing live tree as evidence.
  }
}

function parkManagedDirRollbackPublication(
  destDir: string,
  before: string,
  published: string,
  journal: ManagedDirTransactionJournal,
): void {
  if (lstatSafe(published) !== null) {
    if (!matchesJournalStagedDir(published, journal)) {
      throw new Error(`managed skill parked publication changed: ${published}`);
    }
    return;
  }
  if (lstatSafe(destDir) === null || (lstatSafe(before) === null && journal.hadLive)) return;
  const isStaged = matchesJournalStagedDir(destDir, journal);
  const isRestoredPrior = lstatSafe(before) !== null && matchesJournalPriorDir(destDir, journal);
  if (!isStaged && !isRestoredPrior) throw new Error(`managed skill transaction target changed: ${destDir}`);
  if (!isStaged) return;
  renameSync(destDir, published);
  if (matchesJournalStagedDir(published, journal)) return;
  republishParkedManagedDir(published, destDir);
  throw new Error(`managed skill transaction target changed while being parked: ${destDir}`);
}

function restoreManagedDirRollbackPreimage(
  destDir: string,
  before: string,
  journal: ManagedDirTransactionJournal,
): void {
  if (lstatSafe(before) !== null) {
    if (!matchesJournalPriorDir(before, journal)) throw new Error(`managed skill prior tree changed: ${before}`);
    if (lstatSafe(destDir) === null) publishPhysicalTreeNoClobber(before, destDir);
    if (!matchesJournalPriorDir(destDir, journal)) {
      throw new Error(`managed skill prior tree changed during restore: ${destDir}`);
    }
    return;
  }
  if (journal.hadLive && !matchesJournalPriorDir(destDir, journal)) {
    throw new Error(`managed skill transaction lost prior tree: ${destDir}`);
  }
  if (!journal.hadLive && lstatSafe(destDir) !== null) {
    throw new Error(`managed skill transaction restore found new live data: ${destDir}`);
  }
}

function rollbackManagedDirTransaction(
  targetParent: string,
  transactionDir: string,
  journal: ManagedDirTransactionJournal,
): void {
  try {
    const destDir = join(targetParent, journal.destName);
    const before = join(transactionDir, 'before');
    const staged = join(transactionDir, 'staged');
    const published = join(transactionDir, 'published');
    if (lstatSafe(staged) !== null && !matchesJournalStagedDir(staged, journal)) {
      throw new Error(`managed skill staged tree changed: ${staged}`);
    }
    parkManagedDirRollbackPublication(destDir, before, published, journal);
    restoreManagedDirRollbackPreimage(destDir, before, journal);
    rmSync(transactionDir, { recursive: true, force: true });
    removeEmptyDirSafe(join(targetParent, SKILL_TRANSACTION_ROOT));
  } catch (error) {
    if (lstatSafe(transactionDir) === null) throw error;
    const conflict = preserveManagedDirTransactionConflict(transactionDir);
    throw new ManagedArtifactConflictError(`${errMsg(error)}; preserved managed skill evidence at ${conflict}`);
  }
}

/** Recover every journaled managed-skill promotion before classifying ownership. */
function recoverManagedDirTransactions(targetParent: string, report: AgentReport): Set<string> {
  const blocked = new Set<string>();
  const transactionRoot = join(targetParent, SKILL_TRANSACTION_ROOT);
  const rootStat = lstatSafe(transactionRoot);
  if (rootStat === null) return blocked;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    recordFailure(report, `managed skill transaction root is not a physical directory: ${transactionRoot}`);
    blocked.add('*');
    return blocked;
  }
  for (const entry of readdirSync(transactionRoot, { withFileTypes: true })) {
    const transactionDir = join(transactionRoot, entry.name);
    if (entry.name.startsWith(SKILL_TRANSACTION_STAGING_PREFIX)) {
      quarantineTransactionDebris(transactionRoot, transactionDir);
      continue;
    }
    if (entry.name.startsWith(SKILL_REMOVAL_PREFIX)) {
      try {
        recoverManagedDirRemovalTransaction(
          targetParent,
          transactionRoot,
          transactionDir,
          entry.name.slice(SKILL_REMOVAL_PREFIX.length),
        );
      } catch (error) {
        blocked.add('*');
        recordFailure(report, `managed skill removal recovery failed: ${errMsg(error)}`);
      }
      continue;
    }
    if (!entry.name.startsWith(SKILL_TRANSACTION_PREFIX)) continue;
    let journal: ManagedDirTransactionJournal | null = null;
    try {
      journal = readManagedDirTransactionJournal(transactionDir);
      if (existsSync(join(transactionDir, 'COMMITTED'))) {
        const destDir = join(targetParent, journal.destName);
        if (!matchesManagedDirIdentity(destDir, journal.stagedContentDigest, journal.stagedManifestDigest)) {
          const conflict = preserveManagedDirTransactionConflict(transactionDir);
          throw new Error(`committed managed skill transaction is inconsistent; preserved at ${conflict}`);
        }
        rmSync(transactionDir, { recursive: true, force: true });
      } else {
        rollbackManagedDirTransaction(targetParent, transactionDir, journal);
      }
    } catch (error) {
      blocked.add(journal?.destName ?? '*');
      recordFailure(report, `managed skill recovery failed: ${errMsg(error)}`);
    }
  }
  removeEmptyDirSafe(transactionRoot);
  return blocked;
}

/**
 * Recover every journal below one skills parent before callers enumerate live
 * skill directories. This also discovers removals whose live target is absent
 * because the owned tree is parked inside the hidden transaction root.
 */
export function recoverManagedSkillTransactions(targetParent: string): void {
  const report = emptyReport('claude');
  const blocked = recoverManagedDirTransactions(targetParent, report);
  if (blocked.size > 0 || (report.failures?.length ?? 0) > 0) {
    throw new Error(report.failures?.join('; ') ?? `managed skill recovery blocked under ${targetParent}`);
  }
}

function recoverLegacyManagedDirSwap(destDir: string): void {
  const stageDir = `${destDir}${STAGING_SUFFIX}`;
  const oldDir = `${destDir}${PREV_SUFFIX}`;
  if (lstatSafe(stageDir) !== null) quarantineTransactionDebris(dirname(destDir), stageDir);
  if (lstatSafe(oldDir) !== null && lstatSafe(destDir) === null) {
    const identity = managedDirIdentity(oldDir);
    publishPhysicalTreeNoClobber(oldDir, destDir);
    if (!matchesManagedDirIdentity(destDir, identity.contentDigest, identity.manifestDigest)) {
      throw new Error(`legacy managed skill restore changed; preserved prior tree at ${oldDir}`);
    }
    rmSync(oldDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Skill enumeration + per-dir policy
// ============================================================================

/** Source skills = dirs under `<pluginRoot>/skills` that contain a SKILL.md. */
function enumerateSourceSkills(pluginRoot: string): SourceSkill[] {
  const skillsRoot = join(pluginRoot, 'skills');
  if (!existsSync(skillsRoot)) return [];
  const skills: SourceSkill[] = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    const dir = join(skillsRoot, entry.name);
    if (classifyEntry(dir, entry) !== 'dir') continue;
    if (existsSync(join(dir, 'SKILL.md'))) skills.push({ name: entry.name, dir });
  }
  return skills;
}

/**
 * Sync every source skill into `targetParent`, then remove managed orphans.
 * Each skill is guarded independently so one failure cannot sink the rest.
 */
function syncSkillDirsInto(
  ctx: RunContext,
  agent: string,
  targetParent: string,
  report: AgentReport,
  exclude?: Set<string>,
): void {
  const sourceSkills = enumerateSourceSkills(ctx.pluginRoot).filter((skill) => !exclude?.has(skill.name));
  const sourceNames = new Set(sourceSkills.map((skill) => skill.name));
  mkdirSync(targetParent, { recursive: true });
  const recoveryBlocked = recoverManagedDirTransactions(targetParent, report);
  for (const skill of sourceSkills) {
    if (recoveryBlocked.has('*') || recoveryBlocked.has(skill.name)) continue;
    try {
      report.skills.push({ name: skill.name, ...syncOneSkill(ctx, skill, targetParent) });
    } catch (err) {
      const failure = `skill ${skill.name} (${agent}) failed: ${errMsg(err)}`;
      report.advisories.push(failure);
      recordFailure(report, failure);
    }
  }
  removeManagedOrphans(ctx, agent, targetParent, sourceNames, recoveryBlocked, report);
}

/**
 * Per-dir policy:
 *   absent                                        → create
 *   managed, files match manifest, source same    → unchanged (no writes)
 *   managed, files match manifest, source differs → update
 *   managed but files edited                       → preserve + report
 *   unmanaged or corrupt-manifest same-name dir   → preserve + report
 */
function syncOneSkill(ctx: RunContext, skill: SourceSkill, targetParent: string): SkillOutcome {
  const destDir = join(targetParent, skill.name);
  recoverLegacyManagedDirSwap(destDir);
  const sourceDigest = computeDirDigest(skill.dir);
  const manifest = buildManifest(ctx, sourceDigest);
  // lstat, not existsSync: a dangling symlink is absent to existsSync but present to the
  // lstat-based identity check that guards promotion. Treating it as absent would stage a
  // create, then abort on the "changed before promotion" conflict it can never satisfy.
  const destStat = lstatSafe(destDir);
  if (destStat === null) {
    writeManagedDir(ctx, skill.dir, destDir, manifest, { contentDigest: null, manifestDigest: null });
    return { action: 'created' };
  }
  if (destStat.isSymbolicLink()) {
    return { action: 'skipped-unmanaged-kept', detail: 'same-name symlink preserved and never followed' };
  }
  const existing = readManifest(destDir);
  if (existing === null) {
    const reason = existsSync(join(destDir, MANIFEST_NAME)) ? 'corrupt or foreign manifest' : 'no ownership manifest';
    return { action: 'skipped-unmanaged-kept', detail: `${reason}; existing directory preserved` };
  }
  const currentDigest = acceptedManagedDirPhysicalDigest(destDir, existing.manifest, sourceDigest);
  if (currentDigest !== null) {
    if (
      existing.manifest.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION &&
      sourceDigest === existing.manifest.digest
    ) {
      return { action: 'unchanged' };
    }
    writeManagedDir(ctx, skill.dir, destDir, manifest, {
      contentDigest: currentDigest,
      manifestDigest: existing.fileDigest,
    });
    return { action: 'updated' };
  }
  return {
    action: 'kept-modified',
    detail: 'content differs from the recorded managed digest; existing directory preserved',
  };
}

/**
 * A managed dir whose name is no longer in source is an orphan. Unmodified →
 * back up + remove (kills zombie skills). Modified → keep + advise. Dirs without
 * a manifest are never touched — genie only removes what it provably shipped.
 */
function removeManagedOrphans(
  ctx: RunContext,
  agent: string,
  targetParent: string,
  sourceNames: Set<string>,
  recoveryBlocked: Set<string>,
  report: AgentReport,
): void {
  for (const entry of readdirSync(targetParent, { withFileTypes: true })) {
    if (
      entry.name === SKILL_TRANSACTION_ROOT ||
      entry.name.endsWith(STAGING_SUFFIX) ||
      entry.name.endsWith(PREV_SUFFIX) ||
      recoveryBlocked.has('*') ||
      recoveryBlocked.has(entry.name)
    ) {
      continue;
    }
    const dir = join(targetParent, entry.name);
    if (classifyEntry(dir, entry) !== 'dir' || sourceNames.has(entry.name)) continue;
    const manifest = readManifest(dir);
    if (manifest === null) continue;
    const contentDigest = acceptedManagedDirPhysicalDigest(dir, manifest.manifest);
    if (contentDigest !== null) {
      try {
        removeManagedDir(ctx, agent, entry.name, dir, {
          contentDigest,
          manifestDigest: manifest.fileDigest,
        });
        report.skills.push({ name: entry.name, action: 'removed' });
      } catch (error) {
        const failure = `managed orphan ${entry.name} (${agent}) removal failed: ${errMsg(error)}`;
        report.advisories.push(failure);
        recordFailure(report, failure);
      }
    } else {
      report.skills.push({ name: entry.name, action: 'kept-modified-orphan' });
      report.advisories.push(`kept modified orphan ${entry.name} (${agent})`);
    }
  }
}

// ============================================================================
// Workflow stamp (output parity-locked to council-stamp.cjs)
// ============================================================================

export type ManagedWorkflowState = 'unmanaged' | 'managed-clean' | 'managed-modified' | 'corrupt-metadata';

export interface ManagedWorkflowReport {
  targetPath: string;
  manifestPath: string;
  state: ManagedWorkflowState;
  /** Accepted physical identity captured by the ownership read. */
  targetDigest?: string;
  manifestDigest?: string;
  targetMode?: number;
  manifestMode?: number;
}

function readWorkflowManifest(path: string): {
  status: 'missing' | 'valid' | 'corrupt';
  manifest?: SyncManifest;
  fileDigest?: string;
} {
  const stat = lstatSafe(path);
  if (stat === null) return { status: 'missing' };
  if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'corrupt' };
  try {
    const content = readFileSync(path);
    const parsed = JSON.parse(content.toString('utf8')) as Partial<SyncManifest>;
    if (
      parsed.managedBy !== MANAGED_BY ||
      typeof parsed.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.digest) ||
      (parsed.version !== null && parsed.version !== undefined && typeof parsed.version !== 'string') ||
      typeof parsed.syncedAt !== 'string' ||
      (parsed.identityVersion !== undefined && parsed.identityVersion !== PHYSICAL_TREE_IDENTITY_VERSION) ||
      (parsed.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION && !isPhysicalMode(parsed.targetMode))
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
        ...(parsed.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION
          ? { identityVersion: PHYSICAL_TREE_IDENTITY_VERSION, targetMode: parsed.targetMode }
          : {}),
      },
      fileDigest: createHash('sha256').update(content).digest('hex'),
    };
  } catch {
    return { status: 'corrupt' };
  }
}

function regularFileDigest(path: string): string | null {
  const stat = lstatSafe(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  try {
    return hashFile(path);
  } catch {
    return null;
  }
}

interface PhysicalRegularFileIdentity {
  kind: 'regular';
  mode: number;
  digest: string;
}

type PhysicalFileIdentity =
  | { kind: 'absent' }
  | PhysicalRegularFileIdentity
  | { kind: 'directory'; mode: number }
  | { kind: 'symlink'; mode: number; target: string }
  | { kind: 'other'; mode: number; entry: PhysicalTreeEntry['kind'] }
  | { kind: 'unreadable'; code: string };

function physicalFileIdentity(path: string): PhysicalFileIdentity {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', code };
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    try {
      return { kind: 'symlink', mode, target: readlinkSync(path) };
    } catch (error) {
      return { kind: 'unreadable', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
    }
  }
  if (stat.isDirectory()) return { kind: 'directory', mode };
  if (!stat.isFile()) return { kind: 'other', mode, entry: physicalEntryKind(stat) };
  try {
    return { kind: 'regular', mode, digest: hashFile(path) };
  } catch (error) {
    return { kind: 'unreadable', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
  }
}

function physicalIdentityEquals(left: PhysicalFileIdentity, right: PhysicalFileIdentity): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'regular' && right.kind === 'regular') {
    return left.mode === right.mode && left.digest === right.digest;
  }
  if (left.kind === 'directory' && right.kind === 'directory') return left.mode === right.mode;
  if (left.kind === 'symlink' && right.kind === 'symlink') {
    return left.mode === right.mode && left.target === right.target;
  }
  if (left.kind === 'other' && right.kind === 'other') {
    return left.mode === right.mode && left.entry === right.entry;
  }
  if (left.kind === 'unreadable' && right.kind === 'unreadable') return left.code === right.code;
  return left.kind === 'absent' && right.kind === 'absent';
}

function expectedPhysicalFile(digest: string | null, mode: number | null): PhysicalFileIdentity {
  return digest === null || mode === null ? { kind: 'absent' } : { kind: 'regular', mode, digest };
}

/** Classify council.js using only its sidecar ownership grant and recorded digest. */
export function inspectManagedWorkflow(targetDir: string): ManagedWorkflowReport {
  const targetPath = join(targetDir, TARGET_NAME);
  const manifestPath = join(targetDir, WORKFLOW_MANIFEST_NAME);
  const ownership = readWorkflowManifest(manifestPath);
  if (ownership.status === 'missing') return { targetPath, manifestPath, state: 'unmanaged' };
  if (ownership.status === 'corrupt') return { targetPath, manifestPath, state: 'corrupt-metadata' };
  const targetIdentity = physicalFileIdentity(targetPath);
  const manifestIdentity = physicalFileIdentity(manifestPath);
  const expectedTargetMode =
    ownership.manifest?.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION
      ? ownership.manifest.targetMode
      : WORKFLOW_FILE_MODE;
  const clean =
    targetIdentity.kind === 'regular' &&
    targetIdentity.digest === ownership.manifest?.digest &&
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
 * Stamp the /council template's LENS_ROOT placeholder with `pluginRoot` and
 * write `<targetDir>/council.js` plus a digest ownership sidecar. Output remains
 * byte-identical to plugins/genie/scripts/council-stamp.cjs, but ownership is
 * granted only by valid metadata: unmanaged, modified, or corrupt targets are
 * preserved byte-identically and never adopted by content/signature.
 */
export function stampWorkflow(opts: {
  templatePath: string;
  pluginRoot: string;
  targetDir: string;
  version?: string | null;
  now?: () => Date;
  /** Test seam invoked before the final workflow CAS check. */
  beforePromotion?: () => void;
  /** Failure-injection seam after authorization but before physical parking. */
  afterAuthorization?: () => void;
  /** Failure-injection seam after parking and immediately before exclusive publication. */
  beforePublish?: () => void;
}): {
  action: 'written' | 'skipped' | 'kept-unmanaged' | 'kept-modified' | 'metadata-corrupt';
  targetPath: string;
} {
  const { templatePath, pluginRoot, targetDir } = opts;
  const template = readFileSync(templatePath, 'utf8');
  const stamped = stampWorkflowTemplate(template, pluginRoot);
  recoverManagedWorkflowTransactions(targetDir);
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
  if (ownership.state === 'managed-clean' && readFileSync(ownership.targetPath, 'utf8') === stamped) {
    return { action: 'skipped', targetPath: ownership.targetPath };
  }
  const manifest: SyncManifest = {
    managedBy: MANAGED_BY,
    version: opts.version ?? null,
    digest: createHash('sha256').update(stamped).digest('hex'),
    syncedAt: (opts.now ?? (() => new Date()))().toISOString(),
    identityVersion: PHYSICAL_TREE_IDENTITY_VERSION,
    targetMode: WORKFLOW_FILE_MODE,
  };
  const expected =
    ownership.state === 'managed-clean'
      ? {
          targetDigest: ownership.targetDigest ?? null,
          manifestDigest: ownership.manifestDigest ?? null,
          targetMode: ownership.targetMode ?? null,
          manifestMode: ownership.manifestMode ?? null,
        }
      : { targetDigest: null, manifestDigest: null, targetMode: null, manifestMode: null };
  if (
    (ownership.state === 'managed-clean' &&
      (expected.targetDigest === null ||
        expected.manifestDigest === null ||
        expected.targetMode === null ||
        expected.manifestMode === null)) ||
    (ownership.state === 'unmanaged' && targetExists)
  ) {
    return { action: 'kept-modified', targetPath: ownership.targetPath };
  }
  publishWorkflowTransaction(
    targetDir,
    stamped,
    manifest,
    expected,
    opts.beforePromotion,
    opts.afterAuthorization,
    opts.beforePublish,
  );
  return { action: 'written', targetPath: ownership.targetPath };
}

const WORKFLOW_TRANSACTION_PREFIX = '.council.genie-txn-';
const WORKFLOW_TRANSACTION_STAGING_PREFIX = '.council.genie-txn-staging-';
const WORKFLOW_REMOVAL_PREFIX = '.council.genie-delete-';
const WORKFLOW_REMOVAL_CONFLICT_PREFIX = '.council.genie-delete-conflict-';

interface WorkflowRemovalJournal {
  version: 1 | 2;
  targetDigest: string;
  manifestDigest: string;
  identityVersion?: typeof PHYSICAL_TREE_IDENTITY_VERSION;
  targetMode?: number;
  manifestMode?: number;
}

interface WorkflowTransactionJournal {
  targetDigest: string;
  manifestDigest: string;
  hadTarget: boolean;
  hadManifest: boolean;
  beforeTargetDigest: string | null;
  beforeManifestDigest: string | null;
  identityVersion?: typeof PHYSICAL_TREE_IDENTITY_VERSION;
  targetMode?: number;
  manifestMode?: number;
  beforeTargetMode?: number | null;
  beforeManifestMode?: number | null;
}

function stampWorkflowTemplate(template: string, pluginRoot: string): string {
  const quotedPlaceholder = `'${PLACEHOLDER}'`;
  if (!template.includes(quotedPlaceholder)) {
    throw new Error(`council workflow template is missing quoted placeholder ${quotedPlaceholder}`);
  }
  return template.split(quotedPlaceholder).join(JSON.stringify(pluginRoot));
}

function publishWorkflowTransaction(
  targetDir: string,
  stamped: string,
  manifest: SyncManifest,
  expected: {
    targetDigest: string | null;
    manifestDigest: string | null;
    targetMode: number | null;
    manifestMode: number | null;
  },
  beforePromotion?: () => void,
  afterAuthorization?: () => void,
  beforePublish?: () => void,
): void {
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, TARGET_NAME);
  const manifestPath = join(targetDir, WORKFLOW_MANIFEST_NAME);
  const targetDigest = createHash('sha256').update(stamped).digest('hex');
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestDigest = createHash('sha256').update(manifestContent).digest('hex');
  const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const working = createExclusiveTransactionDir(targetDir, `${WORKFLOW_TRANSACTION_STAGING_PREFIX}${token}`);
  const transactionDir = join(targetDir, `${WORKFLOW_TRANSACTION_PREFIX}${token}`);
  const staged = join(working, 'staged');
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, TARGET_NAME), stamped, 'utf8');
  writeFileSync(join(staged, WORKFLOW_MANIFEST_NAME), manifestContent, 'utf8');
  chmodSync(join(staged, TARGET_NAME), WORKFLOW_FILE_MODE);
  chmodSync(join(staged, WORKFLOW_MANIFEST_NAME), WORKFLOW_FILE_MODE);
  const stagedTarget = physicalFileIdentity(join(staged, TARGET_NAME));
  const stagedManifest = physicalFileIdentity(join(staged, WORKFLOW_MANIFEST_NAME));
  if (stagedTarget.kind !== 'regular' || stagedManifest.kind !== 'regular') {
    throw new Error('council workflow staging did not produce physical regular files');
  }
  writeFileSync(
    join(working, 'journal.json'),
    `${JSON.stringify({
      version: 2,
      targetDigest,
      manifestDigest,
      hadTarget: expected.targetDigest !== null,
      hadManifest: expected.manifestDigest !== null,
      beforeTargetDigest: expected.targetDigest,
      beforeManifestDigest: expected.manifestDigest,
      identityVersion: PHYSICAL_TREE_IDENTITY_VERSION,
      targetMode: stagedTarget.mode,
      manifestMode: stagedManifest.mode,
      beforeTargetMode: expected.targetMode,
      beforeManifestMode: expected.manifestMode,
    })}\n`,
    'utf8',
  );
  renameSync(working, transactionDir);
  const before = join(transactionDir, 'before');
  const publishedStaged = join(transactionDir, 'staged');
  mkdirSync(before, { recursive: true });
  try {
    beforePromotion?.();
    const expectedTarget = expectedPhysicalFile(expected.targetDigest, expected.targetMode);
    const expectedManifest = expectedPhysicalFile(expected.manifestDigest, expected.manifestMode);
    if (
      !physicalIdentityEquals(physicalFileIdentity(targetPath), expectedTarget) ||
      !physicalIdentityEquals(physicalFileIdentity(manifestPath), expectedManifest)
    ) {
      const conflict = preserveWorkflowConflict(transactionDir);
      throw new ManagedArtifactConflictError(
        `council workflow changed before promotion; kept live and incoming versions for review at ${conflict}`,
      );
    }
    afterAuthorization?.();
    if (expected.targetDigest !== null) renameSync(targetPath, join(before, TARGET_NAME));
    if (expected.manifestDigest !== null) renameSync(manifestPath, join(before, WORKFLOW_MANIFEST_NAME));
    if (
      !physicalIdentityEquals(physicalFileIdentity(join(before, TARGET_NAME)), expectedTarget) ||
      !physicalIdentityEquals(physicalFileIdentity(join(before, WORKFLOW_MANIFEST_NAME)), expectedManifest) ||
      physicalFileIdentity(targetPath).kind !== 'absent' ||
      physicalFileIdentity(manifestPath).kind !== 'absent'
    ) {
      restoreWorkflowPreimagesNoClobber(targetDir, transactionDir);
      const conflict = preserveWorkflowConflict(transactionDir);
      throw new ManagedArtifactConflictError(
        `council workflow changed during promotion; kept both versions for review at ${conflict}`,
      );
    }
    beforePublish?.();
    try {
      publishRegularFileNoClobber(join(publishedStaged, TARGET_NAME), targetPath);
      publishRegularFileNoClobber(join(publishedStaged, WORKFLOW_MANIFEST_NAME), manifestPath);
    } catch (error) {
      if (error instanceof NoClobberPublishError) {
        const conflict = preserveWorkflowConflict(transactionDir);
        throw new ManagedArtifactConflictError(
          `${error.message}; kept live, prior, and incoming workflow versions for review at ${conflict}`,
        );
      }
      throw error;
    }
    if (
      !physicalIdentityEquals(physicalFileIdentity(targetPath), stagedTarget) ||
      !physicalIdentityEquals(physicalFileIdentity(manifestPath), stagedManifest)
    ) {
      throw new Error('council workflow changed before transaction commit');
    }
    writeFileSync(join(transactionDir, 'COMMITTED'), 'ok\n');
    rmSync(transactionDir, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof ManagedArtifactConflictError) throw error;
    try {
      rollbackWorkflowTransaction(targetDir, transactionDir);
    } catch (rollbackError) {
      throw new Error(`${errMsg(error)}; council workflow rollback failed: ${errMsg(rollbackError)}`);
    }
    throw error;
  }
}

function preserveWorkflowConflict(transactionDir: string): string {
  const conflict = transactionDir.replace(WORKFLOW_TRANSACTION_PREFIX, '.council.genie-conflict-');
  renameSync(transactionDir, conflict);
  return conflict;
}

/** Recover published council transactions. Pure callers should use inspectManagedWorkflow instead. */
export function recoverManagedWorkflowTransactions(targetDir: string): void {
  if (!existsSync(targetDir)) return;
  for (const name of readdirSync(targetDir)) {
    if (name.startsWith(WORKFLOW_TRANSACTION_STAGING_PREFIX)) {
      quarantineTransactionDebris(targetDir, join(targetDir, name));
      continue;
    }
    if (name.startsWith(WORKFLOW_REMOVAL_PREFIX)) {
      recoverWorkflowRemovalTransaction(targetDir, join(targetDir, name));
      continue;
    }
    if (!name.startsWith(WORKFLOW_TRANSACTION_PREFIX)) continue;
    const transactionDir = join(targetDir, name);
    const journal = readWorkflowTransactionJournal(transactionDir);
    if (existsSync(join(transactionDir, 'COMMITTED'))) {
      const targetIdentity = journaledWorkflowIdentity(
        transactionDir,
        TARGET_NAME,
        journal.targetDigest,
        journal.targetMode,
        join(transactionDir, 'staged', TARGET_NAME),
      );
      const manifestIdentity = journaledWorkflowIdentity(
        transactionDir,
        WORKFLOW_MANIFEST_NAME,
        journal.manifestDigest,
        journal.manifestMode,
        join(transactionDir, 'staged', WORKFLOW_MANIFEST_NAME),
      );
      if (
        !physicalIdentityEquals(physicalFileIdentity(join(targetDir, TARGET_NAME)), targetIdentity) ||
        !physicalIdentityEquals(physicalFileIdentity(join(targetDir, WORKFLOW_MANIFEST_NAME)), manifestIdentity)
      ) {
        const conflict = preserveWorkflowConflict(transactionDir);
        throw new Error(`committed council workflow transaction is inconsistent; preserved at ${conflict}`);
      }
      rmSync(transactionDir, { recursive: true, force: true });
    } else {
      rollbackWorkflowTransaction(targetDir, transactionDir);
    }
  }
}

function readWorkflowRemovalJournal(transactionDir: string): WorkflowRemovalJournal {
  const parsed = JSON.parse(
    readFileSync(join(transactionDir, 'journal.json'), 'utf8'),
  ) as Partial<WorkflowRemovalJournal>;
  if (
    ![1, 2].includes(Number(parsed.version)) ||
    !isDigest(parsed.targetDigest) ||
    !isDigest(parsed.manifestDigest) ||
    (parsed.version === 2 &&
      (parsed.identityVersion !== PHYSICAL_TREE_IDENTITY_VERSION ||
        !isPhysicalMode(parsed.targetMode) ||
        !isPhysicalMode(parsed.manifestMode)))
  ) {
    throw new Error(`invalid council workflow removal transaction: ${transactionDir}`);
  }
  return parsed as WorkflowRemovalJournal;
}

function preserveWorkflowRemovalConflict(transactionDir: string): string {
  const conflict = transactionDir.replace(WORKFLOW_REMOVAL_PREFIX, WORKFLOW_REMOVAL_CONFLICT_PREFIX);
  renameSync(transactionDir, conflict);
  return conflict;
}

function publishWorkflowPreimagesNoClobber(targetDir: string, sourceDir: string): boolean {
  let complete = true;
  for (const name of [TARGET_NAME, WORKFLOW_MANIFEST_NAME]) {
    const parked = join(sourceDir, name);
    const target = join(targetDir, name);
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

function restoreWorkflowPreimagesNoClobber(targetDir: string, transactionDir: string): boolean {
  return publishWorkflowPreimagesNoClobber(targetDir, join(transactionDir, 'before'));
}

function restoreWorkflowRemovalPreimages(targetDir: string, transactionDir: string): boolean {
  return publishWorkflowPreimagesNoClobber(targetDir, join(transactionDir, 'parked'));
}

function recoverWorkflowRemovalTransaction(targetDir: string, transactionDir: string): void {
  const journal = readWorkflowRemovalJournal(transactionDir);
  const parkedTarget = join(transactionDir, 'parked', TARGET_NAME);
  const parkedManifest = join(transactionDir, 'parked', WORKFLOW_MANIFEST_NAME);
  if (
    journal.identityVersion !== PHYSICAL_TREE_IDENTITY_VERSION ||
    !isPhysicalMode(journal.targetMode) ||
    !isPhysicalMode(journal.manifestMode)
  ) {
    const conflict = preserveWorkflowRemovalConflict(transactionDir);
    throw new Error(`legacy council removal lacks physical identity authority; preserved for review at ${conflict}`);
  }
  const expectedTarget = { kind: 'regular', mode: journal.targetMode, digest: journal.targetDigest } as const;
  const expectedManifest = {
    kind: 'regular',
    mode: journal.manifestMode,
    digest: journal.manifestDigest,
  } as const;
  if (existsSync(join(transactionDir, 'COMMITTED'))) {
    if (
      !physicalIdentityEquals(physicalFileIdentity(parkedTarget), expectedTarget) ||
      !physicalIdentityEquals(physicalFileIdentity(parkedManifest), expectedManifest)
    ) {
      const conflict = preserveWorkflowRemovalConflict(transactionDir);
      throw new Error(`committed council removal quarantine changed; preserved for review at ${conflict}`);
    }
    rmSync(transactionDir, { recursive: true, force: true });
    return;
  }
  for (const [name, expected] of [
    [TARGET_NAME, expectedTarget],
    [WORKFLOW_MANIFEST_NAME, expectedManifest],
  ] as const) {
    const parked = physicalFileIdentity(join(transactionDir, 'parked', name));
    const live = physicalFileIdentity(join(targetDir, name));
    if (
      !physicalIdentityEquals(parked, expected) &&
      !(parked.kind === 'absent' && physicalIdentityEquals(live, expected))
    ) {
      const conflict = preserveWorkflowRemovalConflict(transactionDir);
      throw new Error(`council removal quarantine changed; preserved for review at ${conflict}`);
    }
  }
  if (!restoreWorkflowRemovalPreimages(targetDir, transactionDir)) {
    const conflict = preserveWorkflowRemovalConflict(transactionDir);
    throw new Error(`council removal recovery found new live data; preserved prior bytes at ${conflict}`);
  }
  rmSync(transactionDir, { recursive: true, force: true });
}

export interface ManagedWorkflowRemovalOptions {
  /** Failure-injection seam immediately before parking or final deletion. */
  beforeRemoval?: (stage: 'before-park' | 'before-delete') => void;
  /**
   * Recorded uninstall-batch identity of the council target plus its sidecar.
   * When supplied, removal proceeds only if the live pair still matches it, so a
   * replacement council stamped at the same path after the batch is preserved.
   */
  expectedIdentity?: {
    targetDigest: string;
    manifestDigest: string;
    targetMode: number;
    manifestMode: number;
  };
}

/** Journaled council removal shared by uninstall and workflow maintenance. */
export function removeManagedWorkflow(
  targetDir: string,
  options: ManagedWorkflowRemovalOptions = {},
): 'removed' | 'unmanaged' | 'kept-modified' | 'kept-identity-mismatch' {
  recoverManagedWorkflowTransactions(targetDir);
  const inspected = inspectManagedWorkflow(targetDir);
  if (inspected.state === 'unmanaged') return 'unmanaged';
  if (
    inspected.state !== 'managed-clean' ||
    inspected.targetDigest === undefined ||
    inspected.manifestDigest === undefined ||
    inspected.targetMode === undefined ||
    inspected.manifestMode === undefined
  ) {
    return 'kept-modified';
  }
  // Refuse a council/sidecar pair whose live identity diverged from the batch
  // record (a re-stamped or swapped workflow). The park guards below then run
  // against this same matched identity, so no live edit slips through.
  if (
    options.expectedIdentity !== undefined &&
    (inspected.targetDigest !== options.expectedIdentity.targetDigest ||
      inspected.manifestDigest !== options.expectedIdentity.manifestDigest ||
      inspected.targetMode !== options.expectedIdentity.targetMode ||
      inspected.manifestMode !== options.expectedIdentity.manifestMode)
  ) {
    return 'kept-identity-mismatch';
  }
  const expectedTarget = {
    kind: 'regular',
    mode: inspected.targetMode,
    digest: inspected.targetDigest,
  } as const;
  const expectedManifest = {
    kind: 'regular',
    mode: inspected.manifestMode,
    digest: inspected.manifestDigest,
  } as const;
  const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const working = createExclusiveTransactionDir(targetDir, `${WORKFLOW_TRANSACTION_STAGING_PREFIX}delete-${token}`);
  const transactionDir = join(targetDir, `${WORKFLOW_REMOVAL_PREFIX}${token}`);
  writeFileSync(
    join(working, 'journal.json'),
    `${JSON.stringify({
      version: 2,
      targetDigest: inspected.targetDigest,
      manifestDigest: inspected.manifestDigest,
      identityVersion: PHYSICAL_TREE_IDENTITY_VERSION,
      targetMode: inspected.targetMode,
      manifestMode: inspected.manifestMode,
    } satisfies WorkflowRemovalJournal)}\n`,
  );
  mkdirSync(join(working, 'parked'));
  renameSync(working, transactionDir);
  const parkedTarget = join(transactionDir, 'parked', TARGET_NAME);
  const parkedManifest = join(transactionDir, 'parked', WORKFLOW_MANIFEST_NAME);
  const targetPath = join(targetDir, TARGET_NAME);
  const manifestPath = join(targetDir, WORKFLOW_MANIFEST_NAME);
  try {
    options.beforeRemoval?.('before-park');
    if (
      !physicalIdentityEquals(physicalFileIdentity(targetPath), expectedTarget) ||
      !physicalIdentityEquals(physicalFileIdentity(manifestPath), expectedManifest)
    ) {
      const conflict = preserveWorkflowRemovalConflict(transactionDir);
      throw new ManagedArtifactConflictError(
        `council workflow changed before removal; preserved transaction at ${conflict}`,
      );
    }
    renameSync(targetPath, parkedTarget);
    renameSync(manifestPath, parkedManifest);
    if (
      !physicalIdentityEquals(physicalFileIdentity(parkedTarget), expectedTarget) ||
      !physicalIdentityEquals(physicalFileIdentity(parkedManifest), expectedManifest) ||
      physicalFileIdentity(targetPath).kind !== 'absent' ||
      physicalFileIdentity(manifestPath).kind !== 'absent'
    ) {
      restoreWorkflowRemovalPreimages(targetDir, transactionDir);
      const conflict = preserveWorkflowRemovalConflict(transactionDir);
      throw new ManagedArtifactConflictError(
        `council workflow changed while being parked; preserved live and prior bytes at ${conflict}`,
      );
    }
    options.beforeRemoval?.('before-delete');
    if (
      !physicalIdentityEquals(physicalFileIdentity(parkedTarget), expectedTarget) ||
      !physicalIdentityEquals(physicalFileIdentity(parkedManifest), expectedManifest)
    ) {
      const conflict = preserveWorkflowRemovalConflict(transactionDir);
      throw new ManagedArtifactConflictError(
        `council workflow changed after parking; preserved exact objects at ${conflict}`,
      );
    }
    writeFileSync(join(transactionDir, 'COMMITTED'), 'ok\n');
    rmSync(transactionDir, { recursive: true, force: true });
    return 'removed';
  } catch (error) {
    if (error instanceof ManagedArtifactConflictError) throw error;
    try {
      if (existsSync(transactionDir)) recoverWorkflowRemovalTransaction(targetDir, transactionDir);
    } catch (rollbackError) {
      throw new Error(`${errMsg(error)}; council removal rollback failed: ${errMsg(rollbackError)}`);
    }
    throw error;
  }
}

function readWorkflowTransactionJournal(transactionDir: string): WorkflowTransactionJournal {
  const parsed = JSON.parse(readFileSync(join(transactionDir, 'journal.json'), 'utf8')) as Record<string, unknown>;
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
    (parsed.identityVersion !== undefined && parsed.identityVersion !== PHYSICAL_TREE_IDENTITY_VERSION) ||
    (parsed.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION &&
      (!isPhysicalMode(parsed.targetMode) ||
        !isPhysicalMode(parsed.manifestMode) ||
        !isOptionalPhysicalMode(parsed.beforeTargetMode) ||
        !isOptionalPhysicalMode(parsed.beforeManifestMode) ||
        parsed.hadTarget !== (parsed.beforeTargetMode !== null) ||
        parsed.hadManifest !== (parsed.beforeManifestMode !== null)))
  ) {
    throw new Error(`invalid council workflow transaction: ${transactionDir}`);
  }
  return parsed as unknown as WorkflowTransactionJournal;
}

function journaledWorkflowIdentity(
  transactionDir: string,
  name: string,
  digest: string,
  mode: number | null | undefined,
  evidencePath: string,
  referenceMode?: number,
): PhysicalRegularFileIdentity {
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

function parkWorkflowRollbackTarget(
  transactionDir: string,
  name: string,
  target: string,
  expected: PhysicalRegularFileIdentity,
): void {
  const current = physicalFileIdentity(target);
  if (current.kind === 'absent') return;
  if (!physicalIdentityEquals(current, expected)) {
    throw new Error(`council transaction target changed: ${target}`);
  }
  const publishedDir = join(transactionDir, 'published');
  mkdirSync(publishedDir, { recursive: true });
  const parked = join(publishedDir, name);
  renameSync(target, parked);
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

function rollbackWorkflowTransaction(targetDir: string, transactionDir: string): void {
  try {
    const journal = readWorkflowTransactionJournal(transactionDir);
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
    ] as const;
    const resolved = entries.map(([name, digest, mode, had, beforeDigest, beforeMode]) => {
      const target = join(targetDir, name);
      const before = join(transactionDir, 'before', name);
      const staged = journaledWorkflowIdentity(
        transactionDir,
        name,
        digest,
        mode,
        join(transactionDir, 'staged', name),
      );
      let prior: PhysicalRegularFileIdentity | null = null;
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
      const expected: PhysicalFileIdentity = entry.prior ?? { kind: 'absent' };
      if (!physicalIdentityEquals(physicalFileIdentity(entry.target), expected)) {
        throw new Error(`council transaction restore changed before cleanup: ${entry.target}`);
      }
    }
    rmSync(transactionDir, { recursive: true, force: true });
  } catch (error) {
    if (lstatSafe(transactionDir) === null) throw error;
    const conflict = preserveWorkflowConflict(transactionDir);
    throw new ManagedArtifactConflictError(`${errMsg(error)}; preserved workflow evidence at ${conflict}`);
  }
}

// ============================================================================
// Adapters
// ============================================================================

function syncClaude(ctx: RunContext, report: AgentReport): void {
  const claudeDir = ctx.targets.claude;
  if (!existsSync(claudeDir)) return;
  report.detected = true;
  syncSkillDirsInto(ctx, 'claude', join(claudeDir, 'skills'), report, CLAUDE_EXCLUDED_SKILLS);
  stampClaudeWorkflow(ctx, claudeDir, report);
}

function stampClaudeWorkflow(ctx: RunContext, claudeDir: string, report: AgentReport): void {
  const templatePath = join(ctx.pluginRoot, 'workflows', TARGET_NAME);
  if (!existsSync(templatePath)) {
    report.extras.push({ kind: 'stamp', action: 'unavailable', detail: `${templatePath} missing` });
    return;
  }
  const res = stampWorkflow({
    templatePath,
    pluginRoot: ctx.pluginRoot,
    targetDir: join(claudeDir, 'workflows'),
    version: ctx.version,
    now: ctx.now,
  });
  report.extras.push({ kind: 'stamp', action: res.action, detail: res.targetPath });
}

function syncCodex(ctx: RunContext, report: AgentReport): void {
  const codexDir = ctx.targets.codex;
  if (!existsSync(codexDir)) return;
  report.detected = true;
  migrateLegacyCodexCurated(ctx, codexDir, report);
  // Codex loads user skills from the top-level `~/.agents/skills/<name>` tier.
  // Everything under `<codexDir>/skills/` (incl. OpenAI's `.system/`) is left
  // alone: hidden dirs are pruned by codex and were never genie's to manage.
  syncSkillDirsInto(ctx, 'codex', ctx.targets.agentsSkills, report);
  if (report.skills.some((skill) => WRITE_ACTIONS.has(skill.action))) {
    report.advisories.push('restart Codex to pick up updated skills');
  }
}

/**
 * One-time cleanup of the retired `<codexDir>/skills/.curated` lane (see
 * {@link codexLegacyCuratedDir}): every manifest-managed dir there is a
 * stranded orphan codex never loaded. Digest-clean managed dirs are backed up
 * outside GENIE_HOME and removed. Modified or unmanaged entries are preserved
 * in place; a migration must never trade live user data for a backup that a
 * later uninstall deletes. The lane dir itself goes only once it is empty.
 * Genie's own crashed-run staging debris is swept unbacked.
 */
function migrateLegacyCodexCurated(ctx: RunContext, codexDir: string, report: AgentReport): void {
  const legacyDir = codexLegacyCuratedDir(codexDir);
  if (!existsSync(legacyDir)) return;
  let kept = 0;
  for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
    const dir = join(legacyDir, entry.name);
    if (entry.name.endsWith(STAGING_SUFFIX) || entry.name.endsWith(PREV_SUFFIX)) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (classifyEntry(dir, entry) !== 'dir') {
      kept += 1;
      continue;
    }
    const manifest = readManifest(dir);
    if (manifest === null) {
      kept += 1;
      continue;
    }
    const contentDigest = acceptedManagedDirPhysicalDigest(dir, manifest.manifest);
    if (contentDigest === null) {
      kept += 1;
      report.extras.push({ kind: 'legacy-curated', action: 'kept-modified', detail: dir });
      report.advisories.push(`kept modified legacy codex skill ${entry.name} at ${dir}`);
      continue;
    }
    try {
      removeManagedDir(ctx, 'codex-legacy-curated', entry.name, dir, {
        contentDigest,
        manifestDigest: manifest.fileDigest,
      });
      report.extras.push({ kind: 'legacy-curated', action: 'removed', detail: dir });
    } catch (error) {
      kept += 1;
      const failure = `legacy codex skill ${entry.name} removal failed: ${errMsg(error)}`;
      report.extras.push({ kind: 'legacy-curated', action: 'kept-modified', detail: dir });
      report.advisories.push(failure);
      recordFailure(report, failure);
    }
  }
  if (kept === 0) {
    rmSync(legacyDir, { recursive: true, force: true });
  } else {
    report.advisories.push(`legacy codex lane ${legacyDir} contains unmanaged entries; left in place`);
  }
}

type LinkAction = 'created' | 'unchanged' | 'adopted' | 'skipped-unmanaged-kept';

function syncHermes(ctx: RunContext, opts: AgentSyncOptions, report: AgentReport): void {
  const hermesHome = ctx.targets.hermes;
  const binary = detectHermesBinary(opts);
  if (!existsSync(hermesHome) && binary === null) return;
  report.detected = true;
  if (ctx.hermesRoot === null) {
    report.advisories.push('hermes source (hermes-genie) not found next to plugins/genie; skipping link');
    return;
  }
  const hermesRoot = ctx.hermesRoot;
  const mainAction = ensureHermesLink(ctx, join(hermesHome, 'plugins', 'genie'), hermesRoot, 'plugins-genie', report);
  ensureStickyProfileLink(ctx, hermesHome, hermesRoot, report);
  // A freshly linked main plugin — created OR adopted from a real dir — is newly
  // enabled; fire enable exactly once. Never gated on the sticky-profile link.
  if ((mainAction === 'created' || mainAction === 'adopted') && binary !== null) {
    runHermesEnable(opts, binary, report);
  }
  // AFTER the plugin link/enable converge, wire the two config legs (MCP server +
  // skills external dir) into the live profile's config.yaml. Each leg is
  // independently non-fatal: an inline-shaped operator config degrades to a WARN
  // skip and any helper error records `failed`, but neither ever throws, sets
  // report.failures, or blocks the other leg — the plugin link has already won.
  convergeHermesConfig(ctx, hermesHome, report);
}

/**
 * Resolve the Hermes `config.yaml` for the live profile the plugin-link lane
 * targets: the active sticky profile's home when a safe `active_profile` is set,
 * else the default Hermes home. Mirrors {@link ensureStickyProfileLink}'s
 * validation so a config write lands in the same home whose plugins/genie link is
 * converged. An unsafe/invalid profile falls back to the default home (never an
 * escaped path); the link lane already surfaces the invalid-profile failure.
 */
export function resolveHermesConfigPath(hermesHome: string): string {
  return join(resolveHermesProfileHome(hermesHome), 'config.yaml');
}

function resolveHermesProfileHome(hermesHome: string): string {
  const active = readTrimmed(join(hermesHome, 'active_profile'));
  if (active === null || active === '') return hermesHome;
  // Same guard the sticky-link lane enforces — an invalid/unsafe profile name
  // must never redirect a write outside the profiles root.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(active) || active === '.' || active === '..') return hermesHome;
  const profilesRoot = resolve(hermesHome, 'profiles');
  const profileRoot = resolve(profilesRoot, active);
  if (!profileRoot.startsWith(`${profilesRoot}${sep}`)) return hermesHome;
  return profileRoot;
}

/**
 * Converge the MCP-server and skills-external-dir legs into the one live-profile
 * config.yaml. Both legs back up the same file before mutating it, so each is
 * handed a distinct backup timestamp (skills offset +1s) — otherwise two
 * same-run mutations would write the same `config.yaml.genie-backup-<stamp>`
 * name and the skills leg would clobber the MCP leg's pristine backup.
 */
function convergeHermesConfig(ctx: RunContext, hermesHome: string, report: AgentReport): void {
  const configPath = resolveHermesConfigPath(hermesHome);
  const base = ctx.now().getTime();
  convergeHermesLeg(
    'mcp-config',
    report,
    () => mergeMcpServersGenie({ configPath, genieHome: ctx.genieHome, now: new Date(base) }).status,
  );
  convergeHermesLeg(
    'skills-dir',
    report,
    () => mergeSkillsExternalDir({ configPath, genieHome: ctx.genieHome, now: new Date(base + 1000) }).status,
  );
}

/**
 * Run one Hermes config leg and record its outcome as a report extra, never
 * throwing. A {@link HermesConfigError} carrying `code === 'inline-top-level-key'`
 * is the operator's inline/flow-style top-level key: a NON-FATAL convergence
 * outcome recorded as a `skipped` WARN with the helper's remediation hint
 * ("rewrite … as a block mapping"). Any other error records `failed`. Neither
 * sets report.failures — a config-leg outcome must not fail a strict `genie
 * update` or block the plugin-link / sibling leg that already converged.
 */
function convergeHermesLeg(
  kind: 'mcp-config' | 'skills-dir',
  report: AgentReport,
  run: () => 'created' | 'updated' | 'unchanged',
): void {
  try {
    report.extras.push({ kind, action: run() });
  } catch (err) {
    if (err instanceof HermesConfigError && err.code === 'inline-top-level-key') {
      report.extras.push({ kind, action: 'skipped', detail: err.message });
      report.advisories.push(`hermes ${kind} skipped (inline top-level key): ${err.message}`);
      return;
    }
    report.extras.push({ kind, action: 'failed', detail: errMsg(err) });
    report.advisories.push(`hermes ${kind} failed: ${errMsg(err)}`);
  }
}

/**
 * Converge `linkPath` onto a symlink at `ctx.hermesRoot`:
 *   missing        → create the symlink,
 *   our symlink    → unchanged,
 *   other symlink  → leave it (dev checkout) + advise,
 *   real dir/file  → back up, then replace with the symlink.
 */
function ensureHermesLink(
  ctx: RunContext,
  linkPath: string,
  hermesRoot: string,
  backupName: string,
  report: AgentReport,
): LinkAction {
  mkdirSync(dirname(linkPath), { recursive: true });
  const stat = lstatSafe(linkPath);
  if (stat === null) {
    symlinkSync(hermesRoot, linkPath);
    report.extras.push({ kind: 'symlink', action: 'created', detail: `${linkPath} -> ${hermesRoot}` });
    return 'created';
  }
  if (stat.isSymbolicLink()) return reconcileExistingSymlink(linkPath, hermesRoot, report);
  const backup = ctx.backupInto('hermes', backupName, linkPath);
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(hermesRoot, linkPath);
  report.extras.push({ kind: 'symlink', action: 'adopted', detail: `real dir backed up to ${backup}` });
  return 'adopted';
}

function reconcileExistingSymlink(linkPath: string, hermesRoot: string, report: AgentReport): LinkAction {
  const current = readlinkSync(linkPath);
  if (resolve(dirname(linkPath), current) === resolve(hermesRoot)) {
    report.extras.push({ kind: 'symlink', action: 'unchanged', detail: linkPath });
    return 'unchanged';
  }
  report.extras.push({ kind: 'symlink', action: 'skipped-unmanaged-kept', detail: current });
  report.advisories.push(`hermes link ${linkPath} points elsewhere (${current}); left as-is`);
  return 'skipped-unmanaged-kept';
}

/** When a profile is active, freshen its plugins/genie link too. */
function ensureStickyProfileLink(ctx: RunContext, hermesHome: string, hermesRoot: string, report: AgentReport): void {
  const active = readTrimmed(join(hermesHome, 'active_profile'));
  if (active === null || active === '') return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(active) || active === '.' || active === '..') {
    report.advisories.push(`invalid Hermes active_profile ${JSON.stringify(active)}; sticky link skipped safely`);
    report.failures = [`invalid Hermes active_profile ${JSON.stringify(active)}`];
    return;
  }
  const profilesRoot = resolve(hermesHome, 'profiles');
  const profileRoot = resolve(profilesRoot, active);
  if (!profileRoot.startsWith(`${profilesRoot}${sep}`)) {
    report.advisories.push('Hermes active_profile escaped profiles root; sticky link skipped safely');
    report.failures = ['Hermes active_profile escaped profiles root'];
    return;
  }
  const linkPath = join(profileRoot, 'plugins', 'genie');
  ensureHermesLink(ctx, linkPath, hermesRoot, `profiles-${active}-plugins-genie`, report);
}

function runHermesEnable(opts: AgentSyncOptions, binary: string, report: AgentReport): void {
  const exec =
    opts.execHermesEnable ??
    ((args: string[]) => {
      // Bounded: a wedged hermes must not hang the 45s-budgeted session-start
      // delegation (or a terminal `genie update`) indefinitely.
      execFileSync(binary, args, { stdio: 'ignore', timeout: 10_000 });
    });
  try {
    exec(['plugins', 'enable', 'genie']);
    report.extras.push({ kind: 'enable', action: 'ran', detail: 'hermes plugins enable genie' });
  } catch (err) {
    report.extras.push({ kind: 'enable', action: 'failed', detail: errMsg(err) });
    report.advisories.push(`hermes plugins enable genie failed: ${errMsg(err)}`);
    report.failures = [`hermes plugins enable genie failed: ${errMsg(err)}`];
  }
}

function detectHermesBinary(opts: AgentSyncOptions): string | null {
  if (opts.hermesBinary !== undefined) return opts.hermesBinary;
  if (typeof Bun !== 'undefined') return Bun.which('hermes');
  try {
    const found = execFileSync('which', ['hermes'], { encoding: 'utf8' }).trim();
    return found === '' ? null : found;
  } catch {
    return null;
  }
}

// ============================================================================
// Cross-process lock
// ============================================================================

/**
 * Acquire the per-GENIE_HOME sync lock via O_EXCL create. Returns a release
 * handle or a fail-closed skip reason.
 * A lock whose mtime is older than {@link LOCK_STALE_MS}, or implausibly more
 * than that far in the future, is stealable only when its recorded PID is not
 * live. Stealing is serialized by another token-owned lock. Any other lock I/O
 * failure fails closed; a destructive sync never runs without ownership.
 */
function acquireSyncLock(lockPath: string): { release: () => void } | { skipped: string } {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = tryInitializeSyncLock(lockPath);
    if (created.status === 'acquired') return created.lock;
    if (created.status === 'failed') return { skipped: created.reason };
    const stat = statSafe(lockPath);
    if (stat === null) continue; // holder released between open and stat — retry
    if (!isStaleOrInvalidLockTime(stat.mtimeMs)) return heldLockSkip();
    // Age alone never proves abandonment. A slow or clock-skewed live owner
    // retains the lock regardless of whether its timestamp is old or future.
    if (lockHasLiveOwner(lockPath)) return heldLockSkip();
    if (stealStaleLock(lockPath) === 'contended') return heldLockSkip();
    // stale debris cleared — loop and retry the exclusive create
  }
  return { skipped: 'agent-sync lock remained contended after retries; skipped safely' };
}

type LockCreateAttempt =
  | { status: 'acquired'; lock: { release: () => void } }
  | { status: 'exists' }
  | { status: 'failed'; reason: string };

function tryInitializeSyncLock(lockPath: string): LockCreateAttempt {
  let fd: number;
  const token = randomBytes(16).toString('hex');
  const processIdentity = processStartIdentity(process.pid) ?? 'unknown';
  const ownerRecord = `${process.pid}:${token}:${processIdentity}`;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return code === 'EEXIST'
      ? { status: 'exists' }
      : { status: 'failed', reason: `could not acquire agent-sync lock (${code}); skipped safely` };
  }
  let failure: unknown;
  try {
    writeSync(fd, `${ownerRecord}\n`);
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure === undefined) {
    return { status: 'acquired', lock: { release: () => releaseOwnedLock(lockPath, ownerRecord) } };
  }
  // A failed initializer never unlinks by pathname alone: if another process
  // replaced the record, only our token may release it. Partial debris safely
  // fails closed and is handled by the stale-lock path later.
  releaseOwnedLock(lockPath, ownerRecord);
  const code = (failure as NodeJS.ErrnoException).code ?? 'unknown';
  return { status: 'failed', reason: `could not initialize agent-sync lock (${code}); skipped safely` };
}

function heldLockSkip(): { skipped: string } {
  return { skipped: 'another agent-sync run holds the lock; skipped (the holder converges the same targets)' };
}

/** Old locks and far-future timestamps cannot suppress synchronization indefinitely. */
function isStaleOrInvalidLockTime(mtimeMs: number, nowMs = Date.now()): boolean {
  const ageMs = nowMs - mtimeMs;
  return ageMs > LOCK_STALE_MS || ageMs < -LOCK_STALE_MS;
}

/** Parse current pid/token/start locks plus legacy pid/token and pid-only records. */
function lockOwner(lockPath: string): { pid: number; processIdentity: string | null } | null {
  const raw = readTrimmed(lockPath);
  const match = raw?.match(/^(\d+)(?::[a-f0-9]{32})?(?::([a-f0-9]{64}|unknown))?$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, processIdentity: match[2] ?? null } : null;
}

/** Never steal a live lock; PID reuse is rejected by the process-start identity. */
function lockHasLiveOwner(lockPath: string): boolean {
  const owner = lockOwner(lockPath);
  if (owner === null) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (owner.processIdentity === null || owner.processIdentity === 'unknown') return true;
  const currentIdentity = processStartIdentity(owner.pid);
  return currentIdentity === null || currentIdentity === owner.processIdentity;
}

/** Release only the exact owner record created by this acquisition. */
function releaseOwnedLock(lockPath: string, ownerRecord: string): void {
  if (readTrimmed(lockPath) !== ownerRecord) return;
  rmSyncSafe(lockPath);
}

function processStartIdentity(pid: number): string | null {
  let marker: string;
  try {
    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = raw.lastIndexOf(')');
      const fields = raw
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      marker = `linux:${fields[19] ?? ''}`;
    } else if (process.platform === 'win32') {
      marker = `windows:${execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
        { encoding: 'utf8', timeout: 1_000 },
      ).trim()}`;
    } else {
      marker = `ps:${execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1_000,
      }).trim()}`;
    }
    if (marker.endsWith(':')) return null;
    return createHash('sha256').update(marker).digest('hex');
  } catch {
    return null;
  }
}

export interface LifecycleLease {
  path: string;
  release: () => void;
}

const ACTIVE_LIFECYCLE_LEASES = new Map<string, { count: number; releaseUnderlying: () => void }>();

/** Stable sibling-of-GENIE_HOME lease shared by lifecycle commands. */
export function lifecycleLockPath(genieHome = resolveGenieHome()): string {
  const canonical = resolve(genieHome);
  const suffix = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return join(dirname(canonical), `.genie-lifecycle-${suffix}.lock`);
}

export function acquireLifecycleLease(genieHome = resolveGenieHome()): LifecycleLease | { skipped: string } {
  const path = lifecycleLockPath(genieHome);
  const borrowedPath = process.env[LIFECYCLE_LEASE_PATH_ENV];
  const borrowedOwner = process.env[LIFECYCLE_LEASE_OWNER_ENV];
  if (borrowedPath !== undefined || borrowedOwner !== undefined) {
    if (
      borrowedPath !== path ||
      borrowedOwner === undefined ||
      borrowedOwner.length === 0 ||
      borrowedOwner.includes('\n') ||
      borrowedOwner.includes('\r') ||
      readTrimmed(path) !== borrowedOwner
    ) {
      return { skipped: 'borrowed lifecycle lease did not exactly match the expected live owner; skipped safely' };
    }
    // The shell parent remains the sole owner. A child must neither register
    // an exit handler nor unlink/decrement the parent lease when it finishes.
    return { path, release: () => undefined };
  }
  const active = ACTIVE_LIFECYCLE_LEASES.get(path);
  if (active) {
    active.count += 1;
    let released = false;
    return {
      path,
      release: () => {
        if (released) return;
        released = true;
        active.count -= 1;
        if (active.count === 0) {
          ACTIVE_LIFECYCLE_LEASES.delete(path);
          active.releaseUnderlying();
        }
      },
    };
  }
  const acquired = acquireSyncLock(path);
  if ('skipped' in acquired) return acquired;
  const releaseOnExit = () => acquired.release();
  process.once('exit', releaseOnExit);
  const state = {
    count: 1,
    releaseUnderlying: () => {
      process.removeListener('exit', releaseOnExit);
      acquired.release();
    },
  };
  ACTIVE_LIFECYCLE_LEASES.set(path, state);
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      state.count -= 1;
      if (state.count === 0) {
        ACTIVE_LIFECYCLE_LEASES.delete(path);
        state.releaseUnderlying();
      }
    },
  };
}

/**
 * Clear a stale lock safely under a `.steal` guard file. The previous
 * unlink-then-retry steal let two processes both "win": between one stealer's
 * unlink and its re-create, a second stealer's unlink silently removed the
 * first's FRESH lock (observed as two concurrent writers in the regression
 * test). The guard closes that hole with two properties: (a) the O_EXCL guard
 * admits exactly one stealer at a time, and (b) the lock's staleness is
 * RE-verified while holding the guard, so a fresh lock created after the
 * caller's first observation is never removed. A guard left by a crashed
 * stealer ages out via {@link LOCK_STALE_MS} like the lock itself.
 *
 * ONE protocol, two acquirers — this function and the shell installer
 * (recover_stale_lifecycle_lock in install.sh) must stay byte-compatible:
 *   - Lock path: `<dirname(canonical GENIE_HOME)>/.genie-lifecycle-<sha256(canonical)[:16]>.lock`
 *     ({@link lifecycleLockPath}); guard path is `<lock>.steal`.
 *   - Owner record: `pid:token32[:sha64|unknown]` — a decimal pid, an optional
 *     32-hex token, and an optional process-start identity (64-hex, or the
 *     literal `unknown` the shell always writes). {@link lockOwner} parses it;
 *     an empty or otherwise unparseable record yields `null`.
 *   - Staleness window: ±{@link LOCK_STALE_MS} (10 min) around the mtime; a
 *     timestamp too old OR implausibly far future is "stale".
 *   - Guard reap rule (the aged-guard-recovery branch below, mirrored by the
 *     shell's foreign_lock_record_is_stale): reap an existing guard we did not
 *     create only when its mtime is stale AND its owner is dead. An empty or
 *     unparseable record counts as dead (`lockOwner` → null). A live pid —
 *     including another user's process, where `process.kill(pid, 0)` throws
 *     EPERM — counts as alive and is never reaped ({@link lockHasLiveOwner}). A
 *     symlinked/non-regular guard OR lock is never reaped (lstat, never follow —
 *     parity with the shell's `! -L`). Reaping only unlinks; it never renames or
 *     quarantines.
 *   - Residual race (accepted): a process suspended (e.g. SIGSTOP, GC, swap)
 *     across BOTH the guard read→rm window and the lock read→rm window can
 *     still let two acquirers proceed as concurrent owners. This is pre-existing
 *     in the TS path; the shell matches it at parity rather than widening it.
 */
function stealStaleLock(lockPath: string): 'cleared' | 'contended' {
  const guardPath = `${lockPath}.steal`;
  const guardAttempt = tryInitializeSyncLock(guardPath);
  if (guardAttempt.status !== 'acquired') {
    // lstat (never follow): a symlinked or otherwise non-regular guard is never
    // ours to reap — refuse it, matching the shell's `! -L` guard, so neither
    // acquirer can be redirected into unlinking a target it does not own.
    const guardStat = lstatSafe(guardPath);
    if (guardStat?.isFile() && isStaleOrInvalidLockTime(guardStat.mtimeMs) && !lockHasLiveOwner(guardPath)) {
      rmSyncSafe(guardPath);
    }
    return 'contended'; // another stealer holds the guard — back off like a live lock
  }
  try {
    const stat = statSafe(lockPath);
    if (stat !== null && !isStaleOrInvalidLockTime(stat.mtimeMs)) return 'contended'; // refreshed under us — live
    if (stat !== null && lockHasLiveOwner(lockPath)) return 'contended';
    // Same fail-closed refusal for the lock: never unlink through a symlink or
    // other non-regular node (a symlinked lock is not ours to steal).
    const lockStat = lstatSafe(lockPath);
    if (lockStat !== null && !lockStat.isFile()) return 'contended';
    rmSyncSafe(lockPath); // re-verified stale (or already gone) under the guard
    return 'cleared';
  } finally {
    guardAttempt.lock.release();
  }
}

// ============================================================================
// Orchestration
// ============================================================================

/**
 * Converge every detected agent from the resolved source. Never throws for
 * agent-level failures; a null pluginRoot yields an empty report. Exactly one
 * run per GENIE_HOME may write at a time: a concurrent run returns a report
 * with `skipped` set and performs zero writes.
 */
export function runAgentSync(opts: AgentSyncOptions = {}): AgentSyncReport {
  const genieHome = opts.genieHome ?? resolveGenieHome();
  const source = resolveGenieSource(genieHome);
  const log = opts.log ?? (() => undefined);
  if (source.pluginRoot === null) {
    log('agent-sync: no genie plugin source found (looked for plugins/genie); skipping');
    return { source, agents: [], backupsDir: null };
  }
  const lock = acquireSyncLock(join(genieHome, LOCK_NAME));
  if ('skipped' in lock) {
    log(`agent-sync: ${lock.skipped}`);
    return { source, agents: [], backupsDir: null, skipped: lock.skipped };
  }
  try {
    const ctx = createRunContext(genieHome, source.pluginRoot, source, opts);
    const selection = opts.selection ?? 'auto';
    const agents: AgentReport[] = [];
    if (selection === 'auto' || selection === 'all' || selection === 'claude') {
      agents.push(runAgentSafe('claude', (report) => syncClaude(ctx, report)));
    }
    if (selection === 'auto' || selection === 'all' || selection === 'codex') {
      agents.push(runAgentSafe('codex', (report) => syncCodex(ctx, report)));
    }
    if (selection === 'auto' || selection === 'all') {
      agents.push(runAgentSafe('hermes', (report) => syncHermes(ctx, opts, report)));
    }
    return { source, agents, backupsDir: ctx.backupsDirIfCreated() };
  } finally {
    lock.release();
  }
}

function createRunContext(
  genieHome: string,
  pluginRoot: string,
  source: GenieSource,
  opts: AgentSyncOptions,
): RunContext {
  const now = opts.now ?? (() => new Date());
  const targets = {
    claude: opts.targets?.claude ?? resolveClaudeDir(),
    codex: opts.targets?.codex ?? resolveCodexDir(),
    hermes: opts.targets?.hermes ?? resolveHermesHome(),
    agentsSkills: opts.targets?.agentsSkills ?? resolveAgentsSkillsDir(),
  };
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  let backupsDir: string | null = null;
  const backupInto = (agent: string, name: string, existingDir: string): string => {
    if (backupsDir === null) {
      // Uninstall removes GENIE_HOME. Recovery material therefore lives in a
      // sibling root so a later uninstall cannot erase the only surviving copy.
      const recoveryRoot = join(dirname(resolve(genieHome)), '.genie-recovery');
      const base = join(recoveryRoot, `agent-sync-${stamp}-${process.pid}`);
      backupsDir = base;
      for (let suffix = 1; existsSync(backupsDir); suffix += 1) backupsDir = `${base}-${suffix}`;
      mkdirSync(backupsDir, { recursive: true });
    }
    const dest = join(backupsDir, agent, name);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(existingDir, dest, { recursive: true });
    return dest;
  };
  return {
    genieHome,
    pluginRoot,
    hermesRoot: source.hermesRoot,
    version: source.version,
    now,
    targets,
    backupInto,
    backupsDirIfCreated: () => backupsDir,
    renameManagedDir: opts.renameManagedDir ?? renameSync,
    beforeManagedDirPromotion: opts.beforeManagedDirPromotion,
    beforeManagedDirPublish: opts.beforeManagedDirPublish,
    beforeManagedDirRemoval: opts.beforeManagedDirRemoval,
  };
}

/**
 * Run one adapter against a report this function owns, so a late throw (e.g. in
 * removeManagedOrphans, after writes already landed on disk) keeps whatever the
 * adapter collected up to the failure point — the error is appended as an
 * advisory rather than discarding the partial report. Never throws.
 */
function runAgentSafe(agent: AgentReport['agent'], run: (report: AgentReport) => void): AgentReport {
  const report = emptyReport(agent);
  try {
    run(report);
  } catch (err) {
    const failure = `${agent} sync failed: ${errMsg(err)}`;
    report.advisories.push(failure);
    report.failures = [failure];
  }
  return report;
}

// ============================================================================
// Small shared helpers
// ============================================================================

function emptyReport(agent: AgentReport['agent']): AgentReport {
  return { agent, detected: false, skills: [], extras: [], advisories: [] };
}

function recordFailure(report: AgentReport, failure: string): void {
  if (report.failures === undefined) report.failures = [];
  report.failures.push(failure);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isOptionalDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isPhysicalMode(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0o7777;
}

function isOptionalPhysicalMode(value: unknown): value is number | null {
  return value === null || isPhysicalMode(value);
}

function isSafeEntryName(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

function createExclusiveTransactionDir(parent: string, preferredName: string): string {
  mkdirSync(parent, { recursive: true });
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = join(parent, attempt === 0 ? preferredName : `${preferredName}-${randomBytes(4).toString('hex')}`);
    try {
      mkdirSync(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`could not allocate collision-free transaction directory under ${parent}`);
}

function quarantineTransactionDebris(parent: string, path: string): void {
  const stat = lstatSafe(path);
  if (stat === null) return;
  const quarantineRoot = join(parent, '.genie-sync-quarantine');
  mkdirSync(quarantineRoot, { recursive: true });
  const destination = join(
    quarantineRoot,
    `${path.split(sep).at(-1) ?? 'transaction'}-${randomBytes(6).toString('hex')}`,
  );
  renameSync(path, destination);
}

function removeEmptyDirSafe(path: string): void {
  try {
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
  } catch {
    // Already absent, non-directory, or concurrently populated: leave it fail-safe.
  }
}

function lstatSafe(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Absence-aware lstat for commit authorization; non-ENOENT errors are not absence. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function statSafe(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function rmSyncSafe(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort: a leftover lock ages out via LOCK_STALE_MS anyway.
  }
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
