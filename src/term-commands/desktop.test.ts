/**
 * genie desktop — opens the Automagik desktop app with Genie preloaded, mirroring Omni's
 * `omni desktop`. Unit tests for the release pick, the checksum list, the cache and the launch
 * (with `--preload=genie`); CLI tests run the real entry as a subprocess with `--path` and
 * `--dry-run`, so nothing is downloaded or opened.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DesktopRelease,
  PRELOAD,
  appCacheDir,
  desktopHome,
  desktopTarget,
  extractionDir,
  launchPlan,
  parseSums,
  pickRelease,
  writePreload,
} from './desktop.js';

const GENIE = join(import.meta.dir, '..', 'genie.ts');
const asset = (name: string) => ({ name, browser_download_url: `https://example.test/${name}`, size: 1 });
const release = (tag: string, names: string[], extra: Partial<DesktopRelease> = {}): DesktopRelease => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: names.map(asset),
  ...extra,
});
const linux = desktopTarget('linux', 'x64');
if (!linux.supported) throw new Error('linux x64 is supported');
const mac = desktopTarget('darwin', 'arm64');
if (!mac.supported) throw new Error('macOS arm64 is supported');

describe('genie desktop: the build for this machine', () => {
  test('Linux x64 and macOS get a build; other machines are told why not', () => {
    expect(linux.asset.test('Omni-3.261024.1-linux-x86_64.AppImage')).toBe(true);
    expect(desktopTarget('linux', 'x64', 'Linux version 5.15 (Microsoft)')).toMatchObject({ label: 'Linux (WSL)' });
    expect(mac.asset.test('Omni-3.261024.1-mac-arm64.dmg')).toBe(true);
    expect(mac.requires).toBe('latest-mac.yml');
    expect(desktopTarget('linux', 'arm64')).toMatchObject({ supported: false });
    expect(desktopTarget('win32', 'x64')).toMatchObject({ supported: false, reason: expect.stringContaining('WSL') });
  });

  test('the newest release with a build for this machine is picked; drafts and plugin-only releases are skipped', () => {
    const releases = [
      release('v3.261025.1', ['automagik-bots-dsh-3.261025.1.tgz', 'plugins.json']),
      release('v3.261024.2', ['Omni-3.261024.2-linux-x86_64.AppImage', 'SHA256SUMS'], { draft: true }),
      release('v3.261024.1', ['Omni-3.261024.1-linux-x86_64.AppImage', 'SHA256SUMS']),
      release('v3.261023.1', ['Omni-3.261023.1-linux-x86_64.AppImage', 'SHA256SUMS']),
    ];
    expect(pickRelease(releases, linux)?.tag_name).toBe('v3.261024.1');
    expect(pickRelease(releases, linux, 'v3.261023.1')?.tag_name).toBe('v3.261023.1');
    expect(pickRelease(releases, linux, 'v9.0.0')).toBeUndefined();
    expect(pickRelease([], linux)).toBeUndefined();
    // A build without its SHA256SUMS is never picked.
    expect(pickRelease([release('v3.261026.1', ['Omni-3.261026.1-linux-x86_64.AppImage'])], linux)).toBeUndefined();
  });

  test('on macOS only a signed release (it carries latest-mac.yml) is picked', () => {
    const releases = [
      release('v3.261025.1', ['Omni-3.261025.1-mac-arm64.dmg', 'SHA256SUMS']),
      release('v2.261023.32', ['Omni-2.261023.32-mac-arm64.dmg', 'latest-mac.yml', 'SHA256SUMS']),
    ];
    expect(pickRelease(releases, mac)?.tag_name).toBe('v2.261023.32');
    expect(pickRelease(releases.slice(0, 1), mac)).toBeUndefined();
  });

  test('SHA256SUMS is read as sha256sum writes it', () => {
    const hex = 'a'.repeat(64);
    const sums = parseSums(
      `${hex}  Omni-3.261024.1-linux-x86_64.AppImage\n${'B'.repeat(64)} *Omni-Linux.deb\nnot a line\n`,
    );
    expect(sums.get('Omni-3.261024.1-linux-x86_64.AppImage')).toBe(hex);
    expect(sums.get('Omni-Linux.deb')).toBe('b'.repeat(64));
    expect(sums.size).toBe(2);
  });

  test("builds share omni desktop's cache", () => {
    expect(appCacheDir({ OMNI_HOME: '/srv/omni' })).toBe('/srv/omni/desktop/app');
    expect(extractionDir('/x/Omni-3.261024.1-linux-x86_64.AppImage', { OMNI_HOME: '/srv/omni' })).toBe(
      '/srv/omni/desktop/app/extracted/Omni-3.261024.1-linux-x86_64',
    );
  });

  test('the app opens with Genie preloaded', () => {
    expect(PRELOAD).toBe('genie');
    expect(launchPlan('/c/Omni.AppImage', linux, '/c/x')).toEqual({
      command: '/c/x/squashfs-root/AppRun',
      args: ['--preload=genie'],
    });
    // A dmg takes no arguments: the app dragged to Applications reads the preload from its home.
    expect(launchPlan('/c/Omni.dmg', mac, '/c/x')).toEqual({ command: 'open', args: ['/c/Omni.dmg'] });
  });

  test("the preload goes in the app's home, where the app reads it at every start", () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-desktop-home-'));
    try {
      expect(desktopHome({ OMNI_HOME: '/srv/omni' })).toBe('/srv/omni/desktop');
      expect(desktopHome({ OMNI_HOME: '/srv/omni', OMNI_DESKTOP_HOME: '/opt/app' })).toBe('/opt/app');
      const file = writePreload({ OMNI_DESKTOP_HOME: join(root, 'desktop') });
      expect(file).toBe(join(root, 'desktop', 'preload'));
      expect(readFileSync(file, 'utf8')).toBe('genie\n');
      // Idempotent: written again, the same.
      writePreload({ OMNI_DESKTOP_HOME: join(root, 'desktop') });
      expect(readFileSync(file, 'utf8')).toBe('genie\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('genie desktop (CLI)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'genie-desktop-'));
    writeFileSync(join(dir, 'Omni-3.261024.1-linux-x86_64.AppImage'), 'not really an AppImage');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function cli(...args: string[]) {
    const proc = Bun.spawn(['bun', GENIE, 'desktop', ...args], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', OMNI_HOME: join(dir, 'omni-home'), GENIE_TEST_SKIP_PGSERVE: '1' },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  test('a dry run says what it would open, with the preload, and does it the same way twice', async () => {
    const file = join(dir, 'Omni-3.261024.1-linux-x86_64.AppImage');
    const first = await cli('--path', file, '--dry-run');
    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toContain(`Would open ${file} (Linux`);
    expect(first.stdout).toContain('squashfs-root/AppRun --preload=genie');
    expect(first.stdout).toContain(`Would write genie to ${join(dir, 'omni-home', 'desktop', 'preload')}`);
    // A dry run writes nothing.
    expect(existsSync(join(dir, 'omni-home', 'desktop', 'preload'))).toBe(false);
    const again = await cli('--path', file, '--dry-run');
    expect(again).toEqual(first);
  });

  test('a missing file is an error on stderr with exit 1', async () => {
    const r = await cli('--path', join(dir, 'nothing.AppImage'), '--dry-run');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Error: No file at');
  });
});
