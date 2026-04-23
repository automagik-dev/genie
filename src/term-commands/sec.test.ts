import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  type SecScanDeps,
  applySecScanExitCode,
  buildSecQuarantineGcArgv,
  buildSecQuarantineListArgv,
  buildSecRemediateArgv,
  buildSecRollbackArgv,
  buildSecScanArgv,
  registerSecCommands,
  resolveSecRemediateScript,
  resolveSecScanScript,
} from './sec.js';

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
    const deps: SecScanDeps = {
      existsSync: (path) => path === '/repo/package.json' || path === '/repo/scripts/sec-scan.cjs',
      realpathSync: (path) => path,
      spawnSync: spawnMock,
      setExitCode: setExitCodeMock,
    };

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
      spawnSync: spawnMock,
      setExitCode: setExitCodeMock,
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
      spawnSync: spawnMock,
      setExitCode: setExitCodeMock,
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
      spawnSync: spawnMock,
      setExitCode: () => {},
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
