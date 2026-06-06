import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ============================================================================
// Smart child_process mock for startTuiTmuxServer tests.
//
// Bun's mock.module is process-global and leaks across test files. To keep
// other tests in this file (and other files) safe, the default execSync
// implementation falls through to the REAL child_process.execSync. Each test
// in `describe('startTuiTmuxServer')` installs a per-test handler via
// setExecSyncHandler(); the handler scripts responses for genie-tui tmux
// commands and lets non-matching commands fall through to the real exec.
//
// `spawn` and `spawnSync` are preserved verbatim — the rest of this file's
// tests rely on them.
// ============================================================================

type ExecSyncHandler = (
  cmd: string,
  opts?: { encoding?: BufferEncoding | 'buffer' } & Record<string, unknown>,
) => string | Buffer;

let _execSyncHandler: ExecSyncHandler | null = null;
function setExecSyncHandler(handler: ExecSyncHandler | null): void {
  _execSyncHandler = handler;
}

function isTuiTmuxCmd(cmd: string): boolean {
  return cmd.includes('-L genie-tui');
}

// IMPORTANT: capture the REAL execSync / spawnSync as `const` references
// BEFORE registering mock.module. Namespace imports (`* as realChildProcess`)
// expose live bindings — after mock, `realChildProcess.execSync` would point
// at the mocked function, causing infinite recursion when the mock falls
// through to the "real" implementation. A const captured here freezes the
// binding to the original function.
const realExecSync: typeof realChildProcess.execSync = realChildProcess.execSync;
const realSpawnSync: typeof realChildProcess.spawnSync = realChildProcess.spawnSync;
const realSpawn: typeof realChildProcess.spawn = realChildProcess.spawn;

mock.module('node:child_process', () => ({
  ...realChildProcess,
  execSync: (cmd: string, opts?: Parameters<typeof realChildProcess.execSync>[1]) => {
    if (_execSyncHandler && isTuiTmuxCmd(cmd)) {
      return _execSyncHandler(cmd, opts as Record<string, unknown>);
    }
    return realExecSync(cmd, opts);
  },
  spawn: realSpawn,
  spawnSync: ((file: string, args?: readonly string[], opts?: Record<string, unknown>) => {
    // While a startTuiTmuxServer test is active, swallow tmux invocations on
    // the genie-tui socket so setupTuiKeybindings doesn't poke the real tmux
    // server. Other spawnSync calls (e.g. installer probes) fall through.
    if (_execSyncHandler && Array.isArray(args) && args.includes('-L') && args.includes('genie-tui')) {
      return {
        pid: 0,
        output: [null, '', ''],
        stdout: '',
        stderr: '',
        status: 0,
        signal: null,
      };
    }
    return realSpawnSync(file, args as readonly string[], opts as Parameters<typeof realChildProcess.spawnSync>[2]);
  }) as typeof realChildProcess.spawnSync,
}));

const {
  autoStartServe,
  clearStoppingLock,
  getTuiKeybindings,
  getTuiQuitBindingArgs,
  isStoppingLockActive,
  printStandaloneBrainStatus,
  startBrainServerIfEnabled,
  startTuiTmuxServer,
  writeStoppingLockSync,
} = await import('./serve.js');

describe('getTuiKeybindings', () => {
  test('includes explicit left and right pane focus bindings', () => {
    const bindings = getTuiKeybindings();

    expect(bindings).toContain('bind-key -T root C-1 select-pane -t genie-tui:0.0');
    expect(bindings).toContain('bind-key -T root C-2 select-pane -t genie-tui:0.1');
  });

  test('keeps existing tab toggle and quit passthrough bindings', () => {
    const bindings = getTuiKeybindings();

    expect(bindings.some((binding) => binding.includes('bind-key -T root Tab if-shell'))).toBe(true);
    expect(bindings).toContain('bind-key -T root C-q select-pane -t genie-tui:0.0 \\; send-keys -t genie-tui:0.0 C-q');
  });

  test('builds quit passthrough binding args without shell escaping', () => {
    expect(getTuiQuitBindingArgs()).toEqual([
      'bind-key',
      '-T',
      'root',
      'C-q',
      'select-pane',
      '-t',
      'genie-tui:0.0',
      '\\;',
      'send-keys',
      '-t',
      'genie-tui:0.0',
      'C-q',
    ]);
  });
});

