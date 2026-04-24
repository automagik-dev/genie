import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  PROVENANCE_SOURCE_URI,
  SIGNER_IDENTITY_REGEXP,
  SIGNER_OIDC_ISSUER,
  type SecScanDeps,
  VERIFY_EXIT,
  applySecScanExitCode,
  buildSecQuarantineGcArgv,
  buildSecQuarantineListArgv,
  buildSecRemediateArgv,
  buildSecRollbackArgv,
  buildSecScanArgv,
  discoverSignatureBundle,
  readsAsCosignSentinel,
  registerSecCommands,
  resolveSecRemediateScript,
  resolveSecScanScript,
  runVerifyInstall,
} from './sec.js';

// Minimal shared stubs so every test can build a SecScanDeps without
// re-declaring the whole surface.
function buildDeps(overrides: Partial<SecScanDeps> = {}): SecScanDeps {
  return {
    existsSync: () => false,
    realpathSync: (p) => p,
    readFileSync: () => '',
    spawnSync: () => ({ status: 0 }),
    setExitCode: () => {},
    stdout: () => {},
    stderr: () => {},
    now: () => new Date('2026-04-23T00:00:00.000Z'),
    ...overrides,
  };
}

describe('sec scan command', () => {
  let originalArgv1: string | undefined;

  beforeEach(() => {
    originalArgv1 = process.argv[1];
  });

  afterEach(() => {
    if (originalArgv1 === undefined) {
      process.argv.splice(1, Math.max(process.argv.length - 1, 0));
    } else {
      process.argv[1] = originalArgv1;
    }
  });

  test('buildSecScanArgv preserves repeated homes and roots', () => {
    expect(
      buildSecScanArgv({
        json: true,
        allHomes: true,
        home: ['/home/a', '/Users/b'],
        root: ['/srv/app', '/opt/app'],
      }),
    ).toEqual([
      '--json',
      '--all-homes',
      '--home',
      '/home/a',
      '--home',
      '/Users/b',
      '--root',
      '/srv/app',
      '--root',
      '/opt/app',
    ]);
  });

  test('buildSecScanArgv passes through Group 1 observability flags', () => {
    expect(
      buildSecScanArgv({
        json: true,
        noProgress: true,
        quiet: true,
        verbose: true,
        progressJson: true,
        progressInterval: '500',
        eventsFile: '/tmp/evt.jsonl',
        redact: true,
        persist: false,
        impactSurface: true,
        phaseBudget: ['temp=3000', 'npm=5000'],
      }),
    ).toEqual([
      '--json',
      '--no-progress',
      '--quiet',
      '--verbose',
      '--progress-json',
      '--redact',
      '--impact-surface',
      '--phase-budget',
      'temp=3000',
      '--phase-budget',
      'npm=5000',
      '--progress-interval',
      '500',
      '--events-file',
      '/tmp/evt.jsonl',
      '--no-persist',
    ]);
  });

  test('buildSecScanArgv defaults persist=true to no flag', () => {
    expect(buildSecScanArgv({ json: true, persist: true })).toEqual(['--json']);
    expect(buildSecScanArgv({ json: true })).toEqual(['--json']);
  });

  test('resolveSecScanScript finds the packaged payload from dist layout', () => {
    const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'genie-sec-root-')));
    try {
      mkdirSync(join(tempRoot, 'dist'), { recursive: true });
      mkdirSync(join(tempRoot, 'scripts'), { recursive: true });
      writeFileSync(join(tempRoot, 'package.json'), '{}');
      writeFileSync(join(tempRoot, 'dist', 'genie.js'), '');
      writeFileSync(join(tempRoot, 'scripts', 'sec-scan.cjs'), '');

      const scriptPath = resolveSecScanScript(join(tempRoot, 'dist', 'genie.js'));
      expect(scriptPath).toBe(join(tempRoot, 'scripts', 'sec-scan.cjs'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('registered command forwards options to the scanner payload and preserves exit code', async () => {
    const spawnMock = mock<SecScanDeps['spawnSync']>(() => ({ status: 2 }));
    const setExitCodeMock = mock<SecScanDeps['setExitCode']>(() => {});
    const deps = buildDeps({
      existsSync: (path) => path === '/repo/package.json' || path === '/repo/scripts/sec-scan.cjs',
      realpathSync: (path) => path,
      spawnSync: spawnMock,
      setExitCode: setExitCodeMock,
    });

    process.argv[1] = '/repo/dist/genie.js';

    const program = new Command();
    registerSecCommands(program, deps);

    await program.parseAsync([
      'bun',
      'genie',
      'sec',
      'scan',
      '--json',
      '--all-homes',
      '--home',
      '/home/dev',
      '--home',
      '/Users/dev',
      '--root',
      '/srv/app',
    ]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        '/repo/scripts/sec-scan.cjs',
        '--json',
        '--all-homes',
        '--home',
        '/home/dev',
        '--home',
        '/Users/dev',
        '--root',
        '/srv/app',
      ],
      { stdio: 'inherit' },
    );
    expect(setExitCodeMock).toHaveBeenCalledTimes(1);
    expect(setExitCodeMock).toHaveBeenCalledWith(2);
  });

  test('applySecScanExitCode is a no-op for successful scans', () => {
    const setExitCodeMock = mock<SecScanDeps['setExitCode']>(() => {});

    applySecScanExitCode(0, { setExitCode: setExitCodeMock });

    expect(setExitCodeMock).not.toHaveBeenCalled();
  });
});

describe('sec remediate command', () => {
  let originalArgv1: string | undefined;

  beforeEach(() => {
    originalArgv1 = process.argv[1];
  });

  afterEach(() => {
    if (originalArgv1 === undefined) {
      process.argv.splice(1, Math.max(process.argv.length - 1, 0));
    } else {
      process.argv[1] = originalArgv1;
    }
  });

  test('buildSecRemediateArgv preserves dry-run, scan-id, kill-pid, and unsafe ack', () => {
    expect(
      buildSecRemediateArgv({
        dryRun: true,
        scanId: 'SCAN1',
        json: true,
      }),
    ).toEqual(['--dry-run', '--scan-id', 'SCAN1', '--json']);

    expect(
      buildSecRemediateArgv({
        apply: true,
        plan: '/tmp/plan.json',
        unsafeUnverified: 'INC1',
        killPid: [42, 99],
        autoConfirmFrom: '/tmp/c.json',
      }),
    ).toEqual([
      '--apply',
      '--plan',
      '/tmp/plan.json',
      '--unsafe-unverified',
      'INC1',
      '--kill-pid',
      '42',
      '--kill-pid',
      '99',
      '--auto-confirm-from',
      '/tmp/c.json',
    ]);
  });

  test('resolveSecRemediateScript locates the cjs payload from a dist layout', () => {
    const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'genie-sec-rem-')));
    try {
      mkdirSync(join(tempRoot, 'dist'), { recursive: true });
      mkdirSync(join(tempRoot, 'scripts'), { recursive: true });
      writeFileSync(join(tempRoot, 'package.json'), '{}');
      writeFileSync(join(tempRoot, 'dist', 'genie.js'), '');
      writeFileSync(join(tempRoot, 'scripts', 'sec-remediate.cjs'), '');

      const scriptPath = resolveSecRemediateScript(join(tempRoot, 'dist', 'genie.js'));
      expect(scriptPath).toBe(join(tempRoot, 'scripts', 'sec-remediate.cjs'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('registered remediate command forwards dry-run by default and surfaces exit code', async () => {
    const spawnMock = mock<SecScanDeps['spawnSync']>(() => ({ status: 0 }));
    const setExitCodeMock = mock<SecScanDeps['setExitCode']>(() => {});
    const deps: SecScanDeps = {
      existsSync: (path) =>
        path === '/repo/package.json' ||
        path === '/repo/scripts/sec-scan.cjs' ||
        path === '/repo/scripts/sec-remediate.cjs',
      realpathSync: (path) => path,
      readFileSync: () => '',
      spawnSync: spawnMock,
      setExitCode: setExitCodeMock,
      stdout: () => {},
      stderr: () => {},
      now: () => new Date(0),
    };

    process.argv[1] = '/repo/dist/genie.js';

    const program = new Command();
    registerSecCommands(program, deps);

    await program.parseAsync(['bun', 'genie', 'sec', 'remediate', '--scan-id', 'SCAN1', '--json']);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/repo/scripts/sec-remediate.cjs', '--dry-run', '--scan-id', 'SCAN1', '--json'],
      { stdio: 'inherit' },
    );
    expect(setExitCodeMock).not.toHaveBeenCalled();
  });

  test('registered restore command forwards quarantine id with --restore', async () => {
    const spawnMock = mock<SecScanDeps['spawnSync']>(() => ({ status: 0 }));
    const setExitCodeMock = mock<SecScanDeps['setExitCode']>(() => {});
    const deps: SecScanDeps = {
      existsSync: (path) =>
        path === '/repo/package.json' ||
        path === '/repo/scripts/sec-scan.cjs' ||
        path === '/repo/scripts/sec-remediate.cjs',
      realpathSync: (path) => path,
      readFileSync: () => '',
      spawnSync: spawnMock,
      setExitCode: setExitCodeMock,
      stdout: () => {},
      stderr: () => {},
      now: () => new Date(0),
    };

    process.argv[1] = '/repo/dist/genie.js';
    const program = new Command();
    registerSecCommands(program, deps);

    await program.parseAsync(['bun', 'genie', 'sec', 'restore', 'QUARANTINE-ID-1']);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/repo/scripts/sec-remediate.cjs', '--restore', 'QUARANTINE-ID-1'],
      { stdio: 'inherit' },
    );
  });
});

describe('sec rollback + quarantine list/gc commands', () => {
  let originalArgv1: string | undefined;

  beforeEach(() => {
    originalArgv1 = process.argv[1];
  });

  afterEach(() => {
    if (originalArgv1 === undefined) {
      process.argv.splice(1, Math.max(process.argv.length - 1, 0));
    } else {
      process.argv[1] = originalArgv1;
    }
  });

  test('buildSecRollbackArgv forwards scan_id and optional --json', () => {
    expect(buildSecRollbackArgv('SCAN-X', {})).toEqual(['--rollback', 'SCAN-X']);
    expect(buildSecRollbackArgv('SCAN-X', { json: true })).toEqual(['--rollback', 'SCAN-X', '--json']);
  });

  test('buildSecQuarantineListArgv emits the top-level flag and --json', () => {
    expect(buildSecQuarantineListArgv({})).toEqual(['--quarantine-list']);
    expect(buildSecQuarantineListArgv({ json: true })).toEqual(['--quarantine-list', '--json']);
  });

  test('buildSecQuarantineGcArgv forwards --older-than + --confirm-gc', () => {
    expect(buildSecQuarantineGcArgv({ olderThan: '30d' })).toEqual(['--quarantine-gc', '--older-than', '30d']);
    expect(buildSecQuarantineGcArgv({ olderThan: '24h', confirmGc: 'CONFIRM-GC-abcdef', json: true })).toEqual([
      '--quarantine-gc',
      '--older-than',
      '24h',
      '--confirm-gc',
      'CONFIRM-GC-abcdef',
      '--json',
    ]);
  });

  function depsWith(spawnMock: ReturnType<typeof mock<SecScanDeps['spawnSync']>>): SecScanDeps {
    return {
      existsSync: (path) =>
        path === '/repo/package.json' ||
        path === '/repo/scripts/sec-scan.cjs' ||
        path === '/repo/scripts/sec-remediate.cjs',
      realpathSync: (path) => path,
      readFileSync: () => '',
      spawnSync: spawnMock,
      setExitCode: () => {},
      stdout: () => {},
      stderr: () => {},
      now: () => new Date(0),
    };
  }

  test('rollback command forwards scan-id + --json to the payload', async () => {
    const spawnMock = mock<SecScanDeps['spawnSync']>(() => ({ status: 0 }));
    process.argv[1] = '/repo/dist/genie.js';
    const program = new Command();
    registerSecCommands(program, depsWith(spawnMock));

    await program.parseAsync(['bun', 'genie', 'sec', 'rollback', 'SCAN-Z', '--json']);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/repo/scripts/sec-remediate.cjs', '--rollback', 'SCAN-Z', '--json'],
      { stdio: 'inherit' },
    );
  });

  test('quarantine list command forwards --quarantine-list', async () => {
    const spawnMock = mock<SecScanDeps['spawnSync']>(() => ({ status: 0 }));
    process.argv[1] = '/repo/dist/genie.js';
    const program = new Command();
    registerSecCommands(program, depsWith(spawnMock));

    await program.parseAsync(['bun', 'genie', 'sec', 'quarantine', 'list', '--json']);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/repo/scripts/sec-remediate.cjs', '--quarantine-list', '--json'],
      { stdio: 'inherit' },
    );
  });

  test('quarantine gc command forwards --older-than and --confirm-gc', async () => {
    const spawnMock = mock<SecScanDeps['spawnSync']>(() => ({ status: 0 }));
    process.argv[1] = '/repo/dist/genie.js';
    const program = new Command();
    registerSecCommands(program, depsWith(spawnMock));

    await program.parseAsync([
      'bun',
      'genie',
      'sec',
      'quarantine',
      'gc',
      '--older-than',
      '30d',
      '--confirm-gc',
      'CONFIRM-GC-abcdef',
    ]);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        '/repo/scripts/sec-remediate.cjs',
        '--quarantine-gc',
        '--older-than',
        '30d',
        '--confirm-gc',
        'CONFIRM-GC-abcdef',
      ],
      { stdio: 'inherit' },
    );
  });
});

