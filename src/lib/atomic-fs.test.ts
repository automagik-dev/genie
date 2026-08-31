/**
 * Tests for the atomic filesystem primitives. Split verbatim out of
 * `agent-sync.test.ts` when the primitives moved into their own module; the
 * blocks below are unchanged apart from their imports and the minimal tmpdir
 * fixture they need (the full agent-sync fixture built agent target dirs these
 * tests never touch).
 *
 * Run with: bun test src/lib/atomic-fs.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type FsyncPathDeps,
  MANIFEST_NAME,
  atomicRenameDirectoryNoClobber,
  atomicWriteFileSync,
  computeDirDigest,
  computeFileDigest,
  fsyncParentDir,
  fsyncPathForTest,
  publishDirectoryViaNameClaim,
  readBoundedRegularFile,
  resolveLinuxRenameat2,
  unlinkWithParentFsync,
  writeAllSync,
} from './atomic-fs';

interface Fixture {
  root: string;
}

let fixture: Fixture;

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

beforeEach(() => {
  fixture = { root: realpathSync(mkdtempSync(join(tmpdir(), 'atomic-fs-'))) };
});

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// G4 short-write loop + G5 musl-safe no-clobber directory publish primitives
// ---------------------------------------------------------------------------

describe('writeAllSync short-write loop (G4)', () => {
  test('completes a whole buffer across a partial write then a full write', () => {
    const path = join(fixture.root, 'writeall-target');
    const buffer = Buffer.from('the quick brown fox jumps over the lazy dog\n');
    let calls = 0;
    const partialOnce: typeof writeSync = ((fd: number, buf: Buffer, offset: number, length: number) => {
      calls += 1;
      const chunk = calls === 1 ? Math.min(4, length) : length; // short write on the first call only
      return writeSync(fd, buf, offset, chunk);
    }) as typeof writeSync;
    const fd = openSync(path, 'w');
    try {
      writeAllSync(fd, buffer, partialOnce);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path)).toEqual(buffer); // every byte landed despite the short write
    expect(calls).toBeGreaterThanOrEqual(2); // the loop advanced the offset and finished the tail
  });

  test('a writer that never makes progress raises rather than looping forever', () => {
    const zeroWriter: typeof writeSync = (() => 0) as typeof writeSync;
    expect(() => writeAllSync(1, Buffer.from('x'), zeroWriter)).toThrow('made no progress');
  });
});

describe('no-clobber directory publish (G5 musl portability)', () => {
  function stagedTree(name: string, body = `# ${name}\n`): string {
    const dir = join(fixture.root, name);
    writeFile(join(dir, 'SKILL.md'), body);
    return dir;
  }

  function bufPath(b: Buffer): string {
    return b.toString('utf8').replace(/\0$/, '');
  }

  // A JS stand-in for renameat2(RENAME_NOREPLACE): refuse when the target exists.
  const noReplaceRenamer = (s: Buffer, t: Buffer): number => {
    const target = bufPath(t);
    if (existsSync(target)) return -1;
    renameSync(bufPath(s), target);
    return 0;
  };

  test('resolveLinuxRenameat2 tries candidate sonames in order and returns the first that resolves', () => {
    const attempted: string[] = [];
    const opener = (soname: string) => {
      attempted.push(soname);
      return soname === 'good.so' ? noReplaceRenamer : null;
    };
    const resolved = resolveLinuxRenameat2(opener, ['bad-1.so', 'good.so', 'never-reached.so']);
    expect(resolved).toBe(noReplaceRenamer);
    expect(attempted).toEqual(['bad-1.so', 'good.so']); // stops at the first success
  });

  test('a resolved renameat2 publishes atomically onto an absent target and rejects an existing one', () => {
    const staged = stagedTree('rn-src');
    const digest = computeDirDigest(staged);
    const target = join(fixture.root, 'rn-target');
    atomicRenameDirectoryNoClobber(staged, target, {
      platform: 'linux',
      opener: () => noReplaceRenamer,
      probe: {},
    });
    expect(computeDirDigest(target)).toBe(digest);
    const staged2 = stagedTree('rn-src2');
    expect(() =>
      atomicRenameDirectoryNoClobber(staged2, target, {
        platform: 'linux',
        opener: () => noReplaceRenamer,
        probe: {},
      }),
    ).toThrow('target preserved');
    expect(computeDirDigest(target)).toBe(digest); // pre-existing target bytes untouched
  });

  test('with no libc renameat2 available, the portable name-claim publishes onto an absent target', () => {
    const staged = stagedTree('portable-src');
    const digest = computeDirDigest(staged);
    const target = join(fixture.root, 'portable-target'); // absent
    atomicRenameDirectoryNoClobber(staged, target, { platform: 'linux', opener: () => null, probe: {} });
    expect(computeDirDigest(target)).toBe(digest); // mkdir-claim + rename-onto-empty reproduces the tree
  });

  test('with no libc renameat2 available, a non-empty target is preserved and NoClobberPublishError is raised', () => {
    const staged = stagedTree('portable-src2');
    const target = join(fixture.root, 'portable-target2');
    writeFile(join(target, 'EXISTING.txt'), 'user bytes\n');
    const before = computeDirDigest(target);
    expect(() =>
      atomicRenameDirectoryNoClobber(staged, target, { platform: 'linux', opener: () => null, probe: {} }),
    ).toThrow('portable directory claim failed');
    expect(computeDirDigest(target)).toBe(before); // target never clobbered
    expect(readFileSync(join(target, 'EXISTING.txt'), 'utf8')).toBe('user bytes\n');
  });

  test('publishDirectoryViaNameClaim replaces only an empty claimed dir and rejects a populated target', () => {
    const staged = stagedTree('claim-src');
    const digest = computeDirDigest(staged);
    const target = join(fixture.root, 'claim-target'); // absent
    publishDirectoryViaNameClaim(staged, target);
    expect(computeDirDigest(target)).toBe(digest);
    const staged2 = stagedTree('claim-src2');
    const before = computeDirDigest(target);
    expect(() => publishDirectoryViaNameClaim(staged2, target)).toThrow('portable directory claim failed');
    expect(computeDirDigest(target)).toBe(before); // a real (non-empty) target is never touched
  });

  test('Darwin falls back safely when native rename setup is unavailable before invocation', () => {
    const staged = stagedTree('darwin-portable-src');
    const digest = computeDirDigest(staged);
    const target = join(fixture.root, 'darwin-portable-target');
    atomicRenameDirectoryNoClobber(staged, target, { platform: 'darwin', darwinOpener: () => null });
    expect(computeDirDigest(target)).toBe(digest);
  });

  test('feature detection is memoized at first use across publishes', () => {
    let calls = 0;
    const probe = {}; // fresh probe cache shared across both publishes
    const opener = () => {
      calls += 1;
      return null; // simulate musl: no candidate resolves
    };
    atomicRenameDirectoryNoClobber(stagedTree('cache-1'), join(fixture.root, 'cache-t1'), {
      platform: 'linux',
      opener,
      probe,
    });
    const afterFirst = calls;
    atomicRenameDirectoryNoClobber(stagedTree('cache-2'), join(fixture.root, 'cache-t2'), {
      platform: 'linux',
      opener,
      probe,
    });
    expect(calls).toBe(afterFirst); // the second publish reuses the memoized probe — no re-detection
    expect(afterFirst).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — directory-metadata fsync tolerance (Windows / network-fs failpoint).
// A directory fsync that the platform refuses must NOT brick journal-prepare;
// FILE fsync stays strict because journal/staging byte durability is load-bearing.
// ---------------------------------------------------------------------------

describe('fsyncPath directory-metadata flush tolerance (Fix 4)', () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  const dir = (name: string): string => {
    const d = join(fixture.root, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const throwingFsync = (code: string): FsyncPathDeps['fsync'] =>
    (() => {
      throw errno(code);
    }) as unknown as FsyncPathDeps['fsync'];

  for (const code of ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'] as const) {
    test(`a DIRECTORY fsync raising ${code} is swallowed (best-effort)`, () => {
      expect(() => fsyncPathForTest(dir(`fsync-dir-${code}`), { fsync: throwingFsync(code) })).not.toThrow();
    });
  }

  test('a DIRECTORY that cannot even be opened for fsync is tolerated', () => {
    const open = (() => {
      throw errno('EISDIR');
    }) as unknown as FsyncPathDeps['open'];
    expect(() => fsyncPathForTest(dir('fsync-open-eisdir'), { open })).not.toThrow();
  });

  test('a DIRECTORY fsync is skipped entirely on win32 (open never attempted)', () => {
    let opened = false;
    const open = (() => {
      opened = true;
      return 0;
    }) as unknown as FsyncPathDeps['open'];
    fsyncPathForTest(dir('fsync-win32'), { platform: 'win32', open });
    expect(opened).toBe(false);
  });

  test('a FILE fsync failure stays strict — journal/staging durability is load-bearing', () => {
    const f = join(fixture.root, 'fsync-file-strict');
    writeFile(f, 'durable\n');
    expect(() => fsyncPathForTest(f, { fsync: throwingFsync('EIO') })).toThrow('EIO');
  });

  test('a DIRECTORY fsync raising a NON-tolerable code still propagates', () => {
    expect(() => fsyncPathForTest(dir('fsync-dir-eio'), { fsync: throwingFsync('EIO') })).toThrow('EIO');
  });

  test('a healthy directory fsync succeeds through the real syscalls', () => {
    expect(() => fsyncPathForTest(dir('fsync-dir-ok'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Digest properties
// ---------------------------------------------------------------------------

describe('computeDirDigest', () => {
  test('is stable regardless of directory entry creation order', () => {
    const dirA = join(fixture.root, 'digest-a');
    writeFile(join(dirA, 'b.md'), 'B');
    writeFile(join(dirA, 'a.md'), 'A');
    writeFile(join(dirA, 'nested', 'c.md'), 'C');

    const dirB = join(fixture.root, 'digest-b');
    writeFile(join(dirB, 'nested', 'c.md'), 'C');
    writeFile(join(dirB, 'a.md'), 'A');
    writeFile(join(dirB, 'b.md'), 'B');

    expect(computeDirDigest(dirA)).toBe(computeDirDigest(dirB));
  });

  test('excludes the manifest so a manifest does not change the digest', () => {
    const dir = join(fixture.root, 'digest-manifest');
    writeFile(join(dir, 'SKILL.md'), 'body');
    const before = computeDirDigest(dir);
    writeFile(join(dir, MANIFEST_NAME), '{"managedBy":"genie-agent-sync","digest":"x"}');
    expect(computeDirDigest(dir)).toBe(before);
  });

  test('changes when file content changes', () => {
    const dir = join(fixture.root, 'digest-content');
    writeFile(join(dir, 'SKILL.md'), 'one');
    const before = computeDirDigest(dir);
    writeFile(join(dir, 'SKILL.md'), 'two');
    expect(computeDirDigest(dir)).not.toBe(before);
  });

  test('identifies symlink kind and target without following external content', () => {
    const dir = join(fixture.root, 'physical-symlink');
    const external = join(fixture.root, 'external.txt');
    writeFile(external, 'one\n');
    mkdirSync(dir, { recursive: true });
    symlinkSync(external, join(dir, 'entry'));
    const linked = computeDirDigest(dir);

    writeFile(external, 'two\n');
    expect(computeDirDigest(dir)).toBe(linked);
    rmSync(join(dir, 'entry'));
    writeFile(join(dir, 'entry'), 'two\n');
    expect(computeDirDigest(dir)).not.toBe(linked);
    rmSync(join(dir, 'entry'));
    symlinkSync('different-target', join(dir, 'entry'));
    expect(computeDirDigest(dir)).not.toBe(linked);
  });

  test('identifies entry modes and broken symlinks', () => {
    const dir = join(fixture.root, 'physical-modes');
    writeFile(join(dir, 'tool'), '#!/bin/sh\n');
    symlinkSync('missing-target', join(dir, 'broken'));
    const before = computeDirDigest(dir);
    chmodSync(join(dir, 'tool'), 0o755);
    expect(computeDirDigest(dir)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Bounded reads + durable writes (moved in from the retired Codex activation persistence module)
// ---------------------------------------------------------------------------

describe('readBoundedRegularFile', () => {
  test('reads a regular file within the cap', () => {
    const path = join(fixture.root, 'bounded-ok');
    writeFileSync(path, 'payload', 'utf8');
    expect(readBoundedRegularFile(path, 1024)).toEqual({ status: 'ok', content: 'payload', size: 7 });
  });

  test('distinguishes absent, symlink, non-regular and oversized without mutating', () => {
    expect(readBoundedRegularFile(join(fixture.root, 'nope'), 1024)).toEqual({ status: 'absent' });

    const target = join(fixture.root, 'link-target');
    writeFileSync(target, 'x', 'utf8');
    const link = join(fixture.root, 'a-symlink');
    symlinkSync(target, link);
    expect(readBoundedRegularFile(link, 1024)).toEqual({ status: 'symlink' });

    const dir = join(fixture.root, 'a-directory');
    mkdirSync(dir);
    expect(readBoundedRegularFile(dir, 1024)).toEqual({ status: 'non-regular' });

    const big = join(fixture.root, 'oversized');
    writeFileSync(big, 'abcdefghij', 'utf8');
    expect(readBoundedRegularFile(big, 4)).toEqual({ status: 'oversized', size: 10 });
    expect(readFileSync(big, 'utf8')).toBe('abcdefghij');
  });
});

describe('atomicWriteFileSync', () => {
  test('publishes content at the requested mode and leaves no staging residue', () => {
    const path = join(fixture.root, 'nested', 'state.json');
    atomicWriteFileSync(path, '{"a":1}', { mode: 0o640 });
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}');
    expect(lstatSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dirname(path)).filter((name) => name.includes('.staging-'))).toEqual([]);
  });

  test('backs the prior regular file up before replacing it when asked', () => {
    const path = join(fixture.root, 'backed-up.json');
    atomicWriteFileSync(path, 'first');
    atomicWriteFileSync(path, 'second', { backup: true });
    expect(readFileSync(path, 'utf8')).toBe('second');
    const backups = readdirSync(fixture.root).filter((name) => name.includes('.genie-backup-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(fixture.root, backups[0]), 'utf8')).toBe('first');
  });
});

describe('unlinkWithParentFsync and fsyncParentDir', () => {
  test('removing an absent path is a no-op rather than a throw', () => {
    const path = join(fixture.root, 'already-gone');
    writeFileSync(path, 'x', 'utf8');
    unlinkWithParentFsync(path);
    expect(existsSync(path)).toBe(false);
    expect(() => unlinkWithParentFsync(path)).not.toThrow();
  });

  test('a parent-directory fsync never throws, even for a path that does not exist', () => {
    expect(() => fsyncParentDir(join(fixture.root, 'missing', 'deeper', 'file'))).not.toThrow();
  });
});

describe('computeFileDigest', () => {
  test('is the sha256 of the file bytes and changes with content', () => {
    const path = join(fixture.root, 'digest-me');
    writeFileSync(path, 'one', 'utf8');
    const before = computeFileDigest(path);
    expect(before).toBe(createHash('sha256').update(Buffer.from('one')).digest('hex'));
    writeFileSync(path, 'two', 'utf8');
    expect(computeFileDigest(path)).not.toBe(before);
  });
});
