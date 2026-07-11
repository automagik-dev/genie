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
  type Dirent,
  type Stats,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { resolveClaudeDir, resolveCodexDir, resolveGenieHome, resolveHermesHome } from './genie-home.js';

// ============================================================================
// Constants
// ============================================================================

/** Placeholder the /council template carries for its lens-card root. */
const PLACEHOLDER = '__GENIE_LENS_ROOT__';
/** Stamped/synced workflow filename. Exported: doctor/uninstall key their checks on it. */
export const TARGET_NAME = 'council.js';
/** Digest-backed ownership record for the stamped council workflow. */
export const WORKFLOW_MANIFEST_NAME = `${TARGET_NAME}.genie-sync.json`;
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
}

interface RunContext {
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
// Digest — a stable fingerprint of a directory's file content
// ============================================================================

/**
 * sha256 over the sorted `(relpath, sha256(content))` pairs of every file in
 * `dir`. The manifest is always excluded (its digest field would otherwise be
 * self-referential); callers may exclude additional relpaths. Directory entry
 * order does not affect the result.
 */
export function computeDirDigest(dir: string, exclude?: Set<string>): string {
  const excluded = new Set(exclude ?? []);
  excluded.add(MANIFEST_NAME);
  const files: Array<{ rel: string; hash: string }> = [];
  collectFileHashes(dir, dir, excluded, files);
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

function byRel(a: { rel: string }, b: { rel: string }): number {
  if (a.rel < b.rel) return -1;
  if (a.rel > b.rel) return 1;
  return 0;
}

function collectFileHashes(
  root: string,
  current: string,
  excluded: Set<string>,
  out: Array<{ rel: string; hash: string }>,
): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const abs = join(current, entry.name);
    const rel = relative(root, abs);
    if (excluded.has(rel)) continue;
    const kind = classifyEntry(abs, entry);
    if (kind === 'dir') collectFileHashes(root, abs, excluded, out);
    else if (kind === 'file') out.push({ rel, hash: hashFile(abs) });
  }
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
    if (parsed.managedBy === MANAGED_BY && typeof parsed.digest === 'string' && /^[a-f0-9]{64}$/.test(parsed.digest)) {
      return {
        manifest: {
          managedBy: MANAGED_BY,
          version: parsed.version ?? null,
          digest: parsed.digest,
          syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '',
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
  return { managedBy: MANAGED_BY, version: ctx.version, digest, syncedAt: ctx.now().toISOString() };
}

interface ManagedDirTransactionJournal {
  version: 1;
  destName: string;
  hadLive: boolean;
  beforeContentDigest: string | null;
  beforeManifestDigest: string | null;
  stagedContentDigest: string;
  stagedManifestDigest: string;
}

interface ManagedDirExpectedIdentity {
  contentDigest: string | null;
  manifestDigest: string | null;
}

class ManagedArtifactConflictError extends Error {}

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
      version: 1,
      destName,
      hadLive: expected.contentDigest !== null,
      beforeContentDigest: expected.contentDigest,
      beforeManifestDigest: expected.manifestDigest,
      stagedContentDigest: stagedIdentity.contentDigest,
      stagedManifestDigest: stagedIdentity.manifestDigest,
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
          if (lstatSafe(destDir) === null) renameSync(before, destDir);
          const conflict = preserveManagedDirConflict(transactionRoot, published, token);
          throw new ManagedArtifactConflictError(
            `managed skill changed during promotion; kept both versions for review at ${conflict}`,
          );
        }
      }
      ctx.renameManagedDir(join(published, 'staged'), destDir);
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

function managedDirIdentity(dir: string): { contentDigest: string; manifestDigest: string } {
  const stat = lstatSafe(dir);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`managed skill tree is not a physical directory: ${dir}`);
  }
  const manifestDigest = regularFileDigest(join(dir, MANIFEST_NAME));
  if (manifestDigest === null) throw new Error(`managed skill manifest is not a physical file: ${dir}`);
  return { contentDigest: computeDirDigest(dir), manifestDigest };
}

