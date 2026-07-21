import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NativeNoReplaceDependencies,
  NativeNoReplaceUnavailableError,
  NoClobberRenameError,
  inspectPhysicalPath,
  linuxLibcCandidates,
  nativeNoReplaceCapability,
  parsePhysicalPathIdentity,
  renamePathNoClobber,
} from './install-transaction.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-native-noreplace-'));
  roots.push(root);
  return root;
}

function decode(path: Buffer): string {
  return path.subarray(0, -1).toString();
}

function injectedNative(
  parent: string,
  overrides: Partial<NativeNoReplaceDependencies> = {},
): NativeNoReplaceDependencies {
  return {
    platform: 'linux',
    linuxCandidates: ['fixture-libc'],
    linuxOpener: () => (_sourceParentFd, source, _targetParentFd, target) => {
      const sourcePath = join(parent, decode(source));
      const targetPath = join(parent, decode(target));
      if (existsSync(targetPath)) return -1;
      renameSync(sourcePath, targetPath);
      return 0;
    },
    ...overrides,
  };
}

describe('strict native no-clobber transaction primitive', () => {
  test('uses only the versioned glibc soname and architecture-matched absolute musl loader', () => {
    expect(linuxLibcCandidates('x64')).toEqual(['libc.so.6', '/lib/ld-musl-x86_64.so.1']);
    expect(linuxLibcCandidates('arm64')).toEqual(['libc.so.6', '/lib/ld-musl-aarch64.so.1']);
    expect(linuxLibcCandidates('riscv64')).toEqual(['libc.so.6']);
  });

  test('uses the architecture-specific renameat2 syscall when musl has no wrapper symbol', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');
    const wrapperAttempts: string[] = [];
    const syscallAttempts: Array<{ soname: string; syscallNumber: number }> = [];
    const dependencies = injectedNative(root, {
      architecture: 'x64',
      linuxCandidates: ['musl-libc'],
      linuxOpener: (soname) => {
        wrapperAttempts.push(soname);
        return null;
      },
      linuxSyscallOpener: (soname, syscallNumber) => {
        syscallAttempts.push({ soname, syscallNumber });
        return (_sourceParentFd, sourceBuffer, _targetParentFd, targetBuffer) => {
          renameSync(join(root, decode(sourceBuffer)), join(root, decode(targetBuffer)));
          return 0;
        };
      },
    });

    renamePathNoClobber(source, target, expected, dependencies);

    expect(wrapperAttempts).toEqual(['musl-libc']);
    expect(syscallAttempts).toEqual([{ soname: 'musl-libc', syscallNumber: 316 }]);
    expect(readFileSync(target, 'utf8')).toBe('payload');
  });

  test('maps Linux arm64 to its renameat2 syscall without invoking a wrong architecture number', () => {
    const attempts: Array<{ soname: string; syscallNumber: number }> = [];
    const capability = nativeNoReplaceCapability({
      platform: 'linux',
      architecture: 'arm64',
      linuxCandidates: ['musl-libc'],
      linuxOpener: () => null,
      linuxSyscallOpener: (soname, syscallNumber) => {
        attempts.push({ soname, syscallNumber });
        return () => 0;
      },
    });

    expect(capability.available).toBe(true);
    expect(attempts).toEqual([{ soname: 'musl-libc', syscallNumber: 276 }]);
  });

  test('an unsupported Linux architecture never invents or invokes a renameat2 syscall number', () => {
    let syscallAttempted = false;
    const capability = nativeNoReplaceCapability({
      platform: 'linux',
      architecture: 'riscv64',
      linuxCandidates: ['libc.so.6'],
      linuxOpener: () => null,
      linuxSyscallOpener: () => {
        syscallAttempted = true;
        return () => 0;
      },
    });

    expect(capability.available).toBe(false);
    expect(syscallAttempted).toBe(false);
  });

  test('strictly parses exact physical identities and rejects extra or malformed authority', () => {
    const root = fixture();
    const path = join(root, 'payload');
    writeFileSync(path, 'payload');
    const identity = inspectPhysicalPath(path);
    if (identity === null) throw new Error('identity missing');

    expect(parsePhysicalPathIdentity(JSON.parse(JSON.stringify(identity)))).toEqual(identity);
    expect(() => parsePhysicalPathIdentity({ ...identity, outsidePath: '/tmp/victim' })).toThrow(
      'missing or unknown fields',
    );
    expect(() => parsePhysicalPathIdentity({ ...identity, inode: '01' })).toThrow('not a canonical integer');
    expect(() => parsePhysicalPathIdentity({ ...identity, digest: 'not-a-digest' })).toThrow('digest is malformed');
    expect(() => parsePhysicalPathIdentity({ ...identity, kind: ['file'] })).toThrow('schema or kind is unsupported');
  });

  test('rejects filesystem roots before native setup', () => {
    const root = fixture();
    const target = join(root, 'target');
    const expected = inspectPhysicalPath(root);
    if (expected === null) throw new Error('root identity missing');

    expect(() => renamePathNoClobber('/', target, expected)).toThrow('filesystem roots cannot be transaction members');
  });

  test('moves one exact physical file onto an absent name', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    renamePathNoClobber(source, target, expected, injectedNative(root));

    expect(existsSync(source)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('payload');
    expect(inspectPhysicalPath(target)).toEqual(expected);
  });

  test('an occupied target is preserved and the exact source remains retryable', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    writeFileSync(target, 'foreign');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    expect(() => renamePathNoClobber(source, target, expected, injectedNative(root))).toThrow(NoClobberRenameError);
    expect(readFileSync(source, 'utf8')).toBe('payload');
    expect(readFileSync(target, 'utf8')).toBe('foreign');
  });

  test('a target created at the final native boundary is never overwritten', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    expect(() =>
      renamePathNoClobber(
        source,
        target,
        expected,
        injectedNative(root, { beforeInvoke: () => writeFileSync(target, 'boundary-racer') }),
      ),
    ).toThrow(NoClobberRenameError);
    expect(readFileSync(source, 'utf8')).toBe('payload');
    expect(readFileSync(target, 'utf8')).toBe('boundary-racer');
  });

  test('a same-byte source inode replacement is moved but never mistaken for or deletes the expected object', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    const held = join(root, 'held-expected');
    writeFileSync(source, 'same bytes');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    expect(() =>
      renamePathNoClobber(
        source,
        target,
        expected,
        injectedNative(root, {
          beforeInvoke: () => {
            renameSync(source, held);
            writeFileSync(source, 'same bytes');
          },
        }),
      ),
    ).toThrow(NoClobberRenameError);
    expect(readFileSync(held, 'utf8')).toBe('same bytes');
    expect(readFileSync(target, 'utf8')).toBe('same bytes');
    expect(lstatSync(held).ino).not.toBe(lstatSync(target).ino);
  });

  test('an exception after the native commit reconciles the exact moved inode and never retries', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');
    let calls = 0;
    const dependencies = injectedNative(root, {
      linuxOpener: () => (_sourceParentFd, sourceBuffer, _targetParentFd, targetBuffer) => {
        calls += 1;
        renameSync(join(root, decode(sourceBuffer)), join(root, decode(targetBuffer)));
        throw new Error('ffi wrapper failed after commit');
      },
    });

    renamePathNoClobber(source, target, expected, dependencies);

    expect(calls).toBe(1);
    expect(existsSync(source)).toBe(false);
    expect(inspectPhysicalPath(target)).toEqual(expected);
  });

  test('a native exception before mutation preserves the source and leaves the target absent', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');
    const dependencies = injectedNative(root, {
      linuxOpener: () => () => {
        throw new Error('ffi failed before rename');
      },
    });

    expect(() => renamePathNoClobber(source, target, expected, dependencies)).toThrow('ffi failed before rename');
    expect(readFileSync(source, 'utf8')).toBe('payload');
    expect(existsSync(target)).toBe(false);
  });

  test('a source name reused after commit is preserved and reported without revoking the commit', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    const result = renamePathNoClobber(
      source,
      target,
      expected,
      injectedNative(root, { afterInvoke: () => writeFileSync(source, 'foreign source reuse') }),
    );

    expect(result.committed).toBe(true);
    expect(result.sourcePathOccupied).toBe(true);
    expect(readFileSync(source, 'utf8')).toBe('foreign source reuse');
    expect(readFileSync(target, 'utf8')).toBe('payload');
  });

  test('a non-regular source-name reuse is reported without inspecting or following it', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    const victim = join(root, 'victim');
    writeFileSync(source, 'payload');
    writeFileSync(victim, 'victim bytes');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    const result = renamePathNoClobber(
      source,
      target,
      expected,
      injectedNative(root, { afterInvoke: () => symlinkSync(victim, source) }),
    );

    expect(result.committed).toBe(true);
    expect(result.sourcePathOccupied).toBe(true);
    expect(readlinkSync(source)).toBe(victim);
    expect(readFileSync(victim, 'utf8')).toBe('victim bytes');
    expect(readFileSync(target, 'utf8')).toBe('payload');
  });

  test('an afterInvoke exception is returned as post-commit evidence, never thrown as an uncommitted outcome', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');
    const postCommit = new Error('post-native crash seam');

    const result = renamePathNoClobber(
      source,
      target,
      expected,
      injectedNative(root, {
        afterInvoke: () => {
          throw postCommit;
        },
      }),
    );

    expect(result.committed).toBe(true);
    expect(result.postInvokeError).toEqual({ name: 'Error', message: 'post-native crash seam' });
    expect(readFileSync(target, 'utf8')).toBe('payload');
  });

  test('an unprintable afterInvoke value is serialized without escaping after commit', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    const result = renamePathNoClobber(
      source,
      target,
      expected,
      injectedNative(root, {
        afterInvoke: () => {
          throw {
            toString: () => {
              throw new Error('cannot stringify');
            },
          };
        },
      }),
    );

    expect(result.committed).toBe(true);
    expect(result.postInvokeError).toEqual({
      name: 'Error',
      message: 'post-invoke callback threw an unprintable value',
    });
    expect(readFileSync(target, 'utf8')).toBe('payload');
  });

  test('a held-parent fsync failure is returned as committed but not durable', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    const result = renamePathNoClobber(
      source,
      target,
      expected,
      injectedNative(root, {
        fsyncDirectoryFd: () => {
          throw new Error('directory durability unavailable');
        },
      }),
    );

    expect(result.committed).toBe(true);
    expect(result.durable).toBe(false);
    expect(result.durabilityErrors).toEqual([
      { parent: 'source', name: 'Error', message: 'directory durability unavailable' },
    ]);
    expect(readFileSync(target, 'utf8')).toBe('payload');
  });

  test('a non-zero return after the native commit also reconciles without a retry', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');
    let calls = 0;
    const dependencies = injectedNative(root, {
      linuxOpener: () => (_sourceParentFd, sourceBuffer, _targetParentFd, targetBuffer) => {
        calls += 1;
        renameSync(join(root, decode(sourceBuffer)), join(root, decode(targetBuffer)));
        return -1;
      },
    });

    renamePathNoClobber(source, target, expected, dependencies);

    expect(calls).toBe(1);
    expect(inspectPhysicalPath(target)).toEqual(expected);
  });

  test('moves a complete physical directory and binds every descendant inode and byte', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'nested', 'payload'), 'directory payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    renamePathNoClobber(source, target, expected, injectedNative(root));

    expect(readFileSync(join(target, 'nested', 'payload'), 'utf8')).toBe('directory payload');
    expect(inspectPhysicalPath(target)).toEqual(expected);
  });

  test('a directory changed after native publication is preserved but never accepted as the committed identity', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    mkdirSync(source);
    writeFileSync(join(source, 'payload'), 'original');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    expect(() =>
      renamePathNoClobber(
        source,
        target,
        expected,
        injectedNative(root, { afterInvoke: () => writeFileSync(join(target, 'foreign-child'), 'preserve me') }),
      ),
    ).toThrow(NoClobberRenameError);
    expect(readFileSync(join(target, 'payload'), 'utf8')).toBe('original');
    expect(readFileSync(join(target, 'foreign-child'), 'utf8')).toBe('preserve me');
  });

  test('moves a symlink as an object without following its target', () => {
    const root = fixture();
    const victim = join(root, 'victim');
    const source = join(root, 'source-link');
    const target = join(root, 'target-link');
    writeFileSync(victim, 'victim bytes');
    symlinkSync(victim, source);
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');

    renamePathNoClobber(source, target, expected, injectedNative(root));

    expect(readlinkSync(target)).toBe(victim);
    expect(readFileSync(victim, 'utf8')).toBe('victim bytes');
  });

  test('held parent dirfds bind publication when the visible target parent is replaced', () => {
    const root = fixture();
    const sourceParent = join(root, 'source-parent');
    const targetParent = join(root, 'target-parent');
    const movedTargetParent = join(root, 'target-parent-held');
    mkdirSync(sourceParent);
    mkdirSync(targetParent);
    const source = join(sourceParent, 'source');
    const target = join(targetParent, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');
    expect(nativeNoReplaceCapability().available).toBe(true);

    const result = renamePathNoClobber(source, target, expected, {
      beforeInvoke: () => {
        renameSync(targetParent, movedTargetParent);
        mkdirSync(targetParent);
        writeFileSync(join(targetParent, 'foreign'), 'replacement parent bytes');
      },
    });

    expect(result.committed).toBe(true);
    expect(result.parentPathsStable).toBe(false);
    expect(result.committedTargetPath).toBe(join(realpathSync(movedTargetParent), 'target'));
    expect(readFileSync(result.committedTargetPath, 'utf8')).toBe('payload');
    expect(readFileSync(join(targetParent, 'foreign'), 'utf8')).toBe('replacement parent bytes');
    expect(existsSync(target)).toBe(false);
  });

  test('fails closed when native setup is unavailable', () => {
    const root = fixture();
    const source = join(root, 'source');
    const target = join(root, 'target');
    writeFileSync(source, 'payload');
    const expected = inspectPhysicalPath(source);
    if (expected === null) throw new Error('source missing');
    const unavailable = injectedNative(root, { linuxOpener: () => null });

    expect(nativeNoReplaceCapability(unavailable)).toEqual({ schemaVersion: 1, platform: 'linux', available: false });
    expect(() => renamePathNoClobber(source, target, expected, unavailable)).toThrow(NativeNoReplaceUnavailableError);
    expect(readFileSync(source, 'utf8')).toBe('payload');
    expect(existsSync(target)).toBe(false);
  });
});
