import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanonicalInstallLinkError,
  classifyOwnedDirectorySafety,
  preflightCanonicalInstallLink,
  prepareCanonicalInstallLink,
  verifyCanonicalInstallLink,
} from './install-link.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'genie-install-link-'));
  roots.push(root);
  const home = join(root, 'home');
  const target = join(home, '.genie', 'bin', 'genie');
  const link = join(home, '.local', 'bin', 'genie');
  mkdirSync(join(home, '.genie', 'bin'), { recursive: true, mode: 0o700 });
  writeFileSync(target, 'binary');
  return { root, home, target, link };
}

describe('canonical installer link', () => {
  test('publishes once with no-clobber and admits the exact same link idempotently', () => {
    const f = fixture();
    const first = prepareCanonicalInstallLink({
      trustedHome: f.home,
      linkPath: f.link,
      targetPath: f.target,
      randomId: () => 'first',
    });

    expect(first.created).toBe(true);
    expect(lstatSync(f.link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(f.link)).toBe(f.target);
    const second = prepareCanonicalInstallLink({
      trustedHome: f.home,
      linkPath: f.link,
      targetPath: f.target,
      randomId: () => 'second',
    });
    expect(second.created).toBe(false);
    expect(second.identity).toEqual(first.identity);
  });

  test('preserves an occupied foreign file', () => {
    const f = fixture();
    mkdirSync(join(f.home, '.local', 'bin'), { recursive: true, mode: 0o755 });
    writeFileSync(f.link, 'foreign');

    expect(() => prepareCanonicalInstallLink({ trustedHome: f.home, linkPath: f.link, targetPath: f.target })).toThrow(
      CanonicalInstallLinkError,
    );
    expect(readFileSync(f.link, 'utf8')).toBe('foreign');
  });

  test('preserves a foreign symlink target', () => {
    const f = fixture();
    const victim = join(f.root, 'victim');
    mkdirSync(join(f.home, '.local', 'bin'), { recursive: true, mode: 0o755 });
    writeFileSync(victim, 'victim');
    symlinkSync(victim, f.link);

    expect(() => prepareCanonicalInstallLink({ trustedHome: f.home, linkPath: f.link, targetPath: f.target })).toThrow(
      'points somewhere unexpected',
    );
    expect(readFileSync(victim, 'utf8')).toBe('victim');
    expect(readlinkSync(f.link)).toBe(victim);
  });

  test('a final-boundary collision is never overwritten', () => {
    const f = fixture();
    const dependencies = {
      beforeInvoke: () => writeFileSync(f.link, 'boundary foreign'),
    };

    expect(() =>
      prepareCanonicalInstallLink({
        trustedHome: f.home,
        linkPath: f.link,
        targetPath: f.target,
        nativeRename: dependencies,
        randomId: () => 'boundary',
      }),
    ).toThrow();
    expect(readFileSync(f.link, 'utf8')).toBe('boundary foreign');
  });

  test('verification rejects same-target inode replacement', () => {
    const f = fixture();
    const guard = prepareCanonicalInstallLink({
      trustedHome: f.home,
      linkPath: f.link,
      targetPath: f.target,
      randomId: () => 'guard',
    });
    const held = join(f.root, 'held-link');
    renameSync(f.link, held);
    symlinkSync(f.target, f.link);

    expect(() => verifyCanonicalInstallLink(guard)).toThrow('changed');
    expect(readlinkSync(held)).toBe(f.target);
    expect(readlinkSync(f.link)).toBe(f.target);
  });

  test('rejects a symlinked ~/.local parent without touching its victim', () => {
    const f = fixture();
    const victim = join(f.root, 'local-victim');
    mkdirSync(victim);
    symlinkSync(victim, join(f.home, '.local'), 'dir');

    expect(() => prepareCanonicalInstallLink({ trustedHome: f.home, linkPath: f.link, targetPath: f.target })).toThrow(
      'not a physical directory',
    );
    expect(existsSync(join(victim, 'bin'))).toBe(false);
  });

  for (const unsafeAncestor of ['.local', '.local/bin'] as const) {
    test('accepts a 0775 ~/.local/bin owned by the user and their effective group (user-private-group umask 002)', () => {
      const f = fixture();
      const localBin = join(f.home, '.local', 'bin');
      mkdirSync(localBin, { recursive: true, mode: 0o755 });
      chmodSync(join(f.home, '.local'), 0o775);
      chmodSync(localBin, 0o775);
      // gid of a fresh dir is the process egid on non-setgid parents, matching the relaxation.
      expect(() =>
        preflightCanonicalInstallLink({
          trustedHome: f.home,
          linkPath: join(localBin, 'genie'),
          targetPath: join(f.home, '.genie', 'bin', 'genie'),
        }),
      ).not.toThrow();
    });

    test('classifyOwnedDirectorySafety: pure verdicts', () => {
      const uid = 1000n;
      const gid = 1000n;
      const mk = (mode: number, o: Partial<{ uid: bigint; gid: bigint; nlink: bigint }> = {}) =>
        ({ uid: o.uid ?? uid, gid: o.gid ?? gid, nlink: o.nlink ?? 2n, mode: BigInt(0o40000 | mode) }) as never;
      expect(classifyOwnedDirectorySafety(mk(0o755), { uid, gid })).toEqual({ ok: true });
      expect(classifyOwnedDirectorySafety(mk(0o775), { uid, gid })).toEqual({ ok: true });
      const foreign = classifyOwnedDirectorySafety(mk(0o775, { gid: 999n }), { uid, gid });
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.reason).toContain('group 999');
      const world = classifyOwnedDirectorySafety(mk(0o777), { uid, gid });
      expect(world.ok).toBe(false);
      if (!world.ok) expect(world.reason).toContain('world-writable (mode 777)');
      const sudo = classifyOwnedDirectorySafety(mk(0o755, { uid: 0n }), { uid, gid });
      expect(sudo.ok).toBe(false);
      if (!sudo.ok) expect(sudo.reason).toContain('owned by uid 0');
    });

    test(`rejects a group/world-writable ${unsafeAncestor} PATH ancestor`, () => {
      const f = fixture();
      const localBin = join(f.home, '.local', 'bin');
      mkdirSync(localBin, { recursive: true, mode: 0o755 });
      chmodSync(join(f.home, unsafeAncestor), 0o777);

      expect(() =>
        prepareCanonicalInstallLink({ trustedHome: f.home, linkPath: f.link, targetPath: f.target }),
      ).toThrow('writable');
      expect(existsSync(f.link)).toBe(false);
    });
  }

  test('held parent descriptors prevent an ancestor replacement from redirecting link publication', () => {
    const f = fixture();
    const local = join(f.home, '.local');
    const localBin = join(local, 'bin');
    const heldBin = join(f.root, 'held-bin');
    const victim = join(f.root, 'victim-bin');
    mkdirSync(localBin, { recursive: true, mode: 0o755 });
    mkdirSync(victim);
    writeFileSync(join(victim, 'sentinel'), 'victim\n');

    expect(() =>
      prepareCanonicalInstallLink({
        trustedHome: f.home,
        linkPath: f.link,
        targetPath: f.target,
        afterParentValidated: () => {
          renameSync(localBin, heldBin);
          symlinkSync(victim, localBin, 'dir');
        },
      }),
    ).toThrow();
    expect(readdirSync(victim)).toEqual(['sentinel']);
    expect(readFileSync(join(victim, 'sentinel'), 'utf8')).toBe('victim\n');
    expect(existsSync(join(heldBin, 'genie'))).toBe(false);
    expect(lstatSync(localBin).isSymbolicLink()).toBe(true);
  });
});
