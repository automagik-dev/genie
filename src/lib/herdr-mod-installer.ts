/**
 * The Herdr mod channel — the one way the Tasks board mod reaches Herdr.
 *
 * `genie install` / `genie update` copy the payload's `plugins/genie-herdr`
 * (staged inside the existing `plugins` payload member, already converged to
 * `<GENIE_HOME>/plugins` before this runs) into Herdr's mods folder,
 * `<Herdr app home>/mods/genie-herdr`, per file, with a sha256 of every
 * delivered file recorded in `skills-install.json` under the optional
 * `herdrMod` field (wish `genie-v7-board` group 3, decisions 10 and 22). The
 * mod therefore always matches the `genie-rs` it ships beside.
 *
 * It is the workflows channel's shape (`workflows-installer.ts`) applied to one
 * directory in another app's home, with these rules:
 *
 *  - CONSENT `none` skips the channel; so does a missing or malformed install
 *    record (no record, no install: a file genie cannot record is a file it can
 *    never remove), and so does a host with no Herdr app home — genie creates
 *    no product home (A18). The app home is `$HERDR_APP_HOME`, else
 *    `~/.config/herdr-app`.
 *  - NO MOD IN THE PAYLOAD is a skip, never an empty catalog (review r1
 *    MEDIUM-1): a dev release can carry this channel before the mod exists, and
 *    reading that as "the release ships no files" would retire every installed
 *    one. Nothing is removed and the record is left untouched.
 *  - BACKUP FIRST: a file matching neither the recorded nor the delivered digest
 *    is archived before it is replaced, under a FRESH root
 *    `<GENIE_HOME>/state-backups/herdr-mod-collision-<compact ISO>[-<n>]/`
 *    created exclusively — an existing root is never reused or written into,
 *    and an archived file is created without overwriting or following a link.
 *    A failed backup fails the channel before the target is touched. Equal
 *    bytes are left alone, so a rerun backs up nothing.
 *  - HANDS OFF: only delivered and recorded paths are ever touched. Herdr's own
 *    generated `gpui-kit.d.ts` and `jsconfig.json` are never delivered, read,
 *    archived or removed — a record that claims them loses that claim — and
 *    every undelivered file stays as is.
 *  - STALE FILES (A19): a recorded file the payload no longer ships is archived
 *    and removed, and dropped from the record. The criterion reads "a modified
 *    one is backed up first", so — unlike the workflows channel, which keeps a
 *    modified dropped file in place — a modified one is removed too, after its
 *    bytes are proven in the backup root.
 *
 * SYMLINK POLICY — the skills channel's rule ("allow a symlinked HOME, but
 * never follow a redirected agent home below it"), applied to both trees:
 *
 *  - The CONFIGURED ROOTS may be symlinks: `GENIE_HOME`, the Herdr app home,
 *    and any system alias above them (macOS `/var` → `/private/var`, a
 *    dotfiles-managed `~/.config`). The operator chose those paths, so every
 *    walk starts at the configured root and lets the OS resolve it.
 *  - EVERYTHING BELOW a configured root must be physical. Each directory
 *    component — `plugins/genie-herdr` in the payload, `mods/genie-herdr`, every
 *    nested directory of a delivered or recorded file, and `state-backups` — is
 *    checked with `lstat` before any read, write or removal through it. A
 *    redirected component (a symlink, or anything that is not a directory) is
 *    refused and left in place, never traversed: at a root it fails the channel
 *    with nothing written; below the mod root it preserves the one file behind
 *    it, keeping any recorded receipt.
 *  - Files are read with `O_NOFOLLOW`, and every write goes through a staging
 *    file created `O_EXCL | O_NOFOLLOW` inside a private directory made by
 *    `mkdtempSync` (unpredictable name, mode 0700), then renamed into place.
 *
 * Failure policy, inherited: a failure never rolls back delivered bytes and
 * never throws at the caller. It prints the remedy, sets `process.exitCode = 1`
 * and returns `failed`.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fsyncParentDir, unlinkWithParentFsync } from './atomic-fs.js';
import type { IntegrationSelection } from './runtime-integrations.js';
import {
  type SkillsHerdrModInstall,
  inspectSkillsInstallRecord,
  isSafeHerdrModFilePath,
  releaseTag,
  writeSkillsInstallRecord,
} from './skills-installer.js';

/** The mod's folder name inside Herdr's `mods/`. */
const MOD_NAME = 'genie-herdr';