describe('pgserve boot probe — UDS-first / TCP-fallback (post-#1667)', () => {
  test('boot probe uses the unified resolvePgserveTransport resolver', () => {
    const source = readFileSync(join(__dirname, 'serve.ts'), 'utf-8');
    const fnStart = source.indexOf('async function requirePgserveReady');
    const fnEnd = source.indexOf('/** Start the scheduler daemon', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = source.slice(fnStart, fnEnd);

    // Post-#1667: the boot probe must match the connection probe so a host
    // running pgserve in foreground TCP mode (no canonical daemon UDS) gets
    // the correct "ready on tcp" banner instead of the misleading
    // "pgserve unreachable" warning the old `requirePgserveDaemon` printed.
    expect(body).toContain('resolvePgserveTransport');
    // Legacy hard-fail-on-UDS-only API must be gone from the boot path.
    expect(body).not.toContain('requirePgserveDaemon');
    // Legacy embedded TCP-router fallback and spawn-bound port banner stay
    // gone (canonical-cutover regression locks).
    expect(body).not.toContain('ensurePgserve');
    expect(body).not.toContain('getOrStartDaemon');
    expect(body).not.toContain('pgserve ready on port');
    // Registry hook stays — observability tools still want to know which
    // serve is talking to pgserve.
    expect(body).toContain("registerService('pgserve-owner'");
  });

  test('boot probe branches on transport.kind for the ready banner', () => {
    // Both transports must produce a ready banner (UDS-style vs TCP-style)
    // so operators see the truth on hosts where only TCP is reachable.
    const source = readFileSync(join(__dirname, 'serve.ts'), 'utf-8');
    const fnStart = source.indexOf('async function requirePgserveReady');
    const fnEnd = source.indexOf('/** Start the scheduler daemon', fnStart);
    const body = source.slice(fnStart, fnEnd);

    expect(body).toContain("transport.kind === 'unix'");
    expect(body).toContain('socketDir');
    expect(body).toContain('.s.PGSQL.');
    expect(body).toContain('tcp');
  });

  test('boot probe disables in-process pgserve retries after startup failure', () => {
    const source = readFileSync(join(__dirname, 'serve.ts'), 'utf-8');
    const fnStart = source.indexOf('async function requirePgserveReady');
    expect(fnStart).toBeGreaterThan(-1);
    const catchStart = source.indexOf('} catch (err) {', fnStart);
    const retryGuard = source.indexOf("process.env.GENIE_PG_NO_AUTOSTART = '1'", catchStart);
    expect(catchStart).toBeGreaterThan(-1);
    expect(retryGuard).toBeGreaterThan(-1);
  });
});

describe('brain startup integration', () => {
  function makeVault(root: string, name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'brain.json'), '{}', 'utf-8');
    return realpathSync(path);
  }

  function makeDir(root: string, name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return realpathSync(path);
  }

  async function eventually(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  test('skips brain import and startup when brain.embedded=false', async () => {
    const importBrain = mock(async () => {
      throw new Error('brain should not be imported');
    });
    const logs: string[] = [];
    const warnings: string[] = [];
    const log = mock((message: string) => logs.push(message));
    const warn = mock((message: string) => warnings.push(message));
    const setBrainHandles = mock(() => {});

    const result = await startBrainServerIfEnabled({
      loadConfig: () => ({ brain: { embedded: false } }),
      importBrain,
      getActivePort: () => 19642,
      log,
      warn,
      setBrainHandles,
    });

    expect(result).toEqual([]);
    expect(importBrain.mock.calls.length).toBe(0);
    expect(setBrainHandles.mock.calls.length).toBe(0);
    expect(logs[0]).toContain('brain.embedded=false');
    expect(warnings.length).toBe(0);
  });

  test('warns when registry reports more brains than were started', async () => {
    const root = join(tmpdir(), `genie-serve-brain-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const valid = makeVault(root, 'valid');
    const missing = makeDir(root, 'missing');
    const stop = mock(async () => {});
    const startEmbeddedBrainServer = mock(async () => ({ port: 4801, stop }));
    const warnings: string[] = [];
    const warn = mock((message: string) => warnings.push(message));

    try {
      const result = await startBrainServerIfEnabled({
        loadConfig: () => ({ brain: { embedded: true } }),
        importBrain: async () => ({
          listBrains: mock(async () => [{ homePath: valid }, { homePath: missing }]),
          startEmbeddedBrainServer,
        }),
        getActivePort: () => 19642,
        log: mock(() => {}),
        warn,
        setBrainHandles: mock(() => {}),
      });

      expect(result.map((handle) => handle.brainPath)).toEqual([realpathSync(valid)]);
      expect(startEmbeddedBrainServer.mock.calls.length).toBe(1);
      expect(warnings.some((message) => message.includes(`skipped registered vault ${realpathSync(missing)}`))).toBe(
        true,
      );
      expect(warnings.some((message) => message.includes('registry drift: started 1/2'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports a standalone brain binary as installed even when no server is running', async () => {
    const logs: string[] = [];

    const handled = await printStandaloneBrainStatus({
      readActiveConfig: () => null,
      getStandaloneVersion: () => '1.64.0',
      log: (message: string) => logs.push(message),
    });

    expect(handled).toBe(true);
    expect(logs).toEqual(['  brain:      installed standalone (1.64.0, server not running)']);
  });

  test('schedules a later brain vault while an earlier start is pending', async () => {
    const root = join(tmpdir(), `genie-serve-brain-parallel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const first = makeVault(root, 'first');
    const second = makeVault(root, 'second');
    const stop = mock(async () => {});
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const startEmbeddedBrainServer = mock(({ brainPath }: { brainPath: string }) => {
      started.push(brainPath);
      if (brainPath === first) {
        return new Promise<{ port: number; stop: () => Promise<void> }>((resolve) => {
          releaseFirst = () => resolve({ port: 4901, stop });
        });
      }
      return Promise.resolve({ port: 4902, stop });
    });

    try {
      const pending = startBrainServerIfEnabled({
        loadConfig: () => ({ brain: { embedded: true } }),
        importBrain: async () => ({
          listBrains: mock(async () => [{ homePath: first }, { homePath: second }]),
          startEmbeddedBrainServer,
        }),
        getActivePort: () => 19642,
        log: mock(() => {}),
        warn: mock(() => {}),
        setBrainHandles: mock(() => {}),
      });

      await eventually(() => startEmbeddedBrainServer.mock.calls.length >= 2);
      expect(started).toEqual([realpathSync(first), realpathSync(second)]);

      releaseFirst?.();
      const result = await pending;
      expect(result.map((handle) => handle.brainPath)).toEqual([realpathSync(first), realpathSync(second)]);
    } finally {
      releaseFirst?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Lifecycle tests: bridge failure + shutdown
//
// These spawn the real CLI (`bun src/genie.ts serve start --foreground --headless`)
// as a child process against a refused NATS URL. The child inherits the test
// pgserve via GENIE_TEST_PG_PORT so it doesn't touch the user's real data.
// ============================================================================

const GENIE_ENTRY = resolve(__dirname, '..', 'genie.ts');
const BUN_PATH = process.execPath;

let testDir: string;
let genieHome: string;
let child: ChildProcess | null = null;

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until `predicate` returns true or the deadline elapses.
 * Returns true if predicate ever returned true, false on timeout.
 */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await waitFor(pollMs);
  }
  return false;
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface SpawnResult {
  child: ChildProcess;
  stdout: { buffer: string };
  stderr: { buffer: string };
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnServe(env: Record<string, string | undefined>): SpawnResult {
  const stdout = { buffer: '' };
  const stderr = { buffer: '' };

  // Strip keys whose value is `undefined` so they don't become the literal
  // string "undefined" in the child env.
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') mergedEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete mergedEnv[k];
    } else {
      mergedEnv[k] = v;
    }
  }

  const proc = spawn(BUN_PATH, [GENIE_ENTRY, 'serve', 'start', '--foreground', '--headless'], {
    env: mergedEnv,
    cwd: testDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdout.buffer += chunk.toString('utf-8');
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr.buffer += chunk.toString('utf-8');
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return { child: proc, stdout, stderr, exit };
}

beforeEach(() => {
  testDir = join(tmpdir(), `genie-serve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  genieHome = join(testDir, '.genie');
  mkdirSync(genieHome, { recursive: true });
  // Mark this tmp dir as a workspace so `ensureWorkspace()` doesn't abort
  // with "No workspace found" in hermetic environments (CI) where no
  // ancestor .genie/workspace.json exists.
  writeFileSync(join(genieHome, 'workspace.json'), '{"name":"test","tmuxSocket":"genie"}');
  child = null;
});

afterEach(async () => {
  if (child && isAlive(child.pid)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already dead
    }
    // Give the OS a moment to reap
    await waitFor(100);
  }
  child = null;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('serve lifecycle — bridge failure + shutdown', () => {
  test('survives bridge failure when GENIE_OMNI_REQUIRED is unset', async () => {
    const result = spawnServe({
      GENIE_HOME: genieHome,
      GENIE_NATS_URL: 'nats://127.0.0.1:1',
      // Do NOT set GENIE_OMNI_REQUIRED — degraded mode should be the default.
      GENIE_OMNI_REQUIRED: undefined,
      // Bypass `ensureServeReady` — this test exercises the post-precondition
      // bridge/shutdown lifecycle, not the precondition orchestrator.
      GENIE_SKIP_PRECONDITIONS: '1',
    });
    child = result.child;

    // Wait for the serve process to settle: PID file should exist and process
    // should still be alive after 3 seconds despite the bridge failure.
    const pidPath = join(genieHome, 'serve.pid');
    const started = await waitUntil(() => existsSync(pidPath), 10_000);
    expect(started).toBe(true);

    // Hold for 3 seconds — if the bridge failure were fatal, the process
    // would have exited long before this.
    await waitFor(3_000);
    expect(isAlive(result.child.pid)).toBe(true);

    // stderr or stdout must mention degradation, not a FAILED hard error.
    const combined = `${result.stdout.buffer}\n${result.stderr.buffer}`;
    expect(combined).toContain('Omni bridge: degraded');
    expect(combined).toContain('GENIE_OMNI_REQUIRED=1');

    // Clean shutdown via SIGTERM: PID file should be removed and a
    // daemon_stopped event should be flushed to scheduler.log.
    result.child.kill('SIGTERM');
    const exitInfo = await Promise.race([
      result.exit,
      waitFor(10_000).then(() => ({ code: null, signal: null as NodeJS.Signals | null })),
    ]);
    expect(exitInfo.code !== null || exitInfo.signal !== null).toBe(true);

    // PID file gone after shutdown
    expect(existsSync(pidPath)).toBe(false);

    // Scheduler log must contain a daemon_stopped event.
    const logPath = join(genieHome, 'logs', 'scheduler.log');
    expect(existsSync(logPath)).toBe(true);
    const logContents = readFileSync(logPath, 'utf-8');
    expect(logContents).toContain('"event":"daemon_stopped"');
  }, 30_000);

  test('exits non-zero on bridge failure when GENIE_OMNI_REQUIRED=1', async () => {
    const result = spawnServe({
      GENIE_HOME: genieHome,
      GENIE_NATS_URL: 'nats://127.0.0.1:1',
      GENIE_OMNI_REQUIRED: '1',
      GENIE_SKIP_PRECONDITIONS: '1',
    });
    child = result.child;

    const exitInfo = await Promise.race([result.exit, waitFor(20_000).then(() => null)]);
    expect(exitInfo).not.toBeNull();
    if (!exitInfo) return; // satisfy TS narrowing
    expect(exitInfo.code).not.toBe(0);

    const combined = `${result.stdout.buffer}\n${result.stderr.buffer}`;
    // Strict mode uses the old FAILED messaging
    expect(combined).toContain('Omni bridge: FAILED');
    expect(combined).not.toContain('Omni bridge: degraded');
  }, 30_000);
});

// ============================================================================
// Stopping sentinel — Defect 1 (autoStartServe cascade)
//
// `serve stop` writes ~/.genie/serve.stopping.lock before SIGTERM. While the
// lock is active, autoStartServe must refuse to spawn a new daemon — even
// when isServeRunning() is false. The lock has a TTL so a crashed stop
// cannot brick autostart.
// ============================================================================

describe('stopping sentinel', () => {
  let originalGenieHome: string | undefined;

  beforeEach(() => {
    originalGenieHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = genieHome;
  });

  afterEach(() => {
    if (originalGenieHome === undefined) {
      // Assigning `undefined` would store the literal string "undefined" in
      // process.env (Node coerces env values to strings); `delete` is the
      // only way to fully remove the variable.
      // biome-ignore lint/performance/noDelete: env vars must actually be removed
      delete process.env.GENIE_HOME;
    } else {
      process.env.GENIE_HOME = originalGenieHome;
    }
  });

  test('writeStoppingLockSync creates a non-empty sentinel that isStoppingLockActive recognises', () => {
    expect(isStoppingLockActive()).toBe(false);
    writeStoppingLockSync();
    expect(existsSync(join(genieHome, 'serve.stopping.lock'))).toBe(true);
    expect(isStoppingLockActive()).toBe(true);
    clearStoppingLock();
    expect(existsSync(join(genieHome, 'serve.stopping.lock'))).toBe(false);
    expect(isStoppingLockActive()).toBe(false);
  });

  test('expired lock is treated as absent and cleaned up', () => {
    // Negative TTL → expiry timestamp is in the past.
    writeStoppingLockSync(-1_000);
    expect(existsSync(join(genieHome, 'serve.stopping.lock'))).toBe(true);
    expect(isStoppingLockActive()).toBe(false);
    // isStoppingLockActive removes the corrupt/expired file.
    expect(existsSync(join(genieHome, 'serve.stopping.lock'))).toBe(false);
  });

  test('corrupt sentinel content is treated as expired and removed', () => {
    mkdirSync(genieHome, { recursive: true });
    writeFileSync(join(genieHome, 'serve.stopping.lock'), 'not-a-number', 'utf-8');
    expect(isStoppingLockActive()).toBe(false);
    expect(existsSync(join(genieHome, 'serve.stopping.lock'))).toBe(false);
  });

  test('autoStartServe returns immediately while sentinel is active and never writes a PID file', async () => {
    writeStoppingLockSync();
    const before = Date.now();
    await autoStartServe();
    const elapsed = Date.now() - before;
    // Must short-circuit; the spawn-and-poll path takes >=500 ms even on the
    // happy path. < 200 ms is well below that threshold.
    expect(elapsed).toBeLessThan(200);
    // No PID file means we did not spawn the daemon.
    expect(existsSync(join(genieHome, 'serve.pid'))).toBe(false);
    clearStoppingLock();
  });
});

describe('serve boot precondition ordering', () => {
  test('marks foreground serve as daemon before running preconditions', () => {
    const source = readFileSync(resolve(__dirname, 'serve.ts'), 'utf-8');
    const startIdx = source.indexOf('async function startForeground');
    const endIdx = source.indexOf('async function startBackground', startIdx);
    const startForegroundSource = source.slice(startIdx, endIdx);

    const daemonMarkerIdx = startForegroundSource.indexOf("process.env.GENIE_IS_DAEMON = '1'");
    const preconditionsIdx = startForegroundSource.indexOf('await runStartPreconditions(autoFix');

    expect(daemonMarkerIdx).toBeGreaterThanOrEqual(0);
    expect(preconditionsIdx).toBeGreaterThanOrEqual(0);
    expect(daemonMarkerIdx).toBeLessThan(preconditionsIdx);
  });

  test('daemon no-fix waits for child startup status before reporting success', () => {
    const source = readFileSync(resolve(__dirname, 'serve.ts'), 'utf-8');
    const startIdx = source.indexOf('async function startBackground');
    const endIdx = source.indexOf('/** Unlink serve.pid', startIdx);
    const startBackgroundSource = source.slice(startIdx, endIdx);

    expect(startBackgroundSource).toContain('GENIE_SERVE_STARTUP_STATUS');
    expect(startBackgroundSource).toContain('await confirmBackgroundStarted');
    expect(source).toContain('await waitForStartupStatus');
    expect(source).toContain('status?.ok === false');
  });
});

// ============================================================================
// Atomic PID claim — Defect 2 (claimServePidOrExit race)
//
// Two parallel `genie serve --foreground --headless` processes used to both
// pass the pre-write isProcessAlive check and stomp serve.pid. With
// O_EXCL-based claim, exactly one survives — the other prints "already
// running" and exits 0.
// ============================================================================

describe('atomic PID claim', () => {
  test('two parallel serves resolve to exactly one survivor', async () => {
    const r1 = spawnServe({
      GENIE_HOME: genieHome,
      GENIE_NATS_URL: 'nats://127.0.0.1:1',
      GENIE_OMNI_REQUIRED: undefined,
    });
    const r2 = spawnServe({
      GENIE_HOME: genieHome,
      GENIE_NATS_URL: 'nats://127.0.0.1:1',
      GENIE_OMNI_REQUIRED: undefined,
    });

    // Track both children for afterEach cleanup. We can only assign `child`
    // once — kill r2 manually if it's still alive.
    child = r1.child;

    const pidPath = join(genieHome, 'serve.pid');
    const settled = await waitUntil(async () => {
      if (!existsSync(pidPath)) return false;
      // One process exited (the loser) AND the other is still alive.
      const r1Exited = !isAlive(r1.child.pid);
      const r2Exited = !isAlive(r2.child.pid);
      return r1Exited !== r2Exited;
    }, 15_000);
    expect(settled).toBe(true);

    const pidContents = readFileSync(pidPath, 'utf-8').trim();
    const survivorPid = Number.parseInt(pidContents.split(':')[0], 10);
    const survivor = isAlive(r1.child.pid) ? r1 : r2;
    const loser = survivor === r1 ? r2 : r1;
    expect(survivorPid).toBe(survivor.child.pid as number);

    // Loser exited 0 with the "already running" message.
    const loserExit = await Promise.race([loser.exit, waitFor(5_000).then(() => null)]);
    expect(loserExit?.code).toBe(0);
    expect(`${loser.stdout.buffer}\n${loser.stderr.buffer}`).toContain('already running');

    // Cleanup: SIGKILL the survivor so afterEach doesn't have to wait for
    // graceful shutdown of the slow scheduler.
    try {
      survivor.child.kill('SIGKILL');
    } catch {
      // already gone
    }
    await Promise.race([survivor.exit, waitFor(5_000)]);
  }, 30_000);
});

// ============================================================================
// pgserve v1/v2 coexistence
//
// pgserve@1.2.0 is the final v1 line and uses TCP/port lockfiles. pgserve v2
// is portless. New serve startup must not delete legacy v1 artifacts unless
// the operator explicitly forces legacy TCP mode.
// ============================================================================

describe('pgserve v1/v2 coexistence', () => {
  test('serve only removes the legacy pgserve.port file when legacy TCP is forced', () => {
    const source = readFileSync(join(__dirname, 'serve.ts'), 'utf-8');
    const helperStart = source.indexOf('function removeLegacyPgservePortLockfileIfForcedTcp');
    expect(helperStart).toBeGreaterThan(-1);
    const helperEnd = source.indexOf('\n}\n', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);

    expect(helperBody).toContain("process.env.GENIE_PG_FORCE_TCP !== '1'");
    expect(helperBody).toContain("join(genieHome(), 'pgserve.port')");

    const startForeground = source.slice(source.indexOf('async function startForeground'));
    expect(startForeground).toContain('removeLegacyPgservePortLockfileIfForcedTcp();');
    expect(startForeground).not.toContain('removePgservePortLockfile();');
  });
});

// ============================================================================
// startTuiTmuxServer — regression tests for the silent-fall-through bug
//
// The function used to wrap `has-session` + repair branch in a single
// `try { ... } catch {}`, so any failure inside the repair branch fell
// through to `new-session -d -s genie-tui` and crashed with the opaque
// "duplicate session: genie-tui" / `output: [null, null, null]` error.
//
// G1 split the probe from the repair branch and added a kill-session +
// fresh-create recovery path with forensic logging. These tests lock in
// every reachable state.
//
// Mocking strategy: the file-level `mock.module('node:child_process', ...)`
// intercepts only commands targeting the `-L genie-tui` socket while the
// per-test handler is set; everything else falls through to the real
// child_process module.
// ============================================================================

describe('startTuiTmuxServer', () => {
  let tuiHome: string;
  let originalGenieHome: string | undefined;

  beforeEach(() => {
    originalGenieHome = process.env.GENIE_HOME;
    tuiHome = mkdtempSync(join(tmpdir(), 'genie-tui-server-'));
    process.env.GENIE_HOME = tuiHome;
  });

  afterEach(() => {
    setExecSyncHandler(null);
    if (originalGenieHome === undefined) {
      // biome-ignore lint/performance/noDelete: env vars must actually be removed
      delete process.env.GENIE_HOME;
    } else {
      process.env.GENIE_HOME = originalGenieHome;
    }
    try {
      rmSync(tuiHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /**
   * Build a recording handler whose `responder` decides — per matching tmux
   * subcommand — what to return (or throw). Calls to non-tui-tmux commands
   * never reach here because the file-level mock filters them out.
   */
  function recordHandler(
    responder: (cmd: string) => { value?: string; error?: { stderr: string; message?: string } },
  ): { handler: ExecSyncHandler; calls: string[] } {
    const calls: string[] = [];
    const handler: ExecSyncHandler = (cmd) => {
      calls.push(cmd);
      const out = responder(cmd);
      if (out.error) {
        // Mimic Bun/node execSync error shape: `.stderr` is a Buffer, but a
        // string also satisfies runTuiTmuxCapturing's `.toString('utf-8')`
        // path because that method only fires on Buffer.
        const err = new Error(out.error.message ?? `Command failed: ${cmd}`) as Error & {
          stderr?: string;
          stdout?: string;
        };
        err.stderr = out.error.stderr;
        err.stdout = '';
        throw err;
      }
      return out.value ?? '';
    };
    return { handler, calls };
  }

  test('(a) session exists with 2 panes — returns early, no new-session', () => {
    const { handler, calls } = recordHandler((cmd) => {
      if (cmd.includes('has-session')) return { value: '' };
      if (cmd.includes('list-panes')) return { value: '%0\n%1' };
      if (cmd.includes('respawn-pane')) return { value: '' };
      // Any tui-tmux command we didn't anticipate → empty no-op
      return { value: '' };
    });
    setExecSyncHandler(handler);

    const result = startTuiTmuxServer();

    expect(result).toEqual({ leftPane: '%0', rightPane: '%1' });
    expect(calls.some((c) => c.includes('new-session'))).toBe(false);
    expect(calls.some((c) => c.includes('split-window'))).toBe(false);
    expect(calls.some((c) => c.includes('has-session'))).toBe(true);
    expect(calls.some((c) => c.includes('respawn-pane'))).toBe(true);
  });

  test('(b) session exists with 1 pane — split-window invoked once, no new-session', () => {
    let listPanesCallCount = 0;
    const { handler, calls } = recordHandler((cmd) => {
      if (cmd.includes('has-session')) return { value: '' };
      if (cmd.includes('list-panes')) {
        listPanesCallCount += 1;
        // First call sees only %0; after split, second call sees both panes.
        return { value: listPanesCallCount === 1 ? '%0' : '%0\n%2' };
      }
      if (cmd.includes('display-message')) return { value: '120' };
      if (cmd.includes('split-window')) return { value: '' };
      return { value: '' };
    });
    setExecSyncHandler(handler);

    const result = startTuiTmuxServer();

    expect(result.leftPane).toBe('%0');
    expect(result.rightPane).toBe('%2');
    const splitCalls = calls.filter((c) => c.includes('split-window'));
    expect(splitCalls.length).toBe(1);
    expect(calls.some((c) => c.includes('new-session'))).toBe(false);
  });

  test('(c) has-session fails — fresh new-session + split-window each called once', () => {
    const { handler, calls } = recordHandler((cmd) => {
      if (cmd.includes('has-session')) {
        return { error: { stderr: "can't find session: genie-tui", message: 'has-session failed' } };
      }
      if (cmd.includes('new-session')) return { value: '' };
      if (cmd.includes('split-window')) return { value: '' };
      if (cmd.includes('list-panes')) return { value: '%0\n%1' };
      return { value: '' };
    });
    setExecSyncHandler(handler);

    const result = startTuiTmuxServer();

    expect(result).toEqual({ leftPane: '%0', rightPane: '%1' });
    const newSessionCalls = calls.filter((c) => c.includes('new-session'));
    const splitCalls = calls.filter((c) => c.includes('split-window'));
    expect(newSessionCalls.length).toBe(1);
    expect(splitCalls.length).toBe(1);
  });

  test('(d) repair branch throws — kill-session + fresh-create + crash log written', () => {
    const repairFailureStderr = "can't find window";
    let listPanesCallCount = 0;
    let splitWindowCallCount = 0;
    // 1st split-window is the repair-branch attempt → throw to trigger
    // the recovery path. 2nd split-window comes from freshCreate after
    // kill-session, and must succeed.
    const handleSplitWindow = () => {
      splitWindowCallCount += 1;
      return splitWindowCallCount === 1
        ? { error: { stderr: repairFailureStderr, message: 'Command failed' } }
        : { value: '' };
    };
    const { handler, calls } = recordHandler((cmd) => {
      if (cmd.includes('list-panes')) {
        listPanesCallCount += 1;
        // 1st call: 1-pane state triggers repair branch.
        // 2nd call (after kill + fresh new-session + split-window): 2 panes.
        return { value: listPanesCallCount === 1 ? '%0' : '%0\n%1' };
      }
      if (cmd.includes('display-message')) return { value: '120' };
      if (cmd.includes('split-window')) return handleSplitWindow();
      return { value: '' };
    });
    setExecSyncHandler(handler);

    const result = startTuiTmuxServer();

    expect(result).toEqual({ leftPane: '%0', rightPane: '%1' });
    const killSessionCalls = calls.filter((c) => c.includes('kill-session'));
    expect(killSessionCalls.length).toBe(1);

    // Verify ordering: kill-session must come before new-session.
    const killIdx = calls.findIndex((c) => c.includes('kill-session'));
    const newIdx = calls.findIndex((c) => c.includes('new-session'));
    expect(killIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(killIdx);

    const newSessionCalls = calls.filter((c) => c.includes('new-session'));
    expect(newSessionCalls.length).toBe(1);

    // Forensic log written with prefix + the original tmux stderr message.
    const crashLogPath = join(tuiHome, 'logs', 'tui-crash.log');
    expect(existsSync(crashLogPath)).toBe(true);
    const logContents = readFileSync(crashLogPath, 'utf-8');
    const lines = logContents.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain('[startTuiTmuxServer]');
    expect(lastLine).toContain(repairFailureStderr);
  });
});
