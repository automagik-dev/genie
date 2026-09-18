/**
 * The workflows channel — the one supported way the genie workflow catalog
 * reaches Claude Code's user scope (`~/.claude/workflows/`).
 *
 * Until 2026-09-18 the catalog existed only in this repository's project scope,
 * so `Workflow name=council` from any other checkout answered
 * `Workflow "council" not found`. `genie install` / `genie update` now deliver
 * `<GENIE_HOME>/templates/workflows/*.js` — staged into the `templates/` payload
 * member by `scripts/build-binary.sh`, and already converged to GENIE_HOME by
 * the time this runs — into that one directory, per file, with a sha256 of every
 * delivered file recorded in `skills-install.json`.
 *
 * Four rules, all inherited from the skills channel and none negotiable:
 *
 *  - CONSENT `none` skips the channel entirely, and genie creates no product
 *    home: with no `~/.claude` on the host there is nothing to install into and
 *    the channel says so (wish decision 6).
 *  - NO RECORD, NO INSTALL (wish decision 4). The `workflows` field rides the
 *    existing `skills-install.json`, written by the atomic record writer, so
 *    doctor and uninstall keep ONE authority. When that record is absent or
 *    malformed after the skills channel ran, this channel installs nothing: a
 *    file genie cannot record is a file `genie uninstall` can never remove.
 *  - BACKUP FIRST (wish decision 5). A file matching neither the recorded digest
 *    nor the delivered one is archived under
 *    `<GENIE_HOME>/state-backups/workflows-collision-<compact ISO>/` before it is
 *    replaced, and named in the transcript. A file matching the recorded digest
 *    is genie's own previous copy and is replaced silently; one already matching
 *    the delivered digest is left alone (so a second run creates no backup root).
 *  - THE TRANSCRIPT PRINTS WHAT THE RUN DID BEFORE WHAT THE HOST HAS: every
 *    archive, retirement and preservation line first, the one summary last.
 *
 * Failure policy, also inherited: a failure here never rolls back delivered
 * bytes and never throws at the caller. It prints the remedy, sets
 * `process.exitCode = 1`, and returns `failed`.
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync, fsyncParentDir, unlinkWithParentFsync } from './atomic-fs.js';
import { resolveClaudeDir } from './genie-home.js';
import type { IntegrationSelection } from './runtime-integrations.js';
import {
  type SkillsWorkflowsInstall,
  inspectSkillsInstallRecord,
  isSafeWorkflowFileName,
  releaseTag,
  writeSkillsInstallRecord,
} from './skills-installer.js';

/** Where the release's catalog lands after `templates/` converges. */
export function shippedWorkflowsRoot(genieHome: string): string {
  return join(genieHome, 'templates', 'workflows');
}

/**
 * What one user-scope workflow file IS, judged only by digests:
 *
 *  - `missing`  — nothing on disk under that name.
 *  - `current`  — byte-identical to the file this release delivers.
 *  - `replace`  — byte-identical to what the record says genie installed, and
 *                 different from what this release delivers: genie's own stale
 *                 copy, replaced (or, for a dropped name, archived) silently.
 *  - `modified` — recorded by genie, and now neither the recorded nor the
 *                 delivered bytes: a hand-edited genie file.
 *  - `foreign`  — never recorded by genie and not the delivered bytes.
 *
 * `modified` and `foreign` are both archived before being replaced; they are
 * separate values because the operator-facing sentence differs, exactly as it
 * does for a skill directory. Callers give the verdict its meaning: for a
 * DELIVERED name `replace` means write, while for a name this release DROPPED
 * it is the only verdict that authorizes removal (wish decision 5).
 */
export type WorkflowFileClassification = 'current' | 'replace' | 'modified' | 'missing' | 'foreign';

export function classifyWorkflowFile(args: {
  recorded?: string;
  delivered?: string;
  onDisk: string | null;
}): WorkflowFileClassification {
  if (args.onDisk === null) return 'missing';
  if (args.delivered !== undefined && args.onDisk === args.delivered) return 'current';
  if (args.recorded !== undefined && args.onDisk === args.recorded) return 'replace';
  return args.recorded === undefined ? 'foreign' : 'modified';
}

export interface WorkflowsChannelConvergenceOptions {
  /** Persisted integration consent: `none` skips the channel entirely. */
  selection: IntegrationSelection;
  /** The running binary's version; recorded as the `v`-prefixed release tag. */
  version: string;
  genieHome: string;
  /** Test seam for `$HOME`; production resolves `~/.claude` (or `$CLAUDE_CONFIG_DIR`). */
  home?: string;
  log?: (line: string) => void;
  /** Test seam for the backup-root timestamp. */
  now?: () => Date;
}

export interface WorkflowsChannelConvergenceResult {
  status: 'installed' | 'skipped' | 'failed';
  /** Every line emitted before the summary, in the order it was emitted. */
  warnings: string[];
}

