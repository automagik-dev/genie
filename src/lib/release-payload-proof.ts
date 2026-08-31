/**
 * Release-version grammar and physical-payload tree proof.
 *
 * Two independent primitives the binary-promotion path and the local-delivery
 * repair gate both need, and which outlive the Codex plugin subsystem that
 * originally hosted them:
 *
 *   - the pure, dependency-free `MAJOR.YYMMDD.N` release grammar (moved verbatim
 *     from the retired Codex release-version leaf), plus the bounded control-sequence
 *     sanitiser that travelled with it; and
 *   - `scanPhysicalTree`, the symlink-rejecting SHA-256 over a physical payload
 *     directory (moved verbatim from the retired Codex activation protocol).
 *
 * The tree digest's domain separator is a wire contract shared with
 * `scripts/build-delivery-evidence.ts`; it is deliberately unchanged by the move.
 */

import { createHash } from 'node:crypto';
import { type Stats, closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ============================================================================
// Release-version grammar (moved verbatim from the retired Codex release-version leaf)
// ============================================================================

/** Exact `MAJOR.YYMMDD.N` release grammar; build metadata is stripped only after a match. */
export const RELEASE_VERSION_RE = /^(\d+)\.(\d{6})\.(\d+)(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export interface ParsedReleaseVersion {
  readonly major: number;
  readonly ymd: number;
  readonly n: number;
  /** The `MAJOR.YYMMDD.N` triple with build metadata removed; used for equality. */
  readonly canonical: string;
}

/** Parse a release version, returning null for anything that fails the exact grammar. */
export function parseReleaseVersion(raw: unknown): ParsedReleaseVersion | null {
  if (typeof raw !== 'string') return null;
  const match = RELEASE_VERSION_RE.exec(raw);
  if (!match) return null;
  const major = Number(match[1]);
  const ymd = Number(match[2]);
  const n = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(ymd) || !Number.isSafeInteger(n)) return null;
  return { major, ymd, n, canonical: `${major}.${match[2]}.${n}` };
}

/** Total numeric order over validated versions. */
export function compareReleaseVersions(a: ParsedReleaseVersion, b: ParsedReleaseVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.ymd !== b.ymd) return a.ymd < b.ymd ? -1 : 1;
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  return 0;
}

/** Strip ANSI CSI and OSC control sequences from modeled diagnostics/output. */
export function stripControl(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ESC/BEL control bytes.
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
}

// ============================================================================
// Physical-tree scanning (symlink-rejecting, bounded)
// ============================================================================

export interface PhysicalTreeReport {
  status: 'ok' | 'symlink' | 'unsafe' | 'absent';
  digest?: string;
  identity?: string;
  detail?: string;
}

/**
 * Symlink-rejecting SHA-256 over a physical directory tree, plus the root's
 * `dev:ino` identity. Any symlink inside the required payload is unsafe; a
 * non-directory root or unreadable tree is unsafe rather than silently skipped.
 */
export function scanPhysicalTree(root: string): PhysicalTreeReport {
  let rootStat: Stats;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'unsafe', detail: `root unreadable: ${errorText(error)}` };
  }
  if (rootStat.isSymbolicLink()) return { status: 'symlink', detail: 'root is a symlink' };
  if (!rootStat.isDirectory()) return { status: 'unsafe', detail: 'root is not a directory' };
  const entries: string[] = [];
  const symlink = collectTreeEntries(root, root, entries);
  if (symlink) return { status: 'symlink', detail: symlink };
  const digest = createHash('sha256');
  digest.update('genie-codex-activation-tree-v1\0');
  for (const line of entries.sort()) digest.update(line);
  return { status: 'ok', digest: digest.digest('hex'), identity: `${rootStat.dev}:${rootStat.ino}` };
}

/** Returns a symlink-detail string on the first symlink, else null (tree fully scanned). */
function collectTreeEntries(root: string, current: string, out: string[]): string | null {
  let names: string[];
  try {
    names = readdirSync(current).sort();
  } catch (error) {
    out.push(`ERR\0${relative(root, current)}\0${errorText(error)}\0`);
    return null;
  }
  for (const name of names) {
    const abs = join(current, name);
    const rel = relative(root, abs).split(sep).join('/');
    let stat: Stats;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      out.push(`ERR\0${rel}\0${errorText(error)}\0`);
      continue;
    }
    if (stat.isSymbolicLink()) return `symlink at ${rel}`;
    if (stat.isDirectory()) {
      out.push(`D\0${rel}\0`);
      const nested = collectTreeEntries(root, abs, out);
      if (nested) return nested;
    } else if (stat.isFile()) {
      out.push(`F\0${rel}\0${(stat.mode & 0o111) !== 0 ? 'x' : '-'}\0${hashFileBounded(abs)}\0`);
    } else {
      out.push(`O\0${rel}\0`);
    }
  }
  return null;
}

function hashFileBounded(path: string): string {
  const digest = createHash('sha256');
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    return `unreadable:${errorText(error)}`;
  }
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