/** Files Herdr generates in a mod folder; genie never delivers or touches them. */
const HERDR_OWNED_FILES: ReadonlySet<string> = new Set(['gpui-kit.d.ts', 'jsconfig.json']);

/** O_NOFOLLOW is POSIX-only; Linux and macOS are the targets. */
const O_NOFOLLOW = (fsConstants.O_NOFOLLOW ?? 0) as number;

/** Where the release's mod lands after the `plugins` payload member converges. */
export function shippedHerdrModRoot(genieHome: string): string {
  return join(genieHome, 'plugins', MOD_NAME);
}

/** `$HERDR_APP_HOME` (resolved to an absolute path), else `~/.config/herdr-app`. */
export function resolveHerdrAppHome(): string {
  const fromEnv = process.env.HERDR_APP_HOME;
  return fromEnv === undefined || fromEnv === '' ? join(homedir(), '.config', 'herdr-app') : resolve(fromEnv);
}

export interface HerdrModChannelConvergenceOptions {
  /** Persisted integration consent: `none` skips the channel entirely. */
  selection: IntegrationSelection;
  /** The running binary's version; recorded as the `v`-prefixed release tag. */
  version: string;
  genieHome: string;
  /** Test seam; production resolves `$HERDR_APP_HOME`, else `~/.config/herdr-app`. */
  herdrAppHome?: string;
  log?: (line: string) => void;
  /** Test seam for the backup-root timestamp. */
  now?: () => Date;
}

export interface HerdrModChannelConvergenceResult {
  status: 'installed' | 'skipped' | 'failed';
  /** Every line emitted before the summary, in the order it was emitted. */
  warnings: string[];
}

/** The one Herdr mod channel step both command seams call. */
export function runHerdrModChannelConvergence(
  options: HerdrModChannelConvergenceOptions,
): HerdrModChannelConvergenceResult {
  const emit = options.log ?? defaultLog;
  const skip = (reason: string): HerdrModChannelConvergenceResult => {
    emit(`herdr-mod: skipped (${reason})`);
    return { status: 'skipped', warnings: [] };
  };
  const warnings: string[] = [];
  const fail = (reason: string): HerdrModChannelConvergenceResult => {
    for (const warning of warnings) emit(warning);
    emit(`Herdr mod install failed: ${reason}. Run: genie update`);
    process.exitCode = 1;
    return { status: 'failed', warnings };
  };
  if (options.selection === 'none') return skip('consent: none');
  const read = inspectSkillsInstallRecord(options.genieHome);
  if (read.status !== 'ok') return skip('no install record — run genie update');
  const appHome = options.herdrAppHome === undefined ? resolveHerdrAppHome() : resolve(options.herdrAppHome);
  // `statSync` follows: the configured root may be a symlink (policy above).
  if (!isDirectory(appHome)) return skip(`no Herdr app home — ${appHome} does not exist`);
  // Every walk below starts AT a configured root, so the root itself may be a
  // symlink while each component under it is `lstat`ed (policy above).
  let source: ChainResult;
  try {
    source = physicalChain(options.genieHome, ['plugins', MOD_NAME], false);
  } catch (error) {
    return fail(errorMessage(error));
  }
  if (source.status === 'absent') return skip(`no mod in payload — ${shippedHerdrModRoot(options.genieHome)}`);
  if (source.status === 'redirected') return fail(refusal(source.path));

  const modDir = join(appHome, 'mods', MOD_NAME);
  let modReal: string;
  try {
    const target = physicalChain(appHome, ['mods', MOD_NAME], true);
    if (target.status === 'redirected') return fail(refusal(target.path));
    modReal = target.path;
  } catch (error) {
    return fail(errorMessage(error));
  }
  const previousDir = read.record.herdrMod?.dir;
  if (previousDir !== undefined && previousDir !== modDir) {
    warnings.push(
      `herdr-mod: the install record named ${previousDir}; this run installs into ${modDir}, so the files in the previous dir are no longer tracked (nothing there was moved or removed)`,
    );
  }
  let outcome: ApplyOutcome;
  try {
    outcome = applyModPlan({
      modDir: modReal,
      deliveredRoot: source.path,
      delivered: readDeliveredMod(source.path),
      recorded: previousDir === modDir ? (read.record.herdrMod?.files ?? {}) : {},
      genieHome: options.genieHome,
      now: options.now ?? (() => new Date()),
      warnings,
    });
  } catch (error) {
    return fail(errorMessage(error));
  }
  const herdrMod: SkillsHerdrModInstall = { dir: modDir, ref: releaseTag(options.version), files: outcome.files };
  try {
    writeSkillsInstallRecord(options.genieHome, { ...read.record, herdrMod });
  } catch (error) {
    return fail(`could not record the installed Herdr mod: ${errorMessage(error)}`);
  }
  for (const warning of warnings) emit(warning);
  emit(summaryLine(herdrMod, outcome));
  return { status: 'installed', warnings };
}