/** The one workflows-channel step both command seams call. */
export function runWorkflowsChannelConvergence(
  options: WorkflowsChannelConvergenceOptions,
): WorkflowsChannelConvergenceResult {
  const emit = options.log ?? defaultLog;
  if (options.selection === 'none') {
    emit('workflows: skipped (consent: none)');
    return { status: 'skipped', warnings: [] };
  }
  const claudeDir = options.home === undefined ? resolveClaudeDir() : join(options.home, '.claude');
  // Genie installs to product homes it finds and creates none — the same
  // boundary the skills channel draws around a missing agent home.
  if (!isDirectory(claudeDir)) {
    emit(`workflows: skipped (no ~/.claude — ${claudeDir} does not exist)`);
    return { status: 'skipped', warnings: [] };
  }
  const read = inspectSkillsInstallRecord(options.genieHome);
  if (read.status !== 'ok') {
    emit('workflows: skipped (no install record — run genie update)');
    return { status: 'skipped', warnings: [] };
  }
  const deliveredRoot = shippedWorkflowsRoot(options.genieHome);
  const delivered = readDeliveredCatalog(deliveredRoot);
  const warnings: string[] = [];
  const fail = (reason: string): WorkflowsChannelConvergenceResult => {
    for (const warning of warnings) emit(warning);
    emit(`Workflows install failed: ${reason}. Run: genie update`);
    // Deliberately non-fatal, like the skills channel: the delivered bytes stay
    // committed and the operator gets exit 1 with the remedy.
    process.exitCode = 1;
    return { status: 'failed', warnings };
  };
  if (delivered.size === 0) return fail(`no delivered workflow catalog at ${deliveredRoot}`);

  const workflowsDir = join(claudeDir, 'workflows');
  let outcome: WorkflowsApplyOutcome;
  try {
    outcome = applyWorkflowsPlan({
      workflowsDir,
      deliveredRoot,
      delivered,
      recorded: read.record.workflows?.files ?? {},
      genieHome: options.genieHome,
      now: options.now ?? (() => new Date()),
      warnings,
    });
  } catch (error) {
    return fail(errorMessage(error));
  }
  const workflows: SkillsWorkflowsInstall = {
    dir: workflowsDir,
    ref: releaseTag(options.version),
    files: outcome.files,
  };
  try {
    writeSkillsInstallRecord(options.genieHome, { ...read.record, workflows });
  } catch (error) {
    return fail(`could not record the installed workflows: ${errorMessage(error)}`);
  }
  for (const warning of warnings) emit(warning);
  emit(summaryLine(workflows, outcome));
  return { status: 'installed', warnings };
}

/**
 * ORDER IS THE MESSAGE, and the counts are the run's own: `written` is what this
 * run changed on disk, and the total is what `genie uninstall` will act on.
 */
function summaryLine(workflows: SkillsWorkflowsInstall, outcome: WorkflowsApplyOutcome): string {
  const tail = [
    `${outcome.written} written`,
    `${outcome.unchanged} already current`,
    ...(outcome.retired > 0 ? [`${outcome.retired} retired`] : []),
    ...(outcome.preserved > 0 ? [`${outcome.preserved} preserved`] : []),
  ].join(', ');
  return `workflows: ${Object.keys(workflows.files).length} workflow(s) in ${workflows.dir} @ ${workflows.ref} (${tail})`;
}

interface WorkflowsApplyContext {
  workflowsDir: string;
  deliveredRoot: string;
  /** Delivered file name → sha256 of the delivered bytes. */
  delivered: Map<string, string>;
  /** The previous record's file name → sha256 map. */
  recorded: Record<string, string>;
  genieHome: string;
  now: () => Date;
  warnings: string[];
}

interface WorkflowsApplyOutcome {
  /** What the new record names: file name → the sha256 now expected on disk. */
  files: Record<string, string>;
  written: number;
  unchanged: number;
  retired: number;
  preserved: number;
}

function applyWorkflowsPlan(context: WorkflowsApplyContext): WorkflowsApplyOutcome {
  const archive = createArchiveSink(context);
  const outcome: WorkflowsApplyOutcome = { files: {}, written: 0, unchanged: 0, retired: 0, preserved: 0 };
  installDeliveredWorkflows(context, archive, outcome);
  retireDroppedWorkflows(context, archive, outcome);
  // A run that replaced and retired nothing leaves no root behind: the backup
  // root is created only by the first file that actually needs archiving.
  archive.discardIfUnused();
  const root = archive.usedRoot();
  if (root !== null) {
    context.warnings.push(`workflows: collision backup kept at ${root} (${archive.count()} file(s))`);
  }
  return outcome;
}

