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
 * destructive step (adopt, remove) back up first, so nothing is ever lost.
 *
 * Everything is non-fatal: an adapter that throws is caught per-agent and
 * reported as an advisory; {@link runAgentSync} never throws for agent-level
 * failures.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { dirname, join, relative, resolve } from 'node:path';
import { resolveClaudeDir, resolveCodexDir, resolveGenieHome, resolveHermesHome } from './genie-home.js';

// ============================================================================
// Constants
// ============================================================================

/** Placeholder the /council template carries for its lens-card root. */
const PLACEHOLDER = '__GENIE_LENS_ROOT__';
/** Stamped/synced workflow filename. Exported: doctor/uninstall key their checks on it. */
export const TARGET_NAME = 'council.js';
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
 */
const CLAUDE_EXCLUDED_SKILLS = new Set(['council']);
/** Skill actions that represent an actual write to the target. */
const WRITE_ACTIONS = new Set<SkillAction>(['created', 'updated', 'adopted', 'removed']);
/**
 * Collision-proof staging suffixes for atomic managed-dir writes. Chosen so no
 * human backup convention (e.g. `mv review review.old`, or a `review.new`) can
 * ever collide with genie's staging tree — the pre-clean rmSync then only ever
 * removes genie's own crashed-run debris, never a user's sibling dir.
 */
const STAGING_SUFFIX = '.genie-sync.staging';
const PREV_SUFFIX = '.genie-sync.prev';
/** Cross-process mutual-exclusion lockfile under genieHome — one sync writer per GENIE_HOME. */
const LOCK_NAME = '.agent-sync.lock';
/** A lock older than this is a crashed run's debris and may be stolen. */
const LOCK_STALE_MS = 10 * 60 * 1000;
/**
 * SessionStart-hook throttle marker. The engine writes it at sync START (not
 * completion), so N simultaneous session starts back off immediately instead of
 * queueing behind the lock after the first run releases it.
 */
const MARKER_NAME = '.last-agent-sync';

// ============================================================================
// Public types
// ============================================================================

export interface AgentSyncOptions {
  /** Global genie root; defaults to {@link resolveGenieHome}. */
  genieHome?: string;
  /** Per-agent target dir overrides (tests inject tmpdirs here). */
  targets?: { claude?: string; codex?: string; hermes?: string };
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
}

export type SkillAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'adopted'
  | 'removed'
  | 'skipped-unmanaged-kept'
  | 'kept-modified-orphan';

export interface AgentReport {
  agent: 'claude' | 'codex' | 'hermes';
  detected: boolean;
  skills: Array<{ name: string; action: SkillAction; detail?: string }>;
  /** Non-skill outcomes: stamp / symlink / enable lines. */
  extras: Array<{ kind: string; action: string; detail?: string }>;
  advisories: string[];
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
  targets: { claude: string; codex: string; hermes: string };
  /** Copy `existingDir` into the run's backup root and return the backup path. */
  backupInto: (agent: string, name: string, existingDir: string) => string;
  /** The backup root path, or null when nothing has been backed up this run. */
  backupsDirIfCreated: () => string | null;
}