function refusal(path: string): string {
  return `${path} is not a physical directory (a symlink or another redirect); refused and left in place`;
}

function summaryLine(herdrMod: SkillsHerdrModInstall, outcome: ApplyOutcome): string {
  const tail = [
    `${outcome.written} written`,
    `${outcome.unchanged} already current`,
    ...(outcome.retired > 0 ? [`${outcome.retired} retired`] : []),
    ...(outcome.preserved > 0 ? [`${outcome.preserved} preserved`] : []),
  ].join(', ');
  return `herdr-mod: ${Object.keys(herdrMod.files).length} file(s) in ${herdrMod.dir} @ ${herdrMod.ref} (${tail})`;
}

type ChainResult = { status: 'ok'; path: string } | { status: 'absent' | 'redirected'; path: string };

/**
 * Walk `base/<segments…>` with `lstat`, never following a link. Each component
 * must be a physical directory; with `create`, an absent one is made (one level
 * at a time, so nothing is created through a redirect). `absent` and
 * `redirected` name the first offending path.
 */
function physicalChain(base: string, segments: readonly string[], create: boolean): ChainResult {
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      if (!create) return { status: 'absent', path: current };
      mkdirSync(current, { mode: 0o755 });
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: 'redirected', path: current };
  }
  return { status: 'ok', path: current };
}

/** The directory segments of a relative POSIX file path (`a/b/c.svg` → `a`, `b`). */
function parentSegments(path: string): string[] {
  return path.split('/').slice(0, -1);
}

interface ApplyContext {
  /** The mod dir (`mods/genie-herdr` verified physical below the configured app home). */
  modDir: string;
  /** The payload mod dir (`plugins/genie-herdr` verified physical below GENIE_HOME). */
  deliveredRoot: string;
  /** Delivered relative path → sha256 of the delivered bytes. */
  delivered: Map<string, string>;
  /** The previous record's relative path → sha256 map, for this same mod dir. */
  recorded: Record<string, string>;
  /** The configured GENIE_HOME. */
  genieHome: string;
  now: () => Date;
  warnings: string[];
}

interface ApplyOutcome {
  /** What the new record names: relative path → the sha256 now expected on disk. */
  files: Record<string, string>;
  written: number;
  unchanged: number;
  retired: number;
  preserved: number;
}

function applyModPlan(context: ApplyContext): ApplyOutcome {
  const archive = createArchiveSink(context);
  const staging = createStaging(context.modDir);
  const outcome: ApplyOutcome = { files: {}, written: 0, unchanged: 0, retired: 0, preserved: 0 };
  try {
    installDeliveredFiles(context, archive, staging, outcome);
    retireDroppedFiles(context, archive, outcome);
  } finally {
    staging.dispose();
    archive.discardIfUnused();
  }
  const root = archive.usedRoot();
  if (root !== null) context.warnings.push(`herdr-mod: collision backup kept at ${root} (${archive.count()} file(s))`);
  return outcome;
}

/**
 * What one mod file IS, judged only by digests — the workflows channel's table:
 * `current` equals the delivered bytes, `replace` equals the recorded bytes
 * (genie's own previous copy), `modified` is recorded but neither, `foreign`
 * was never recorded and is not the delivered bytes.
 */
type FileVerdict = 'current' | 'replace' | 'modified' | 'foreign';

function classify(args: { recorded?: string; delivered?: string; onDisk: string }): FileVerdict {
  if (args.delivered !== undefined && args.onDisk === args.delivered) return 'current';
  if (args.recorded !== undefined && args.onDisk === args.recorded) return 'replace';
  return args.recorded === undefined ? 'foreign' : 'modified';
}

