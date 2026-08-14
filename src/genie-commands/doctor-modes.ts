/**
 * doctor: on-disk mode drift inside every registered worktree.
 *
 * `genie launch` materializes worktrees from agent shells that historically
 * ran `umask 000`, so checked-out trees accumulate files and directories that
 * are group/world-writable (0666/0777) or wider than the index says. This
 * module makes that drift visible in `genie doctor` and repairable by
 * `genie doctor --fix` — but only as a tightening, never a widening.
 *
 * Three properties govern everything here:
 *
 *  1. Enumeration is authoritative, never heuristic. Worktrees come from
 *     `git worktree list --porcelain`, files and their index modes from
 *     `git ls-files -s -z` run inside each worktree — the same truth git
 *     itself acts on. Directories are not tracked, so the directory set is
 *     the ancestor chain of tracked paths (including the worktree root), and
 *     the comparison mode for a directory is git's canonical 0755. Ignored
 *     and untracked content is out of scope by construction.
 *
 *  2. Repair is tighten-only. A regular file is restored to its index mode
 *     ONLY when the on-disk mode is a strict superset of it (removing bits is
 *     the only mutation ever made). Directories are tightened ONLY from the
 *     named drift shapes 0775/0777 to 0755. A stricter-than-index mode (0600
 *     files, 0700 dirs) is reported as informational and never widened; a
 *     mode with both extra and missing bits is reported and never edited; a
 *     file carrying setuid/setgid/sticky bits is reported and never stripped;
 *     a probe that fails or is refused (symlink planted on disk, vanished
 *     directory) keeps the item with the reason. Every refusal is surfaced.
 *
 *  3. Symlinks are never followed. Every probe uses lstat; index entries of
 *     kind 120000/160000 are skipped outright, and a symlink occupying the
 *     path of a tracked file — or of a directory that tracked files OR
 *     directories live under — refuses the item instead of operating through
 *     the link. The single mutation site re-proves the path with
 *     open(O_NOFOLLOW) + fchmod on the descriptor, so a swap between scan and
 *     repair can never be chmod'd through either.
 */

import { spawnSync } from 'node:child_process';
import { constants, type Stats, closeSync, fchmodSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseWorktreePorcelain } from './doctor-worktrees.js';
import type { CheckResult } from './doctor.js';

/**
 * How one drifted item may be disposed of. Only `wider` is reachable by
 * `--fix`; every other disposition is a kept line.
 */
export type ModeDriftDisposition =
  /** On-disk mode is a strict superset of the index mode; --fix tightens it. */
  | 'wider'
  /** On-disk mode is a strict subset of the index mode; informational, never widened. */
  | 'stricter'
  /** Both extra and missing bits; never edited. */
  | 'mixed'
  /** Probe failed or was refused (planted symlink, vanished dir, git error); kept with reason. */
  | 'refused';

export interface ModeDriftEntry {
  /** Absolute worktree path exactly as git reported it. */
  worktree: string;
  /**
   * Worktree-relative path of the drifted item; '' is the worktree root dir;
   * null only for a whole-worktree refusal (nothing inside was probeable).
   */
  relPath: string | null;
  kind: 'file' | 'dir' | 'worktree';
  /** Octal display of the index mode (files) or git's canonical dir mode 0755. */
  indexMode: string | null;
  /** Octal display of the on-disk lstat mode. */
  diskMode: string | null;
  disposition: ModeDriftDisposition;
  /** Why it landed in that class; surfaced verbatim in the doctor line. */
  reason: string;
}

export interface ModeDriftScan {
  entries: ModeDriftEntry[];
  /** Non-null when enumeration itself failed; `entries` is then empty. */
  enumerationError: string | null;
}

export interface ModeRepairDeps {
  /** Line sink for `--fix` chatter. Defaults to stdout. */
  logSink?: (line: string) => void;
  /**
   * Pre-computed scan (test seam for the scan→repair window): when omitted the
   * repair re-scans on entry, exactly like production. A stale injected scan
   * must still be fail-closed — the mutation site re-proves the path type.
   */
  scan?: ModeDriftScan;
}

/** git's canonical directory permission shape: tree dirs are 0755, always. */
const CANONICAL_DIR_MODE = 0o755;
/** The only directory modes `--fix` tightens — the two umask-drift shapes. */
const DIR_TIGHTEN_MODES = new Set<number>([0o775, 0o777]);
/** Index entry kinds with no permission domain of their own; skipped outright. */
const SKIP_INDEX_MODES = new Set<number>([0o120000, 0o160000]);