interface SourceSkill {
  name: string;
  dir: string;
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

function readManifest(dir: string): SyncManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8')) as Partial<SyncManifest>;
    if (parsed.managedBy === MANAGED_BY && typeof parsed.digest === 'string') {
      return {
        managedBy: MANAGED_BY,
        version: parsed.version ?? null,
        digest: parsed.digest,
        syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '',
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

/**
 * Copy `sourceDir` into `destDir` and stamp a fresh manifest, atomically. Stage
 * to `<dest>.genie-sync.staging`, rename the live tree to `<dest>.genie-sync.prev`,
 * rename staging into place, then delete the prev tree. The suffixes are
 * collision-proof (see {@link STAGING_SUFFIX}), so the pre-clean rmSync only ever
 * removes genie's own crashed-run debris — never a user's sibling backup dir.
 * Mirrors update.ts's swapAuxiliaryTree (reimplemented, not imported).
 */
function writeManagedDir(sourceDir: string, destDir: string, manifest: SyncManifest): void {
  const stageDir = `${destDir}${STAGING_SUFFIX}`;
  const oldDir = `${destDir}${PREV_SUFFIX}`;
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
  cpSync(sourceDir, stageDir, { recursive: true });
  writeManifest(stageDir, manifest);
  if (existsSync(destDir)) renameSync(destDir, oldDir);
  renameSync(stageDir, destDir);
  if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
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
  for (const skill of sourceSkills) {
    try {
      report.skills.push({ name: skill.name, action: syncOneSkill(ctx, agent, skill, targetParent) });
    } catch (err) {
      report.advisories.push(`skill ${skill.name} (${agent}) failed: ${errMsg(err)}`);
    }
  }
  removeManagedOrphans(ctx, agent, targetParent, sourceNames, report);
}

/**
 * Per-dir policy:
 *   absent                                        → create
 *   managed, files match manifest, source same    → unchanged (no writes)
 *   managed, files match manifest, source differs → update
 *   managed but files edited, OR unmanaged        → adopt-with-backup
 */
function syncOneSkill(ctx: RunContext, agent: string, skill: SourceSkill, targetParent: string): SkillAction {
  const destDir = join(targetParent, skill.name);
  const sourceDigest = computeDirDigest(skill.dir);
  const manifest = buildManifest(ctx, sourceDigest);
  if (!existsSync(destDir)) {
    writeManagedDir(skill.dir, destDir, manifest);
    return 'created';
  }
  const existing = readManifest(destDir);
  const currentDigest = computeDirDigest(destDir);
  if (existing !== null && currentDigest === existing.digest) {
    if (sourceDigest === existing.digest) return 'unchanged';
    writeManagedDir(skill.dir, destDir, manifest);
    return 'updated';
  }
  ctx.backupInto(agent, skill.name, destDir);
  writeManagedDir(skill.dir, destDir, manifest);
  return 'adopted';
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
  report: AgentReport,
): void {
  for (const entry of readdirSync(targetParent, { withFileTypes: true })) {
    if (entry.name.endsWith(STAGING_SUFFIX) || entry.name.endsWith(PREV_SUFFIX)) continue;
    const dir = join(targetParent, entry.name);
    if (classifyEntry(dir, entry) !== 'dir' || sourceNames.has(entry.name)) continue;
    const manifest = readManifest(dir);
    if (manifest === null) continue;
    if (computeDirDigest(dir) === manifest.digest) {
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
// Workflow stamp (parity-locked to council-stamp.cjs)
// ============================================================================

/**
 * Stamp the /council template's LENS_ROOT placeholder with `pluginRoot` and
 * write `<targetDir>/council.js`. Byte-identical output and idempotent-skip
 * semantics to plugins/genie/scripts/council-stamp.cjs (parity test locks it).
 */
export function stampWorkflow(opts: { templatePath: string; pluginRoot: string; targetDir: string }): {
  action: 'written' | 'skipped';
  targetPath: string;
} {
  const { templatePath, pluginRoot, targetDir } = opts;
  const template = readFileSync(templatePath, 'utf8');
  const stamped = template.split(PLACEHOLDER).join(pluginRoot);
  const targetPath = join(targetDir, TARGET_NAME);
  if (existsSync(targetPath) && readFileSync(targetPath, 'utf8') === stamped) {
    return { action: 'skipped', targetPath };
  }
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetPath, stamped, 'utf8');
  return { action: 'written', targetPath };
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
  const res = stampWorkflow({ templatePath, pluginRoot: ctx.pluginRoot, targetDir: join(claudeDir, 'workflows') });
  report.extras.push({ kind: 'stamp', action: res.action, detail: res.targetPath });
}

function syncCodex(ctx: RunContext, report: AgentReport): void {
  const codexDir = ctx.targets.codex;
  if (!existsSync(codexDir)) return;
  report.detected = true;
  // `.curated/` is genie's lane; `.system/` is OpenAI's and is never enumerated.
  syncSkillDirsInto(ctx, 'codex', join(codexDir, 'skills', '.curated'), report);
  if (report.skills.some((skill) => WRITE_ACTIONS.has(skill.action))) {
    report.advisories.push('restart Codex to pick up updated skills');
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
  const linkPath = join(hermesHome, 'profiles', active, 'plugins', 'genie');
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
 * handle, or null when another live sync holds the lock (the caller must skip).
 * A lock whose mtime is older than {@link LOCK_STALE_MS} is a crashed run's
 * debris: it is stolen (removed + one re-acquire attempt). If the lockfile
 * cannot be created for any reason other than contention (EACCES, EROFS, ...),
 * the sync proceeds UNLOCKED — locking is a safety net, never an availability
 * gate.
 */
function acquireSyncLock(lockPath: string): { release: () => void } | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return { release: () => rmSyncSafe(lockPath) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { release: () => undefined };
      const stat = statSafe(lockPath);
      if (stat === null) continue; // holder released between open and stat — retry once
      if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null; // live holder
      rmSyncSafe(lockPath); // stale crashed-run debris — steal and retry once
    }
  }
  return null; // lost the steal race to another process whose lock is now fresh
}

/** Best-effort start-of-sync refresh of the SessionStart-hook throttle marker. */
function touchMarkerSafe(markerPath: string, now: Date): void {
  try {
    writeFileSync(markerPath, `${now.toISOString()}\n`, 'utf8');
  } catch {
    // the marker only optimizes the hook throttle; never fail the sync over it.
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
  if (lock === null) {
    const skipped = 'another agent-sync run holds the lock; skipped (the holder converges the same targets)';
    log(`agent-sync: ${skipped}`);
    return { source, agents: [], backupsDir: null, skipped };
  }
  try {
    const ctx = createRunContext(genieHome, source.pluginRoot, source, opts);
    touchMarkerSafe(join(genieHome, MARKER_NAME), ctx.now());
    const agents: AgentReport[] = [
      runAgentSafe('claude', (report) => syncClaude(ctx, report)),
      runAgentSafe('codex', (report) => syncCodex(ctx, report)),
      runAgentSafe('hermes', (report) => syncHermes(ctx, opts, report)),
    ];
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
  };
  const stamp = now().toISOString();
  let backupsDir: string | null = null;
  const backupInto = (agent: string, name: string, existingDir: string): string => {
    if (backupsDir === null) {
      backupsDir = join(genieHome, 'state-backups', `agent-sync-${stamp}`);
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
    report.advisories.push(`${agent} sync failed: ${errMsg(err)}`);
  }
  return report;
}

// ============================================================================
// Small shared helpers
// ============================================================================

function emptyReport(agent: AgentReport['agent']): AgentReport {
  return { agent, detected: false, skills: [], extras: [], advisories: [] };
}

function lstatSafe(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
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
