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

import { dlopen } from 'bun:ffi';
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
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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
/** Single-writer lock scoped to each fallbackSkillsDir's retirement root; lives directly in it, ignored by the txn-* scan. */
const RETIREMENT_LOCK_NAME = '.retirement.lock';
/** Per-transaction subdir retaining changed-tree copies archived aside during restore disposal (never recursive-deleted). */
const RETIREMENT_EVIDENCE_DIR = 'evidence';
/** Bounded blocking wait before the retirement lock wrapper fails closed. Test-overridable via env for fast reentry proofs. */
const RETIREMENT_LOCK_WAIT_MS = 30_000;
/** Feature-detected glibc/musl sonames for the Linux renameat2 no-clobber fast path (x86_64). */
const LINUX_LIBC_CANDIDATES = ['libc.so.6', 'ld-musl-x86_64.so.1', 'libc.musl-x86_64.so.1'] as const;
/** Borrowed lifecycle-lease path passed from a shell owner to its child process. */
export const LIFECYCLE_LEASE_PATH_ENV = 'GENIE_LIFECYCLE_LEASE_PATH';
/** Exact on-disk owner record paired with {@link LIFECYCLE_LEASE_PATH_ENV}. */
export const LIFECYCLE_LEASE_OWNER_ENV = 'GENIE_LIFECYCLE_LEASE_OWNER';
/**
 * Suffix a preserved managed object gets when its original pathname must be
 * released (uninstall keep, conflict preservation): the runtime stops loading
 * it, the user's bytes survive. Exported: uninstall shares the convention.
 */
export const KEPT_SUFFIX = '.genie-kept';
/** Cross-process mutual-exclusion lockfile under genieHome — one sync writer per GENIE_HOME. */
export const AGENT_SYNC_LOCK_NAME = '.agent-sync.lock';
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
  /** Deterministic barrier immediately before a flat agent pathname is replaced or removed. */
  beforeAgentFileMutation?: (event: AgentFileMutationEvent) => void;
  /** Fault-injection barrier after the shared manifest transaction is staged and before its atomic commit. */
  beforeAgentManifestCommit?: (event: AgentManifestCommitEvent) => void;
  /** Deterministic lock lifecycle seams used by boundary-level regression tests. */
  lockOptions?: AgentSyncLockOptions;
}

/**
 * One barrier event per flat-agent mutation. `replace`/`remove` fire from sync;
 * `remove`/`keep`/`prune` fire from uninstall — both through the same
 * transaction core, after the live object is captured and before it is
 * irreversibly published or disposed.
 */
export interface AgentFileMutationEvent {
  operation: 'replace' | 'remove' | 'keep' | 'prune';
  path: string;
  backupPath?: string;
}

/**
 * Fires once per transaction, inside the manifest commit: after the staged
 * payload (write path) or the captured manifest (removal path) exists, and
 * before the atomic publish decides the transaction outcome.
 */
export interface AgentManifestCommitEvent {
  path: string;
  stagePath: string;
}

export interface AgentSyncLockMutationEvent {
  operation: 'release' | 'stale-remove';
  path: string;
  capturedPath: string;
}

export interface AgentSyncLockOptions {
  /** Deterministic barrier after a generation is prepared and before its atomic publish. */
  beforePublish?: (event: { path: string }) => void;
  /** Deterministic barrier after the lock pathname is captured and before the captured object is finalized. */
  afterCapture?: (event: AgentSyncLockMutationEvent) => void;
}

/** A protected mutation must never proceed when the shared lock cannot be created or verified. */
export class AgentSyncLockError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentSyncLockError';
  }
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

/** Digest stamp for one flat Claude agent file in {@link AgentFilesManifest}. */
export interface AgentFileManifestEntry {
  digest: string;
  version: string | null;
  syncedAt: string;
}

/** Shared manifest stored at `~/.claude/agents/.genie-sync.json`. */
export interface AgentFilesManifest {
  managedBy: 'genie-agent-sync';
  files: Record<string, AgentFileManifestEntry>;
}

interface ManifestFileSnapshot {
  path: string;
  bytes: Buffer;
  stat: Stats;
}

type SafeManifestFile = ManifestFileSnapshot &
  ({ kind: 'managed'; manifest: AgentFilesManifest } | { kind: 'foreign'; manifest: null });

type AgentManifestState =
  | SafeManifestFile
  | { kind: 'absent'; path: string }
  | { kind: 'unsafe'; path: string; reason: string };

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
  /**
   * Write already-validated bytes into the run's backup root exclusively and
   * return the backup path — the backup IS the validated snapshot, so no
   * re-read of the live path can diverge from what the policy decided on.
   */
  backupBytes: (agent: string, name: string, bytes: Buffer) => string;
  /** The backup root path, or null when nothing has been backed up this run. */
  backupsDirIfCreated: () => string | null;
  renameManagedDir: typeof renameSync;
  beforeManagedDirPromotion?: (destDir: string) => void;
  beforeManagedDirPublish?: (destDir: string) => void;
  beforeManagedDirRemoval?: (destDir: string, stage: 'before-park' | 'before-delete') => void;
  beforeAgentFileMutation?: AgentSyncOptions['beforeAgentFileMutation'];
  beforeAgentManifestCommit?: AgentSyncOptions['beforeAgentManifestCommit'];
}

interface SourceSkill {
  name: string;
  dir: string;
}

interface SkillOutcome {
  action: SkillAction;
  detail?: string;
}

export interface SourceAgentFile {
  name: string;
  path: string;
}

export type AgentPathSnapshot =
  | { kind: 'absent' }
  | { kind: 'file'; stat: Stats; bytes: Buffer; digest: string }
  | { kind: 'directory'; stat: Stats; digest: string }
  | { kind: 'symlink'; stat: Stats; target: string }
  | { kind: 'other'; stat: Stats };

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

export function computeFileDigest(path: string): string {
  return hashFile(path);
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

/**
 * Read the shared per-file Claude agent manifest. A malformed entry invalidates
 * the whole ownership claim: callers then treat every target as unmanaged,
 * which biases corrupt-state recovery toward backup/adoption instead of loss.
 */
export function readAgentFilesManifest(dir: string): AgentFilesManifest | null {
  const state = inspectAgentFilesManifest(dir);
  return state.kind === 'managed' ? state.manifest : null;
}

/**
 * Lightweight, read-only view of the shared agent manifest for external
 * consumers (doctor). Distinguishes a genie-managed manifest (with its per-file
 * entries) from foreign / absent / unsafe WITHOUT exposing the raw byte+stat
 * snapshot. `unsafe` mirrors {@link inspectAgentFilesManifest}'s fail-closed
 * verdict (symlink, non-regular file, multiple hard links, or unreadable) so a
 * diagnostic can surface it as a warning instead of silently reporting healthy.
 */
export type AgentFilesManifestView =
  | { kind: 'managed'; files: Record<string, AgentFileManifestEntry> }
  | { kind: 'foreign' }
  | { kind: 'absent' }
  | { kind: 'unsafe'; reason: string };

export function readAgentFilesManifestState(dir: string): AgentFilesManifestView {
  const state = inspectAgentFilesManifest(dir);
  switch (state.kind) {
    case 'managed':
      return { kind: 'managed', files: state.manifest.files };
    case 'foreign':
      return { kind: 'foreign' };
    case 'absent':
      return { kind: 'absent' };
    default:
      return { kind: 'unsafe', reason: state.reason };
  }
}

function inspectAgentFilesManifest(dir: string): AgentManifestState {
  const path = join(dir, MANIFEST_NAME);
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return { kind: 'absent', path };
    return { kind: 'unsafe', path, reason: `cannot inspect it: ${errMsg(error)}` };
  }
  if (stat.isSymbolicLink()) return { kind: 'unsafe', path, reason: 'it is a symlink' };
  if (!stat.isFile()) return { kind: 'unsafe', path, reason: 'it is not a regular file' };
  if (stat.nlink !== 1) return { kind: 'unsafe', path, reason: `it has ${stat.nlink} hard links` };

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { kind: 'unsafe', path, reason: `cannot read it: ${errMsg(error)}` };
  }
  const manifest = parseAgentFilesManifest(bytes);
  if (manifest === null) return { kind: 'foreign', path, bytes, stat, manifest: null };
  return { kind: 'managed', path, bytes, stat, manifest };
}

function parseAgentFilesManifest(bytes: Buffer): AgentFilesManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.managedBy !== MANAGED_BY) return null;
  if (typeof record.files !== 'object' || record.files === null || Array.isArray(record.files)) return null;

  const files: Record<string, AgentFileManifestEntry> = {};
  for (const [name, rawEntry] of Object.entries(record.files)) {
    if (!isFlatAgentFilename(name)) return null;
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) return null;
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.digest !== 'string') return null;
    files[name] = {
      digest: entry.digest,
      version: typeof entry.version === 'string' ? entry.version : null,
      syncedAt: typeof entry.syncedAt === 'string' ? entry.syncedAt : '',
    };
  }
  return { managedBy: MANAGED_BY, files };
}

/**
 * CAS predicate for the manifest commit: the captured object must still be the
 * exact regular file (identity + bytes) the transaction inspected at its start.
 */
function manifestStillBase(path: string, base: AgentManifestState): boolean {
  if (base.kind !== 'managed' && base.kind !== 'foreign') return false;
  const current = inspectManifestPath(path);
  return current !== null && sameManifestFile(base, current);
}

function inspectManifestPath(path: string): SafeManifestFile | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
    const bytes = readFileSync(path);
    const manifest = parseAgentFilesManifest(bytes);
    return manifest === null
      ? { kind: 'foreign', path, bytes, stat, manifest: null }
      : { kind: 'managed', path, bytes, stat, manifest };
  } catch {
    return null;
  }
}

function sameManifestFile(expected: SafeManifestFile, current: SafeManifestFile): boolean {
  return (
    expected.stat.dev === current.stat.dev &&
    expected.stat.ino === current.stat.ino &&
    expected.stat.nlink === current.stat.nlink &&
    expected.bytes.equals(current.bytes)
  );
}

function writeExclusiveFile(path: string, content: Buffer): void {
  const fd = openSync(path, 'wx');
  const identity = fstatSync(fd);
  let complete = false;
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) cleanupFailedExclusiveWrite(path, identity);
  }
}

function cleanupFailedExclusiveWrite(path: string, expected: Stats): void {
  const captured = capturePath(path, 'write-cleanup');
  if (captured === null) return;
  const current = lstatSafe(captured.path);
  if (current !== null && sameObjectIdentity(expected, current)) removeCapturedPath(captured);
  else restoreOrPreserveCaptured(captured, path);
}

/**
 * One staged payload in a uniquely and exclusively allocated sibling directory.
 * Crashed-run debris is never reused or removed, so it cannot wedge a retry.
 */
interface FileStage {
  dir: string;
  path: string;
  stat: Stats;
  bytes: Buffer;
}

function createFileStage(targetPath: string, content: Buffer): FileStage {
  const stageDir = mkdtempSync(join(dirname(targetPath), `.${basename(targetPath)}${STAGING_SUFFIX}-`));
  const stagePath = join(stageDir, 'payload');
  try {
    writeExclusiveFile(stagePath, content);
  } catch (error) {
    removeEmptyDirSafe(stageDir);
    throw error;
  }
  return { dir: stageDir, path: stagePath, stat: lstatSync(stagePath), bytes: content };
}

/** The staged payload is still the exact object this run wrote (identity + bytes). */
function fileStageOwned(stage: FileStage): boolean {
  try {
    const stat = lstatSync(stage.path);
    return stat.isFile() && sameObjectIdentity(stage.stat, stat) && readFileSync(stage.path).equals(stage.bytes);
  } catch {
    return false;
  }
}

/**
 * Failure-path stage disposal: our own payload is removed; a payload someone
 * replaced is preserved byte-for-byte and reported, never discarded.
 */
function cleanupFileStage(stage: FileStage): string | null {
  if (fileStageOwned(stage)) {
    try {
      unlinkSync(stage.path);
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) {
        removeEmptyDirSafe(stage.dir);
        return `could not remove staged payload ${stage.path}: ${errMsg(error)}`;
      }
    }
    removeEmptyDirSafe(stage.dir);
    return null;
  }
  if (lstatSafe(stage.path) === null) {
    removeEmptyDirSafe(stage.dir);
    return null;
  }
  return `preserved replaced staged payload at ${stage.path}`;
}

/**
 * Success-path stage disposal after a link-publish: the stage name is only an
 * extra name for the now-live inode, so dropping it can never discard bytes.
 */
function consumeFileStageName(stage: FileStage): string | null {
  try {
    unlinkSync(stage.path);
  } catch (error) {
    if (!isNodeErrorCode(error, 'ENOENT')) return `could not remove staged name ${stage.path}: ${errMsg(error)}`;
  }
  removeEmptyDirSafe(stage.dir);
  return null;
}

function removeEmptyDirSafe(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (
      !isNodeErrorCode(error, 'ENOENT') &&
      !isNodeErrorCode(error, 'ENOTEMPTY') &&
      !isNodeErrorCode(error, 'EEXIST')
    ) {
      throw error;
    }
  }
}

interface CapturedPath {
  dir: string;
  path: string;
}