describe('sec verify-install — fixture helpers', () => {
  test('readsAsCosignSentinel identifies the committed no-key sentinel', () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'genie-sentinel-')));
    try {
      const path = join(tempDir, 'cosign.pub');
      writeFileSync(
        path,
        '-----BEGIN COSIGN NO-PINNED-KEY SENTINEL-----\nKEYLESS_ONLY\n-----END COSIGN NO-PINNED-KEY SENTINEL-----\n',
      );
      expect(readsAsCosignSentinel(path)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('readsAsCosignSentinel returns false for a real PEM-shaped file', () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'genie-pem-')));
    try {
      const path = join(tempDir, 'cosign.pub');
      writeFileSync(path, '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n');
      expect(readsAsCosignSentinel(path)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('discoverSignatureBundle finds a complete {tgz,sig,cert,provenance} bundle', () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'genie-bundle-')));
    try {
      const tarball = join(tempDir, 'automagik-genie-4.260423.11.tgz');
      writeFileSync(tarball, 'fake tarball');
      writeFileSync(`${tarball}.sig`, 'fake-sig');
      writeFileSync(`${tarball}.cert`, 'fake-cert');
      writeFileSync(join(tempDir, 'provenance.intoto.jsonl'), '{}');

      const bundle = discoverSignatureBundle(tempDir);
      expect(bundle).toBeTruthy();
      expect(bundle?.tarball).toBe(tarball);
      expect(bundle?.signature).toBe(`${tarball}.sig`);
      expect(bundle?.certificate).toBe(`${tarball}.cert`);
      expect(bundle?.provenance).toBe(join(tempDir, 'provenance.intoto.jsonl'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('discoverSignatureBundle returns null when .sig is missing', () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'genie-bundle-')));
    try {
      writeFileSync(join(tempDir, 'automagik-genie-4.260423.11.tgz'), 'fake');
      expect(discoverSignatureBundle(tempDir)).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('sec verify-install — runtime', () => {
  function makeBundleDir(withProvenance = true): string {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'genie-verify-')));
    const tarball = join(tempDir, 'automagik-genie-4.260423.11.tgz');
    writeFileSync(tarball, 'fake tarball');
    writeFileSync(`${tarball}.sig`, 'fake-sig');
    writeFileSync(`${tarball}.cert`, 'fake-cert');
    if (withProvenance) writeFileSync(join(tempDir, 'provenance.intoto.jsonl'), '{}');
    return tempDir;
  }

  test('exit 5 (no signature material) when no bundle is found', () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'genie-empty-')));
    try {
      const result = runVerifyInstall(
        { bundleDir: tempDir },
        buildDeps({
          existsSync: () => true,
        }),
      );
      expect(result.exitCode).toBe(VERIFY_EXIT.NO_SIGNATURE_MATERIAL);
      expect(result.json.verified).toBe(false);
      expect(result.json.pinned_key_fingerprint).toBeNull();
      expect(result.json.signing_mode).toBe('cosign-keyless');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('exit 0 when cosign + slsa-verifier both succeed', () => {
    const bundleDir = makeBundleDir();
    try {
      const spawnCalls: string[] = [];
      const deps = buildDeps({
        existsSync,
        spawnSync: (cmd, _args, _opts) => {
          spawnCalls.push(cmd);
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const result = runVerifyInstall({ bundleDir }, deps);
      expect(result.exitCode).toBe(VERIFY_EXIT.VERIFIED);
      expect(result.json.verified).toBe(true);
      expect(result.json.offline).toBe(false);
      expect(result.json.signer_identity).toBe(SIGNER_IDENTITY_REGEXP);
      expect(result.json.signer_oidc_issuer).toBe(SIGNER_OIDC_ISSUER);
      // ensureBinary(cosign), cosign verify-blob, ensureBinary(slsa-verifier), slsa verify-artifact
      expect(spawnCalls).toEqual(['cosign', 'cosign', 'slsa-verifier', 'slsa-verifier']);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  test('exit 2 (signature-invalid) when cosign rejects without identity hint', () => {
    const bundleDir = makeBundleDir();
    try {
      const deps = buildDeps({
        existsSync,
        spawnSync: (cmd, args) => {
          if (cmd === 'cosign' && args[0] === '--version') return { status: 0, stdout: 'cosign 2.2.4' };
          if (cmd === 'cosign' && args[0] === 'verify-blob') {
            return {
              status: 1,
              stdout: '',
              stderr: 'error: signature mismatch: payload hash does not match',
            };
          }
          return { status: 0 };
        },
      });
      const result = runVerifyInstall({ bundleDir }, deps);
      expect(result.exitCode).toBe(VERIFY_EXIT.SIGNATURE_INVALID);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  test('exit 3 (signer-identity-mismatch) when cosign complains about certificate identity', () => {
    const bundleDir = makeBundleDir();
    try {
      const deps = buildDeps({
        existsSync,
        spawnSync: (cmd, args) => {
          if (cmd === 'cosign' && args[0] === '--version') return { status: 0, stdout: 'cosign 2.2.4' };
          if (cmd === 'cosign' && args[0] === 'verify-blob') {
            return {
              status: 1,
              stdout: '',
              stderr: 'error: none of the expected certificate identity patterns matched',
            };
          }
          return { status: 0 };
        },
      });
      const result = runVerifyInstall({ bundleDir }, deps);
      expect(result.exitCode).toBe(VERIFY_EXIT.SIGNER_IDENTITY_MISMATCH);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  test('exit 4 (provenance-invalid) when slsa-verifier rejects the artifact', () => {
    const bundleDir = makeBundleDir();
    try {
      const deps = buildDeps({
        existsSync,
        spawnSync: (cmd, args) => {
          if (cmd === 'cosign') return { status: 0, stdout: 'cosign 2.2.4', stderr: '' };
          if (cmd === 'slsa-verifier' && args[0] === '--version') {
            return { status: 0, stdout: 'slsa-verifier 2.6' };
          }
          if (cmd === 'slsa-verifier' && args[0] === 'verify-artifact') {
            return { status: 1, stdout: '', stderr: 'FAILED: artifact hash mismatch' };
          }
          return { status: 0 };
        },
      });
      const result = runVerifyInstall({ bundleDir }, deps);
      expect(result.exitCode).toBe(VERIFY_EXIT.PROVENANCE_INVALID);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  test('exit 4 (provenance-invalid) when provenance.intoto.jsonl is missing', () => {
    const bundleDir = makeBundleDir(false);
    try {
      const deps = buildDeps({
        existsSync,
        spawnSync: (cmd, args) => {
          if (cmd === 'cosign') return { status: 0, stdout: 'cosign 2.2.4', stderr: '' };
          if (cmd === 'slsa-verifier' && args[0] === '--version') {
            return { status: 0, stdout: 'slsa-verifier 2.6' };
          }
          return { status: 0 };
        },
      });
      const result = runVerifyInstall({ bundleDir }, deps);
      expect(result.exitCode).toBe(VERIFY_EXIT.PROVENANCE_INVALID);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  test('exit 127 (missing binary) when cosign is not on PATH', () => {
    const bundleDir = makeBundleDir();
    try {
      const deps = buildDeps({
        existsSync,
        spawnSync: (cmd, args) => {
          if (cmd === 'cosign' && args[0] === '--version') {
            return { status: 127, error: new Error('command not found: cosign') };
          }
          return { status: 0 };
        },
      });
      const result = runVerifyInstall({ bundleDir }, deps);
      expect(result.exitCode).toBe(VERIFY_EXIT.MISSING_BINARY);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  test('--offline passes cosign flags that skip the Rekor transparency-log check', () => {
    const bundleDir = makeBundleDir();
    try {
      let cosignVerifyArgs: string[] = [];
      const deps = buildDeps({
        existsSync,
        spawnSync: (cmd, args) => {
          if (cmd === 'cosign' && args[0] === 'verify-blob') cosignVerifyArgs = args;
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const result = runVerifyInstall({ bundleDir, offline: true }, deps);
      expect(result.exitCode).toBe(VERIFY_EXIT.VERIFIED);
      expect(result.json.offline).toBe(true);
      expect(cosignVerifyArgs).toContain('--insecure-ignore-tlog');
      expect(cosignVerifyArgs).toContain('--offline');
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  test('json output shape is stable and contains every documented field', () => {
    const bundleDir = makeBundleDir();
    try {
      const deps = buildDeps({
        existsSync,
        spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
      });
      const result = runVerifyInstall({ bundleDir }, deps);
      const keys = Object.keys(result.json).sort();
      expect(keys).toEqual(
        [
          'errors',
          'exit_code',
          'offline',
          'pinned_key_fingerprint',
          'provenance_source',
          'signature_source',
          'signer_identity',
          'signer_oidc_issuer',
          'signing_mode',
          'tarball_path',
          'verified',
          'verified_at',
        ].sort(),
      );
      expect(result.json.pinned_key_fingerprint).toBeNull();
      expect(result.json.signing_mode).toBe('cosign-keyless');
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  test('provenance source-uri matches the release.yml pin', () => {
    expect(PROVENANCE_SOURCE_URI).toBe('github.com/automagik-dev/genie');
  });
});
