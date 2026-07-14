import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fixtures for install.sh's transactional binary promotion/rollback (wish
// stable-release-security-gate, F31a) PLUS a regression check that the durable
// `.steal` lifecycle-lock recovery protocol is left byte-for-byte unchanged
// (F42/F45–F47/F50 hardening constraint). Real tar/bash on a tmp dir — the swap
// needs same-filesystem rename primitives, so nothing is mocked.

const INSTALL_SH = join(import.meta.dir, '..', 'install.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mkroot(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-install-swap-'));
  roots.push(root);
  return root;
}

/** A fake `genie` that ignores args and prints a version — stands in for the
 *  real bun-compiled binary so the swap mechanics can be exercised hermetically. */
function fakeBinary(version: string): string {
  return `#!/bin/sh\necho "${version}"\n`;
}

/** Build a release-shaped tarball: `genie` at the root plus VERSION + a sidecar
 *  tree, matching scripts/build-binary.sh's layout. */
function buildTarball(root: string, opts: { version: string; withBinary?: boolean; sidecar?: string }): string {
  const tree = mkdtempSync(join(root, 'tree-'));
  if (opts.withBinary !== false) {
    const bin = join(tree, 'genie');
    writeFileSync(bin, fakeBinary(opts.version));
    chmodSync(bin, 0o755);
  }
  writeFileSync(join(tree, 'VERSION'), `${opts.version}\n`);
  mkdirSync(join(tree, 'plugins'), { recursive: true });
  writeFileSync(join(tree, 'plugins', opts.sidecar ?? 'marker.txt'), 'sidecar');
  const tarball = join(root, `genie-${opts.version}.tar.gz`);
  const packed = Bun.spawnSync(['tar', '-czf', tarball, '-C', tree, '.'], { stdout: 'pipe', stderr: 'pipe' });
  if (packed.exitCode !== 0) throw new Error(`tar failed: ${packed.stderr.toString()}`);
  return tarball;
}

interface Layout {
  home: string;
  bin: string;
  liveBinary: string;
  homeRoot: string;
}

function scaffold(root: string, opts: { liveVersion?: string } = {}): Layout {
  const homeRoot = join(root, 'home');
  const genieHome = join(homeRoot, '.genie');
  const bin = join(genieHome, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(homeRoot, '.local', 'bin'), { recursive: true });
  const liveBinary = join(bin, 'genie');
  if (opts.liveVersion) {
    writeFileSync(liveBinary, fakeBinary(opts.liveVersion));
    chmodSync(liveBinary, 0o755);
    writeFileSync(join(bin, 'VERSION'), `${opts.liveVersion}\n`);
    mkdirSync(join(bin, 'plugins'), { recursive: true });
    writeFileSync(join(bin, 'plugins', 'old.txt'), 'old-sidecar');
  }
  return { home: genieHome, bin, liveBinary, homeRoot };
}

/** Source install.sh (main suppressed) and run extract_and_link. `die`
 *  propagates as the process exit code, so exit codes are directly assertable. */
