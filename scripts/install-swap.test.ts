import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fixtures for install.sh's transactional binary promotion/rollback (wish
// stable-release-security-gate, F31a) PLUS a regression check that the durable
// `.steal` lifecycle-lock recovery protocol is left byte-for-byte unchanged
// (F42/F45–F47/F50 hardening constraint). Real tar/bash on a tmp dir — the swap
// needs same-filesystem rename primitives, so nothing is mocked.

const INSTALL_SH = join(import.meta.dir, '..', 'install.sh');
const INSTALL_PROMOTER = join(import.meta.dir, '..', 'src', 'genie-commands', 'install-promote.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mkroot(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-install-swap-'));
  roots.push(root);
  return root;
}

/** Release-shaped executable fixture. The hidden command dispatches into the
 * real promoter module while binding runtime authority to this exact script. */
function fakeBinary(version: string, driver: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi
if [ "$1" = "__install-promote" ]; then
  shift
  GENIE_TEST_STAGED_BINARY="$0" GENIE_TEST_VERSION="${version}" exec ${JSON.stringify(process.execPath)} ${JSON.stringify(driver)} "$@"
fi
echo "${version}"
`;
}

/** Build the exact eight-member release payload consumed by the promoter. */
function buildTarball(root: string, opts: { version: string; withBinary?: boolean; sidecar?: string }): string {
  const tree = mkdtempSync(join(root, 'tree-'));
  const driver = join(root, 'promoter-driver.ts');
  writeFileSync(
    driver,
    [
      `import { installPromoteCommand } from ${JSON.stringify(INSTALL_PROMOTER)};`,
      'const args = process.argv.slice(2);',
      'const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };',
      "installPromoteCommand({ stagingRoot: value('--staging-root'), expectedVersion: value('--expected-version') }, {",
      '  runtimeExecutable: process.env.GENIE_TEST_STAGED_BINARY,',
      '  runtimeVersion: process.env.GENIE_TEST_VERSION,',
      '  userHome: process.env.HOME,',
      '});',
      '',
    ].join('\n'),
  );
  if (opts.withBinary !== false) {
    const bin = join(tree, 'genie');
    writeFileSync(bin, fakeBinary(opts.version, driver));
    chmodSync(bin, 0o755);
  }
  writeFileSync(join(tree, 'VERSION'), `${opts.version}\n`);
  writeFileSync(join(tree, 'LICENSE'), 'fixture license\n');
  for (const name of ['plugins', 'skills', 'templates', '.agents', '.claude-plugin']) {
    mkdirSync(join(tree, name), { recursive: true });
    writeFileSync(join(tree, name, opts.sidecar ?? 'marker.txt'), `sidecar:${name}\n`);
  }
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
    writeFileSync(liveBinary, fakeBinary(opts.liveVersion, join(root, 'old-driver-unused.ts')));
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
    [
      'bash',
      '-c',
      'source "$1"; acquire_lifecycle_lock; extract_and_link "$2" "$3"',
      'bash',
      INSTALL_SH,
      tarball,
      version,
    ],
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
    'pid_is_live_or_unknown',
    'lock_record_is_stale',
    'foreign_lock_record_is_stale',
    'recover_stale_lifecycle_lock',
    'acquire_lifecycle_lock',
    'release_lifecycle_lock',
  ];
  const PINNED_DIGEST = '022718a55602d39044e19a31905a280290e260d36a17d2bccad9ca9ee472c200';

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
  test('happy path delegates to the verified promoter, preserves the prior binary, and wires PATH', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const tarball = buildTarball(root, { version: '5.260714.1', sidecar: 'new.txt' });

    const run = runExtract(layout, tarball, '5.260714.1');
    expect(run.exitCode).toBe(0);
    expect(readFileSync(layout.liveBinary, 'utf8')).toBe(fakeBinary('5.260714.1', join(root, 'promoter-driver.ts')));
    const backups = readdirSync(join(layout.bin, '.previous')).filter((name) => name.startsWith('genie-prior-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(layout.bin, '.previous', backups[0] as string), 'utf8')).toBe(
      fakeBinary('5.260713.1', join(root, 'old-driver-unused.ts')),
    );
    expect(readdirSync(join(layout.bin, 'plugins'))).toEqual(['new.txt']);
    const canonical = join(layout.homeRoot, '.local', 'bin', 'genie');
    expect(lstatSync(canonical).isSymbolicLink()).toBe(true);
    expect(readlinkSync(canonical)).toBe(layout.liveBinary);
    const retained = readdirSync(layout.bin).filter((entry) => entry.startsWith('.install-staging-'));
    expect(retained).toEqual([]);
  });

  test('first install promotes every physical release member without manufacturing a backup', () => {
    const root = mkroot();
    const layout = scaffold(root);
    const tarball = buildTarball(root, { version: '5.260714.1' });

    const run = runExtract(layout, tarball, '5.260714.1');

    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(layout.bin, 'VERSION'), 'utf8')).toBe('5.260714.1\n');
    const previous = join(layout.bin, '.previous');
    expect(existsSync(previous) ? readdirSync(previous) : []).toEqual([]);
    for (const name of ['plugins', 'skills', 'templates', '.agents', '.claude-plugin']) {
      expect(lstatSync(join(layout.bin, name)).isDirectory()).toBe(true);
      expect(lstatSync(join(layout.bin, name)).isSymbolicLink()).toBe(false);
    }
  });

  test('corrupt artifact with no Genie executable fails closed and leaves live bytes intact', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const tarball = buildTarball(root, { version: '5.260714.1', withBinary: false });

    const run = runExtract(layout, tarball, '5.260714.1');

    expect(run.exitCode).toBe(4);
    expect(run.stderr.toString()).toContain('physical executable');
    expect(readFileSync(layout.liveBinary, 'utf8')).toBe(fakeBinary('5.260713.1', join(root, 'old-driver-unused.ts')));
  });

  test('corrupt tarball fails closed and leaves live bytes intact', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const tarball = join(root, 'garbage.tar.gz');
    writeFileSync(tarball, 'not a gzip archive');

    const run = runExtract(layout, tarball, '5.260714.1');

    expect(run.exitCode).toBe(5);
    expect(readFileSync(layout.liveBinary, 'utf8')).toBe(fakeBinary('5.260713.1', join(root, 'old-driver-unused.ts')));
  });

  test('version mismatch fails before the hidden promoter receives mutation authority', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const tarball = buildTarball(root, { version: '9.999999.9' });

    const run = runExtract(layout, tarball, '5.260714.1');

    expect(run.exitCode).toBe(4);
    expect(run.stderr.toString()).toContain('version mismatch');
    expect(readFileSync(layout.liveBinary, 'utf8')).toBe(fakeBinary('5.260713.1', join(root, 'old-driver-unused.ts')));
  });

  test('an occupied canonical pathname is preserved and blocks live promotion', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const canonical = join(layout.homeRoot, '.local', 'bin', 'genie');
    writeFileSync(canonical, 'foreign canonical file');
    const tarball = buildTarball(root, { version: '5.260714.1' });

    const run = runExtract(layout, tarball, '5.260714.1');

    expect(run.exitCode).toBe(1);
    expect(readFileSync(canonical, 'utf8')).toBe('foreign canonical file');
    expect(readFileSync(layout.liveBinary, 'utf8')).toBe(fakeBinary('5.260713.1', join(root, 'old-driver-unused.ts')));
  });

  test('a symlinked GENIE_HOME/bin is rejected without writing through it', () => {
    const root = mkroot();
    const layout = scaffold(root);
    const victim = join(root, 'bin-victim');
    rmSync(layout.bin, { recursive: true });
    mkdirSync(victim);
    writeFileSync(join(victim, 'sentinel'), 'untouched');
    symlinkSync(victim, layout.bin, 'dir');
    const tarball = buildTarball(root, { version: '5.260714.1' });

    const run = runExtract(layout, tarball, '5.260714.1');

    expect(run.exitCode).toBe(1);
    expect(readFileSync(join(victim, 'sentinel'), 'utf8')).toBe('untouched');
    expect(readdirSync(victim)).toEqual(['sentinel']);
  });

  test('a second install converges without clobbering the existing canonical link', () => {
    const root = mkroot();
    const layout = scaffold(root, { liveVersion: '5.260713.1' });
    const tarball = buildTarball(root, { version: '5.260714.1' });
    expect(runExtract(layout, tarball, '5.260714.1').exitCode).toBe(0);
    const link = join(layout.homeRoot, '.local', 'bin', 'genie');
    const firstInode = lstatSync(link).ino;

    const retry = runExtract(layout, tarball, '5.260714.1');

    expect(retry.exitCode).toBe(0);
    expect(lstatSync(link).ino).toBe(firstInode);
    expect(readlinkSync(link)).toBe(layout.liveBinary);
    expect(readdirSync(join(layout.bin, '.previous')).filter((name) => name.startsWith('genie-prior-'))).toHaveLength(
      2,
    );
  });

  test('extract_and_link contains no shell live-swap, clobber-link, chmod, or staging-delete primitive', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');
    const body = source.slice(source.indexOf('extract_and_link() {'), source.indexOf('\n}\n\n# Detect pre-cutover'));

    expect(body).toContain('"$STAGING_DIR/genie" __install-promote');
    expect(body).toContain('GENIE_LIFECYCLE_LEASE_PATH="$LIFECYCLE_LOCK"');
    expect(body).toContain('GENIE_LIFECYCLE_LEASE_OWNER="$LIFECYCLE_OWNER_RECORD"');
    expect(body).not.toMatch(/\b(?:rm|mv|cp|chmod)\b/);
    expect(body).not.toContain('ln -sfn');
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
