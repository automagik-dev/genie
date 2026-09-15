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

test('an escaping member name is rejected before extraction', () => {
  const w = workspace();
  const tarball = join(w.root, 'escape.tar.gz');
  expect(
    Bun.spawnSync(['tar', '-czf', tarball, '-C', w.payload, '--transform', 's|nested/file.txt|../escape.txt|', '.'])
      .exitCode,
  ).toBe(0);
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
  expect(statSync(join(out, 'nested', 'file.txt')).mode & 0o777).toBe(0o777 & ~0o022);
});