/** Atomically move the current pathname into a fresh attempt-owned directory. */
function capturePath(path: string, label: string): CapturedPath | null {
  const captureDir = mkdtempSync(join(dirname(path), `.${basename(path)}.${label}-`));
  const capturedPath = join(captureDir, 'object');
  try {
    renameSync(path, capturedPath);
    return { dir: captureDir, path: capturedPath };
  } catch (error) {
    removeEmptyDirSafe(captureDir);
    if (isNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** Restore a captured file/symlink without replacing anything that appeared meanwhile. */
function restoreCapturedPathNoReplace(capturedPath: string, originalPath: string): boolean {
  const stat = lstatSync(capturedPath);
  try {
    if (stat.isFile()) {
      linkSync(capturedPath, originalPath);
      unlinkSync(capturedPath);
      return true;
    }
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(capturedPath), originalPath);
      unlinkSync(capturedPath);
      return true;
    }
    return false;
  } catch (error) {
    if (isNodeErrorCode(error, 'EEXIST')) return false;
    throw error;
  }
}

/** Prefer restoring the original pathname; otherwise leave the object safely quarantined. */
function restoreOrPreserveCaptured(captured: CapturedPath, originalPath: string): string | null {
  if (restoreCapturedPathNoReplace(captured.path, originalPath)) {
    removeEmptyDirSafe(captured.dir);
    return originalPath;
  }
  return captured.path;
}

function removeCapturedPath(captured: CapturedPath): void {
  const stat = lstatSafe(captured.path);
  if (stat?.isDirectory()) rmSync(captured.path, { recursive: true, force: true });
  else if (stat !== null) unlinkSync(captured.path);
  removeEmptyDirSafe(captured.dir);
}

function sameObjectIdentity(expected: Stats, current: Stats): boolean {
  return expected.dev === current.dev && expected.ino === current.ino && expected.mode === current.mode;
}

function isFlatAgentFilename(name: string): boolean {
  return name === basename(name) && name.endsWith('.md') && name !== '.' && name !== '..';
}

/**
 * Park a captured object at an exclusively allocated `<target>.genie-kept[-…]`
 * sibling so the runtime stops loading it while the bytes stay visible on disk.
 * Type-aware (file / symlink / directory); collisions advance to a timestamped
 * candidate, never overwrite. Returns the kept path, or null when the object
 * could not be parked and remains quarantined at `captured.path`.
 */
function keepAsideCaptured(captured: CapturedPath, targetPath: string, now: () => Date): string | null {
  const base = `${targetPath}${KEPT_SUFFIX}`;
  const timestamp = now().getTime();
  const stat = lstatSafe(captured.path);
  if (stat === null) {
    removeEmptyDirSafe(captured.dir);
    return null;
  }
  for (let collision = 0; collision < 10_000; collision += 1) {
    const candidate =
      collision === 0 ? base : collision === 1 ? `${base}-${timestamp}` : `${base}-${timestamp}-${collision - 1}`;
    if (tryParkCapturedAt(captured.path, candidate, stat)) {
      removeEmptyDirSafe(captured.dir);
      return candidate;
    }
  }
  return null;
}

/** Exclusive no-replace park of one captured object; false only on candidate collision. */
function tryParkCapturedAt(capturedPath: string, candidate: string, stat: Stats): boolean {
  try {
    if (stat.isFile()) {
      linkSync(capturedPath, candidate);
      unlinkSync(capturedPath);
      return true;
    }
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(capturedPath), candidate);
      unlinkSync(capturedPath);
      return true;
    }
    if (stat.isDirectory()) {
      mkdirSync(candidate, { mode: stat.mode & 0o777 });
      for (const name of readdirSync(capturedPath)) renameSync(join(capturedPath, name), join(candidate, name));
      rmdirSync(capturedPath);
      return true;
    }
    throw new Error(`cannot safely keep non-regular agent path ${candidate}`);
  } catch (error) {
    if (isNodeErrorCode(error, 'EEXIST')) return false;
    throw error;
  }
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

function buildAgentFileManifestEntry(ctx: RunContext, digest: string): AgentFileManifestEntry {
  return { version: ctx.version, digest, syncedAt: ctx.now().toISOString() };
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
  /**
   * Provenance metadata only — not authenticated, and NOT part of the
   * ownership match key (see {@link historicalTupleKey}). Fallback seeding
   * stamps `marker.version` to whatever release happens to be installed, so a
   * byte-identical tree seeded by a later, unlisted release must still match
   * on (skillName, physicalDigest) alone.
   */
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

/**
 * Ownership proof key: (skillName, physicalDigest) only. `markerVersion` is
 * self-reported by the untrusted marker file and is retained on the tuple as
 * provenance metadata, but it adds zero proof value over the exact-content
 * digest — fallback seeding stamps `marker.version` to whatever release
 * happened to be installed, so keying on it silently rejects byte-identical
 * historical content stamped by a later release than the one the fixture froze.
 */
function historicalTupleKey(tuple: Pick<CodexFallbackHistoricalTuple, 'skillName' | 'physicalDigest'>): string {
  return `${tuple.skillName}\0${tuple.physicalDigest}`;
}

/**
 * Load the frozen historical-tuple allowlist as an ownership-key set. Exported
 * so read-only callers (doctor's tier inspection) apply the SAME acceptance
 * policy as {@link planCodexFallbackRetirement} instead of re-deriving their
 * own notion of "recognized" — the fixture loading and key derivation live in
 * exactly one place.
 */
export function loadHistoricalCodexFallbackTupleKeys(): ReadonlySet<string> {
  const tuples = historicalCodexFallbackAllowlist as CodexFallbackHistoricalTuple[];
  return new Set(tuples.map(historicalTupleKey));
}

/**
 * Classify a single `~/.agents/skills/<name>` dir's Codex-fallback ownership.
 * Exported so doctor's read-only tier inspection can split a structurally
 * `managed-clean` tree into "recognized, retirable by `genie update`" vs
 * "well-formed but unrecognized, needs manual review" using the identical
 * marker/digest/allowlist gate {@link planCodexFallbackRetirement} uses to
 * decide what it will actually retire — so doctor never promises a retirement
 * the engine then refuses.
 */
export function classifyCodexFallback(
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
  if (historical.has(historicalTupleKey({ skillName, physicalDigest }))) {
    return { ...common, accepted: true, reason: 'historical-tuple' };
  }
  return {
    ...common,
    ...(targetDigest === null ? {} : { targetDigest }),
    accepted: false,
    reason: 'ambiguous-ownership',
  };
}

/** Deterministic transaction id (sha256[:32]) — exported so a forged-journal test can build a self-consistent journal. */
export function retirementTransactionId(accepted: readonly CodexFallbackAcceptedIdentity[], generation = 0): string {
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
  const historical = loadHistoricalCodexFallbackTupleKeys();
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
  /** Basename under `evidence/` where a changed quarantine tree was archived aside during disposal. */
  evidence?: string;
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
  | `after-restore-publication:${number}`
  | `after-restore-filesystem:${number}`
  | `before-restore-cleanup:${number}`
  | `before-quarantine-disposal:${number}`
  | `after-quarantine-disposal:${number}`
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

/** Errors a DIRECTORY-metadata flush may legitimately raise on platforms/filesystems that refuse it. */
function isTolerableDirectoryFsyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP';
}

/**
 * Test seam for {@link fsyncPath}: inject the open/fsync syscalls (and platform)
 * so a directory-metadata flush can be forced to throw the way Windows and some
 * network filesystems do. Real callers pass nothing.
 */
export interface FsyncPathDeps {
  open?: typeof openSync;
  fsync?: typeof fsyncSync;
  platform?: NodeJS.Platform;
}

/**
 * fsync a path's metadata to disk. FILE fsync is STRICT — journal and staging
 * byte durability is the load-bearing crash-safety guarantee, so a failure
 * propagates. DIRECTORY-metadata flush is best-effort: Windows (and some network
 * filesystems) refuse to open/fsync a directory fd (EISDIR/EPERM/EINVAL/ENOTSUP),
 * which must NOT brick the codex step of `genie update` at journal-prepare. On
 * win32 a directory fsync is skipped entirely; elsewhere the tolerable errors are
 * swallowed. A durable rename still lands; only the extra directory-entry flush
 * is skipped, exactly as on filesystems that never guaranteed it.
 */
function fsyncPath(path: string, deps: FsyncPathDeps = {}): void {
  const open = deps.open ?? openSync;
  const fsync = deps.fsync ?? fsyncSync;
  const platform = deps.platform ?? process.platform;
  const isDirectory = lstatSafe(path)?.isDirectory() ?? false;
  if (isDirectory && platform === 'win32') return; // never fsync a directory fd on Windows
  let fd: number;
  try {
    fd = open(path, constants.O_RDONLY);
  } catch (error) {
    if (isDirectory && isTolerableDirectoryFsyncError(error)) return; // best-effort directory flush
    throw error;
  }
  try {
    fsync(fd);
  } catch (error) {
    if (!(isDirectory && isTolerableDirectoryFsyncError(error))) throw error; // FILE fsync stays strict
  } finally {
    closeSync(fd);
  }
}

/** Directly exercisable {@link fsyncPath} for the directory-fsync-tolerance proof (Windows/network-fs failpoint). */
export function fsyncPathForTest(path: string, deps: FsyncPathDeps = {}): void {
  fsyncPath(path, deps);
}

/**
 * Write a whole buffer to a descriptor, tolerating partial `writeSync` results.
 * Exported for a direct unit proof (a `writeFn` that returns a partial count
 * once, then delegates). The `<= 0` guard turns a stuck writer into a thrown
 * error rather than an infinite loop.
 */
export function writeAllSync(fd: number, buffer: Buffer, writeFn: typeof writeSync = writeSync): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeFn(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error(`journal write made no progress at offset ${offset}/${buffer.length}`);
    offset += written;
  }
}

