/**
 * Archive-safety primitives shared by the release gates that open a published
 * tarball: `build-delivery-evidence.ts` (which mints the signed delivery
 * descriptor) and `verify-dsh-genie-board-release.ts` (which re-verifies the
 * published DSH plugin payload).
 *
 * Both gates must reject exactly the same archive shapes — a second, weaker
 * copy of these checks is a hole, not a duplicate — so the checks live here
 * once and throw plain `Error`s. Each CLI maps the throw onto its own exit
 * contract (`delivery-evidence:` + exit 2, or the verifier's exit 1).
 */

import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Streaming SHA-256 so a 100 MB+ release tarball never has to be buffered whole. */
export function sha256File(path: string): string {
  const digest = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count <= 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

function listArchive(tarball: string, flags: string): string[] {
  const result = Bun.spawnSync(['tar', flags, tarball], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
  if (result.exitCode !== 0) throw new Error(`cannot list tarball: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().split('\n');
}

/**
 * Reject escaping, backslash-bearing and duplicate member names, then reject
 * every member that is not a regular file or a directory — before a single
 * byte is extracted.
 */
export function assertSafeArchiveListing(tarball: string): void {
  const seen = new Set<string>();
  for (const raw of listArchive(tarball, '-tzf')) {
    if (!raw) continue;
    const path = raw.replace(/^\.\//, '').replace(/\/$/, '');
    if (!path) continue;
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..')) {
      throw new Error(`unsafe archive path ${raw}`);
    }
    if (seen.has(path)) throw new Error(`duplicate archive path ${raw}`);
    seen.add(path);
  }
  for (const line of listArchive(tarball, '-tvzf')) {
    if (!line) continue;
    const kind = line[0];
    if (kind !== '-' && kind !== 'd') throw new Error(`archive contains link or unsupported member type ${kind}`);
  }
}

/** Rescan the extracted tree: a listing check alone cannot prove what landed on disk. */
export function assertPhysicalArchiveTree(current: string): void {
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`archive extracted a symlink at ${path}`);
    if (stat.isDirectory()) assertPhysicalArchiveTree(path);
    else if (!stat.isFile()) throw new Error(`archive extracted an unsupported entry at ${path}`);
  }
}

/** Safe-list, extract without inheriting archived ownership/modes, then rescan. */
export function extractTarball(tarball: string, root: string): void {
  assertSafeArchiveListing(tarball);
  const extracted = Bun.spawnSync(['tar', '-xzf', tarball, '--no-same-owner', '--no-same-permissions', '-C', root], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  if (extracted.exitCode !== 0) throw new Error(`cannot extract tarball: ${extracted.stderr.toString().trim()}`);
  assertPhysicalArchiveTree(root);
}