/** Install (or leave alone) every file this release delivers. */
function installDeliveredWorkflows(
  context: WorkflowsApplyContext,
  archive: ArchiveSink,
  outcome: WorkflowsApplyOutcome,
): void {
  for (const [name, delivered] of context.delivered) {
    const target = join(context.workflowsDir, name);
    const state = inspectOnDiskWorkflow(target);
    if (state.kind === 'other') {
      // Not a regular file (a symlink, a directory): genie neither digests nor
      // replaces it, because it cannot prove what it would be destroying.
      context.warnings.push(`workflows: preserved ${name} — not a regular file; left in place`);
      outcome.preserved += 1;
      continue;
    }
    const recorded = context.recorded[name];
    const verdict = classifyWorkflowFile({ recorded, delivered, onDisk: state.digest });
    if (verdict === 'current') {
      outcome.files[name] = delivered;
      outcome.unchanged += 1;
      continue;
    }
    if (verdict === 'modified' || verdict === 'foreign') {
      archive.take(name, target);
      context.warnings.push(describeArchivedCollision(name, verdict, archive.usedRoot() ?? ''));
    }
    atomicWriteFileSync(target, readFileSync(join(context.deliveredRoot, name), 'utf8'), { mode: 0o644 });
    // The record is only worth as much as the bytes it names: a published file
    // that does not hash to the delivered digest is recorded by nobody.
    if (fileDigest(target) !== delivered) throw new Error(`published ${target} does not match the delivered ${name}`);
    outcome.files[name] = delivered;
    outcome.written += 1;
  }
}

/**
 * Retire every recorded name this release no longer ships — archived only while
 * its digest still proves it is genie's own (wish decision 5). Anything else
 * stays on disk AND stays in the record under its RECORDED digest, so the next
 * update retries it and `genie uninstall` still refuses to delete it.
 */
function retireDroppedWorkflows(
  context: WorkflowsApplyContext,
  archive: ArchiveSink,
  outcome: WorkflowsApplyOutcome,
): void {
  for (const [name, recorded] of Object.entries(context.recorded)) {
    if (context.delivered.has(name) || !isSafeWorkflowFileName(name)) continue;
    const target = join(context.workflowsDir, name);
    const state = inspectOnDiskWorkflow(target);
    if (state.kind === 'absent') continue;
    const verdict = classifyWorkflowFile({ recorded, onDisk: state.digest });
    if (verdict !== 'replace') {
      context.warnings.push(
        `workflows: preserved ${name} — this release no longer ships it, and it changed since the recorded install; left in place`,
      );
      outcome.files[name] = recorded;
      outcome.preserved += 1;
      continue;
    }
    archive.take(name, target);
    unlinkWithParentFsync(target);
    context.warnings.push(`workflows: retired ${name} — no longer shipped; archived to ${archive.usedRoot() ?? ''}`);
    outcome.retired += 1;
  }
}

function describeArchivedCollision(name: string, verdict: 'modified' | 'foreign', root: string): string {
  return verdict === 'modified'
    ? `workflows: ${name} was modified locally — previous contents backed up to ${root}`
    : `workflows: ${name} was not installed by genie — previous contents backed up to ${root}`;
}

/**
 * The run's single archive root, created lazily.
 *
 * `state-backups/` is an ARCHIVE: nothing here ever removes, moves or rewrites a
 * root an earlier run wrote. The one removal is this run's own root, and only
 * while it still holds nothing.
 */
interface ArchiveSink {
  /** Copy `source` into the root under `name`, verifying the bytes on arrival. */
  take(name: string, source: string): void;
  usedRoot(): string | null;
  count(): number;
  discardIfUnused(): void;
}

function createArchiveSink(context: WorkflowsApplyContext): ArchiveSink {
  let root: string | null = null;
  let count = 0;
  const ensure = (): string => {
    if (root === null) {
      // Sortable, same family as `skills-retirement-<compact ISO 8601>`.
      const stamp = context.now().toISOString().replace(/[:.]/g, '-');
      root = join(context.genieHome, 'state-backups', `workflows-collision-${stamp}`);
      mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    return root;
  };
  return {
    take(name, source) {
      const destination = join(ensure(), name);
      copyFileSync(source, destination);
      // Backup-first is only a rule if the bytes are provably there: a copy that
      // did not arrive intact fails the channel before anything is replaced.
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
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best effort: an unremovable empty staging root never fails an install.
      }
      root = null;
    },
  };
}

/** The delivered catalog: top-level `*.js` regular files, name → sha256. */
function readDeliveredCatalog(root: string): Map<string, string> {
  const catalog = new Map<string, string>();
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return catalog;
  }
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (!entry.isFile() || !isSafeWorkflowFileName(entry.name)) continue;
    catalog.set(entry.name, fileDigest(join(root, entry.name)));
  }
  return catalog;
}

type OnDiskWorkflow =
  | { kind: 'absent'; digest: null }
  | { kind: 'file'; digest: string }
  | { kind: 'other'; digest: null };

/** Fail-closed: anything that is not a physical regular file is `other`. */
function inspectOnDiskWorkflow(path: string): OnDiskWorkflow {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: 'absent', digest: null };
  }
  if (!stat.isFile()) return { kind: 'other', digest: null };
  try {
    return { kind: 'file', digest: fileDigest(path) };
  } catch {
    return { kind: 'other', digest: null };
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
