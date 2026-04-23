/**
 * Group 1 coverage: runtime context, versioned envelope, CLI flag surface,
 * SIGINT flush, kill switch, exit-code trichotomy.
 *
 * Unit tests require `scripts/sec-scan.cjs` as a CommonJS module via
 * `require.main` guard; the script only runs `main()` when invoked directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCANNER_PATH = resolve(__dirname, 'sec-scan.cjs');

const scanner = require(SCANNER_PATH) as Record<string, any>;

interface FakeStream {
  chunks: string[];
  write(data: string): boolean;
}

function makeFakeStream(): FakeStream {
  const chunks: string[] = [];
  return {
    chunks,
    write(data: string) {
      chunks.push(data);
      return true;
    },
  };
}

function makeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function deterministicRandom(seed = 0xa5) {
  return (n: number) => {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i += 1) buf[i] = (seed + i) & 0xff;
    return buf;
  };
}

describe('sec-scan runtime helpers', () => {
  test('generateUlid produces 26-char Crockford base32 strings', () => {
    const id = scanner.generateUlid(1_700_000_000_000);
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test('generateUlid timestamp prefix is monotonic with time', () => {
    const early = scanner.generateUlid(1_000_000_000_000, deterministicRandom(0));
    const later = scanner.generateUlid(1_000_000_001_000, deterministicRandom(0));
    expect(later.slice(0, 10) >= early.slice(0, 10)).toBe(true);
  });

  test('createHostId returns 16-char hex sha256 prefix', () => {
    const platformInfo = scanner.detectPlatform();
    const hostId = scanner.createHostId(platformInfo);
    expect(hostId).toMatch(/^[0-9a-f]{16}$/);
  });

  test('createRuntime produces scan_id, hostId, scannerVersion, startedAt', () => {
    const clock = makeClock();
    const runtime = scanner.createRuntime({
      options: scanner.parseArgs(['node', 'sec-scan.cjs', '--quiet']),
      clock,
      platformInfo: scanner.detectPlatform(),
      argv: ['node', 'sec-scan.cjs'],
      scannerVersion: '0.0.0-test',
      randomBytesProvider: deterministicRandom(),
    });
    expect(runtime.scanId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(runtime.hostId).toMatch(/^[0-9a-f]{16}$/);
    expect(runtime.startedAt).toBe(new Date(clock.now()).toISOString());
    expect(runtime.scannerVersion).toBe('0.0.0-test');
  });

  test('runtime phase lifecycle records elapsed_ms in finish()', () => {
    const clock = makeClock();
    const stderr = makeFakeStream();
    const runtime = scanner.createRuntime({
      options: scanner.parseArgs(['node', 'sec-scan.cjs', '--no-progress']),
      clock,
      platformInfo: scanner.detectPlatform(),
      argv: ['node', 'sec-scan.cjs'],
      scannerVersion: '0.0.0',
      stderr,
      randomBytesProvider: deterministicRandom(),
    });
    runtime.startPhase('scanNpmCache');
    clock.advance(150);
    runtime.endPhase('scanNpmCache');
    runtime.startPhase('scanBunCache');
    clock.advance(75);
    runtime.endPhase('scanBunCache');
    const state = runtime.finish();
    expect(state.phases).toHaveLength(2);
    expect(state.phases[0]).toMatchObject({ id: 'scanNpmCache', elapsed_ms: 150 });
    expect(state.phases[1]).toMatchObject({ id: 'scanBunCache', elapsed_ms: 75 });
    expect(state.interrupted).toBe(false);
  });

  test('progress JSON mode emits NDJSON events to stderr on tick-free API calls', () => {
    const clock = makeClock();
    const stderr = makeFakeStream();
    const runtime = scanner.createRuntime({
      options: scanner.parseArgs(['node', 'sec-scan.cjs', '--progress-json', '--progress-interval', '10000']),
      clock,
      platformInfo: scanner.detectPlatform(),
      argv: ['node', 'sec-scan.cjs'],
      scannerVersion: '0.0.0',
      stderr,
      randomBytesProvider: deterministicRandom(),
    });
    runtime.startPhase('scanNpmCache');
    clock.advance(50);
    runtime.endPhase('scanNpmCache');
    runtime.finish();
    const lines = stderr.chunks.join('').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const evt = JSON.parse(line);
      expect(evt.scan_id).toBe(runtime.scanId);
      expect(typeof evt.ts_ms).toBe('number');
      expect(typeof evt.kind).toBe('string');
    }
  });

  test('--no-progress and --quiet suppress progress output', () => {
    for (const flag of ['--no-progress', '--quiet']) {
      const stderr = makeFakeStream();
      const runtime = scanner.createRuntime({
        options: scanner.parseArgs(['node', 'sec-scan.cjs', flag]),
        clock: makeClock(),
        platformInfo: scanner.detectPlatform(),
        argv: ['node', 'sec-scan.cjs'],
        scannerVersion: '0.0.0',
        stderr,
        randomBytesProvider: deterministicRandom(),
      });
      runtime.startPhase('scanNpmCache');
      runtime.endPhase('scanNpmCache');
      runtime.finish();
      expect(stderr.chunks).toEqual([]);
    }
  });

  test('markInterrupted flags phase and sets interrupted=true', () => {
    const clock = makeClock();
    const runtime = scanner.createRuntime({
      options: scanner.parseArgs(['node', 'sec-scan.cjs', '--no-progress']),
      clock,
      platformInfo: scanner.detectPlatform(),
      argv: ['node', 'sec-scan.cjs'],
      scannerVersion: '0.0.0',
      stderr: makeFakeStream(),
      randomBytesProvider: deterministicRandom(),
    });
    runtime.startPhase('scanTempArtifacts');
    clock.advance(300);
    runtime.markInterrupted('signal:SIGINT');
    const state = runtime.finish();
    expect(state.interrupted).toBe(true);
    expect(state.interruptReason).toBe('signal:SIGINT');
    expect(state.phases[0]).toMatchObject({ id: 'scanTempArtifacts', interrupted: true, elapsed_ms: 300 });
  });
});

describe('sec-scan envelope and exit code', () => {
  function buildRuntime(options: Record<string, unknown> = {}) {
    return scanner.createRuntime({
      options: scanner.parseArgs(['node', 'sec-scan.cjs', '--no-progress']),
      clock: makeClock(),
      platformInfo: scanner.detectPlatform(),
      argv: ['node', 'sec-scan.cjs', '--no-progress'],
      scannerVersion: '0.0.0-test',
      stderr: makeFakeStream(),
      randomBytesProvider: deterministicRandom(),
      ...options,
    });
  }

  function baseReport() {
    return {
      host: 'test-host',
      platform: scanner.detectPlatform(),
      scannedAt: new Date(0).toISOString(),
      cwd: '/tmp',
      homes: [],
      roots: [],
      compromisedVersions: [],
      trackedPackages: [],
      compromiseWindow: { start: '', end: '' },
      npmCacheMetadata: [],
      npmTarballFetches: [],
      bunCacheFindings: [],
      installFindings: [],
      lockfileFindings: [],
      npmLogHits: [],
      shellProfileFindings: [],
      shellHistoryFindings: [],
      persistenceFindings: [],
      pythonPthFindings: [],
      tempArtifactFindings: [],
      liveProcessFindings: [],
      impactSurfaceFindings: [],
      timeline: [],
      errors: [],
      summary: {
        status: 'NO FINDINGS',
        likelyCompromised: false,
        likelyAffected: false,
        observedOnly: false,
        suspicionScore: 0,
        compromiseReasons: [],
        affectedReasons: [],
        findingCounts: {},
        recommendations: [],
      },
    };
  }

  test('envelope has reportVersion=1 and all required fields', () => {
    const runtime = buildRuntime();
    const envelope = scanner.envelopeFromReport(runtime, baseReport());
    expect(envelope.reportVersion).toBe(1);
    expect(envelope.scan_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(envelope.hostId).toMatch(/^[0-9a-f]{16}$/);
    expect(envelope.scannerVersion).toBe('0.0.0-test');
    expect(typeof envelope.startedAt).toBe('string');
    expect(typeof envelope.finishedAt).toBe('string');
    expect(envelope.invocation).toBeDefined();
    expect(envelope.invocation.argv).toEqual(['--no-progress']);
    expect(envelope.invocation.flags.progress).toBe(false);
    expect(envelope.platform).toBeDefined();
    expect(envelope.coverage).toBeDefined();
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.interrupted).toBe(false);
  });

  test('envelope preserves detection report fields alongside envelope fields', () => {
    const runtime = buildRuntime();
    const report = baseReport();
    report.installFindings = [{ kind: 'node_modules', path: '/tmp/x', packageName: 'y', version: '1.0.0' }];
    const envelope = scanner.envelopeFromReport(runtime, report);
    expect(envelope.installFindings).toBe(report.installFindings);
    expect(envelope.host).toBe('test-host');
    expect(envelope.summary).toBeDefined();
  });

  test('computeExitCode: clean and complete → 0', () => {
    const runtime = buildRuntime();
    const envelope = scanner.envelopeFromReport(runtime, baseReport());
    expect(scanner.computeExitCode(envelope)).toBe(0);
  });

  test('computeExitCode: any findings → 1', () => {
    const runtime = buildRuntime();
    const report = baseReport();
    report.summary.likelyCompromised = true;
    const envelope = scanner.envelopeFromReport(runtime, report);
    expect(scanner.computeExitCode(envelope)).toBe(1);

    const runtime2 = buildRuntime();
    const report2 = baseReport();
    report2.summary.observedOnly = true;
    const envelope2 = scanner.envelopeFromReport(runtime2, report2);
    expect(scanner.computeExitCode(envelope2)).toBe(1);
  });

  test('computeExitCode: clean but interrupted → 2', () => {
    const runtime = buildRuntime();
    runtime.markInterrupted('signal:SIGINT');
    const envelope = scanner.envelopeFromReport(runtime, baseReport());
    expect(envelope.coverage.complete).toBe(false);
    expect(scanner.computeExitCode(envelope)).toBe(2);
  });

  test('computeExitCode: clean but capped → 2', () => {
    const runtime = buildRuntime();
    runtime.recordCap('walk.max-entries', { root: '/tmp', entries: 25000 });
    const envelope = scanner.envelopeFromReport(runtime, baseReport());
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.coverage.capEvents).toHaveLength(1);
    expect(scanner.computeExitCode(envelope)).toBe(2);
  });

  test('buildInvocation captures all Group 1 flags', () => {
    const options = scanner.parseArgs([
      'node',
      'sec-scan.cjs',
      '--json',
      '--all-homes',
      '--home',
      '/home/a',
      '--root',
      '/srv/app',
      '--no-progress',
      '--quiet',
      '--verbose',
      '--progress-json',
      '--progress-interval',
      '500',
      '--events-file',
      '/tmp/evt.jsonl',
      '--redact',
      '--no-persist',
      '--impact-surface',
      '--phase-budget',
      'temp=3000',
    ]);
    const invocation = scanner.buildInvocation(['node', 'sec-scan.cjs', '--json'], options);
    expect(invocation.flags.json).toBe(true);
    expect(invocation.flags.allHomes).toBe(true);
    expect(invocation.flags.homes).toEqual(['/home/a']);
    expect(invocation.flags.roots).toEqual(['/srv/app']);
    expect(invocation.flags.progressJson).toBe(true);
    expect(invocation.flags.progressIntervalMs).toBe(500);
    expect(invocation.flags.eventsFile).toBe('/tmp/evt.jsonl');
    expect(invocation.flags.redact).toBe(true);
    expect(invocation.flags.persist).toBe(false);
    expect(invocation.flags.impactSurface).toBe(true);
    expect(invocation.flags.phaseBudgets).toEqual({ temp: 3000 });
    expect(invocation.flags.verbose).toBe(true);
    expect(invocation.flags.quiet).toBe(true);
  });
});

describe('sec-scan parseArgs errors', () => {
  test('unknown flag throws', () => {
    expect(() => scanner.parseArgs(['node', 'sec-scan.cjs', '--nope'])).toThrow(/Unknown argument/);
  });

  test('--root without value throws', () => {
    expect(() => scanner.parseArgs(['node', 'sec-scan.cjs', '--root'])).toThrow(/requires a value/);
  });

  test('--progress-interval rejects non-numeric', () => {
    expect(() => scanner.parseArgs(['node', 'sec-scan.cjs', '--progress-interval', 'abc'])).toThrow(
      /non-negative number/,
    );
  });

  test('--phase-budget rejects malformed entries', () => {
    expect(() => scanner.parseArgs(['node', 'sec-scan.cjs', '--phase-budget', 'temp'])).toThrow(/name=ms/);
    expect(() => scanner.parseArgs(['node', 'sec-scan.cjs', '--phase-budget', 'temp=-1'])).toThrow(/non-negative/);
  });

  test('--help sets options.help without throwing', () => {
    const opts = scanner.parseArgs(['node', 'sec-scan.cjs', '--help']);
    expect(opts.help).toBe(true);
  });
});

describe('sec-scan kill switch', () => {
  test('isKillSwitchEnabled reads GENIE_SEC_SCAN_DISABLED', () => {
    expect(scanner.isKillSwitchEnabled({})).toBe(false);
    expect(scanner.isKillSwitchEnabled({ GENIE_SEC_SCAN_DISABLED: '1' })).toBe(true);
    expect(scanner.isKillSwitchEnabled({ GENIE_SEC_SCAN_DISABLED: '0' })).toBe(false);
  });

  test('emitKillSwitchResponse --json writes disabled envelope to stdout', () => {
    const stdout = makeFakeStream();
    const stderr = makeFakeStream();
    const code = scanner.emitKillSwitchResponse({ json: true }, { stdout, stderr });
    expect(code).toBe(0);
    expect(stderr.chunks).toEqual([]);
    const payload = JSON.parse(stdout.chunks.join(''));
    expect(payload).toEqual({
      reportVersion: 1,
      disabled: true,
      reason: 'GENIE_SEC_SCAN_DISABLED=1',
    });
  });

  test('emitKillSwitchResponse human writes reason to stderr', () => {
    const stdout = makeFakeStream();
    const stderr = makeFakeStream();
    scanner.emitKillSwitchResponse({ json: false }, { stdout, stderr });
    expect(stdout.chunks).toEqual([]);
    expect(stderr.chunks.join('')).toMatch(/GENIE_SEC_SCAN_DISABLED=1/);
  });
});

describe('sec-scan end-to-end subprocess', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sec-scan-e2e-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('--help exits 0 and documents Group 1 flags on stdout', () => {
    const res = spawnSync(process.execPath, [SCANNER_PATH, '--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const stdout = res.stdout;
    expect(stdout).toContain('--no-progress');
    expect(stdout).toContain('--progress-json');
    expect(stdout).toContain('--progress-interval');
    expect(stdout).toContain('--events-file');
    expect(stdout).toContain('--redact');
    expect(stdout).toContain('--no-persist');
    expect(stdout).toContain('--impact-surface');
    expect(stdout).toContain('--phase-budget');
    expect(stdout).toContain('Exit codes');
  });

  test('GENIE_SEC_SCAN_DISABLED=1 exits 0 with disabled envelope', () => {
    const res = spawnSync(process.execPath, [SCANNER_PATH, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, GENIE_SEC_SCAN_DISABLED: '1', HOME: tmpRoot },
      cwd: tmpRoot,
    });
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout.trim());
    expect(payload.reportVersion).toBe(1);
    expect(payload.disabled).toBe(true);
    expect(payload.reason).toBe('GENIE_SEC_SCAN_DISABLED=1');
  });

  test('GENIE_SEC_SCAN_DISABLED=1 human mode prints reason to stderr', () => {
    const res = spawnSync(process.execPath, [SCANNER_PATH], {
      encoding: 'utf8',
      env: { ...process.env, GENIE_SEC_SCAN_DISABLED: '1', HOME: tmpRoot },
      cwd: tmpRoot,
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/GENIE_SEC_SCAN_DISABLED=1/);
    expect(res.stdout).toBe('');
  });

  test('unknown flag exits 3 with error on stderr', () => {
    const res = spawnSync(process.execPath, [SCANNER_PATH, '--nope'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmpRoot },
      cwd: tmpRoot,
    });
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/Unknown argument/);
  });
});

describe('sec-scan signal handling', () => {
  test('installSignalHandlers calls flush then exit(2) under 500ms budget', () => {
    const runtime = scanner.createRuntime({
      options: scanner.parseArgs(['node', 'sec-scan.cjs', '--no-progress']),
      clock: makeClock(),
      platformInfo: scanner.detectPlatform(),
      argv: ['node', 'sec-scan.cjs'],
      scannerVersion: '0.0.0',
      stderr: makeFakeStream(),
      randomBytesProvider: deterministicRandom(),
    });

    const events: string[] = [];
    let exitCode: number | null = null;
    const flush = (reason: string) => {
      events.push(`flush:${reason}`);
    };

    const handler = scanner.installSignalHandlers(runtime, flush, {
      exitFn: (code: number) => {
        exitCode = code;
        events.push(`exit:${code}`);
      },
    });

    try {
      const start = Date.now();
      handler('SIGINT');
      const elapsedMs = Date.now() - start;

      expect(events).toEqual(['flush:signal:SIGINT', 'exit:2']);
      expect(exitCode).toBe(2);
      expect(elapsedMs).toBeLessThan(500);
      expect(runtime.isInterrupted()).toBe(true);

      // Second signal is idempotent — flush only runs once.
      handler('SIGTERM');
      expect(events).toEqual(['flush:signal:SIGINT', 'exit:2']);
    } finally {
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
    }
  });

  test('installSignalHandlers still exits when flush throws', () => {
    const runtime = scanner.createRuntime({
      options: scanner.parseArgs(['node', 'sec-scan.cjs', '--no-progress']),
      clock: makeClock(),
      platformInfo: scanner.detectPlatform(),
      argv: ['node', 'sec-scan.cjs'],
      scannerVersion: '0.0.0',
      stderr: makeFakeStream(),
      randomBytesProvider: deterministicRandom(),
    });

    let exitCode: number | null = null;
    const handler = scanner.installSignalHandlers(
      runtime,
      () => {
        throw new Error('flush failed');
      },
      {
        exitFn: (code: number) => {
          exitCode = code;
        },
      },
    );

    try {
      handler('SIGTERM');
      expect(exitCode).toBe(2);
      expect(runtime.isInterrupted()).toBe(true);
    } finally {
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
    }
  });
});