function matchesManagedDirIdentity(dir: string, contentDigest: string | null, manifestDigest: string | null): boolean {
  if (contentDigest === null || manifestDigest === null) return false;
  try {
    const identity = managedDirIdentity(dir);
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
    parsed.version !== 1 ||
    typeof parsed.destName !== 'string' ||
    !isSafeEntryName(parsed.destName) ||
    typeof parsed.hadLive !== 'boolean' ||
    !isOptionalDigest(parsed.beforeContentDigest) ||
    !isOptionalDigest(parsed.beforeManifestDigest) ||
    !isDigest(parsed.stagedContentDigest) ||
    !isDigest(parsed.stagedManifestDigest) ||
    (parsed.hadLive && (parsed.beforeContentDigest === null || parsed.beforeManifestDigest === null)) ||
    (!parsed.hadLive && (parsed.beforeContentDigest !== null || parsed.beforeManifestDigest !== null))
  ) {
    throw new Error(`invalid managed skill transaction: ${transactionDir}`);
  }
  return parsed as ManagedDirTransactionJournal;
}

function rollbackManagedDirTransaction(
  targetParent: string,
  transactionDir: string,
  journal: ManagedDirTransactionJournal,
): void {
  const destDir = join(targetParent, journal.destName);
  const before = join(transactionDir, 'before');
  if (lstatSafe(before) !== null) {
    if (!matchesManagedDirIdentity(before, journal.beforeContentDigest, journal.beforeManifestDigest)) {
      throw new Error(`managed skill prior tree changed: ${before}`);
    }
    if (lstatSafe(destDir) !== null) {
      if (!matchesManagedDirIdentity(destDir, journal.stagedContentDigest, journal.stagedManifestDigest)) {
        throw new Error(`managed skill transaction target changed: ${destDir}`);
      }
      rmSync(destDir, { recursive: true, force: true });
    }
    renameSync(before, destDir);
  } else if (journal.hadLive) {
    if (!matchesManagedDirIdentity(destDir, journal.beforeContentDigest, journal.beforeManifestDigest)) {
      throw new Error(`managed skill transaction lost prior tree: ${destDir}`);
    }
  } else if (lstatSafe(destDir) !== null) {
    if (!matchesManagedDirIdentity(destDir, journal.stagedContentDigest, journal.stagedManifestDigest)) {
      throw new Error(`managed skill transaction target changed: ${destDir}`);
    }
    rmSync(destDir, { recursive: true, force: true });
  }
  rmSync(transactionDir, { recursive: true, force: true });
  removeEmptyDirSafe(join(targetParent, SKILL_TRANSACTION_ROOT));
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
    if (!entry.name.startsWith(SKILL_TRANSACTION_PREFIX)) continue;
    let journal: ManagedDirTransactionJournal | null = null;
    try {
      journal = readManagedDirTransactionJournal(transactionDir);
      if (existsSync(join(transactionDir, 'COMMITTED'))) {
        const destDir = join(targetParent, journal.destName);
        if (!matchesManagedDirIdentity(destDir, journal.stagedContentDigest, journal.stagedManifestDigest)) {
          throw new Error(`committed managed skill transaction is inconsistent: ${transactionDir}`);
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

function recoverLegacyManagedDirSwap(destDir: string): void {
  const stageDir = `${destDir}${STAGING_SUFFIX}`;
  const oldDir = `${destDir}${PREV_SUFFIX}`;
  if (lstatSafe(stageDir) !== null) quarantineTransactionDebris(dirname(destDir), stageDir);
  if (lstatSafe(oldDir) !== null && lstatSafe(destDir) === null) renameSync(oldDir, destDir);
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
  if (!existsSync(destDir)) {
    writeManagedDir(ctx, skill.dir, destDir, manifest, { contentDigest: null, manifestDigest: null });
    return { action: 'created' };
  }
  if (lstatSafe(destDir)?.isSymbolicLink()) {
    return { action: 'skipped-unmanaged-kept', detail: 'same-name symlink preserved and never followed' };
  }
  const existing = readManifest(destDir);
  if (existing === null) {
    const reason = existsSync(join(destDir, MANIFEST_NAME)) ? 'corrupt or foreign manifest' : 'no ownership manifest';
    return { action: 'skipped-unmanaged-kept', detail: `${reason}; existing directory preserved` };
  }
  const currentDigest = computeDirDigest(destDir);
  if (currentDigest === existing.manifest.digest) {
    if (sourceDigest === existing.manifest.digest) return { action: 'unchanged' };
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
    if (computeDirDigest(dir) === manifest.manifest.digest) {
      ctx.backupInto(agent, entry.name, dir);
      rmSync(dir, { recursive: true, force: true });
      report.skills.push({ name: entry.name, action: 'removed' });
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
      typeof parsed.syncedAt !== 'string'
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

/** Classify council.js using only its sidecar ownership grant and recorded digest. */
export function inspectManagedWorkflow(targetDir: string): ManagedWorkflowReport {
  const targetPath = join(targetDir, TARGET_NAME);
  const manifestPath = join(targetDir, WORKFLOW_MANIFEST_NAME);
  const ownership = readWorkflowManifest(manifestPath);
  if (ownership.status === 'missing') return { targetPath, manifestPath, state: 'unmanaged' };
  if (ownership.status === 'corrupt') return { targetPath, manifestPath, state: 'corrupt-metadata' };
  const digest = regularFileDigest(targetPath);
  return {
    targetPath,
    manifestPath,
    state: digest !== null && digest === ownership.manifest?.digest ? 'managed-clean' : 'managed-modified',
    ...(digest !== null && digest === ownership.manifest?.digest && ownership.fileDigest !== undefined
      ? { targetDigest: digest, manifestDigest: ownership.fileDigest }
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
  };
  const expected =
    ownership.state === 'managed-clean'
      ? {
          targetDigest: ownership.targetDigest ?? null,
          manifestDigest: ownership.manifestDigest ?? null,
        }
      : { targetDigest: null, manifestDigest: null };
  if (
    (ownership.state === 'managed-clean' && (expected.targetDigest === null || expected.manifestDigest === null)) ||
    (ownership.state === 'unmanaged' && targetExists)
  ) {
    return { action: 'kept-modified', targetPath: ownership.targetPath };
  }
  publishWorkflowTransaction(targetDir, stamped, manifest, expected, opts.beforePromotion);
  return { action: 'written', targetPath: ownership.targetPath };
}

const WORKFLOW_TRANSACTION_PREFIX = '.council.genie-txn-';
const WORKFLOW_TRANSACTION_STAGING_PREFIX = '.council.genie-txn-staging-';

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
  expected: { targetDigest: string | null; manifestDigest: string | null },
  beforePromotion?: () => void,
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
    })}\n`,
    'utf8',
  );
  renameSync(working, transactionDir);
  const before = join(transactionDir, 'before');
  const publishedStaged = join(transactionDir, 'staged');
  mkdirSync(before, { recursive: true });
  try {
    beforePromotion?.();
    if (
      regularFileDigest(targetPath) !== expected.targetDigest ||
      regularFileDigest(manifestPath) !== expected.manifestDigest
    ) {
      const conflict = preserveWorkflowConflict(transactionDir);
      throw new ManagedArtifactConflictError(
        `council workflow changed before promotion; kept live and incoming versions for review at ${conflict}`,
      );
    }
    if (lstatSafe(targetPath) !== null) renameSync(targetPath, join(before, TARGET_NAME));
    if (lstatSafe(manifestPath) !== null) renameSync(manifestPath, join(before, WORKFLOW_MANIFEST_NAME));
    if (
      (expected.targetDigest !== null && regularFileDigest(join(before, TARGET_NAME)) !== expected.targetDigest) ||
      (expected.manifestDigest !== null &&
        regularFileDigest(join(before, WORKFLOW_MANIFEST_NAME)) !== expected.manifestDigest)
    ) {
      if (lstatSafe(targetPath) === null && lstatSafe(join(before, TARGET_NAME)) !== null)
        renameSync(join(before, TARGET_NAME), targetPath);
      if (lstatSafe(manifestPath) === null && lstatSafe(join(before, WORKFLOW_MANIFEST_NAME)) !== null)
        renameSync(join(before, WORKFLOW_MANIFEST_NAME), manifestPath);
      const conflict = preserveWorkflowConflict(transactionDir);
      throw new ManagedArtifactConflictError(
        `council workflow changed during promotion; kept both versions for review at ${conflict}`,
      );
    }
    renameSync(join(publishedStaged, TARGET_NAME), targetPath);
    renameSync(join(publishedStaged, WORKFLOW_MANIFEST_NAME), manifestPath);
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
    if (!name.startsWith(WORKFLOW_TRANSACTION_PREFIX)) continue;
    const transactionDir = join(targetDir, name);
    const journal = readWorkflowTransactionJournal(transactionDir);
    if (existsSync(join(transactionDir, 'COMMITTED'))) {
      if (
        regularFileDigest(join(targetDir, TARGET_NAME)) !== journal.targetDigest ||
        regularFileDigest(join(targetDir, WORKFLOW_MANIFEST_NAME)) !== journal.manifestDigest
      ) {
        throw new Error(`committed council workflow transaction is inconsistent: ${transactionDir}`);
      }
      rmSync(transactionDir, { recursive: true, force: true });
    } else {
      rollbackWorkflowTransaction(targetDir, transactionDir);
    }
  }
}

function readWorkflowTransactionJournal(transactionDir: string): {
  targetDigest: string;
  manifestDigest: string;
  hadTarget: boolean;
  hadManifest: boolean;
  beforeTargetDigest: string | null;
  beforeManifestDigest: string | null;
} {
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
    parsed.hadManifest !== (parsed.beforeManifestDigest !== null)
  ) {
    throw new Error(`invalid council workflow transaction: ${transactionDir}`);
  }
  return parsed as ReturnType<typeof readWorkflowTransactionJournal>;
}

function rollbackWorkflowTransaction(targetDir: string, transactionDir: string): void {
  const journal = readWorkflowTransactionJournal(transactionDir);
  for (const [name, digest, had, beforeDigest] of [
    [TARGET_NAME, journal.targetDigest, journal.hadTarget, journal.beforeTargetDigest],
    [WORKFLOW_MANIFEST_NAME, journal.manifestDigest, journal.hadManifest, journal.beforeManifestDigest],
  ] as const) {
    const target = join(targetDir, name);
    const before = join(transactionDir, 'before', name);
    if (lstatSafe(before) !== null) {
      if (regularFileDigest(before) !== beforeDigest)
        throw new Error(`council transaction prior target changed: ${before}`);
      if (lstatSafe(target) !== null) {
        if (regularFileDigest(target) !== digest) throw new Error(`council transaction target changed: ${target}`);
        rmSync(target, { force: true });
      }
      renameSync(before, target);
    } else if (!had && lstatSafe(target) !== null) {
      if (regularFileDigest(target) !== digest) throw new Error(`council transaction target changed: ${target}`);
      rmSync(target, { force: true });
    } else if (had) {
      if (regularFileDigest(target) !== beforeDigest)
        throw new Error(`council transaction lost prior target: ${target}`);
    }
  }
  rmSync(transactionDir, { recursive: true, force: true });
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
    if (computeDirDigest(dir) !== manifest.manifest.digest) {
      kept += 1;
      report.extras.push({ kind: 'legacy-curated', action: 'kept-modified', detail: dir });
      report.advisories.push(`kept modified legacy codex skill ${entry.name} at ${dir}`);
      continue;
    }
    ctx.backupInto('codex-legacy-curated', entry.name, dir);
    rmSync(dir, { recursive: true, force: true });
    report.extras.push({ kind: 'legacy-curated', action: 'removed', detail: dir });
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
 */
function stealStaleLock(lockPath: string): 'cleared' | 'contended' {
  const guardPath = `${lockPath}.steal`;
  const guardAttempt = tryInitializeSyncLock(guardPath);
  if (guardAttempt.status !== 'acquired') {
    const guardStat = statSafe(guardPath);
    if (guardStat !== null && isStaleOrInvalidLockTime(guardStat.mtimeMs) && !lockHasLiveOwner(guardPath)) {
      rmSyncSafe(guardPath);
    }
    return 'contended'; // another stealer holds the guard — back off like a live lock
  }
  try {
    const stat = statSafe(lockPath);
    if (stat !== null && !isStaleOrInvalidLockTime(stat.mtimeMs)) return 'contended'; // refreshed under us — live
    if (stat !== null && lockHasLiveOwner(lockPath)) return 'contended';
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
    pluginRoot,
    hermesRoot: source.hermesRoot,
    version: source.version,
    now,
    targets,
    backupInto,
    backupsDirIfCreated: () => backupsDir,
    renameManagedDir: opts.renameManagedDir ?? renameSync,
    beforeManagedDirPromotion: opts.beforeManagedDirPromotion,
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
