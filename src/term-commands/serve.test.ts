import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getTuiKeybindings, getTuiQuitBindingArgs } from './serve.js';

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