function writeDurableRetirementJournal(
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  const journalPath = join(transactionDir, 'journal.json');
  // Unique per-writer temp under O_EXCL: even a future unlocked caller cannot
  // clobber a peer's temp or the durable journal. The single writer lock is the
  // primary guarantee; this is defense-in-depth CAS on the durable write.
  const temporary = join(transactionDir, `.journal.${process.pid}.${randomBytes(6).toString('hex')}.next`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    failpoint?.('after-journal-temp-create');
    // Loop until every byte is written before fsync; a short write must never
    // publish a torn journal via the atomic rename below.
    writeAllSync(fd, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`));
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
        (entry.observedTreeDigest !== undefined && !isDigest(entry.observedTreeDigest)) ||
        (entry.evidence !== undefined &&
          (!isSafeEntryName(entry.evidence) ||
            !isInside(transactionDir, join(transactionDir, RETIREMENT_EVIDENCE_DIR, entry.evidence)))),
    )
  ) {
    throw new Error(`invalid Codex fallback retirement journal: ${transactionDir}`);
  }
  validateRetirementPaths(fallbackSkillsDir, transactionDir, parsed);
  // The single writer lock guarantees one live writer; sweep any crashed peer's
  // unique-temp leftovers so they can never masquerade as the durable journal.
  for (const name of readdirSync(transactionDir)) {
    if (name.startsWith('.journal.') && name.endsWith('.next')) rmSync(join(transactionDir, name), { force: true });
  }
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

const AT_FDCWD = -100;
const LINUX_RENAME_NOREPLACE = 1;
const DARWIN_RENAME_EXCL = 4;

type Renameat2 = (staged: Buffer, target: Buffer) => number;
type LibcRenameOpener = (soname: string) => Renameat2 | null;
interface RenameProbe {
  resolved?: Renameat2 | null;
}
/** Dependency-injection seam for the Linux no-clobber fast path — no global mutable state, no test-only setter. */
export interface NoClobberDeps {
  opener?: LibcRenameOpener;
  candidates?: readonly string[];
  probe?: RenameProbe;
}

const defaultLibcOpener: LibcRenameOpener = (soname) => {
  try {
    const libc = dlopen(soname, {
      renameat2: { args: ['i32', 'cstring', 'i32', 'cstring', 'u32'], returns: 'i32' },
    } as const);
    // Handle intentionally retained for process lifetime via the closure (single memoized detection).
    return (s, t) => libc.symbols.renameat2(AT_FDCWD, s, AT_FDCWD, t, LINUX_RENAME_NOREPLACE);
  } catch {
    return null;
  }
};

/** First soname whose renameat2 resolves, else null (musl / no renameat2). Exported for candidate fall-through proofs. */
export function resolveLinuxRenameat2(
  opener: LibcRenameOpener = defaultLibcOpener,
  candidates: readonly string[] = LINUX_LIBC_CANDIDATES,
): Renameat2 | null {
  for (const soname of candidates) {
    const fn = opener(soname);
    if (fn) return fn;
  }
  return null;
}

const defaultLinuxProbe: RenameProbe = {};
function probeLinuxRenameat2(deps: NoClobberDeps): Renameat2 | null {
  const probe = deps.probe ?? defaultLinuxProbe;
  if (!('resolved' in probe)) probe.resolved = resolveLinuxRenameat2(deps.opener, deps.candidates);
  return probe.resolved ?? null;
}

/**
 * Portable, always-available, directory-ONLY, provably no-clobber publish.
 * `mkdir` reserves the target name atomically (EEXIST => a real target is
 * present and never touched); `rename` then replaces only the empty dir we just
 * claimed. A concurrently-populated claim makes `rename` fail and only the
 * still-empty claim is removed.
 */
export function publishDirectoryViaNameClaim(stagedDir: string, targetDir: string): void {
  try {
    mkdirSync(targetDir);
  } catch (e) {
    throw new NoClobberPublishError(
      `portable directory claim failed (${(e as NodeJS.ErrnoException).code}); target preserved: ${targetDir}`,
    );
  }
  try {
    renameSync(stagedDir, targetDir);
  } catch (e) {
    if (readdirSync(targetDir).length === 0) rmSyncSafe(targetDir); // remove only our own still-empty claim
    throw new NoClobberPublishError(
      `portable directory publish failed (${(e as NodeJS.ErrnoException).code}); target preserved: ${targetDir}`,
    );
  }
}

/** Publish one complete same-filesystem directory while atomically rejecting every existing target inode. */
export function atomicRenameDirectoryNoClobber(stagedDir: string, targetDir: string, deps: NoClobberDeps = {}): void {
  const stagedStat = lstatSync(stagedDir);
  if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink()) {
    throw new Error(`atomic publish source is not a physical directory: ${stagedDir}`);
  }
  const stagedPath = Buffer.from(`${stagedDir}\0`);
  const targetPath = Buffer.from(`${targetDir}\0`);
  if (process.platform === 'linux') {
    const rn = probeLinuxRenameat2(deps);
    if (rn === null) {
      publishDirectoryViaNameClaim(stagedDir, targetDir); // musl / no renameat2 => portable
      return;
    }
    if (rn(stagedPath, targetPath) !== 0) {
      const detail = lstatSafe(targetDir) === null ? 'rename failed' : 'target exists';
      throw new NoClobberPublishError(`atomic no-clobber publish failed (${detail}); target preserved: ${targetDir}`);
    }
    return;
  }
  if (process.platform === 'darwin') {
    const libc = dlopen('/usr/lib/libSystem.B.dylib', {
      renamex_np: { args: ['cstring', 'cstring', 'u32'], returns: 'i32' },
    } as const);
    let result: number;
    try {
      result = libc.symbols.renamex_np(stagedPath, targetPath, DARWIN_RENAME_EXCL);
    } finally {
      libc.close();
    }
    if (result !== 0) {
      const detail = lstatSafe(targetDir) === null ? 'rename failed' : 'target exists';
      throw new NoClobberPublishError(`atomic no-clobber publish failed (${detail}); target preserved: ${targetDir}`);
    }
    return;
  }
  publishDirectoryViaNameClaim(stagedDir, targetDir); // was: throw unsupported — now portable & no-clobber
}

function writeRestoreConflict(
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  entry: CodexFallbackRetirementEntry,
  reason: string,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
  retained = 'both trees retained',
): never {
  entry.phase = 'restore-conflict';
  journal.phase = 'restore-conflict';
  writeDurableRetirementJournal(transactionDir, journal, failpoint);
  throw new Error(`${reason}; ${retained} with recoverable status at ${transactionDir}`);
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
  index: number,
  observedTreeDigest: string | undefined,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  failpoint?.(`before-restore-cleanup:${index}`);
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
  // Quarantine stays authoritative until the live object is re-identified at
  // this destructive boundary; publication-time identity is intentionally insufficient.
  if (!matchesRestoreIdentity(paths.source, entry, observedTreeDigest)) {
    const retained = lstatSafe(paths.source) === null ? 'intact quarantine retained' : 'both trees retained';
    writeRestoreConflict(
      transactionDir,
      journal,
      entry,
      `fallback retirement restored source changed during cleanup at ${paths.source}`,
      failpoint,
      retained,
    );
  }
  disposeQuarantineToEvidence(transactionDir, journal, entry, paths, index, observedTreeDigest, failpoint);
  markRetirementEntryRestored(transactionDir, journal, entry, 'restored', failpoint);
}

/**
 * Allocate an unused suffixed evidence basename (`<skill>.2`, `.3`, …) when the
 * primary `evidence/<skill>` slot already holds a DIFFERING archived tree that
 * must be preserved. Probed under the single-writer retirement lock; the
 * no-clobber publish at the call site is the defense-in-depth guard against a
 * probe/rename race. Both the path and its basename are returned so the chosen
 * name can be journaled (it must round-trip {@link isSafeEntryName} — `<skill>.N`
 * is not dot-prefixed and never collides with reserved infra names).
 */
function claimFreshEvidencePath(
  evidenceRoot: string,
  skillName: string,
  transactionDir: string,
): { path: string; name: string } {
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const name = `${skillName}.${suffix}`;
    const path = join(evidenceRoot, name);
    if (!isInside(transactionDir, path)) throw new Error(`unconfined retirement evidence: ${path}`);
    if (lstatSafe(path) === null) return { path, name };
  }
  throw new Error(`could not allocate a fresh retirement evidence path for ${skillName}`);
}

/**
 * Archive the quarantine copy aside with a single atomic rename instead of a
 * recursive delete. The last intact copy is MOVED to `evidence/<skillName>` (or
 * a fresh suffixed sibling), never destroyed, so no interval exists in which
 * zero copies of the tree are on disk. After the move a re-verify converts a
 * source that vanished during the check/disposal window into a recoverable
 * conflict rather than a lost commit — the journal never records `restored`
 * while the live tree is absent.
 *
 * An OCCUPIED primary slot is only ever removed when it holds a byte-identical
 * duplicate of the copy being archived. A DIFFERING archive — the residual
 * last-copy-loss path: a cycle-1 restore archives the user's edited bytes to
 * `evidence/<skill>`, then a later same-txn generation re-moves a byte-pristine
 * tree and re-enters restore with `destinationMatches` true — is preserved
 * in place and the incoming copy is moved to a fresh suffixed path via the
 * no-clobber primitive. The chosen archive path is journaled BEFORE the move.
 */
function disposeQuarantineToEvidence(
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  entry: CodexFallbackRetirementEntry,
  paths: RetirementRestorePaths,
  index: number,
  observedTreeDigest: string | undefined,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): void {
  failpoint?.(`before-quarantine-disposal:${index}`);
  const evidenceRoot = join(transactionDir, RETIREMENT_EVIDENCE_DIR);
  if (lstatSafe(evidenceRoot) === null) mkdirSync(evidenceRoot, { mode: 0o700 });
  const primaryEvidence = join(evidenceRoot, entry.skillName);
  if (!isInside(transactionDir, primaryEvidence)) throw new Error(`unconfined retirement evidence: ${primaryEvidence}`);
  const existing = lstatSafe(primaryEvidence);
  const incomingDigest = existing === null ? null : exactPhysicalDirectoryDigest(paths.destination);
  const duplicate =
    existing !== null && incomingDigest !== null && exactPhysicalDirectoryDigest(primaryEvidence) === incomingDigest;

  let evidencePath: string;
  if (duplicate || existing === null) {
    // Empty slot, or the primary archive already holds these exact bytes. In the
    // duplicate case removing the archive and re-moving the byte-identical copy
    // loses nothing (this is the prior single-archive behavior, kept verbatim).
    evidencePath = primaryEvidence;
    entry.evidence = entry.skillName;
  } else {
    // Occupied by a DIFFERING tree that must survive: claim a fresh suffixed
    // path and NEVER delete the existing archive.
    const fresh = claimFreshEvidencePath(evidenceRoot, entry.skillName, transactionDir);
    evidencePath = fresh.path;
    entry.evidence = fresh.name;
  }
  journal.phase = 'restoring';
  writeDurableRetirementJournal(transactionDir, journal, failpoint); // persist the chosen archive path BEFORE the move
  if (duplicate) rmSync(primaryEvidence, { recursive: true, force: true }); // remove only the byte-identical duplicate
  if (existing === null || duplicate) {
    renameSync(paths.destination, evidencePath); // ATOMIC — the last copy is MOVED aside, never recursive-deleted
  } else {
    atomicRenameDirectoryNoClobber(paths.destination, evidencePath); // no-clobber onto a fresh path; old archive untouched
  }
  fsyncPath(evidenceRoot);
  fsyncPath(paths.quarantine);
  failpoint?.(`after-quarantine-disposal:${index}`);
  // Confirm the live tree survived the check/disposal window before declaring success.
  if (!matchesRestoreIdentity(paths.source, entry, observedTreeDigest)) {
    const retained = lstatSafe(paths.source) === null ? 'changed evidence retained' : 'both trees retained';
    writeRestoreConflict(
      transactionDir,
      journal,
      entry,
      `fallback retirement restored source changed during disposal at ${paths.source}`,
      failpoint,
      retained,
    );
  }
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
    atomicRenameDirectoryNoClobber(paths.staging, paths.source);
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
  failpoint?.(`after-restore-publication:${index}`);
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
  cleanupRestoredRetirementDestination(
    fallbackSkillsDir,
    transactionDir,
    journal,
    entry,
    paths,
    index,
    observedTreeDigest,
    failpoint,
  );
  rmSync(paths.staging, { recursive: true, force: true });
  fsyncPath(paths.stagingRoot);
  failpoint?.(`after-restore:${index}`);
}

/**
 * Neither the live source nor the quarantine copy is present. If the quarantine
 * copy was already archived aside under evidence/ (a valid archived tree
 * exists), surface a recoverable conflict instead of the catastrophic throw —
 * the last intact changed copy is never lost.
 */
function resolveNeitherTreeRestore(
  transactionDir: string,
  journal: CodexFallbackRetirementJournal,
  entry: CodexFallbackRetirementEntry,
  paths: RetirementRestorePaths,
  failpoint?: ApplyCodexFallbackRetirementOptions['failpoint'],
): never {
  const evidencePath = entry.evidence ? join(transactionDir, RETIREMENT_EVIDENCE_DIR, entry.evidence) : null;
  const evidenceDigest = evidencePath ? exactPhysicalDirectoryDigest(evidencePath) : null;
  if (
    evidenceDigest !== null &&
    (entry.observedTreeDigest === undefined || evidenceDigest === entry.observedTreeDigest)
  ) {
    writeRestoreConflict(
      transactionDir,
      journal,
      entry,
      `fallback retirement changed evidence retained at ${evidencePath}`,
      failpoint,
      'changed evidence retained',
    );
  }
  throw new Error(`fallback retirement restore has neither live nor quarantined tree: ${paths.source}`);
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
      index,
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
    resolveNeitherTreeRestore(transactionDir, journal, entry, paths, failpoint);
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
  fallback: string,
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
        ({ destination: _destination, phase: _phase, observedTreeDigest: _observed, evidence: _evidence, ...entry }) =>
          entry,
      ),
    };
    // Reuse the already-held lock (recursion drives the internal body, never the public shell).
    return applyRetirementLocked(generationPlan, fallback, transactionRoot, options);
  }
  return {
    transactionId: plan.transactionId,
    transactionDir,
    status: 'already-committed',
    retired: journal.accepted.map((entry) => entry.skillName),
  };
}

/**
 * Re-prove every source's identity before a forward (re-)move. This resets each
 * entry to `planned` but DELIBERATELY does NOT clear `entry.evidence` between
 * generations: that field is a durable pointer to a changed-tree copy archived
 * aside by a PRIOR restore, and it is the only in-journal reference
 * {@link resolveNeitherTreeRestore} uses to convert a catastrophic "neither
 * tree" into a recoverable "changed evidence retained" — clearing it would
 * weaken the never-lose-a-copy invariant. On-disk safety no longer depends on
 * this field regardless: {@link disposeQuarantineToEvidence} re-reads the
 * evidence slot from disk and refuses to overwrite a differing archive, so a
 * stale `entry.evidence` can never authorize data loss.
 */
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

/** Portable synchronous bounded sleep — no dependency on the Bun global. */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retirementLockWaitMs(): number {
  const override = process.env.GENIE_RETIREMENT_LOCK_WAIT_MS;
  const parsed = override === undefined ? Number.NaN : Number(override);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : RETIREMENT_LOCK_WAIT_MS;
}

/**
 * Bounded-blocking wrapper over the whole tested {@link acquireFileLock}
 * (reuses its O_EXCL create, pid + process-start-identity liveness, staleness,
 * and guard-file stealing verbatim). A stale/dead holder is stolen inside
 * `acquireFileLock`; a live holder is retried until the deadline, then this
 * fails closed having mutated nothing on disk.
 */
function acquireRetirementLock(lockPath: string): { release: () => void } {
  const deadline = Date.now() + retirementLockWaitMs();
  for (;;) {
    const lock = acquireFileLock(lockPath);
    if (!('skipped' in lock)) return lock;
    if (Date.now() >= deadline) {
      throw new Error(`fallback retirement lock contended; no data changed: ${lockPath}`);
    }
    sleepSyncMs(25);
  }
}

/**
 * Assert a physical transaction root BEFORE the lock path is ever opened, so a
 * symlinked root is rejected before any write can reach its target (preserves
 * the symlink-escape rejection). Creates the root only when absent.
 */
function ensurePhysicalTransactionRoot(transactionRoot: string): void {
  if (lstatSafe(transactionRoot) !== null) {
    assertCanonicalPhysicalDirectory(transactionRoot, 'fallback retirement transaction root');
  } else {
    mkdirSync(transactionRoot, { recursive: true, mode: 0o700 });
  }
}

/**
 * Retire one already-planned batch into a retained hidden quarantine. The
 * complete journal is durable before the first rename. Pre-commit failures
 * restore moved trees in reverse without replacing a competing live path.
 *
 * A single-writer lock scoped to this fallback root's retirement root
 * serializes every mutation under it, collapsing the concurrent-invocation
 * threat class. The public function is the ONLY place that takes/releases the
 * lock; the generation recursion drives the internal body directly.
 */
export function applyCodexFallbackRetirement(
  plan: CodexFallbackRetirementPlan,
  options: ApplyCodexFallbackRetirementOptions = {},
): CodexFallbackRetirementResult {
  const fallback = canonicalPhysicalFallbackRoot(plan.fallbackSkillsDir);
  if (
    fallback !== plan.fallbackSkillsDir ||
    retirementTransactionId(plan.accepted, plan.generation ?? 0) !== plan.transactionId
  ) {
    throw new Error('fallback retirement plan identity changed after planning');
  }
  const transactionRoot = join(fallback, CODEX_FALLBACK_RETIREMENT_ROOT);
  ensurePhysicalTransactionRoot(transactionRoot); // MUST run before the lock — rejects a symlinked root first
  const lock = acquireRetirementLock(join(transactionRoot, RETIREMENT_LOCK_NAME));
  try {
    return applyRetirementLocked(plan, fallback, transactionRoot, options);
  } finally {
    lock.release();
  }
}

/** Forward + catch-restore body of a retirement, assuming the retirement lock is already held. */
function applyRetirementLocked(
  plan: CodexFallbackRetirementPlan,
  fallback: string,
  transactionRoot: string,
  options: ApplyCodexFallbackRetirementOptions,
): CodexFallbackRetirementResult {
  const transactionDir = join(transactionRoot, `txn-${plan.transactionId}`);
  validateRetirementPaths(fallback, transactionDir, {
    ...plan,
    phase: 'prepared',
    entries: plan.accepted.map((entry) => ({
      ...entry,
      destination: join(transactionDir, 'quarantine', entry.skillName),
      phase: 'planned',
    })),
  });
  let journal = loadOrPrepareRetirementJournal(plan, fallback, transactionRoot, transactionDir, options.failpoint);
  if (!sameRetirementBatch(plan, journal))
    throw new Error(`fallback retirement transaction identity conflict: ${transactionDir}`);
  if (journal.phase === 'committed') {
    return committedRetirementResult(plan, journal, fallback, transactionRoot, transactionDir, options);
  }
  try {
    if (
      journal.entries.some(
        (entry) =>
          lstatSafe(entry.destination) !== null ||
          lstatSafe(join(transactionDir, RETIREMENT_EVIDENCE_DIR, entry.skillName)) !== null,
      )
    ) {
      restoreRetirementMoves(fallback, transactionDir, journal, options.failpoint);
      journal = readRetirementJournal(fallback, transactionDir);
    }
    validateRetirementSources(fallback, transactionDir, journal);
    moveRetirementEntries(fallback, transactionDir, journal, options.failpoint);
    verifyRetirementDestinations(fallback, transactionDir, journal, options.failpoint);
    commitRetirementJournal(transactionRoot, transactionDir, journal, options.failpoint);
    return {
      transactionId: plan.transactionId,
      transactionDir,
      status: 'committed',
      retired: journal.accepted.map((entry) => entry.skillName),
    };
  } catch (error) {
    journal = readRetirementJournal(fallback, transactionDir);
    if (journal.phase !== 'committed') {
      try {
        restoreRetirementMoves(fallback, transactionDir, journal, options.failpoint);
      } catch (restoreError) {
        throw new Error(`${errMsg(error)}; fallback retirement restore failed: ${errMsg(restoreError)}`);
      }
    }
    throw error;
  }
}

/**
 * Store-enumerating recovery: reconstruct each on-disk transaction's plan from
 * its own journal (not from live paths, which a fresh process cannot replan
 * once sources are quarantined) and drive it through the same idempotent
 * {@link applyRetirementLocked}. Per-transaction isolation records a failure
 * without sinking the rest of the sweep; a committed base whose skill
 * resurrected finishes its generation inline under the held lock.
 */
export function recoverCodexFallbackRetirements(
  fallbackSkillsDir: string,
  options: ApplyCodexFallbackRetirementOptions = {},
): CodexFallbackRetirementResult[] {
  const fallback = canonicalPhysicalFallbackRoot(fallbackSkillsDir);
  const transactionRoot = join(fallback, CODEX_FALLBACK_RETIREMENT_ROOT);
  if (lstatSafe(transactionRoot) === null) return [];
  assertCanonicalPhysicalDirectory(transactionRoot, 'fallback retirement transaction root');
  const lock = acquireRetirementLock(join(transactionRoot, RETIREMENT_LOCK_NAME));
  try {
    const results: CodexFallbackRetirementResult[] = [];
    const failures: string[] = [];
    for (const entry of readdirSync(transactionRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith('txn-')) continue; // skips .retirement.lock, .retirement.lock.steal, temps
      const transactionDir = join(transactionRoot, entry.name);
      try {
        results.push(recoverOneRetirement(fallback, transactionRoot, transactionDir, entry.name, options));
      } catch (error) {
        failures.push(`fallback retirement recovery failed for ${entry.name}: ${errMsg(error)}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; ')); // surface after the full pass; evidence retained
    return results;
  } finally {
    lock.release();
  }
}

function recoverOneRetirement(
  fallback: string,
  transactionRoot: string,
  transactionDir: string,
  dirName: string,
  options: ApplyCodexFallbackRetirementOptions,
): CodexFallbackRetirementResult {
  let journal: CodexFallbackRetirementJournal;
  try {
    journal = readRetirementJournal(fallback, transactionDir); // validates identity + confinement from disk
  } catch (error) {
    // Journal-less / empty-quarantine debris: apply the exact rule
    // loadOrPrepareRetirementJournal uses. Otherwise fail closed, evidence retained.
    const quarantine = join(transactionDir, 'quarantine');
    const journalAbsent = lstatSafe(join(transactionDir, 'journal.json')) === null;
    const quarantineEmpty = lstatSafe(quarantine) === null || readdirSync(quarantine).length === 0;
    if (journalAbsent && quarantineEmpty) {
      rmSync(transactionDir, { recursive: true });
      fsyncPath(transactionRoot);
      return { transactionId: dirName.slice(4), transactionDir, status: 'already-committed', retired: [] };
    }
    throw error;
  }
  const plan: CodexFallbackRetirementPlan = {
    version: journal.version,
    generation: journal.generation,
    fallbackSkillsDir: journal.fallbackSkillsDir,
    transactionId: journal.transactionId,
    accepted: journal.accepted,
    preserved: journal.preserved,
  };
  return applyRetirementLocked(plan, fallback, transactionRoot, options); // lock already held; one proven path
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
// Claude agent enumeration + per-file policy
// ============================================================================

/**
 * Source agents are flat Markdown files directly under `<pluginRoot>/agents`.
 * Exported so doctor's read-only role-agent classifier enumerates the exact same
 * source set the sync engine fans out (no divergent reimplementation).
 */
export function enumerateSourceAgentFiles(pluginRoot: string): SourceAgentFile[] {
  const agentsRoot = join(pluginRoot, 'agents');
  if (!existsSync(agentsRoot)) return [];
  return readdirSync(agentsRoot, { withFileTypes: true })
    .filter((entry) => isFlatAgentFilename(entry.name) && classifyEntry(join(agentsRoot, entry.name), entry) === 'file')
    .map((entry) => ({ name: entry.name, path: join(agentsRoot, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Flat-agent transaction core
//
// One clearly-bounded transaction per target dir:
//   capture → validate → publish → manifest CAS (single commit) → finalize/rollback
// Sync and uninstall both run through {@link runFlatAgentTransaction} while
// holding the shared per-GENIE_HOME lock, so the core only defends against
// non-genie writers. Invariants closed by construction:
//   - every irreversible unlink re-verifies the exact captured identity first;
//   - ownership moves in ONE manifest commit whose claim set is re-verified
//     against the live objects after the commit barrier;
//   - the manifest publishes by rename of an exclusively staged payload, so a
//     second hardlink to the manifest can never exist and post-publish cleanup
//     is rmdir-only — advisory, never a rollback trigger;
//   - final-entry relinquish verifies post-state before reporting success.
// ============================================================================

/** One planned mutation of a flat agent name inside a single transaction. */
export type FlatAgentOp =
  | {
      kind: 'publish';
      name: string;
      payload: Buffer;
      entry: AgentFileManifestEntry;
      /** Live-path snapshot the policy decision validated; the publish CAS target. */
      expected: AgentPathSnapshot;
      action: 'created' | 'updated' | 'adopted';
      backupPath?: string;
    }
  | {
      kind: 'retire';
      name: string;
      expected: AgentPathSnapshot;
      /** Base-manifest digest this op assumes; ownership drift aborts the op. */
      ownedDigest: string;
      disposal: 'discard' | 'keep-aside';
      operation: 'remove' | 'keep';
      backupPath?: string;
    }
  | { kind: 'disown'; name: string; ownedDigest: string; prune: boolean };

export type FlatAgentConflict = 'changed-before-capture' | 'replaced-before-publish' | 'replaced-before-commit';

export interface FlatAgentOutcome {
  op: FlatAgentOp;
  /**
   * applied — mutation performed and its ownership delta committed;
   * conflict — a non-genie writer won the pathname: the foreign object stays
   *            live and unowned, prior managed bytes stay visible;
   * stale   — ownership/classification drifted before mutation; nothing changed;
   * failed  — an exception fired; the live path was restored or kept visible.
   */
  status: 'applied' | 'conflict' | 'stale' | 'failed';
  conflict?: FlatAgentConflict;
  reason?: string;
  /** Where prior bytes were preserved when the disposal was keep-aside. */
  keptPath?: string;
}

export interface FlatAgentTransactionResult {
  /**
   * False when a required manifest commit did not happen: every op carrying an
   * ownership delta was rolled back and must not be reported as performed.
   */
  committed: boolean;
  outcomes: FlatAgentOutcome[];
  advisories: string[];
}

export interface FlatAgentTransactionSeams {
  now: () => Date;
  beforeFileMutation?: (event: AgentFileMutationEvent) => void;
  beforeManifestCommit?: (event: AgentManifestCommitEvent) => void;
}

interface FlatAgentTxnCtx {
  dir: string;
  baseFiles: Record<string, AgentFileManifestEntry>;
  seams: FlatAgentTransactionSeams;
  advisories: string[];
}

interface FlatAgentOpState {
  op: FlatAgentOp;
  status: FlatAgentOutcome['status'];
  conflict?: FlatAgentConflict;
  reason?: string;
  captured: CapturedPath | null;
  published: AgentPathSnapshot | null;
  delta: 'set' | 'delete' | null;
  keptPath?: string;
}

/**
 * Execute one batch of flat-agent ops against `dir` and its shared manifest.
 * The base manifest is inspected once; every mutation CASes against the exact
 * object it validated; ownership moves in ONE commit; commit failure rolls the
 * data phase back. Callers translate outcomes into their own report shape.
 */
export function runFlatAgentTransaction(
  dir: string,
  ops: FlatAgentOp[],
  seams: FlatAgentTransactionSeams,
): FlatAgentTransactionResult {
  const base = inspectAgentFilesManifest(dir);
  if (base.kind === 'unsafe') {
    return {
      committed: false,
      advisories: [`agent manifest ${base.path} is unsafe (${base.reason}); left untouched`],
      outcomes: ops.map((op) => ({ op, status: 'stale', reason: 'manifest unsafe' })),
    };
  }
  const ctx: FlatAgentTxnCtx = {
    dir,
    baseFiles: base.kind === 'managed' ? base.manifest.files : {},
    seams,
    advisories: [],
  };
  const states = ops.map((op) => executeFlatAgentOp(ctx, op));
  let committed: boolean;
  try {
    committed = commitFlatAgentManifest(ctx, base, states);
  } catch (error) {
    // An unexpected commit exception is a failed commit, never a stranded batch.
    ctx.advisories.push(`agent manifest ${join(dir, MANIFEST_NAME)} commit failed: ${errMsg(error)}`);
    committed = false;
  }
  if (committed) finalizeFlatAgentOps(ctx, states);
  else rollbackFlatAgentOps(ctx, states);
  return {
    committed,
    advisories: ctx.advisories,
    outcomes: states.map((state) => ({
      op: state.op,
      status: state.status,
      conflict: state.conflict,
      reason: state.reason,
      keptPath: state.keptPath,
    })),
  };
}

// ---- file phase ------------------------------------------------------------

function executeFlatAgentOp(ctx: FlatAgentTxnCtx, op: FlatAgentOp): FlatAgentOpState {
  const state: FlatAgentOpState = { op, status: 'applied', captured: null, published: null, delta: null };
  if (op.kind !== 'publish' && ctx.baseFiles[op.name]?.digest !== op.ownedDigest) {
    state.status = 'stale';
    state.reason = 'manifest ownership changed before staging';
    return state;
  }
  try {
    if (op.kind === 'publish') executePublishOp(ctx, op, state);
    else if (op.kind === 'retire') executeRetireOp(ctx, op, state);
    else executeDisownOp(ctx, op, state);
  } catch (error) {
    state.status = 'failed';
    state.reason = state.reason ?? errMsg(error);
    quarantinedCapturedToKeepAside(ctx, state);
  }
  return state;
}

/** Last-resort failure handling: captured bytes must never stay hidden in quarantine. */
function quarantinedCapturedToKeepAside(ctx: FlatAgentTxnCtx, state: FlatAgentOpState): void {
  const captured = state.captured;
  if (captured === null) return;
  state.captured = null;
  const targetPath = join(ctx.dir, state.op.name);
  try {
    const kept = keepAsideCaptured(captured, targetPath, ctx.seams.now);
    state.keptPath = kept ?? undefined;
    ctx.advisories.push(`preserved prior agent bytes at ${kept ?? captured.path}`);
  } catch (error) {
    ctx.advisories.push(`prior agent bytes for ${targetPath} left quarantined at ${captured.path}: ${errMsg(error)}`);
  }
}

function executePublishOp(
  ctx: FlatAgentTxnCtx,
  op: Extract<FlatAgentOp, { kind: 'publish' }>,
  state: FlatAgentOpState,
): void {
  const targetPath = join(ctx.dir, op.name);
  const stage = createFileStage(targetPath, op.payload);
  try {
    if (op.expected.kind !== 'absent' && captureValidatedTarget(ctx, op, state, 'agent-old') !== 'captured') {
      markConflict(ctx, state, 'changed-before-capture');
      pushAdvisory(ctx, cleanupFileStage(stage));
      return;
    }
    ctx.seams.beforeFileMutation?.({ operation: 'replace', path: targetPath, backupPath: op.backupPath });
    if (!fileStageOwned(stage)) throw new Error(`staged payload changed: ${stage.path}`);
    try {
      linkSync(stage.path, targetPath);
    } catch (error) {
      if (!isNodeErrorCode(error, 'EEXIST')) throw error;
      markConflict(ctx, state, 'replaced-before-publish');
      pushAdvisory(ctx, cleanupFileStage(stage));
      return;
    }
    pushAdvisory(ctx, consumeFileStageName(stage));
    state.published = captureAgentPathSnapshot(targetPath);
    state.delta = 'set';
  } catch (error) {
    restoreCapturedAfterFailure(ctx, state, targetPath);
    pushAdvisory(ctx, cleanupFileStage(stage));
    state.status = 'failed';
    state.reason = errMsg(error);
  }
}

function executeRetireOp(
  ctx: FlatAgentTxnCtx,
  op: Extract<FlatAgentOp, { kind: 'retire' }>,
  state: FlatAgentOpState,
): void {
  const targetPath = join(ctx.dir, op.name);
  const capture = captureValidatedTarget(ctx, op, state, 'agent-retire');
  if (capture === 'conflict') {
    markConflict(ctx, state, 'changed-before-capture');
    return;
  }
  if (capture === 'captured') {
    try {
      ctx.seams.beforeFileMutation?.({ operation: op.operation, path: targetPath, backupPath: op.backupPath });
    } catch (error) {
      restoreCapturedAfterFailure(ctx, state, targetPath);
      state.status = 'failed';
      state.reason = errMsg(error);
      return;
    }
  }
  state.delta = 'delete';
}

function executeDisownOp(
  ctx: FlatAgentTxnCtx,
  op: Extract<FlatAgentOp, { kind: 'disown' }>,
  state: FlatAgentOpState,
): void {
  if (op.prune) {
    const targetPath = join(ctx.dir, op.name);
    ctx.seams.beforeFileMutation?.({ operation: 'prune', path: targetPath });
    if (lstatSafe(targetPath) !== null) {
      state.status = 'stale';
      state.reason = 'it appeared after classification';
      return;
    }
  }
  state.delta = 'delete';
}

/**
 * Atomically capture the live object and verify it is exactly the validated
 * snapshot. On mismatch the concurrent object is restored (or quarantined
 * visibly) and the caller records a conflict; on absence nothing is captured.
 */
function captureValidatedTarget(
  ctx: FlatAgentTxnCtx,
  op: Extract<FlatAgentOp, { kind: 'publish' | 'retire' }>,
  state: FlatAgentOpState,
  label: string,
): 'captured' | 'absent' | 'conflict' {
  const targetPath = join(ctx.dir, op.name);
  const captured = capturePath(targetPath, label);
  if (captured === null) return 'absent';
  if (agentPathSnapshotMatches(captured.path, op.expected)) {
    state.captured = captured;
    return 'captured';
  }
  try {
    if (restoreCapturedPathNoReplace(captured.path, targetPath)) {
      removeEmptyDirSafe(captured.dir);
    } else {
      const kept = keepAsideCaptured(captured, targetPath, ctx.seams.now);
      ctx.advisories.push(`preserved concurrently changed agent at ${kept ?? captured.path}`);
    }
  } catch (error) {
    ctx.advisories.push(`concurrently changed agent left quarantined at ${captured.path}: ${errMsg(error)}`);
  }
  return 'conflict';
}

/** A conflict relinquishes any base ownership of the name; the foreign object is never claimed. */
function markConflict(ctx: FlatAgentTxnCtx, state: FlatAgentOpState, conflict: FlatAgentConflict): void {
  state.status = 'conflict';
  state.conflict = conflict;
  state.delta = ctx.baseFiles[state.op.name] === undefined ? null : 'delete';
}

/** Failure path: the live pathname is restored, or the bytes stay visible at a kept path. */
function restoreCapturedAfterFailure(ctx: FlatAgentTxnCtx, state: FlatAgentOpState, targetPath: string): void {
  const captured = state.captured;
  if (captured === null) return;
  state.captured = null;
  try {
    restoreCapturedForFailure(ctx, state, captured, targetPath);
  } catch (error) {
    ctx.advisories.push(`prior agent bytes for ${targetPath} left quarantined at ${captured.path}: ${errMsg(error)}`);
  }
}

function restoreCapturedForFailure(
  ctx: FlatAgentTxnCtx,
  state: FlatAgentOpState,
  captured: CapturedPath,
  targetPath: string,
): void {
  if (restoreCapturedPathNoReplace(captured.path, targetPath)) {
    removeEmptyDirSafe(captured.dir);
    return;
  }
  const kept = keepAsideCaptured(captured, targetPath, ctx.seams.now);
  state.keptPath = kept ?? undefined;
  ctx.advisories.push(`preserved prior agent bytes at ${kept ?? captured.path}`);
}

function pushAdvisory(ctx: FlatAgentTxnCtx, advisory: string | null): void {
  if (advisory !== null) ctx.advisories.push(advisory);
}

// ---- commit phase ----------------------------------------------------------

/**
 * Re-verify, immediately before ownership moves, that every published object is
 * still the exact one this transaction created and every retired pathname is
 * still free. A non-genie writer that raced the gap demotes the op to a
 * conflict: the foreign object stays live and unowned.
 */
function reverifyFlatAgentOps(ctx: FlatAgentTxnCtx, states: FlatAgentOpState[]): void {
  for (const state of states) {
    if (state.status !== 'applied') continue;
    const targetPath = join(ctx.dir, state.op.name);
    if (state.published !== null) {
      if (!agentPathSnapshotMatches(targetPath, state.published)) {
        state.published = null;
        markConflict(ctx, state, 'replaced-before-commit');
      }
    } else if (state.op.kind === 'retire' && lstatSafe(targetPath) !== null) {
      // The delta stays 'delete': ownership of the foreign replacement is relinquished.
      state.status = 'conflict';
      state.conflict = 'replaced-before-commit';
    }
  }
}

function buildFlatAgentClaim(ctx: FlatAgentTxnCtx, states: FlatAgentOpState[]): Record<string, AgentFileManifestEntry> {
  const files: Record<string, AgentFileManifestEntry> = { ...ctx.baseFiles };
  for (const state of states) {
    if (state.delta === null) continue;
    if (state.delta === 'set' && state.op.kind === 'publish') files[state.op.name] = state.op.entry;
    else delete files[state.op.name];
  }
  return files;
}

function manifestPayload(files: Record<string, AgentFileManifestEntry>): Buffer {
  const manifest: AgentFilesManifest = { managedBy: MANAGED_BY, files };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

interface ManifestCommitResult {
  committed: boolean;
  reason?: string;
}

/** The single ownership commit; false means every ownership delta must roll back. */
function commitFlatAgentManifest(ctx: FlatAgentTxnCtx, base: AgentManifestState, states: FlatAgentOpState[]): boolean {
  if (!states.some((state) => state.delta !== null)) return true;
  const provisional = buildFlatAgentClaim(ctx, states);
  const result =
    Object.keys(provisional).length > 0
      ? commitFlatAgentManifestWrite(ctx, base, states, provisional)
      : commitFlatAgentManifestRemoval(ctx, base, states);
  if (!result.committed) {
    ctx.advisories.push(`agent manifest ${join(ctx.dir, MANIFEST_NAME)} commit failed: ${result.reason}`);
  }
  return result.committed;
}

/**
 * Write path: stage exclusively → barrier → re-verify live objects → CAS the
 * base manifest out of the way → RENAME the payload in. The rename both decides
 * the outcome and consumes the staged payload, so no second hardlink to the
 * manifest can ever exist; everything after it is advisory-only.
 */
function commitFlatAgentManifestWrite(
  ctx: FlatAgentTxnCtx,
  base: AgentManifestState,
  states: FlatAgentOpState[],
  provisional: Record<string, AgentFileManifestEntry>,
): ManifestCommitResult {
  const manifestPath = join(ctx.dir, MANIFEST_NAME);
  let stage = createFileStage(manifestPath, manifestPayload(provisional));
  try {
    ctx.seams.beforeManifestCommit?.({ path: manifestPath, stagePath: stage.path });
  } catch (error) {
    pushAdvisory(ctx, cleanupFileStage(stage));
    return { committed: false, reason: errMsg(error) };
  }
  if (!fileStageOwned(stage)) {
    pushAdvisory(ctx, cleanupFileStage(stage));
    return { committed: false, reason: 'staged manifest payload changed before commit' };
  }
  reverifyFlatAgentOps(ctx, states);
  const claim = buildFlatAgentClaim(ctx, states);
  if (Object.keys(claim).length === 0) {
    // every remaining claim was demoted at the barrier — fall back to removal
    pushAdvisory(ctx, cleanupFileStage(stage));
    if (base.kind === 'absent') return { committed: true };
    return removeBaseManifestExact(ctx, base, manifestPath, false);
  }
  const payload = manifestPayload(claim);
  if (!payload.equals(stage.bytes)) {
    pushAdvisory(ctx, cleanupFileStage(stage));
    stage = createFileStage(manifestPath, payload);
  }
  let captured: CapturedPath | null = null;
  if (base.kind !== 'absent') {
    captured = capturePath(manifestPath, 'manifest-old');
    if (captured === null || !manifestStillBase(captured.path, base)) {
      if (captured !== null) restorePreviousManifest(ctx, captured, manifestPath);
      pushAdvisory(ctx, cleanupFileStage(stage));
      return { committed: false, reason: 'manifest ownership changed before commit' };
    }
  }
  try {
    renameSync(stage.path, manifestPath);
  } catch (error) {
    if (captured !== null) restorePreviousManifest(ctx, captured, manifestPath);
    pushAdvisory(ctx, cleanupFileStage(stage));
    return { committed: false, reason: errMsg(error) };
  }
  // Outcome decided at the rename. Nothing below may throw or roll back.
  if (captured !== null) {
    try {
      removeCapturedPath(captured);
    } catch (error) {
      ctx.advisories.push(`previous manifest left quarantined at ${captured.path}: ${errMsg(error)}`);
    }
  }
  try {
    removeEmptyDirSafe(stage.dir);
  } catch {
    // empty-stage-dir debris is inert; the payload itself was consumed by the rename
  }
  return { committed: true };
}

/** Removal path: the transaction ends with zero owned names — the manifest itself goes. */
function commitFlatAgentManifestRemoval(
  ctx: FlatAgentTxnCtx,
  base: AgentManifestState,
  states: FlatAgentOpState[],
): ManifestCommitResult {
  reverifyFlatAgentOps(ctx, states);
  if (base.kind === 'absent') return { committed: true };
  return removeBaseManifestExact(ctx, base, join(ctx.dir, MANIFEST_NAME), true);
}

/**
 * Remove the base manifest as the final ownership relinquish. The live pathname
 * is re-checked before AND after the unlink: success is reported only when no
 * manifest object exists there anymore, so a concurrently installed replacement
 * can never ride a false-success relinquish.
 */
function removeBaseManifestExact(
  ctx: FlatAgentTxnCtx,
  base: AgentManifestState,
  manifestPath: string,
  fireBarrier: boolean,
): ManifestCommitResult {
  const captured = capturePath(manifestPath, 'manifest-remove');
  if (fireBarrier) {
    try {
      ctx.seams.beforeManifestCommit?.({ path: manifestPath, stagePath: captured?.path ?? manifestPath });
    } catch (error) {
      if (captured !== null) restorePreviousManifest(ctx, captured, manifestPath);
      return { committed: false, reason: errMsg(error) };
    }
  }
  if (captured === null || !manifestStillBase(captured.path, base)) {
    if (captured !== null) restorePreviousManifest(ctx, captured, manifestPath);
    return { committed: false, reason: 'manifest ownership changed before commit' };
  }
  if (lstatSafe(manifestPath) !== null) {
    restorePreviousManifest(ctx, captured, manifestPath);
    return { committed: false, reason: 'manifest ownership changed before commit: a replacement manifest appeared' };
  }
  removeCapturedPath(captured);
  if (lstatSafe(manifestPath) !== null) {
    return { committed: false, reason: 'manifest ownership changed before commit: a replacement manifest appeared' };
  }
  return { committed: true };
}

function restorePreviousManifest(ctx: FlatAgentTxnCtx, captured: CapturedPath, manifestPath: string): void {
  const preserved = restoreOrPreserveCaptured(captured, manifestPath);
  if (preserved !== null && preserved !== manifestPath) {
    ctx.advisories.push(`preserved previous manifest at ${preserved}`);
  }
}

// ---- finalize / rollback ----------------------------------------------------

/**
 * Success path: dispose captured prior objects. Discard re-verifies the exact
 * captured identity at the instant of unlink — bytes that changed after
 * validation are parked visibly instead of being discarded.
 */
function finalizeFlatAgentOps(ctx: FlatAgentTxnCtx, states: FlatAgentOpState[]): void {
  for (const state of states) {
    const captured = state.captured;
    if (captured === null) continue;
    state.captured = null;
    const targetPath = join(ctx.dir, state.op.name);
    try {
      finalizeCapturedDisposal(ctx, state, captured, targetPath);
    } catch (error) {
      // Disposal failure never fails the committed transaction or hides bytes.
      ctx.advisories.push(`prior agent bytes for ${targetPath} left quarantined at ${captured.path}: ${errMsg(error)}`);
    }
  }
}

function finalizeCapturedDisposal(
  ctx: FlatAgentTxnCtx,
  state: FlatAgentOpState,
  captured: CapturedPath,
  targetPath: string,
): void {
  const keepAside = state.op.kind === 'retire' ? state.op.disposal === 'keep-aside' : state.status === 'conflict';
  if (keepAside) {
    const kept = keepAsideCaptured(captured, targetPath, ctx.seams.now);
    state.keptPath = kept ?? undefined;
    if (kept === null) ctx.advisories.push(`preserved prior agent bytes at ${captured.path}`);
    return;
  }
  disposeCapturedExact(ctx, state, captured, targetPath);
}

function disposeCapturedExact(
  ctx: FlatAgentTxnCtx,
  state: FlatAgentOpState,
  captured: CapturedPath,
  targetPath: string,
): void {
  if (state.op.kind !== 'disown' && agentPathSnapshotMatches(captured.path, state.op.expected)) {
    removeCapturedPath(captured);
    return;
  }
  const kept = keepAsideCaptured(captured, targetPath, ctx.seams.now);
  state.keptPath = kept ?? undefined;
  ctx.advisories.push(
    `agent bytes for ${targetPath} changed after validation; preserved at ${kept ?? captured.path} instead of discarding`,
  );
}

/**
 * Commit-failure path: every published object that is still exactly ours is
 * un-published and the prior object restored; foreign objects that appeared
 * meanwhile stay live while prior bytes are parked visibly.
 */
function rollbackFlatAgentOps(ctx: FlatAgentTxnCtx, states: FlatAgentOpState[]): void {
  for (const state of [...states].reverse()) {
    const targetPath = join(ctx.dir, state.op.name);
    try {
      rollbackFlatAgentOp(ctx, state, targetPath);
    } catch (error) {
      // A rollback failure on one name never strands the rest of the batch.
      const captured = state.captured;
      state.captured = null;
      ctx.advisories.push(
        `rollback for ${targetPath} incomplete${
          captured === null ? '' : `; prior bytes quarantined at ${captured.path}`
        }: ${errMsg(error)}`,
      );
    }
  }
}

function rollbackFlatAgentOp(ctx: FlatAgentTxnCtx, state: FlatAgentOpState, targetPath: string): void {
  if (state.published !== null) unpublishFlatAgent(ctx, state, targetPath);
  const captured = state.captured;
  if (captured === null) return;
  state.captured = null;
  try {
    if (restoreCapturedPathNoReplace(captured.path, targetPath)) {
      removeEmptyDirSafe(captured.dir);
      return;
    }
    const kept = keepAsideCaptured(captured, targetPath, ctx.seams.now);
    state.keptPath = kept ?? undefined;
    ctx.advisories.push(`manifest commit failed; preserved prior managed agent at ${kept ?? captured.path}`);
  } catch (error) {
    ctx.advisories.push(`prior agent bytes for ${targetPath} left quarantined at ${captured.path}: ${errMsg(error)}`);
  }
}

function unpublishFlatAgent(ctx: FlatAgentTxnCtx, state: FlatAgentOpState, targetPath: string): void {
  const current = capturePath(targetPath, 'agent-rollback');
  if (current === null) return;
  if (state.published !== null && agentPathSnapshotMatches(current.path, state.published)) {
    removeCapturedPath(current);
    return;
  }
  const preserved = restoreOrPreserveCaptured(current, targetPath);
  if (preserved !== null && preserved !== targetPath) {
    ctx.advisories.push(`preserved concurrent agent replacement at ${preserved}`);
  }
}

// ---- sync driver -----------------------------------------------------------

/**
 * Converge flat source agent files without replacing their shared parent dir.
 * Only names in source or in the shared manifest are candidates for mutation;
 * every unrelated sibling in `~/.claude/agents` remains invisible. All ops run
 * in ONE transaction with a single ownership commit.
 */
function syncClaudeAgentFiles(ctx: RunContext, claudeDir: string, report: AgentReport): void {
  const sourceAgents = enumerateSourceAgentFiles(ctx.pluginRoot);
  const targetDir = join(claudeDir, 'agents');
  const initialState = inspectAgentFilesManifest(targetDir);
  if (initialState.kind === 'unsafe') {
    report.advisories.push(`agent manifest ${initialState.path} is unsafe (${initialState.reason}); left untouched`);
    return;
  }
  const existingManifest = initialState.kind === 'managed' ? initialState.manifest : null;
  if (sourceAgents.length === 0 && existingManifest === null) return;

  mkdirSync(targetDir, { recursive: true });
  if (initialState.kind === 'foreign') {
    const backup = ctx.backupBytes('claude', join('agents', MANIFEST_NAME), initialState.bytes);
    report.advisories.push(`adopted foreign agent manifest after backing it up to ${backup}`);
  }
  const plan = buildClaudeAgentPlan(ctx, sourceAgents, targetDir, existingManifest?.files ?? {}, report);
  if (plan.ops.length === 0) return;
  const result = runFlatAgentTransaction(targetDir, plan.ops, {
    now: ctx.now,
    beforeFileMutation: ctx.beforeAgentFileMutation,
    beforeManifestCommit: ctx.beforeAgentManifestCommit,
  });
  report.advisories.push(...result.advisories);
  if (!result.committed) {
    recordFailure(report, `claude agent transaction did not commit under ${targetDir}`);
  }
  reportClaudeAgentOutcomes(result, plan.orphanActions, report);
}

interface ClaudeAgentPlan {
  ops: FlatAgentOp[];
  /** Reporting action for each disown op: absent orphans read as removed. */
  orphanActions: Map<string, 'removed' | 'kept-modified-orphan'>;
}

function buildClaudeAgentPlan(
  ctx: RunContext,
  sourceAgents: SourceAgentFile[],
  targetDir: string,
  baseFiles: Record<string, AgentFileManifestEntry>,
  report: AgentReport,
): ClaudeAgentPlan {
  const ops: FlatAgentOp[] = [];
  const orphanActions: ClaudeAgentPlan['orphanActions'] = new Map();
  const sourceNames = new Set(sourceAgents.map((agent) => agent.name));
  for (const source of sourceAgents) {
    try {
      const op = planAgentPublish(ctx, source, targetDir, baseFiles[source.name]);
      if (op === 'unchanged') report.extras.push({ kind: 'agent', action: 'unchanged', detail: source.name });
      else ops.push(op);
    } catch (err) {
      const failure = `agent ${source.name} (claude) failed: ${errMsg(err)}`;
      report.advisories.push(failure);
      recordFailure(report, failure);
    }
  }
  for (const [name, entry] of Object.entries(baseFiles).sort(([a], [b]) => a.localeCompare(b))) {
    if (sourceNames.has(name)) continue;
    try {
      ops.push(planAgentOrphan(ctx, targetDir, name, entry, orphanActions));
    } catch (err) {
      const failure = `agent orphan ${name} (claude) failed: ${errMsg(err)}`;
      report.advisories.push(failure);
      recordFailure(report, failure);
    }
  }
  return { ops, orphanActions };
}

/**
 * Per-file policy mirrors managed skill dirs without ever swapping the parent:
 * missing creates; clean+same skips; clean+changed updates; anything else is
 * backed up before adoption. The snapshot the policy validated is the exact
 * CAS target of the later publish.
 */
function planAgentPublish(
  ctx: RunContext,
  source: SourceAgentFile,
  targetDir: string,
  entry: AgentFileManifestEntry | undefined,
): FlatAgentOp | 'unchanged' {
  // Read first: a source read failure must leave an existing target untouched.
  const payload = readFileSync(source.path);
  const sourceDigest = hashBytes(payload);
  const targetPath = join(targetDir, source.name);
  const expected = captureAgentPathSnapshot(targetPath);
  const manifestEntry = buildAgentFileManifestEntry(ctx, sourceDigest);
  if (expected.kind === 'absent') {
    return { kind: 'publish', name: source.name, payload, entry: manifestEntry, expected, action: 'created' };
  }
  const targetDigest = expected.kind === 'file' ? expected.digest : null;
  if (entry !== undefined && targetDigest === entry.digest) {
    if (sourceDigest === entry.digest) return 'unchanged';
    return { kind: 'publish', name: source.name, payload, entry: manifestEntry, expected, action: 'updated' };
  }
  const backupPath = backupAgentSnapshot(ctx, source.name, targetPath, expected);
  return { kind: 'publish', name: source.name, payload, entry: manifestEntry, expected, action: 'adopted', backupPath };
}

/** Back up exactly the bytes the policy validated; non-file objects fall back to a path copy. */
function backupAgentSnapshot(ctx: RunContext, name: string, targetPath: string, expected: AgentPathSnapshot): string {
  if (expected.kind === 'file') return ctx.backupBytes('claude', join('agents', name), expected.bytes);
  return ctx.backupInto('claude', join('agents', name), targetPath);
}

/**
 * A source orphan is deleted only when its live regular-file bytes still match
 * the entry that owns it. Modified/non-file targets stay byte-for-byte in place
 * and only lose their manifest entry, relinquishing ownership.
 */
function planAgentOrphan(
  ctx: RunContext,
  targetDir: string,
  name: string,
  entry: AgentFileManifestEntry,
  orphanActions: ClaudeAgentPlan['orphanActions'],
): FlatAgentOp {
  const targetPath = join(targetDir, name);
  const expected = captureAgentPathSnapshot(targetPath);
  if (expected.kind === 'file' && expected.digest === entry.digest) {
    const backupPath = ctx.backupBytes('claude', join('agents', name), expected.bytes);
    return {
      kind: 'retire',
      name,
      expected,
      ownedDigest: entry.digest,
      disposal: 'discard',
      operation: 'remove',
      backupPath,
    };
  }
  orphanActions.set(name, expected.kind === 'absent' ? 'removed' : 'kept-modified-orphan');
  return { kind: 'disown', name, ownedDigest: entry.digest, prune: false };
}

function reportClaudeAgentOutcomes(
  result: FlatAgentTransactionResult,
  orphanActions: ClaudeAgentPlan['orphanActions'],
  report: AgentReport,
): void {
  for (const outcome of result.outcomes) {
    const name = outcome.op.name;
    if (outcome.status === 'failed') {
      const failure = `agent ${name} (claude) failed: ${outcome.reason ?? 'unknown failure'}`;
      report.advisories.push(failure);
      recordFailure(report, failure);
      continue;
    }
    if (outcome.status === 'stale') {
      report.advisories.push(`agent ${name} (claude) skipped: ${outcome.reason ?? 'stale classification'}`);
      continue;
    }
    if (!result.committed) continue; // rolled back — nothing happened for this name
    report.extras.push({ kind: 'agent', action: claudeAgentAction(outcome, orphanActions), detail: name });
    pushClaudeAgentConflictAdvisories(outcome, report);
    if (outcome.op.kind === 'disown' && orphanActions.get(name) === 'kept-modified-orphan') {
      report.advisories.push(`kept modified orphan ${name} (claude agents); relinquished manifest ownership`);
    }
  }
}

function claudeAgentAction(outcome: FlatAgentOutcome, orphanActions: ClaudeAgentPlan['orphanActions']): SkillAction {
  const { op, status } = outcome;
  if (op.kind === 'publish') return status === 'applied' ? op.action : 'skipped-unmanaged-kept';
  if (op.kind === 'retire') return status === 'applied' ? 'removed' : 'kept-modified-orphan';
  return orphanActions.get(op.name) ?? 'removed';
}

function pushClaudeAgentConflictAdvisories(outcome: FlatAgentOutcome, report: AgentReport): void {
  if (outcome.status !== 'conflict') return;
  const name = outcome.op.name;
  if (outcome.op.kind === 'publish') {
    report.advisories.push(
      `kept concurrently changed agent ${name} (claude agents); it was not published or claimed by the managed manifest`,
    );
    return;
  }
  report.advisories.push(
    outcome.conflict === 'changed-before-capture'
      ? `kept concurrently changed orphan ${name} (claude agents)`
      : `kept concurrently changed orphan ${name} (claude agents); relinquished ownership`,
  );
}

/**
 * Type-aware stable snapshot of one live path: identity (dev/ino/mode/nlink)
 * plus content (bytes / dir digest / symlink target). Exported: uninstall
 * classification captures the exact snapshots its removal ops later CAS on.
 */
export function captureAgentPathSnapshot(path: string): AgentPathSnapshot {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return { kind: 'absent' };
    throw error;
  }
  if (before.isFile()) {
    const bytes = readFileSync(path);
    const after = lstatSync(path);
    if (!samePathIdentity(before, after)) throw new Error(`agent path changed while reading ${path}`);
    return { kind: 'file', stat: after, bytes, digest: hashBytes(bytes) };
  }
  if (before.isDirectory()) return { kind: 'directory', stat: before, digest: computeDirDigest(path) };
  if (before.isSymbolicLink()) return { kind: 'symlink', stat: before, target: readlinkSync(path) };
  return { kind: 'other', stat: before };
}

/** Any inspection failure reads as a mismatch, biasing every caller toward preservation. */
function agentPathSnapshotMatches(path: string, expected: AgentPathSnapshot): boolean {
  try {
    return sameAgentPathSnapshot(expected, captureAgentPathSnapshot(path));
  } catch {
    return false;
  }
}

function sameAgentPathSnapshot(expected: AgentPathSnapshot, current: AgentPathSnapshot): boolean {
  if (expected.kind !== current.kind) return false;
  if (expected.kind === 'absent' || current.kind === 'absent') return true;
  if (!samePathIdentity(expected.stat, current.stat)) return false;
  if (expected.kind === 'file' && current.kind === 'file') return expected.bytes.equals(current.bytes);
  if (expected.kind === 'directory' && current.kind === 'directory') return expected.digest === current.digest;
  if (expected.kind === 'symlink' && current.kind === 'symlink') return expected.target === current.target;
  return true;
}

function samePathIdentity(expected: Stats, current: Stats): boolean {
  return (
    expected.dev === current.dev &&
    expected.ino === current.ino &&
    expected.mode === current.mode &&
    expected.nlink === current.nlink
  );
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ============================================================================
// Workflow stamp (parity-locked to council-stamp.cjs)
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
  syncClaudeAgentFiles(ctx, claudeDir, report);
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

// The codex writer (`syncCodex`) that used to live here is retired: codex
// product skills are plugin-only, converged end-to-end by
// `installCodexIntegration` in runtime-integrations.ts (plugin → health proof
// → fallback retirement → role agents). `runAgentSync` has no `codex` arm, so
// this module never writes into `~/.agents/skills` again (R2/A1, structural).
// The classifier/retirement primitives that flow — `codexLegacyCuratedDir`,
// `inspectManagedSkillTree`, `planCodexFallbackRetirement`,
// `applyCodexFallbackRetirement`, `recoverCodexFallbackRetirements` — remain:
// they are shared with `genie uninstall` and `genie doctor`, which read/repair
// that tier independently of this file's write path.

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
function acquireFileLock(lockPath: string): { release: () => void } | { skipped: string } {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = tryInitializeFileLock(lockPath);
    if (created.status === 'acquired') return created.lock;
    if (created.status === 'failed') return { skipped: created.reason };
    const stat = statSafe(lockPath);
    if (stat === null) continue; // holder released between open and stat — retry
    if (!isStaleOrInvalidLockTime(stat.mtimeMs)) return heldLockSkip();
    // Age alone never proves abandonment. A slow or clock-skewed live owner
    // retains the lock regardless of whether its timestamp is old or future.
    if (lockHasLiveOwner(lockPath)) return heldLockSkip();
    if (stealStaleFileLock(lockPath) === 'contended') return heldLockSkip();
    // stale debris cleared — loop and retry the exclusive create
  }
  return { skipped: 'agent-sync lock remained contended after retries; skipped safely' };
}

type LockCreateAttempt =
  | { status: 'acquired'; lock: { release: () => void } }
  | { status: 'exists' }
  | { status: 'failed'; reason: string };

function tryInitializeFileLock(lockPath: string): LockCreateAttempt {
  let fd: number;
  const token = randomBytes(16).toString('hex');
  const processIdentity = processStartIdentity(process.pid) ?? 'unknown';
  // Host identity is appended as a 4th field so a lock created on one host can
  // never be stolen from another on an NFS / pid-namespace-shared $HOME. The
  // shell installer (install.sh) writes only the 3-field `pid:token:unknown`
  // form and parses just the leading pid, so a 4th field is backward-compatible
  // both ways: {@link lockOwner} reads it, the shell ignores it.
  const ownerRecord = `${process.pid}:${token}:${processIdentity}:${currentSyncLockHostId()}`;
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

/**
 * Parse current `pid:token:start:host` locks plus every legacy form
 * (`pid:token:start`, `pid:token`, `pid`) and the shell's `pid:token:unknown`.
 * `host` is absent (→ null) for any record written before this field existed or
 * by the shell installer; a null host is treated as "unknown host" downstream.
 */
interface LockOwner {
  pid: number;
  processIdentity: string | null;
  host: string | null;
}

function parseLockOwner(raw: string | null): LockOwner | null {
  const match = raw?.match(/^(\d+)(?::[a-f0-9]{32})?(?::([a-f0-9]{64}|unknown))?(?::([a-f0-9]{64}))?$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0
    ? { pid, processIdentity: match[2] ?? null, host: match[3] ?? null }
    : null;
}

function lockOwner(lockPath: string): LockOwner | null {
  return parseLockOwner(readTrimmed(lockPath));
}

/**
 * Never steal a live lock. Beyond PID-reuse rejection via the process-start
 * identity, a recorded HOST identity that DIFFERS from this host is treated as a
 * live owner and never stolen: `process.kill`/`ps` liveness on THIS host says
 * nothing about a peer on an NFS- or pid-namespace-shared $HOME, so a locally
 * "dead" pid cannot authorize stealing a lock a remote host may still hold. The
 * fail-closed asymmetry is deliberate — a wrongly-kept stale lock costs one
 * manual `rm`; a wrongly-stolen live lock costs a silent double writer.
 *
 * Deliberate scope decision (host-less records): a record with NO host field —
 * pre-this-change debris OR the shell installer's `pid:token:unknown` — falls
 * through to the legacy pid + start-identity liveness rather than being refused
 * outright. This preserves the shipped, tested shell<->TS lifecycle-lock parity
 * contract (install.sh writes and reaps host-less records by pid+mtime; the
 * guard-debris parity test in update.test.ts pins it). Refusing host-less steals
 * in TS alone would desynchronize the two acquirers AND still leave the shell
 * able to cross-host-steal — trading a real regression for incomplete safety.
 * Because every lock written after this change carries a host field — INCLUDING
 * every retirement lock (TS-only) and every post-upgrade agent-sync/lifecycle
 * lock — cross-host steal is prevented everywhere it can actually occur; only
 * transient legacy/shell-shaped records retain the prior semantics, in lockstep
 * with the shell.
 */
function lockHasLiveOwner(lockPath: string): boolean {
  return lockOwnerIsLive(lockOwner(lockPath));
}

function lockOwnerIsLive(owner: LockOwner | null): boolean {
  if (owner === null) return false; // empty / unparseable record is genuine dead-writer debris
  if (owner.host !== null && owner.host !== currentSyncLockHostId()) return true; // host-bearing + cross-host → never steal
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

let cachedSyncLockHostId: string | null = null;

/**
 * A stable identity for THIS host, embedded in every lock owner record so a
 * cross-host stealer can recognize "not my host" and refuse to steal. It is the
 * sha256 of the hostname plus, on linux, the kernel boot id
 * (`/proc/sys/kernel/random/boot_id`) — so a reused hostname across reboots
 * still yields distinct identities where the boot id is readable. Coverage is
 * scoped to distinct-hostname/distinct-kernel hosts: same-kernel containers
 * SHARE the boot id (runc/containerd do not namespace it), so two containers
 * with a pinned identical hostname and a shared $HOME collapse to one host id
 * and fall back to pid-liveness semantics across pid namespaces. The boot id is
 * best-effort: an empty read degrades to hostname-only, which is still
 * host-scoped. Exported for tests that must forge same-host vs cross-host owner
 * records.
 */
export function currentSyncLockHostId(): string {
  if (cachedSyncLockHostId !== null) return cachedSyncLockHostId;
  let bootId = '';
  if (process.platform === 'linux') {
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      bootId = '';
    }
  }
  cachedSyncLockHostId = createHash('sha256').update(`${hostname()}\0${bootId}`).digest('hex');
  return cachedSyncLockHostId;
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
  const acquired = acquireFileLock(path);
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
function stealStaleFileLock(lockPath: string): 'cleared' | 'contended' {
  const guardPath = `${lockPath}.steal`;
  const guardAttempt = tryInitializeFileLock(guardPath);
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
// Generation-safe shared agent mutation lock
// ============================================================================

/**
 * Acquire the per-GENIE_HOME sync lock via O_EXCL create. Returns a release
 * handle, or null when another live sync holds the lock (the caller must skip).
 * An out-of-window lock is stealable only when its host/PID/start record is not
 * live. It is captured via {@link stealStaleAgentLock}, then exclusive create
 * is retried. Any acquisition failure other than contention fails closed with
 * an {@link AgentSyncLockError}; protected mutation never proceeds unlocked.
 */
function acquireAgentMutationLock(lockPath: string, options: AgentSyncLockOptions): { release: () => void } | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owned = createOwnedLockDirectory(lockPath, options);
    if (owned !== null) {
      return { release: () => releaseOwnedSyncLock(lockPath, owned, options, 'release') };
    }
    const observed = inspectLockObject(lockPath);
    if (observed === null) continue; // holder released between exclusive-create and inspection
    if (!isStaleOrInvalidLockTime(observed.stat.mtimeMs)) return null;
    if (observed.kind === 'foreign') return null;
    if (observed.kind === 'legacy-file') {
      // Upgrade compatibility retains the current dev lock protocol's
      // cross-host/PID liveness rule. A generation lock is self-identifying by
      // its owner pathname, while a legacy file carries this record in bytes.
      if (lockHasLiveOwner(lockPath)) return null;
      if (stealLegacyStaleLock(lockPath, observed, options) === 'contended') return null;
      continue;
    }
    if (lockOwnerIsLive(parseLockOwner(observed.token.trim()))) return null;
    if (stealStaleAgentLock(lockPath, observed, options) === 'contended') return null;
    // stale owner token was removed; retry the atomic generation publish
  }
  return null; // lost the steal race to another process whose lock is now fresh
}

interface OwnedLockDirectory {
  kind: 'owned-directory';
  ownerName: string;
  ownerPath: string;
  stat: Stats;
  token: string;
}

interface LegacyLockFile {
  kind: 'legacy-file';
  stat: Stats;
  bytes: Buffer;
}

interface ForeignLockObject {
  kind: 'foreign';
  stat: Stats;
}

/** Publish one non-empty lock generation atomically; existing objects are contention. */
function createOwnedLockDirectory(lockPath: string, options: AgentSyncLockOptions): OwnedLockDirectory | null {
  let stageDir: string;
  try {
    stageDir = mkdtempSync(`${lockPath}.stage-`);
  } catch (error) {
    throw new AgentSyncLockError(
      `could not acquire agent-sync lock; acquisition failed closed for ${lockPath}: ${errMsg(error)}`,
      error,
    );
  }
  const token = `${process.pid}:${randomBytes(16).toString('hex')}:${
    processStartIdentity(process.pid) ?? 'unknown'
  }:${currentSyncLockHostId()}\n`;
  const ownerName = `owner-${hashBytes(Buffer.from(token)).slice(0, 32)}`;
  const stagedOwnerPath = join(stageDir, ownerName);
  try {
    writeExclusiveFile(stagedOwnerPath, Buffer.from(token));
  } catch (error) {
    removeEmptyDirSafe(stageDir);
    throw new AgentSyncLockError(
      `agent-sync lock initialization failed closed for ${lockPath}: ${errMsg(error)}`,
      error,
    );
  }
  const stagedStat = lstatSync(stagedOwnerPath);
  try {
    options.beforePublish?.({ path: lockPath });
    renameSync(stageDir, lockPath);
  } catch (error) {
    unlinkExactOwnedLockFile(stagedOwnerPath, stagedStat, token);
    removeEmptyDirSafe(stageDir);
    if (lstatSafe(lockPath) !== null) return null;
    throw new AgentSyncLockError(`agent-sync lock publish failed closed for ${lockPath}: ${errMsg(error)}`, error);
  }
  const ownerPath = join(lockPath, ownerName);
  const current = inspectOwnedLockFile(ownerPath);
  if (current === null || !sameOwnedLock(stagedStat, token, current)) {
    throw new AgentSyncLockError(`agent-sync lock ownership could not be verified for ${lockPath}`);
  }
  return { kind: 'owned-directory', ownerName, ownerPath, stat: current.stat, token };
}

function inspectLockObject(lockPath: string): OwnedLockDirectory | LegacyLockFile | ForeignLockObject | null {
  try {
    const stat = lstatSync(lockPath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
      const bytes = readFileSync(lockPath);
      const after = lstatSync(lockPath);
      if (!samePathIdentity(stat, after)) throw new AgentSyncLockError('legacy agent-sync lock changed while reading');
      return { kind: 'legacy-file', stat: after, bytes };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: 'foreign', stat };
    const owners = readdirSync(lockPath).filter((name) => name.startsWith('owner-'));
    if (owners.length !== 1 || readdirSync(lockPath).length !== 1) return { kind: 'foreign', stat };
    const ownerName = owners[0] as string;
    const ownerPath = join(lockPath, ownerName);
    const owner = inspectOwnedLockFile(ownerPath);
    if (owner === null) throw new AgentSyncLockError(`agent-sync lock owner disappeared at ${ownerPath}`);
    return { kind: 'owned-directory', ownerName, ownerPath, stat: owner.stat, token: owner.token };
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return null;
    if (error instanceof AgentSyncLockError) throw error;
    throw new AgentSyncLockError(`agent-sync lock inspection failed closed for ${lockPath}: ${errMsg(error)}`, error);
  }
}

function inspectOwnedLockFile(ownerPath: string): { stat: Stats; token: string } | null {
  try {
    const before = lstatSync(ownerPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return null;
    const token = readFileSync(ownerPath, 'utf8');
    const after = lstatSync(ownerPath);
    if (!samePathIdentity(before, after)) return null;
    return { stat: after, token };
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** Acquire the same per-GENIE_HOME mutation lock used by sync and uninstall. */
export function acquireAgentSyncLock(
  genieHome: string,
  options: AgentSyncLockOptions = {},
): { release: () => void } | null {
  return acquireAgentMutationLock(join(genieHome, AGENT_SYNC_LOCK_NAME), options);
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
function stealStaleAgentLock(
  lockPath: string,
  observed: OwnedLockDirectory,
  options: AgentSyncLockOptions,
): 'cleared' | 'contended' {
  if (!unlinkExactOwnedLockFile(observed.ownerPath, observed.stat, observed.token, options, 'stale-remove')) {
    return 'contended';
  }
  return removeEmptyLockGeneration(lockPath) ? 'cleared' : 'contended';
}

/** Upgrade-safe stale removal for the regular-file lock format shipped before generation directories. */
function stealLegacyStaleLock(
  lockPath: string,
  observed: LegacyLockFile,
  options: AgentSyncLockOptions,
): 'cleared' | 'contended' {
  const guard = acquireLegacyStealGuard(lockPath);
  if (guard === null) return 'contended';
  try {
    const current = inspectLegacyLockFile(lockPath);
    if (current === null) return 'cleared';
    if (
      !samePathIdentity(observed.stat, current.stat) ||
      !observed.bytes.equals(current.bytes) ||
      !isStaleOrInvalidLockTime(current.stat.mtimeMs) ||
      lockHasLiveOwner(lockPath)
    ) {
      return 'contended';
    }
    const captured = capturePath(lockPath, 'legacy-lock-stale');
    if (captured === null) return 'cleared';
    options.afterCapture?.({ operation: 'stale-remove', path: lockPath, capturedPath: captured.path });
    const capturedState = inspectLegacyLockFile(captured.path);
    if (
      capturedState === null ||
      !samePathIdentity(observed.stat, capturedState.stat) ||
      !observed.bytes.equals(capturedState.bytes)
    ) {
      restoreOrPreserveCaptured(captured, lockPath);
      return 'contended';
    }
    removeCapturedPath(captured);
    return 'cleared';
  } finally {
    guard.release();
  }
}

/** Preserve the current file-lock guard protocol while upgrading the payload capture to a pathname CAS. */
function acquireLegacyStealGuard(lockPath: string): { release: () => void } | null {
  const guardPath = `${lockPath}.steal`;
  const attempt = tryInitializeFileLock(guardPath);
  if (attempt.status === 'acquired') return attempt.lock;
  if (attempt.status === 'exists') {
    const guardStat = lstatSafe(guardPath);
    if (guardStat?.isFile() && isStaleOrInvalidLockTime(guardStat.mtimeMs) && !lockHasLiveOwner(guardPath)) {
      rmSyncSafe(guardPath);
    }
  }
  return null;
}

function inspectLegacyLockFile(path: string): LegacyLockFile | null {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return null;
    const bytes = readFileSync(path);
    const after = lstatSync(path);
    if (!samePathIdentity(before, after)) return null;
    return { kind: 'legacy-file', stat: after, bytes };
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** The token pathname is the ownership CAS; a replacement generation has a different owner name. */
function releaseOwnedSyncLock(
  lockPath: string,
  expected: OwnedLockDirectory,
  options: AgentSyncLockOptions,
  operation: AgentSyncLockMutationEvent['operation'],
): void {
  try {
    if (!unlinkExactOwnedLockFile(expected.ownerPath, expected.stat, expected.token, options, operation)) return;
    removeEmptyLockGeneration(lockPath);
  } catch {
    // Release is best-effort but fail-closed: any unverified object remains preserved.
  }
}

function unlinkExactOwnedLockFile(
  ownerPath: string,
  expectedStat: Stats,
  expectedToken: string,
  options: AgentSyncLockOptions = {},
  operation: AgentSyncLockMutationEvent['operation'] = 'release',
): boolean {
  const lockPath = dirname(ownerPath);
  let quarantineDir: string;
  try {
    quarantineDir = mkdtempSync(join(lockPath, '.owner-quarantine-'));
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) return false;
    throw error;
  }
  const capturedPath = join(quarantineDir, 'object');
  try {
    renameSync(ownerPath, capturedPath);
  } catch (error) {
    removeEmptyDirSafe(quarantineDir);
    if (isNodeErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
  options.afterCapture?.({ operation, path: lockPath, capturedPath });
  const current = inspectOwnedLockFile(capturedPath);
  if (current === null || !sameOwnedLock(expectedStat, expectedToken, current)) {
    restoreCapturedPathNoReplace(capturedPath, ownerPath);
    removeEmptyDirSafe(quarantineDir);
    return false;
  }
  unlinkSync(capturedPath);
  removeEmptyDirSafe(quarantineDir);
  return true;
}

function removeEmptyLockGeneration(lockPath: string): boolean {
  try {
    rmdirSync(lockPath);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return true;
    if (isNodeErrorCode(error, 'ENOTEMPTY') || isNodeErrorCode(error, 'EEXIST')) return false;
    throw error;
  }
}

function sameOwnedLock(expectedStat: Stats, expectedToken: string, current: { stat: Stats; token: string }): boolean {
  return samePathIdentity(expectedStat, current.stat) && expectedToken === current.token;
}

// ============================================================================
// Orchestration
// ============================================================================

/**
 * Converge every detected agent from the resolved source. Never throws for
 * agent-level failures; a null pluginRoot yields an empty report. Exactly one
 * run per GENIE_HOME may write at a time: a concurrent run returns a report
 * with `skipped` set and performs zero writes.
 *
 * R2/A1 is structural here, not caller discipline: there is no `codex` arm
 * below, so no `selection` value can ever make this function write into
 * `~/.agents/skills`. Codex product skills are plugin-only, converged
 * end-to-end by `installCodexIntegration` (plugin → health proof → fallback
 * retirement → role agents) in runtime-integrations.ts; the old codex writer
 * (`syncCodex`) is retired.
 */
export function runAgentSync(opts: AgentSyncOptions = {}): AgentSyncReport {
  const genieHome = opts.genieHome ?? resolveGenieHome();
  const source = resolveGenieSource(genieHome);
  const log = opts.log ?? (() => undefined);
  if (source.pluginRoot === null) {
    log('agent-sync: no genie plugin source found (looked for plugins/genie); skipping');
    return { source, agents: [], backupsDir: null };
  }
  let lock: { release: () => void } | null;
  try {
    lock = acquireAgentSyncLock(genieHome, opts.lockOptions);
  } catch (error) {
    const skipped = `agent-sync lock acquisition failed closed: ${errMsg(error)}`;
    log(`agent-sync: ${skipped}`);
    return { source, agents: [], backupsDir: null, skipped };
  }
  if (lock === null) {
    const skipped = 'another agent-sync run holds the lock; skipped (the holder converges the same targets)';
    log(`agent-sync: ${skipped}`);
    return { source, agents: [], backupsDir: null, skipped };
  }
  try {
    const ctx = createRunContext(genieHome, source.pluginRoot, source, opts);
    const selection = opts.selection ?? 'auto';
    const agents: AgentReport[] = [];
    if (selection === 'auto' || selection === 'all' || selection === 'claude') {
      agents.push(runAgentSafe('claude', (report) => syncClaude(ctx, report)));
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
  const backupDest = (agent: string, name: string): string => {
    if (backupsDir === null) {
      // Uninstall removes GENIE_HOME. Recovery material therefore lives in a
      // sibling root so a later uninstall cannot erase the only surviving copy.
      backupsDir = allocateExclusiveBackupRootAt(
        join(dirname(resolve(genieHome)), '.genie-recovery'),
        `agent-sync-${stamp}-${process.pid}`,
      );
    }
    const dest = join(backupsDir, agent, name);
    mkdirSync(dirname(dest), { recursive: true });
    return dest;
  };
  const backupInto = (agent: string, name: string, existingDir: string): string => {
    const dest = backupDest(agent, name);
    copyPathExclusive(existingDir, dest);
    return dest;
  };
  const backupBytes = (agent: string, name: string, bytes: Buffer): string => {
    const dest = backupDest(agent, name);
    writeExclusiveFile(dest, bytes);
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
    backupBytes,
    backupsDirIfCreated: () => backupsDir,
    renameManagedDir: opts.renameManagedDir ?? renameSync,
    beforeManagedDirPromotion: opts.beforeManagedDirPromotion,
    beforeManagedDirPublish: opts.beforeManagedDirPublish,
    beforeManagedDirRemoval: opts.beforeManagedDirRemoval,
    beforeAgentFileMutation: opts.beforeAgentFileMutation,
    beforeAgentManifestCommit: opts.beforeAgentManifestCommit,
  };
}

/**
 * Allocate a durable backup attempt root without opening or replacing any
 * existing artifact. Timestamp collisions simply advance to a fresh suffix.
 */
export function allocateExclusiveBackupRoot(genieHome: string, baseName: string): string {
  return allocateExclusiveBackupRootAt(join(genieHome, 'state-backups'), baseName);
}

function allocateExclusiveBackupRootAt(parent: string, baseName: string): string {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`unsafe backup root path: ${parent}`);
  }
  for (let collision = 0; collision < 10_000; collision += 1) {
    const candidate = collision === 0 ? join(parent, baseName) : join(parent, `${baseName}-${collision}`);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if (isNodeErrorCode(error, 'EEXIST')) continue;
      throw error;
    }
  }
  throw new Error(`could not allocate backup root for ${baseName}`);
}

/** Copy to a path that must not already exist; links and regular collisions are never followed or overwritten. */
function copyPathExclusive(source: string, destination: string): void {
  try {
    lstatSync(destination);
    throw new Error(`backup destination already exists: ${destination}`);
  } catch (error) {
    if (!isNodeErrorCode(error, 'ENOENT')) throw error;
  }
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
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

/**
 * Retirement infrastructure basenames a moved/restored entry name must never
 * collide with. The dot-prefixed infra (`.retirement.lock`, `.restore-staging`,
 * `.genie-codex-fallback-retirement`, every `.journal.*` temp) is already
 * excluded by the leading-dot rule below; these are the non-hidden ones.
 */
const RETIREMENT_INFRA_ENTRY_NAMES: ReadonlySet<string> = new Set([
  'journal.json',
  'quarantine',
  RETIREMENT_EVIDENCE_DIR,
]);

/**
 * A journal/skill entry name must be a single path component that can never name
 * the engine's own on-disk infrastructure. Rejecting dot-prefixed names (so
 * `.`, `..`, `.retirement.lock`, `.restore-staging`,
 * `.genie-codex-fallback-retirement`, and any `.journal.*` temp are refused) and
 * the reserved non-hidden infra names (`journal.json`, `quarantine`, `evidence`)
 * is a forged-journal defense: it is applied at BOTH plan time
 * ({@link planCodexFallbackRetirement}) and journal re-validation
 * ({@link validateRetirementPaths} / {@link readRetirementJournal}), so a
 * crafted `accepted[]`/`entries[]` can never steer a recovery move or restore
 * onto the transaction's own state. Suffixed evidence archives (`<skill>.2`) are
 * NOT dot-prefixed and remain valid.
 */
function isSafeEntryName(value: string): boolean {
  return (
    value !== '' &&
    !value.startsWith('.') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !RETIREMENT_INFRA_ENTRY_NAMES.has(value)
  );
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

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
