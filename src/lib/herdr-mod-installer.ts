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
 *    is archived under `<GENIE_HOME>/state-backups/herdr-mod-collision-<compact
 *    ISO>/` before it is replaced; equal bytes are left alone, so a rerun
 *    backs up nothing.
 *  - HANDS OFF: only delivered and recorded paths are ever touched. Herdr's own
 *    generated `gpui-kit.d.ts` and `jsconfig.json` are never delivered, even
 *    from a payload that carried them, and every undelivered file stays as is.
 *  - STALE FILES (A19): a recorded file the payload no longer ships is archived
 *    and removed, and dropped from the record. The criterion reads "a modified
 *    one is backed up first", so — unlike the workflows channel, which keeps a
 *    modified dropped file in place — a modified one is removed too, after its
 *    bytes are proven in the backup root.
 *
 * Failure policy, inherited: a failure never rolls back delivered bytes and
 * never throws at the caller. It prints the remedy, sets `process.exitCode = 1`
 * and returns `failed`.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  if (options.selection === 'none') return skip('consent: none');
  const read = inspectSkillsInstallRecord(options.genieHome);
  if (read.status !== 'ok') return skip('no install record — run genie update');
  const appHome = options.herdrAppHome === undefined ? resolveHerdrAppHome() : resolve(options.herdrAppHome);
  if (!isDirectory(appHome)) return skip(`no Herdr app home — ${appHome} does not exist`);
  const deliveredRoot = shippedHerdrModRoot(options.genieHome);
  if (!isDirectory(deliveredRoot)) return skip(`no mod in payload — ${deliveredRoot}`);

  const warnings: string[] = [];
  const fail = (reason: string): HerdrModChannelConvergenceResult => {
    for (const warning of warnings) emit(warning);
    emit(`Herdr mod install failed: ${reason}. Run: genie update`);
    process.exitCode = 1;
    return { status: 'failed', warnings };
  };

  const modDir = join(appHome, 'mods', MOD_NAME);
  const previousDir = read.record.herdrMod?.dir;
  if (previousDir !== undefined && previousDir !== modDir) {
    warnings.push(
      `herdr-mod: the install record named ${previousDir}; this run installs into ${modDir}, so the files in the previous dir are no longer tracked (nothing there was moved or removed)`,
    );
  }
  let outcome: ApplyOutcome;
  try {
    const delivered = readDeliveredMod(deliveredRoot);
    outcome = applyModPlan({
      modDir,
      deliveredRoot,
      delivered,
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

function summaryLine(herdrMod: SkillsHerdrModInstall, outcome: ApplyOutcome): string {
  const tail = [
    `${outcome.written} written`,
    `${outcome.unchanged} already current`,
    ...(outcome.retired > 0 ? [`${outcome.retired} retired`] : []),
    ...(outcome.preserved > 0 ? [`${outcome.preserved} preserved`] : []),
  ].join(', ');
  return `herdr-mod: ${Object.keys(herdrMod.files).length} file(s) in ${herdrMod.dir} @ ${herdrMod.ref} (${tail})`;
}

interface ApplyContext {
  modDir: string;
  deliveredRoot: string;
  /** Delivered relative path → sha256 of the delivered bytes. */
  delivered: Map<string, string>;
  /** The previous record's relative path → sha256 map, for this same mod dir. */
  recorded: Record<string, string>;
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
  const outcome: ApplyOutcome = { files: {}, written: 0, unchanged: 0, retired: 0, preserved: 0 };
  try {
    installDeliveredFiles(context, archive, outcome);
    retireDroppedFiles(context, archive, outcome);
  } finally {
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

function installDeliveredFiles(context: ApplyContext, archive: ArchiveSink, outcome: ApplyOutcome): void {
  for (const [path, delivered] of context.delivered) {
    const target = join(context.modDir, path);
    const recorded = context.recorded[path];
    const state = inspectOnDisk(target);
    if (state.kind === 'other') {
      // A symlink or a directory: genie cannot prove what it would destroy, so
      // it is left alone and a recorded path keeps its recorded receipt.
      context.warnings.push(`herdr-mod: preserved ${path} — not a regular file; left in place`);
      if (recorded !== undefined) outcome.files[path] = recorded;
      outcome.preserved += 1;
      continue;
    }
    if (state.kind === 'file') {
      const verdict = classify({ recorded, delivered, onDisk: state.digest });
      if (verdict === 'current') {
        outcome.files[path] = delivered;
        outcome.unchanged += 1;
        continue;
      }
      if (verdict === 'modified' || verdict === 'foreign') {
        archive.take(path, target);
        const why = verdict === 'modified' ? 'was modified locally' : 'was not installed by genie';
        context.warnings.push(`herdr-mod: ${path} ${why} — previous contents backed up to ${archive.usedRoot() ?? ''}`);
      }
    }
    publish(join(context.deliveredRoot, path), target, delivered);
    outcome.files[path] = delivered;
    outcome.written += 1;
  }
}

/**
 * A19: every recorded path the payload no longer ships is archived and removed.
 * Only a non-regular file is kept — on disk and in the record under its
 * recorded digest — because genie cannot prove what it is.
 */
function retireDroppedFiles(context: ApplyContext, archive: ArchiveSink, outcome: ApplyOutcome): void {
  for (const [path, recorded] of Object.entries(context.recorded)) {
    if (context.delivered.has(path) || !isSafeHerdrModFilePath(path)) continue;
    const target = join(context.modDir, path);
    const state = inspectOnDisk(target);
    if (state.kind === 'absent') continue;
    if (state.kind === 'other') {
      context.warnings.push(`herdr-mod: preserved ${path} — no longer shipped, and not a regular file; left in place`);
      outcome.files[path] = recorded;
      outcome.preserved += 1;
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

/**
 * Copy the delivered bytes into place through a staging file and a rename, so
 * Herdr never reads a half-written file, then prove the published bytes.
 */
function publish(source: string, target: string, expected: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  const staging = join(dirname(target), `.genie-staging-${process.pid}-${Date.now()}`);
  try {
    copyFileSync(source, staging);
    chmodSync(staging, 0o644);
    renameSync(staging, target);
  } finally {
    rmSync(staging, { force: true });
  }
  fsyncParentDir(target);
  if (fileDigest(target) !== expected) throw new Error(`published ${target} does not match the delivered file`);
}

interface ArchiveSink {
  take(path: string, source: string): void;
  usedRoot(): string | null;
  count(): number;
  discardIfUnused(): void;
}

/**
 * The run's single archive root, created lazily by the first file that needs
 * it. `state-backups/` is an archive: the one removal is this run's own root,
 * and only while it still holds nothing.
 */
function createArchiveSink(context: ApplyContext): ArchiveSink {
  let root: string | null = null;
  let count = 0;
  const ensure = (): string => {
    if (root === null) {
      const stamp = context.now().toISOString().replace(/[:.]/g, '-');
      root = join(context.genieHome, 'state-backups', `herdr-mod-collision-${stamp}`);
      mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    return root;
  };
  return {
    take(path, source) {
      const destination = join(ensure(), path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(source, destination);
      if (fileDigest(destination) !== fileDigest(source)) {
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

/**
 * The delivered mod: every regular file under `root`, by POSIX relative path,
 * sorted. Symlinks are not delivered, nor are Herdr's own generated files.
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
  return new Map(paths.map((path) => [path, fileDigest(join(root, path))]));
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
    return { kind: 'file', digest: fileDigest(path) };
  } catch {
    return { kind: 'other' };
  }
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
