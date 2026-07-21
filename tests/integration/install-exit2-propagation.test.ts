/**
 * Executed installer integration test — delivered-not-activated exit-2 propagation.
 *
 * This test actually RUNS `install.sh` end-to-end inside an isolated fixture: a
 * local file:// release (manifest + tarball), an isolated HOME/GENIE_HOME/
 * CODEX_HOME/TMPDIR, and a fake `genie` whose post-install `install` path yields
 * the delivered/action-required state (exit 2 + the stable result trailer). It
 * asserts the installer:
 *   - exits 2 (delivered-not-activated, not a failure);
 *   - prints the stable result trailer with deliveryComplete:true;
 *   - prints NO all-green footer ("genie v<version> installed");
 *   - leaves the lifecycle lease absent after completion;
 *   - reruns idempotently with an identical exit code and state.
 *
 * `bash -n` is only a fast pre-check; this is the proof.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'install.sh');
const VERSION = '0.0.0-exit2-test';

function hostPlatform(): string | null {
  const os = spawnSync('uname', ['-s'], { encoding: 'utf8' }).stdout.trim();
  const arch = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
  if (os === 'Darwin' && arch === 'arm64') return 'darwin-arm64';
  if (os === 'Linux' && (arch === 'x86_64' || arch === 'amd64')) {
    const ldd = spawnSync('ldd', ['--version'], { encoding: 'utf8' });
    return /musl/i.test(`${ldd.stdout}${ldd.stderr}`) ? 'linux-x64-musl' : 'linux-x64-glibc';
  }
  if (os === 'Linux' && (arch === 'aarch64' || arch === 'arm64')) return 'linux-arm64';
  return null;
}

let work: string;
let home: string;
let releases: string;
let installSh: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'genie-install-exit2-'));
  home = join(work, 'home');
  releases = join(work, 'releases');
  const payload = join(work, 'payload');
  const codexHome = join(work, 'codex');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(releases, { recursive: true });
  mkdirSync(payload, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  // Fake genie: its post-install `install` yields delivered/action-required.
  const fakeGenie = [
    '#!/usr/bin/env bash',
    'case "${1:-}" in',
    `  --version|-v) echo "${VERSION} (fake)"; exit 0 ;;`,
    '  install)',
    `    printf "  ! Codex plugin: activation-pending (installed=5.260710.2, target=${VERSION})\\n"`,
    // The stable A-owned result trailer with deliveryComplete:true.
    '    printf \'%s\\n\' \'{"schemaVersion":1,"code":"activation-pending","deliveryComplete":true,"retry":false,"nextAction":"retire tasks -> genie setup --codex -> /hooks -> new task"}\'',
    '    exit 2 ;;',
    '  *) echo "fake-genie:${1:-}"; exit 0 ;;',
    'esac',
    '',
  ].join('\n');
  writeFileSync(join(payload, 'genie'), fakeGenie, { mode: 0o755 });
  const tar = spawnSync('tar', ['-czf', join(releases, `genie-${VERSION}-PLATFORM.tar.gz`), '-C', payload, 'genie']);
  if (tar.status !== 0) throw new Error(`fixture tar failed: ${tar.stderr?.toString()}`);

  // The manifest schema mirrors release-publish.yml's emitter.
  const manifest = {
    schema_version: 1,
    channel: 'stable',
    version: VERSION,
    released_at: new Date().toISOString(),
    tarball_base: `file://${releases}`,
    platforms: ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'],
  };
  writeFileSync(join(work, 'latest.json'), JSON.stringify(manifest, null, 2));

  // Mutated copy of install.sh with MANIFEST_BASE pointed at the local file:// root.
  const source = readFileSync(INSTALL_SH, 'utf8');
  const mutated = source.replace(/^MANIFEST_BASE=.*$/m, `MANIFEST_BASE="file://${work}"`);
  if (!mutated.includes(`MANIFEST_BASE="file://${work}"`)) throw new Error('MANIFEST_BASE rewrite did not stick');
  installSh = join(work, 'install.sh');
  writeFileSync(installSh, mutated, { mode: 0o755 });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function runInstaller(): { status: number | null; output: string } {
  const platform = hostPlatform();
  if (platform === null) return { status: null, output: '' };
  // The fake curl handles any *.tar.gz via file://; the tarball filename embeds
  // the detected platform, so rename our fixture tarball to match.
  const wanted = join(releases, `genie-${VERSION}-${platform}.tar.gz`);
  if (!existsSync(wanted)) {
    const generic = join(releases, `genie-${VERSION}-PLATFORM.tar.gz`);
    spawnSync('cp', [generic, wanted]);
  }
  const result = spawnSync('bash', [installSh], {
    encoding: 'utf8',
    env: {
      HOME: home,
      GENIE_HOME: join(home, '.genie'),
      CODEX_HOME: join(work, 'codex'),
      TMPDIR: join(work, 'tmp'),
      INSECURE: '1',
      GENIE_CHANNEL: 'stable',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function leaseFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => entry.startsWith('.genie-lifecycle-') && entry.endsWith('.lock'));
}

describe('install.sh delivered-not-activated exit-2 propagation', () => {
  test('propagates exit 2 with the result trailer, no all-green footer, lease released, idempotent rerun', () => {
    const platform = hostPlatform();
    if (platform === null) {
      // No supported host triple (e.g. darwin-x64) — install.sh would refuse here too.
      return;
    }
    mkdirSync(join(work, 'tmp'), { recursive: true });

    const first = runInstaller();
    expect(first.status).toBe(2);
    // The stable A-owned result trailer with deliveryComplete:true.
    expect(first.output).toContain('"deliveryComplete":true');
    expect(first.output).toContain('"code":"activation-pending"');
    // Delivered-not-activated message, and NO all-green footer.
    expect(first.output).toContain('activation is required');
    expect(first.output).not.toContain(`genie v${VERSION} installed`);
    // The binary + symlink were still installed and verified.
    expect(existsSync(join(home, '.genie', 'bin', 'genie'))).toBe(true);
    // The lifecycle lease is absent after completion (released on every exit).
    expect(leaseFilesUnder(home)).toEqual([]);

    // Immediate rerun: identical exit and state (idempotent).
    const second = runInstaller();
    expect(second.status).toBe(2);
    expect(second.output).toContain('"deliveryComplete":true');
    expect(second.output).not.toContain(`genie v${VERSION} installed`);
    expect(leaseFilesUnder(home)).toEqual([]);
  });
});