interface GitOutcome {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

function gitFailure(stderr: string): GitOutcome {
  return { ok: false, status: null, stdout: '', stderr };
}

/**
 * Run git without ever throwing: a failed spawn (e.g. the worktree directory
 * vanished, so `cwd` no longer exists) is reported like any non-zero exit, and
 * every caller turns an unsuccessful outcome into a refusal.
 */
function git(cwd: string, args: string[]): GitOutcome {
  try {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (res.error) return gitFailure(res.error.message);
    return { ok: res.status === 0, status: res.status, stdout: res.stdout ?? '', stderr: (res.stderr ?? '').trim() };
  } catch (error) {
    return gitFailure(error instanceof Error ? error.message : String(error));
  }
}

function firstLine(text: string, fallback: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line === '' ? fallback : line;
}

/** Octal display: 0o644 → '644', 0o1777 → '1777' (high bits widen it naturally). */
function octal(mode: number): string {
  return mode.toString(8).padStart(3, '0');
}

interface IndexEntry {
  /** Full index mode (100644/100755/120000/160000). */
  mode: number;
  /** Worktree-relative path, raw (unquoted thanks to -z). */
  path: string;
}

/** Parse `git ls-files -s -z`: `<mode> <object> <stage>\t<path>\0` records. */
function parseLsFilesZ(text: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const record of text.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const mode = Number.parseInt(record.slice(0, tab).split(' ')[0] ?? '', 8);
    if (!Number.isInteger(mode)) continue;
    entries.push({ mode, path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * Every ancestor directory of the tracked paths, including the worktree root
 * (''). Only these directories are probed: git never tracks directories, so
 * the tracked paths are the sole authority on which directories are tree
 * content — an ignored `node_modules/` is residue, not tree content.
 */
function ancestorDirs(paths: string[]): Set<string> {
  const dirs = new Set<string>(['']);
  for (const path of paths) {
    const parts = path.split('/');
    let acc = '';
    for (let index = 0; index < parts.length - 1; index += 1) {
      acc = acc === '' ? parts[index] : `${acc}/${parts[index]}`;
      dirs.add(acc);
    }
  }
  return dirs;
}

type DirProbe =
  /** A real directory: carry its lstat identity and mode for repair proof. */
  | { kind: 'dir'; stat: Stats }
  /** A symlink on disk where a directory belongs — descendants are never followed. */
  | { kind: 'symlink' }
  /** A non-directory non-symlink (file, fifo, socket) occupies the slot. */
  | { kind: 'not-dir' }
  /** lstat failed; without a mode nothing is proven. */
  | { kind: 'error'; reason: string };

interface DirVerdict {
  /** The drift entry for the directory itself, or null when clean. */
  entry: ModeDriftEntry | null;
  /** Non-null when every tracked file beneath must be refused for this reason. */
  blocksDescendants: string | null;
}

function probeDir(path: string): DirProbe {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return { kind: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink' };
  if (!stat.isDirectory()) return { kind: 'not-dir' };
  return { kind: 'dir', stat };
}

interface ScanIdentity {
  dev: number;
  ino: number;
  kind: 'file' | 'dir';
  mode: number;
}

/** Repair-only proof kept out of doctor JSON and the public drift report. */
const scanIdentities = new WeakMap<ModeDriftEntry, ScanIdentity>();

function rememberIdentity(entry: ModeDriftEntry, stat: Stats, kind: 'file' | 'dir'): ModeDriftEntry {
  scanIdentities.set(entry, { dev: stat.dev, ino: stat.ino, kind, mode: stat.mode & 0o7777 });
  return entry;
}

/**
 * Compare one on-disk mode against the mode it must match. Pure + exported so
 * the tighten-only contract is unit-tested without a worktree on disk.
 *
 * Returns null when the modes agree; otherwise a disposition plus the reason
 * the item keeps or is tightened. `dir` narrows the repairable set to the
 * named drift shapes: a wider directory outside {0775, 0777} (e.g. setgid
 * 2775) is refused rather than edited, because its extra bits may be
 * intentional. Files get the same carve-out for the privilege bits: setuid/
 * setgid/sticky are reported and NEVER stripped — the only mutation a chmod
 * to the index mode could make on them is a privilege-semantics change, not
 * drift hygiene.
 */
export function classifyModeDrift(
  diskMode: number,
  indexMode: number,
  kind: 'file' | 'dir',
): { disposition: ModeDriftDisposition; reason: string } | null {
  const disk = diskMode & 0o7777;
  const index = indexMode & 0o777;
  if (disk === index) return null;
  if (kind === 'file' && (disk & 0o7000) !== 0) {
    return { disposition: 'refused', reason: 'setuid/setgid/sticky bits present on a file — never stripped' };
  }
  const wider = (disk & ~index) !== 0;
  const stricter = (index & ~disk) !== 0;
  if (wider && !stricter) {
    if (kind === 'dir' && !DIR_TIGHTEN_MODES.has(disk)) {
      return {
        disposition: 'refused',
        reason: `wider than ${octal(index)} but outside the named repair set (only 0775/0777 dirs are tightened)`,
      };
    }
    return { disposition: 'wider', reason: 'on-disk mode is a superset of the index mode' };
  }
  if (!wider && stricter) {
    return {
      disposition: 'stricter',
      reason: `on-disk mode is stricter than ${octal(index)} — never widened`,
    };
  }
  return { disposition: 'mixed', reason: 'on-disk mode has both extra and missing bits — never edited' };
}

/** Verdict for one tracked-path ancestor directory against canonical 0755. */
function classifyDir(worktree: string, relDir: string, probe: DirProbe): DirVerdict {
  const base = { worktree, relPath: relDir, kind: 'dir' as const, indexMode: octal(CANONICAL_DIR_MODE) };
  if (probe.kind === 'symlink') {
    const reason = 'on-disk is a symlink where a directory belongs — never followed';
    return {
      entry: { ...base, diskMode: null, disposition: 'refused', reason },
      blocksDescendants: `ancestor '${relDir === '' ? '.' : relDir}' is a symlink on disk — never followed`,
    };
  }
  if (probe.kind === 'not-dir') {
    const reason = 'on-disk is a non-directory where a directory belongs — never edited';
    return {
      entry: { ...base, diskMode: null, disposition: 'refused', reason },
      blocksDescendants: `ancestor '${relDir === '' ? '.' : relDir}' is not a directory — never followed`,
    };
  }
  if (probe.kind === 'error') {
    return {
      entry: { ...base, diskMode: null, disposition: 'refused', reason: `lstat failed: ${probe.reason}` },
      blocksDescendants: null,
    };
  }
  const verdict = classifyModeDrift(probe.stat.mode, CANONICAL_DIR_MODE, 'dir');
  return {
    entry:
      verdict === null
        ? null
        : rememberIdentity({ ...base, diskMode: octal(probe.stat.mode & 0o7777), ...verdict }, probe.stat, 'dir'),
    blocksDescendants: null,
  };
}

/** First ancestor dir (from the root down) whose probe blocks file probes, if any. */
function blockingAncestor(path: string, probes: Map<string, DirVerdict>): string | null {
  const rootBlock = probes.get('')?.blocksDescendants ?? null;
  if (rootBlock !== null) return rootBlock;
  const parts = path.split('/');
  let acc = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    acc = acc === '' ? parts[index] : `${acc}/${parts[index]}`;
    const reason = probes.get(acc)?.blocksDescendants ?? null;
    if (reason !== null) return reason;
  }
  return null;
}

type FileProbe =
  /** Missing on disk (ENOENT): content dirt, not mode drift — silently skipped. */
  { kind: 'missing' } | { kind: 'error'; reason: string } | { kind: 'present'; stat: Stats };

/** lstat that never throws; a missing item is reported as such, not as drift. */
function probeFile(path: string): FileProbe {
  try {
    return { kind: 'present', stat: lstatSync(path) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Verdict for one tracked path's directory slot. A blocked dir (an ancestor is
 * a symlink on disk) is refused WITHOUT probing it: lstatSync follows
 * intermediate components, so probing `a/b` under a symlinked `a` would stat a
 * path OUTSIDE the worktree — and could classify, then repair, someone else's
 * directory. The dir list is sorted root-down, so the blocking ancestor is
 * always already in `probes` when a deeper dir is reached.
 */
function probeTreeDir(worktree: string, dir: string, probes: Map<string, DirVerdict>): DirVerdict {
  const blocked = blockingAncestor(dir, probes);
  if (blocked !== null) {
    return {
      entry: {
        worktree,
        relPath: dir,
        kind: 'dir',
        indexMode: octal(CANONICAL_DIR_MODE),
        diskMode: null,
        disposition: 'refused',
        reason: `${blocked}`,
      },
      blocksDescendants: null,
    };
  }
  return classifyDir(worktree, dir, probeDir(join(worktree, dir)));
}

/** Verdict for one tracked file, or null when it is clean or missing on disk. */
function classifyFile(worktree: string, file: IndexEntry, probes: Map<string, DirVerdict>): ModeDriftEntry | null {
  const base = { worktree, relPath: file.path, kind: 'file' as const, indexMode: octal(file.mode & 0o777) };
  const blocked = blockingAncestor(file.path, probes);
  if (blocked !== null) return { ...base, diskMode: null, disposition: 'refused', reason: `${blocked}` };
  const probe = probeFile(join(worktree, file.path));
  if (probe.kind === 'missing') return null; // content dirt, not mode drift
  if (probe.kind === 'error') {
    return { ...base, diskMode: null, disposition: 'refused', reason: `lstat failed: ${probe.reason}` };
  }
  const stat = probe.stat;
  if (stat.isSymbolicLink()) {
    return {
      ...base,
      diskMode: null,
      disposition: 'refused',
      reason: 'on-disk is a symlink where the index records a regular file — never followed',
    };
  }
  if (!stat.isFile()) {
    return {
      ...base,
      diskMode: null,
      disposition: 'refused',
      reason: 'on-disk is a non-file where the index records a regular file — never edited',
    };
  }
  const verdict = classifyModeDrift(stat.mode, file.mode, 'file');
  return verdict === null
    ? null
    : rememberIdentity({ ...base, diskMode: octal(stat.mode & 0o7777), ...verdict }, stat, 'file');
}

/** Whole-worktree refusal for a registration whose directory no longer exists. */
function vanishedWorktreeRefusal(worktree: string): ModeDriftEntry | null {
  try {
    lstatSync(worktree);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {
        worktree,
        relPath: null,
        kind: 'worktree',
        indexMode: null,
        diskMode: null,
        disposition: 'refused',
        reason: 'worktree directory no longer exists',
      };
    }
  }
  return null;
}

/** Mode drift inside ONE worktree. A git probe failure refuses the whole tree. */
function scanWorktree(worktree: string): ModeDriftEntry[] {
  // A registration whose directory is gone can never be probed: refuse it
  // before spawning git, which would only fail with a cryptic spawn error.
  const vanished = vanishedWorktreeRefusal(worktree);
  if (vanished !== null) return [vanished];
  const listing = git(worktree, ['ls-files', '-s', '-z']);
  if (!listing.ok) {
    return [
      {
        worktree,
        relPath: null,
        kind: 'worktree',
        indexMode: null,
        diskMode: null,
        disposition: 'refused',
        reason: firstLine(listing.stderr, 'git ls-files failed'),
      },
    ];
  }
  const index = parseLsFilesZ(listing.stdout);
  const dirs = [...ancestorDirs(index.map((entry) => entry.path))].sort();
  const probes = new Map<string, DirVerdict>();
  const entries: ModeDriftEntry[] = [];
  for (const dir of dirs) {
    const verdict = probeTreeDir(worktree, dir, probes);
    probes.set(dir, verdict);
    if (verdict.entry !== null) entries.push(verdict.entry);
  }
  const seen = new Set<string>();
  for (const file of index) {
    if (SKIP_INDEX_MODES.has(file.mode) || seen.has(file.path)) continue;
    seen.add(file.path);
    const entry = classifyFile(worktree, file, probes);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** Worktree path display: '' and null both collapse to the bare basename. */
function displayName(entry: ModeDriftEntry): string {
  return entry.relPath === null || entry.relPath === ''
    ? basename(entry.worktree)
    : `${basename(entry.worktree)}:${entry.relPath}`;
}

/**
 * Enumerate every registered worktree and classify each drifted item inside.
 * The main checkout and the checkout doctor runs from are included — mode
 * hygiene is content repair, never removal, so nothing is exempt from it.
 */
export function scanWorktreeModes(root: string): ModeDriftScan {
  const list = git(root, ['worktree', 'list', '--porcelain']);
  if (!list.ok) {
    return { entries: [], enumerationError: firstLine(list.stderr, 'git worktree list failed') };
  }
  const records = parseWorktreePorcelain(list.stdout);
  const entries = records.flatMap((record) => scanWorktree(record.path));
  entries.sort((left, right) => {
    if (left.worktree !== right.worktree) return left.worktree < right.worktree ? -1 : 1;
    const a = left.relPath ?? '';
    const b = right.relPath ?? '';
    if (a !== b) return a < b ? -1 : 1;
    return left.kind < right.kind ? -1 : 1;
  });
  return { entries, enumerationError: null };
}

const CHECK_NAME = 'mode drift';

const FIX_ADVICE =
  'Run `genie doctor --fix` to tighten wider-than-index modes (files to their index modes; 0775/0777 dirs to 0755).';
/**
 * The remedy for a refused registration whose directory is gone: every probe
 * inside it fails, so it would warn forever — only a prune clears it.
 */
const PRUNE_ADVICE = 'Run `git worktree prune` to drop registrations whose directory no longer exists.';

/** Headline: how much drift exists and whether anything is provably repairable. */
function summarizeScan(scan: ModeDriftScan): CheckResult {
  if (scan.entries.length === 0) return { name: CHECK_NAME, status: 'pass', detail: 'none found' };
  const count = (disposition: ModeDriftDisposition): number =>
    scan.entries.filter((entry) => entry.disposition === disposition).length;
  const wider = count('wider');
  const stricter = count('stricter');
  const mixed = count('mixed');
  const refused = count('refused');
  const worktrees = new Set(scan.entries.map((entry) => entry.worktree)).size;
  const parts = [
    wider > 0 ? `${wider} wider` : '',
    stricter > 0 ? `${stricter} stricter` : '',
    mixed > 0 ? `${mixed} mixed` : '',
    refused > 0 ? `${refused} refused` : '',
  ].filter((part) => part !== '');
  const across = `${parts.join(', ')} drift item(s) across ${worktrees} worktree(s)`;
  const vanished = scan.entries.some((entry) => entry.kind === 'worktree');
  if (wider === 0) {
    // Fail-closed reads fail-closed: refusals (probe errors, planted symlinks)
    // and unfixable mixed drift escalate the headline to warn even though
    // nothing is repairable. Stricter items alone stay an informational pass —
    // they are deliberate hardening, not damage.
    if (refused > 0 || mixed > 0 || vanished) {
      return {
        name: CHECK_NAME,
        status: 'warn',
        detail: `${across} — nothing to fix`,
        suggestion: vanished ? PRUNE_ADVICE : undefined,
      };
    }
    return { name: CHECK_NAME, status: 'pass', detail: `${across} — nothing to fix` };
  }
  const suggestion = [FIX_ADVICE, vanished ? PRUNE_ADVICE : ''].filter((part) => part !== '').join(' ');
  return { name: CHECK_NAME, status: 'warn', detail: across, suggestion };
}

/** One line per drifted item, stating its disposition and the reason. */
function describeEntry(entry: ModeDriftEntry): CheckResult {
  const name = `${CHECK_NAME}: ${displayName(entry)}`;
  const modes = `on-disk ${entry.diskMode ?? 'unknown'}, ${entry.kind === 'dir' ? 'canonical' : 'index'} ${entry.indexMode ?? 'unknown'}`;
  switch (entry.disposition) {
    case 'wider':
      return { name, status: 'warn', detail: `${modes} — --fix tightens to ${entry.indexMode}` };
    case 'stricter':
      // A stricter FILE on a tracked-100755 path (e.g. a bundle that lost its
      // executable bit) names the one repair that restores it: a manual chmod.
      // That is a widening, so it is a user decision — never a --fix action.
      if (entry.kind === 'file' && entry.indexMode === '755') {
        return {
          name,
          status: 'pass',
          detail: `kept (${entry.reason}; ${modes}) — never widened`,
          suggestion:
            'Restoring the executable bit is a widening: run `chmod 755 <path>` yourself if the index mode is intended — --fix never widens.',
        };
      }
      return { name, status: 'pass', detail: `kept (${entry.reason}; ${modes}) — never widened` };
    case 'mixed':
      return { name, status: 'warn', detail: `kept (${entry.reason}; ${modes}) — never edited` };
    case 'refused':
      return { name, status: 'warn', detail: `kept (${entry.reason}) — --fix will not touch it` };
  }
}

/**
 * Detect-only view of the mode drift. Pure read: doctor without `--fix`
 * mutates nothing here. Outside a git repo (`root === null`) there is nothing
 * to enumerate and no check is emitted.
 */
export function checkWorktreeModes(root: string | null): CheckResult[] {
  if (root === null) return [];
  const scan = scanWorktreeModes(root);
  if (scan.enumerationError !== null) {
    return [
      {
        name: CHECK_NAME,
        status: 'warn',
        detail: `enumeration failed: ${scan.enumerationError}`,
        suggestion: 'Run `git worktree list` from the repo root to see why git refused.',
      },
    ];
  }
  return [summarizeScan(scan), ...scan.entries.map(describeEntry)];
}

/**
 * The single mutation site. The path was classified from an lstat taken
 * during a scan that may be arbitrarily stale, so it is re-proven here:
 * `open(O_NOFOLLOW)` refuses when the final component has been swapped for a
 * symlink (ELOOP), `O_NONBLOCK` keeps a planted FIFO from wedging the open,
 * the opened descriptor is type-checked (regular file or directory only), and
 * the chmod acts on the descriptor — never on the path — so nothing between
 * open and fchmod can redirect it. A re-lstat alone is not sufficient: the
 * swap could land between the lstat and the chmod.
 */
function tightenNoFollow(path: string, mode: number, entry: ModeDriftEntry): string | null {
  const expected = scanIdentities.get(entry);
  if (expected === undefined) return 'scan identity unavailable — never edited';
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    return `open(O_NOFOLLOW) refused: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const stat = fstatSync(fd);
    const currentKind = stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null;
    if (currentKind === null) {
      return 'opened descriptor is not a regular file or directory — never edited';
    }
    if (entry.kind !== expected.kind || currentKind !== expected.kind) {
      return `opened descriptor kind changed from ${expected.kind} to ${currentKind} — never edited`;
    }
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
      return 'opened descriptor replaced since scan — never edited';
    }
    const verdict = classifyModeDrift(stat.mode, mode, currentKind);
    if (verdict?.disposition !== 'wider') {
      return `current mode ${octal(stat.mode & 0o7777)} is no longer safely wider — never edited`;
    }
    if ((stat.mode & 0o7777) !== expected.mode) {
      return `current mode changed since scan (${octal(expected.mode)} → ${octal(stat.mode & 0o7777)}) — never edited`;
    }
    fchmodSync(fd, mode);
    return null;
  } catch (error) {
    return `fchmod refused: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* descriptor cleanup is best-effort; the mutation already succeeded or refused */
    }
  }
}

/**
 * `--fix` half: tighten every item the scan proved wider than its index mode —
 * files to their exact index permissions, 0775/0777 dirs to 0755. Idempotent:
 * a repo with no wider item is a strict no-op. A per-item open/fchmod failure
 * is reported and skipped; it never escalates and never touches a non-wider
 * item.
 */
export function repairWorktreeModes(root: string | null, deps: ModeRepairDeps = {}): void {
  if (root === null) return;
  const emit = deps.logSink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const scan = deps.scan ?? scanWorktreeModes(root);
  if (scan.enumerationError !== null) {
    emit(`  \x1b[33m!\x1b[0m mode repair skipped: enumeration failed (${scan.enumerationError})`);
    return;
  }
  const wider = scan.entries.filter((entry) => entry.disposition === 'wider');
  if (wider.length === 0) return;
  emit(`\x1b[2mTightening ${wider.length} wider-than-index mode(s)...\x1b[0m`);
  for (const entry of wider) {
    const path = entry.relPath === null ? entry.worktree : join(entry.worktree, entry.relPath);
    // Guarded parse: a wider entry whose index mode fails to parse is kept
    // with the reason — chmodding garbage would be neither tightening nor
    // fail-closed.
    const target = entry.indexMode === null ? Number.NaN : Number.parseInt(entry.indexMode, 8);
    if (!Number.isInteger(target) || target < 0 || target > 0o7777) {
      emit(`  \x1b[33m!\x1b[0m kept ${path}: unparseable index mode '${entry.indexMode}' — --fix will not touch it`);
      continue;
    }
    // A `wider` entry implies the on-disk mode is a strict superset of the
    // index mode, so setting the index mode exactly only ever removes bits.
    const failure = tightenNoFollow(path, target, entry);
    if (failure === null) emit(`  \x1b[32m✔\x1b[0m tightened ${path} (${entry.diskMode} → ${entry.indexMode})`);
    else emit(`  \x1b[33m!\x1b[0m kept ${path}: ${failure}`);
  }
}