/** Keep a preserved path's recorded receipt, so doctor and the next run still name it. */
function preserve(context: ApplyContext, outcome: ApplyOutcome, path: string, why: string): void {
  context.warnings.push(`herdr-mod: preserved ${path} — ${why}; left in place`);
  const recorded = context.recorded[path];
  if (recorded !== undefined) outcome.files[path] = recorded;
  outcome.preserved += 1;
}

function installDeliveredFiles(
  context: ApplyContext,
  archive: ArchiveSink,
  staging: Staging,
  outcome: ApplyOutcome,
): void {
  for (const [path, delivered] of context.delivered) {
    const parent = physicalChain(context.modDir, parentSegments(path), true);
    if (parent.status !== 'ok') {
      preserve(context, outcome, path, `${parent.path} is not a physical directory`);
      continue;
    }
    const target = join(context.modDir, path);
    const state = inspectOnDisk(target);
    if (state.kind === 'other') {
      // A symlink or a directory: genie cannot prove what it would destroy.
      preserve(context, outcome, path, 'not a regular file');
      continue;
    }
    if (state.kind === 'file') {
      const verdict = classify({ recorded: context.recorded[path], delivered, onDisk: state.digest });
      if (verdict === 'current') {
        outcome.files[path] = delivered;
        outcome.unchanged += 1;
        continue;
      }
      if (verdict === 'modified' || verdict === 'foreign') {
        // Throws before the target is touched when the backup cannot be proven.
        archive.take(path, target);
        const why = verdict === 'modified' ? 'was modified locally' : 'was not installed by genie';
        context.warnings.push(`herdr-mod: ${path} ${why} — previous contents backed up to ${archive.usedRoot() ?? ''}`);
      }
    }
    staging.publish(readNoFollow(join(context.deliveredRoot, path)), target, delivered, () =>
      physicalChain(context.modDir, parentSegments(path), false),
    );
    outcome.files[path] = delivered;
    outcome.written += 1;
  }
}

/**
 * A19: every recorded path the payload no longer ships is archived and removed.
 * A path behind a redirected directory, or one that is not a regular file, is
 * kept — on disk and in the record under its recorded digest — because genie
 * cannot prove what it is. Herdr's generated files are never genie's: a record
 * that claims one loses the claim, and the file is not even read.
 */
function retireDroppedFiles(context: ApplyContext, archive: ArchiveSink, outcome: ApplyOutcome): void {
  for (const [path, recorded] of Object.entries(context.recorded)) {
    if (context.delivered.has(path) || HERDR_OWNED_FILES.has(path) || !isSafeHerdrModFilePath(path)) continue;
    const parent = physicalChain(context.modDir, parentSegments(path), false);
    if (parent.status === 'absent') continue;
    if (parent.status === 'redirected') {
      preserve(context, outcome, path, `no longer shipped, and ${parent.path} is not a physical directory`);
      continue;
    }
    const target = join(context.modDir, path);
    const state = inspectOnDisk(target);
    if (state.kind === 'absent') continue;
    if (state.kind === 'other') {
      preserve(context, outcome, path, 'no longer shipped, and not a regular file');
      continue;
    }
    archive.take(path, target);
    unlinkWithParentFsync(target);
    const how = state.digest === recorded ? 'no longer shipped' : 'no longer shipped, modified locally';
    context.warnings.push(
      `herdr-mod: retired ${path} — ${how}; previous contents backed up to ${archive.usedRoot() ?? ''}`,
    );
    outcome.retired += 1;
  }
}

interface Staging {
  /**
   * Write `bytes` to an exclusive staging file, re-check the target's parent
   * chain, rename into place, then prove the published bytes.
   */
  publish(bytes: Buffer, target: string, expected: string, recheck: () => ChainResult): void;
  dispose(): void;
}

/**
 * One private staging directory per run, created lazily inside the mod dir
 * (same filesystem, so the rename is atomic) by `mkdtempSync`: an unpredictable
 * name, created exclusively with mode 0700, so no pre-existing entry can stand
 * in for it. Removed on every exit path.
 */
