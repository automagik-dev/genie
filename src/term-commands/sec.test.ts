import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  type SecScanDeps,
  applySecScanExitCode,
  buildSecScanArgv,
  registerSecCommands,
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
