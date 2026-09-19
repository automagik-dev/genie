import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPhysicalArchiveTree,
  assertSafeArchiveListing,
  extractTarball,
  sha256File,
} from './release-archive-safety';

// process.umask() with no argument is deprecated in Node; read it by setting and restoring.
function currentUmask(): number {
  const previous = process.umask(0o022);
  process.umask(previous);
  return previous;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'genie-archive-safety-'));
  roots.push(root);
  const payload = join(root, 'payload');
  mkdirSync(join(payload, 'nested'), { recursive: true });
  writeFileSync(join(payload, 'nested', 'file.txt'), 'bytes');
  const tarball = join(root, 'payload.tar.gz');
  const pack = () => {
    expect(Bun.spawnSync(['tar', '-czf', tarball, '-C', payload, '.']).exitCode).toBe(0);
  };
  pack();
  return { root, payload, tarball, pack };
}

test('streaming sha256 matches the whole-file digest', () => {
  const w = workspace();
  const path = join(w.payload, 'nested', 'file.txt');
  expect(sha256File(path)).toBe(new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex'));
});

test('a safe archive lists and extracts', () => {
  const w = workspace();
  const out = mkdtempSync(join(tmpdir(), 'genie-archive-out-'));
  roots.push(out);
  expect(() => extractTarball(w.tarball, out)).not.toThrow();
  expect(readFileSync(join(out, 'nested', 'file.txt'), 'utf8')).toBe('bytes');
});

test('a backslash-bearing member name is rejected before extraction', () => {
  const w = workspace();
  writeFileSync(join(w.payload, 'back\\slash.txt'), 'bytes');
  w.pack();
  expect(() => assertSafeArchiveListing(w.tarball)).toThrow('unsafe archive path');
});

/**
 * Write a gzipped tar holding exactly one member, under the name given —
 * including a name no `tar` will produce from a real file tree.
 *
 * Byte-by-byte on purpose: the only way to make a tar CLI store an escaping
 * name is GNU tar's `--transform`, which macOS ships no equivalent of (bsdtar
 * has `-s`, with its own regex dialect), so the GNU-only form failed this test
 * on every darwin host (#2926). A plain POSIX ustar header is read identically
 * by GNU tar and bsdtar, which is what the listing guard actually consumes.
 */
function writeSingleMemberTarball(tarball: string, member: string, body: string): void {
  const header = Buffer.alloc(512);
  header.write(member, 0, 100, 'ascii');
  header.write('000644 \0', 100, 8, 'ascii'); // mode
  header.write('000000 \0', 108, 8, 'ascii'); // uid
  header.write('000000 \0', 116, 8, 'ascii'); // gid
  header.write(`${body.length.toString(8).padStart(11, '0')} `, 124, 12, 'ascii'); // size
  header.write('00000000000 ', 136, 12, 'ascii'); // mtime
  header.write('        ', 148, 8, 'ascii'); // checksum, counted as spaces
  header.write('0', 156, 1, 'ascii'); // typeflag: regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const content = Buffer.alloc(512);
  content.write(body, 0, 'ascii');
  // Two zero blocks end the archive.
  writeFileSync(tarball, Bun.gzipSync(Buffer.concat([header, content, Buffer.alloc(1024)])));
}

test('an escaping member name is rejected before extraction', () => {
  const w = workspace();
  const tarball = join(w.root, 'escape.tar.gz');
  writeSingleMemberTarball(tarball, '../escape.txt', 'bytes');
  expect(() => assertSafeArchiveListing(tarball)).toThrow('unsafe archive path');
});

test('a duplicate member name is rejected before extraction', () => {
  const w = workspace();
  const tarball = join(w.root, 'duplicate.tar.gz');
  expect(Bun.spawnSync(['tar', '-czf', tarball, '-C', w.payload, 'nested/file.txt', 'nested/file.txt']).exitCode).toBe(
    0,
  );
  expect(() => assertSafeArchiveListing(tarball)).toThrow('duplicate archive path');
});

test('a symlink member is rejected as a link or unsupported member type', () => {
  const w = workspace();
  symlinkSync('/tmp', join(w.payload, 'outside'));
  w.pack();
  expect(() => assertSafeArchiveListing(w.tarball)).toThrow('link or unsupported member type');
});

test('the extracted tree is rescanned, so a symlink that reaches disk still fails', () => {
  const out = mkdtempSync(join(tmpdir(), 'genie-archive-rescan-'));
  roots.push(out);
  mkdirSync(join(out, 'deep'), { recursive: true });
  writeFileSync(join(out, 'deep', 'file.txt'), 'bytes');
  expect(() => assertPhysicalArchiveTree(out)).not.toThrow();
  symlinkSync('/tmp', join(out, 'deep', 'link'));
  expect(() => assertPhysicalArchiveTree(out)).toThrow('extracted a symlink');
});

test('extraction never inherits archived ownership or permissions', () => {
  const w = workspace();
  chmodSync(join(w.payload, 'nested', 'file.txt'), 0o777);
  w.pack();
  const out = mkdtempSync(join(tmpdir(), 'genie-archive-perm-'));
  const shim = mkdtempSync(join(tmpdir(), 'genie-archive-shim-'));
  roots.push(out, shim);
  const log = join(shim, 'argv.log');
  const real = Bun.which('tar');
  writeFileSync(join(shim, 'tar'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, {
    mode: 0o755,
  });
  const previous = process.env.PATH;
  try {
    process.env.PATH = `${shim}:${previous}`;
    extractTarball(w.tarball, out);
  } finally {
    process.env.PATH = previous;
  }
  const extract = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .find((line) => line.startsWith('-xzf'));
  expect(extract).toContain('--no-same-owner');
  expect(extract).toContain('--no-same-permissions');
  // Whatever the archive recorded, the extracted payload keeps this process's umask.
  expect(statSync(join(out, 'nested', 'file.txt')).mode & 0o777).toBe(0o777 & ~currentUmask());
});

// Regression: the gate must be green on a restrictive-umask host, not only under 022.
test('the extracted mode follows the live umask, not a hardcoded 022', () => {
  const w = workspace();
  chmodSync(join(w.payload, 'nested', 'file.txt'), 0o777);
  w.pack();
  const restore = process.umask(0o077);
  try {
    const out = mkdtempSync(join(tmpdir(), 'genie-archive-umask-'));
    roots.push(out);
    extractTarball(w.tarball, out);
    expect(currentUmask()).toBe(0o077);
    expect(statSync(join(out, 'nested', 'file.txt')).mode & 0o777).toBe(0o777 & ~currentUmask());
    expect(statSync(join(out, 'nested', 'file.txt')).mode & 0o777).toBe(0o700);
  } finally {
    process.umask(restore);
  }
});