function createStaging(modDir: string): Staging {
  let dir: string | null = null;
  let counter = 0;
  return {
    publish(bytes, target, expected, recheck) {
      dir ??= mkdtempSync(join(modDir, '.genie-staging-'));
      counter += 1;
      const staged = join(dir, String(counter));
      writeExclusive(staged, bytes, 0o644);
      if (recheck().status !== 'ok') throw new Error(`the parent of ${target} changed while publishing`);
      renameSync(staged, target);
      fsyncParentDir(target);
      if (digestOf(readNoFollow(target)) !== expected) {
        throw new Error(`published ${target} does not match the delivered file`);
      }
    },
    dispose() {
      if (dir === null) return;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort: a leftover private staging dir never fails an install.
      }
      dir = null;
    },
  };
}

interface ArchiveSink {
  take(path: string, source: string): void;
  usedRoot(): string | null;
  count(): number;
  discardIfUnused(): void;
}

/**
 * The run's single archive root, allocated lazily by the first file that needs
 * it and EXCLUSIVELY: `herdr-mod-collision-<stamp>`, else `-1`, `-2`, … — a
 * name that already exists (an earlier run with the same timestamp, a clock
 * rollback, a planted symlink) is never reused or written into. `state-backups/`
 * is an archive: the one removal is this run's own root, while it holds nothing.
 */
function createArchiveSink(context: ApplyContext): ArchiveSink {
  let root: string | null = null;
  let count = 0;
  const ensure = (): string => {
    if (root !== null) return root;
    const backups = physicalChain(context.genieHome, ['state-backups'], true);
    if (backups.status !== 'ok') throw new Error(`could not archive: ${refusal(backups.path)}`);
    const base = join(backups.path, `herdr-mod-collision-${context.now().toISOString().replace(/[:.]/g, '-')}`);
    for (let attempt = 0; ; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt}`;
      try {
        mkdirSync(candidate, { mode: 0o700 });
        root = candidate;
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  };
  return {
    take(path, source) {
      const archiveRoot = ensure();
      const parent = physicalChain(archiveRoot, parentSegments(path), true);
      if (parent.status !== 'ok') throw new Error(`could not archive ${source}: ${refusal(parent.path)}`);
      const bytes = readNoFollow(source);
      const destination = join(archiveRoot, path);
      writeExclusive(destination, bytes, 0o600);
      if (digestOf(readNoFollow(destination)) !== digestOf(bytes)) {
        throw new Error(`could not archive ${source}: the copy at ${destination} does not match`);
      }
      fsyncParentDir(destination);
      count += 1;
    },
    usedRoot: () => root,
    count: () => count,
    discardIfUnused() {
      if (root === null || count > 0) return;
      try {
        if (readdirSync(root).length > 0) return;
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best effort: an unremovable empty staging root never fails an install.
      }
      root = null;
    },
  };
}

/** Create `path` exclusively — never over an existing entry, never through a link. */
function writeExclusive(path: string, bytes: Buffer, mode: number): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, mode);
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, null);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read a file without following a final-component symlink. */
function readNoFollow(path: string): Buffer {
  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The delivered mod: every regular file under the physical `root`, by POSIX
 * relative path, sorted. `readdir` entry types do not follow links, so a
 * symlinked file or directory in the payload is neither delivered nor
 * traversed; nor are Herdr's own generated files.
 */
function readDeliveredMod(root: string): Map<string, string> {
  const paths: string[] = [];
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(join(root, relativeDir), { withFileTypes: true })) {
      const path = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isSafeHerdrModFilePath(path) && !HERDR_OWNED_FILES.has(path)) paths.push(path);
    }
  };
  walk('');
  paths.sort((left, right) => (left < right ? -1 : 1));
  return new Map(paths.map((path) => [path, digestOf(readNoFollow(join(root, path)))]));
}

type OnDisk = { kind: 'absent' } | { kind: 'file'; digest: string } | { kind: 'other' };

/** Fail-closed: anything that is not a physical regular file is `other`. */
function inspectOnDisk(path: string): OnDisk {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: 'absent' };
  }
  if (!stat.isFile()) return { kind: 'other' };
  try {
    return { kind: 'file', digest: digestOf(readNoFollow(path)) };
  } catch {
    return { kind: 'other' };
  }
}

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultLog(line: string): void {
  process.stdout.write(`${line}\n`);
}
