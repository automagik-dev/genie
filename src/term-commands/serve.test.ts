import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  autoStartServe,
  clearStoppingLock,
  getTuiKeybindings,
  getTuiQuitBindingArgs,
  isStoppingLockActive,
  startBrainServerIfEnabled,
  writeStoppingLockSync,
} from './serve.js';

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

describe('brain startup integration', () => {
  function makeVault(root: string, name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'brain.json'), '{}', 'utf-8');
    return path;
  }

  function makeDir(root: string, name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
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

      expect(result.map((handle) => handle.brainPath)).toEqual([valid]);
      expect(startEmbeddedBrainServer.mock.calls.length).toBe(1);
      expect(warnings.some((message) => message.includes(`skipped registered vault ${missing}`))).toBe(true);
      expect(warnings.some((message) => message.includes('registry drift: started 1/2'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      expect(started).toEqual([first, second]);

      releaseFirst?.();
      const result = await pending;
      expect(result.map((handle) => handle.brainPath)).toEqual([first, second]);
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
// Stale pgserve.port invalidation — Defect 3
//
// An unclean prior shutdown leaves ~/.genie/pgserve.port pointing at a dead
// port. startForeground() must remove that lockfile before pgserve is
// brought up, so cached callers don't ECONNREFUSED forever.
// ============================================================================

describe('pgserve port lockfile invalidation', () => {
  test('startForeground removes a pre-existing pgserve.port at boot', async () => {
    // Seed a stale lockfile pointing at an unused port.
    const stalePortPath = join(genieHome, 'pgserve.port');
    writeFileSync(stalePortPath, '19642', 'utf-8');
    expect(readFileSync(stalePortPath, 'utf-8').trim()).toBe('19642');

    const result = spawnServe({
      GENIE_HOME: genieHome,
      GENIE_NATS_URL: 'nats://127.0.0.1:1',
      GENIE_OMNI_REQUIRED: undefined,
    });
    child = result.child;

    // Wait until the stale value is gone (either deleted or rewritten by
    // ensurePgserve to the new live port).
    const cleared = await waitUntil(() => {
      if (!existsSync(stalePortPath)) return true;
      const current = readFileSync(stalePortPath, 'utf-8').trim();
      return current !== '19642' && current !== '';
    }, 15_000);
    expect(cleared).toBe(true);

    result.child.kill('SIGKILL');
    await Promise.race([result.exit, waitFor(5_000)]);
  }, 30_000);
});
