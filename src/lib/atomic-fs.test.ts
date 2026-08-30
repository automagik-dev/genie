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
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeDirDigest } from './agent-sync';
import {
  type FsyncPathDeps,
  atomicRenameDirectoryNoClobber,
  fsyncPathForTest,
  publishDirectoryViaNameClaim,
  resolveLinuxRenameat2,
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
