import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CodexNativeMcpEvidenceError,
  type NativeMcpTaskSentinel,
  assertUniqueBoardSentinel,
  captureCodexNativeMcpEvidence,
} from './codex-native-mcp-evidence.js';

const LAUNCHER = fileURLToPath(new URL('./codex-native-mcp-launcher.sh', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await Bun.sleep(20);
  }
}

const SENTINEL: NativeMcpTaskSentinel = {
  token: 'unique-77ab',
  task: {
    id: 't_unique-77ab',
    title: 'task unique-77ab',
    wish: 'wish-unique-77ab',
    status: 'ready',
  },
};

describe('assertUniqueBoardSentinel', () => {
  test('accepts one task with exact identity', () => {
    expect(
      assertUniqueBoardSentinel(
        {
          counts: { ready: 1 },
          tasks: [{ ...SENTINEL.task, unrelated: 'preserved' }],
        },
        SENTINEL,
      ),
    ).toEqual(SENTINEL);
  });

  for (const fixture of [
    { name: 'empty', tasks: [] },
    { name: 'duplicate', tasks: [SENTINEL.task, SENTINEL.task] },
    { name: 'cross-repository', tasks: [{ ...SENTINEL.task, id: 't_other' }] },
    { name: 'stale status', tasks: [{ ...SENTINEL.task, status: 'done' }] },
  ]) {
    test(`rejects ${fixture.name} task evidence`, () => {
      expect(() => assertUniqueBoardSentinel({ tasks: fixture.tasks }, SENTINEL)).toThrow(CodexNativeMcpEvidenceError);
    });
  }

  test('rejects a token not bound into the expected exact identity', () => {
    expect(() =>
      assertUniqueBoardSentinel(
        { tasks: [{ id: 't_1', title: 'task', wish: 'wish', status: 'ready' }] },
        { token: 'unbound-token', task: { id: 't_1', title: 'task', wish: 'wish', status: 'ready' } },
      ),
    ).toThrow('sentinel token must occur');
  });

  test('rejects a mismatched claimant when claimant identity is expected', () => {
    const expected = { ...SENTINEL, task: { ...SENTINEL.task, claimedBy: 'worker-a' } };
    expect(() => assertUniqueBoardSentinel({ tasks: [{ ...expected.task, claimedBy: 'worker-b' }] }, expected)).toThrow(
      'task sentinel differs',
    );
  });
});

test('launcher records exact target and preserves its PID through a native adapter exec', async () => {
  const root = makeRoot('genie-native-launcher-');
  const repo = join(root, 'repo');
  const record = join(root, 'record.bin');
  const candidatePidFile = join(root, 'candidate.pid');
  const candidate = join(root, 'candidate.mjs');
  Bun.write(
    candidate,
    `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv.at(-1), String(process.pid));`,
  );
  await Bun.write(join(root, '.keep'), '');
  await Bun.$`mkdir -p ${repo}`.quiet();

  const child = spawn(LAUNCHER, [record, process.execPath, candidate, candidatePidFile], {
    cwd: repo,
    env: process.env,
    stdio: 'ignore',
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  expect(exitCode).toBe(0);
  const fields = readFileSync(record).toString('utf8').split('\0').filter(Boolean);
  expect(fields[0]).toBe('codex-native-mcp-launcher-v1');
  expect(fields[1]).toBe(String(child.pid));
  expect(fields[2]).toBe(realpathSync(repo));
  expect(fields[3]).toMatch(/^\d+:\d+$/);
  expect(fields[4]).toBe(process.execPath);
  expect(fields[5]).toBe(candidate);
  expect(fields.slice(6)).toEqual([candidatePidFile]);
  expect(readFileSync(candidatePidFile, 'utf8')).toBe(String(child.pid));
});

test('RPC timeout TERM/KILLs an uncooperative app-server tree and removes the helper temp child', async () => {
  const root = makeRoot('genie-native-cleanup-');
  const codexHome = join(root, 'codex-home');
  const repo = join(root, 'repo');
  const helperTemp = join(root, 'helper-temp');
  const appPidFile = join(root, 'app.pid');
  const candidatePidFile = join(root, 'candidate.pid');
  const appSignalFile = join(root, 'app.signals');
  const candidateSignalFile = join(root, 'candidate.signals');
  await Bun.$`mkdir -p ${codexHome} ${repo} ${helperTemp}`.quiet();

  const fakeCodex = join(root, 'fake-codex.mjs');
  writeFileSync(
    fakeCodex,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli cleanup-test\\n');
  process.exit(0);
}
writeFileSync(process.env.APP_PID_FILE, String(process.pid));
process.on('SIGTERM', () => appendFileSync(process.env.APP_SIGNAL_FILE, 'TERM\\n'));
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }) + '\\n');
  } else if (message.method === 'thread/start') {
    const config = message.params.config.mcp_servers.genie;
    spawn(config.command, config.args, { cwd: message.params.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-cleanup' } } }) + '\\n');
  } else if (message.method === 'mcpServerStatus/list') {
    const result = { data: [{ name: 'genie', tools: { genie_board: {} } }], nextCursor: null };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
setInterval(() => {}, 1 << 30);
`,
    'utf8',
  );
  chmodSync(fakeCodex, 0o755);

  const candidate = join(root, 'capability-only.mjs');
  writeFileSync(
    candidate,
    `import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.CANDIDATE_PID_FILE, String(process.pid));
process.on('SIGTERM', () => appendFileSync(process.env.CANDIDATE_SIGNAL_FILE, 'TERM\\n'));
setInterval(() => {}, 1 << 30);
`,
    'utf8',
  );
  const env = {
    ...process.env,
    APP_PID_FILE: appPidFile,
    APP_SIGNAL_FILE: appSignalFile,
    CANDIDATE_PID_FILE: candidatePidFile,
    CANDIDATE_SIGNAL_FILE: candidateSignalFile,
    CODEX_HOME: codexHome,
  };

  let failure: unknown;
  try {
    await captureCodexNativeMcpEvidence({
      codex: { executable: fakeCodex, version: 'codex-cli cleanup-test' },
      requestedCwd: repo,
      candidate: { executable: candidate, adapter: process.execPath },
      launcherExecutable: LAUNCHER,
      controlExecutable: process.execPath,
      env,
      tempDir: helperTemp,
      expectedSentinel: SENTINEL,
      timeouts: {
        initializeMs: 1_000,
        threadStartMs: 1_000,
        launcherMs: 1_000,
        inventoryMs: 1_000,
        toolCallMs: 75,
        cleanupGraceMs: 100,
      },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CodexNativeMcpEvidenceError);
  expect((failure as CodexNativeMcpEvidenceError).code).toBe('rpc-timeout');
  const appPid = Number(readFileSync(appPidFile, 'utf8'));
  const candidatePid = Number(readFileSync(candidatePidFile, 'utf8'));
  await waitForExit(appPid);
  await waitForExit(candidatePid);
  expect(processExists(appPid)).toBe(false);
  expect(processExists(candidatePid)).toBe(false);
  expect(readFileSync(appSignalFile, 'utf8')).toContain('TERM');
  expect(readFileSync(candidateSignalFile, 'utf8')).toContain('TERM');
  expect(readdirSync(helperTemp).filter((entry) => entry.startsWith('genie-native-mcp-evidence-'))).toEqual([]);
  expect(existsSync(repo)).toBe(true);
  expect(existsSync(codexHome)).toBe(true);
});
