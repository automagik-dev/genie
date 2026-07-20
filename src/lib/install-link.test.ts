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
import { CanonicalInstallLinkError, prepareCanonicalInstallLink, verifyCanonicalInstallLink } from './install-link.js';

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
  mkdirSync(join(home, '.genie', 'bin'), { recursive: true });
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
    mkdirSync(join(f.home, '.local', 'bin'), { recursive: true });
    writeFileSync(f.link, 'foreign');

    expect(() => prepareCanonicalInstallLink({ trustedHome: f.home, linkPath: f.link, targetPath: f.target })).toThrow(
      CanonicalInstallLinkError,
    );
    expect(readFileSync(f.link, 'utf8')).toBe('foreign');
  });

  test('preserves a foreign symlink target', () => {
    const f = fixture();
    const victim = join(f.root, 'victim');
    mkdirSync(join(f.home, '.local', 'bin'), { recursive: true });
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
    test(`rejects a group/world-writable ${unsafeAncestor} PATH ancestor`, () => {
      const f = fixture();
      const localBin = join(f.home, '.local', 'bin');
      mkdirSync(localBin, { recursive: true });
      chmodSync(join(f.home, unsafeAncestor), 0o777);

      expect(() =>
        prepareCanonicalInstallLink({ trustedHome: f.home, linkPath: f.link, targetPath: f.target }),
      ).toThrow('safe permissions');
      expect(existsSync(f.link)).toBe(false);
    });
  }

  test('held parent descriptors prevent an ancestor replacement from redirecting link publication', () => {
    const f = fixture();
    const local = join(f.home, '.local');
    const localBin = join(local, 'bin');
    const heldBin = join(f.root, 'held-bin');
    const victim = join(f.root, 'victim-bin');
    mkdirSync(localBin, { recursive: true });
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