function runExtract(layout: Layout, tarball: string, version: string, extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync(
    ['bash', '-c', 'source "$1"; extract_and_link "$2" "$3"', 'bash', INSTALL_SH, tarball, version],
    {
      env: {
        PATH: process.env.PATH ?? '',
        GENIE_INSTALL_SOURCE_ONLY: '1',
        GENIE_HOME: layout.home,
        HOME: layout.homeRoot,
        ...extraEnv,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

// ---------------------------------------------------------------------------
// Steal-guard regression: the `.steal` lifecycle-lock protocol must not drift.
// ---------------------------------------------------------------------------

describe('install.sh .steal lifecycle-lock protocol (F42/F45–F47/F50 — must not drift)', () => {
  // The ordered set of functions that make up the durable `.steal` recovery
  // protocol + its shell/TS parity. Their concatenated source is pinned so any
  // edit to this contract fails loudly. To intentionally rotate the pin, change
  // these functions in lockstep with src/lib/agent-sync.ts's stealStaleLock and
  // update the digest below in the SAME review.
  const PROTECTED_FUNCTIONS = [
    'logical_absolute_path',
    'lock_mtime_seconds',
    'lock_record_is_stale',
    'foreign_lock_record_is_stale',
    'recover_stale_lifecycle_lock',
    'acquire_lifecycle_lock',
    'release_lifecycle_lock',
  ];
  const PINNED_DIGEST = 'c6d5c4bd29f8c42a51300633f371fbe99fb293813c274d17286762d5f277194e';

  function extractFunction(source: string, name: string): string {
    const lines = source.split('\n');
    const start = lines.indexOf(`${name}() {`);
    if (start === -1) throw new Error(`protected function not found: ${name}`);
    for (let i = start; i < lines.length; i += 1) {
      if (lines[i] === '}') return `${lines.slice(start, i + 1).join('\n')}\n`;
    }
    throw new Error(`unterminated protected function: ${name}`);
  }

  test('protected function bodies match the pinned digest', () => {
    const source = readFileSync(INSTALL_SH, 'utf-8');
    const concatenated = PROTECTED_FUNCTIONS.map((fn) => extractFunction(source, fn)).join('');
    const digest = createHash('sha256').update(concatenated).digest('hex');
    expect(digest).toBe(PINNED_DIGEST);
  });
});

// ---------------------------------------------------------------------------
// Transactional promotion / rollback.
// ---------------------------------------------------------------------------

describe('install.sh transactional binary promotion (F31a)', () => {
  test('happy path: stages, backs up the old binary, promotes the new one, wires PATH', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const tarball = buildTarball(root, { version: '5.260714.1', sidecar: 'new.txt' });

    const run = runExtract(layout, tarball, '5.260714.1');
    expect(run.exitCode).toBe(0);
    expect(readFileSync(layout.liveBinary, 'utf-8')).toBe(fakeBinary('5.260714.1'));
    // Old binary preserved for rollback.
    expect(readdirSync(join(layout.bin, '.previous'))).toContain('genie-5.260713.1');
    expect(readFileSync(join(layout.bin, '.previous', 'genie-5.260713.1'), 'utf-8')).toBe(fakeBinary('5.260713.1'));
    // Sidecars swapped: new present, old gone.
    expect(readdirSync(join(layout.bin, 'plugins'))).toEqual(['new.txt']);
    // Symlink wired to the canonical binary.
    expect(readFileSync(join(layout.homeRoot, '.local', 'bin', 'genie'), 'utf-8')).toBe(fakeBinary('5.260714.1'));
    // Staging cleaned up.
    expect(readdirSync(layout.bin).filter((e) => e.startsWith('.install-staging'))).toEqual([]);
  });

  test('first install (no live binary) promotes without a backup', () => {
    const root = mkroot();
    const layout = scaffold(root);
    const tarball = buildTarball(root, { version: '5.260714.1' });
    const run = runExtract(layout, tarball, '5.260714.1');
    expect(run.exitCode).toBe(0);
    expect(readFileSync(layout.liveBinary, 'utf-8')).toBe(fakeBinary('5.260714.1'));
    expect(readdirSync(join(layout.bin, '.previous')).filter((e) => e.startsWith('genie-'))).toEqual([]);
  });

  test('corrupt artifact (tarball has no genie binary) fails closed; live binary intact', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const tarball = buildTarball(root, { version: '5.260714.1', withBinary: false });
    const run = runExtract(layout, tarball, '5.260714.1');
    expect(run.exitCode).toBe(4);
    expect(run.stderr.toString()).toContain('corrupt artifact');
    expect(readFileSync(layout.liveBinary, 'utf-8')).toBe(fakeBinary('5.260713.1'));
  });

  test('corrupt tarball (not a gzip archive) fails closed; live binary intact', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const tarball = join(root, 'garbage.tar.gz');
    writeFileSync(tarball, 'this is not a gzip archive');
    const run = runExtract(layout, tarball, '5.260714.1');
    expect(run.exitCode).toBe(5);
    expect(readFileSync(layout.liveBinary, 'utf-8')).toBe(fakeBinary('5.260713.1'));
  });

  test('version mismatch (wrong tarball) fails closed; live binary intact', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const tarball = buildTarball(root, { version: '9.999999.9' });
    const run = runExtract(layout, tarball, '5.260714.1');
    expect(run.exitCode).toBe(4);
    expect(run.stderr.toString()).toContain('version mismatch');
    expect(readFileSync(layout.liveBinary, 'utf-8')).toBe(fakeBinary('5.260713.1'));
  });

  test('kill mid-swap (fault injected before the atomic rename) leaves the old binary runnable', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const tarball = buildTarball(root, { version: '5.260714.1' });
    const run = runExtract(layout, tarball, '5.260714.1', { GENIE_INSTALL_SWAP_FAULT: 'before-promote' });
    expect(run.exitCode).toBe(1);
    // The old binary is still the live one, byte-for-byte, and still runs.
    expect(readFileSync(layout.liveBinary, 'utf-8')).toBe(fakeBinary('5.260713.1'));
    const probe = Bun.spawnSync([layout.liveBinary, '--version'], { stdout: 'pipe' });
    expect(probe.stdout.toString().trim()).toBe('5.260713.1');
    // A rollback candidate was captured before the injected failure.
    expect(readdirSync(join(layout.bin, '.previous'))).toContain('genie-5.260713.1');
  });
});

// ---------------------------------------------------------------------------
// Mismatched provenance: an unverified download never reaches extraction.
// ---------------------------------------------------------------------------

describe('install.sh download_and_verify refuses on failed provenance (F31a)', () => {
  test('gh attestation unavailable + cosign verify failure fails closed with exit 4', () => {
    const root = mkroot();
    const stub = join(root, 'stub');
    mkdirSync(stub, { recursive: true });
    // curl: honor `-o <path>` by writing placeholder bytes so download succeeds.
    writeFileSync(
      join(stub, 'curl'),
      '#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done\n[ -n "$out" ] && printf fake > "$out"\nexit 0\n',
    );
    // gh: attestation subsystem unavailable → `gh attestation verify --help` fails.
    writeFileSync(join(stub, 'gh'), '#!/bin/sh\nexit 1\n');
    // cosign: verify-blob rejects (bad signature).
    writeFileSync(join(stub, 'cosign'), '#!/bin/sh\nexit 1\n');
    for (const name of ['curl', 'gh', 'cosign']) chmodSync(join(stub, name), 0o755);

    const run = Bun.spawnSync(
      [
        'bash',
        '-c',
        'source "$1"; download_and_verify "$2" "$3" "$4"',
        'bash',
        INSTALL_SH,
        '5.260714.1',
        'linux-x64-glibc',
        'https://example.invalid/base',
      ],
      {
        env: {
          PATH: `${stub}:${process.env.PATH ?? ''}`,
          GENIE_INSTALL_SOURCE_ONLY: '1',
          GENIE_HOME: join(root, 'home', '.genie'),
          HOME: join(root, 'home'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(run.exitCode).toBe(4);
    expect(run.stderr.toString()).toContain('verification failed');
  });
});
