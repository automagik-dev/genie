import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../src/lib/v5/genie-db.js';
import { claimTask, createBoard, createTask } from '../../src/lib/v5/task-state.js';
import {
  type CodexAppServerPin,
  CodexNativeMcpEvidenceError,
  captureCodexNativeMcpEvidence,
  captureCodexNativeMcpEvidenceForDogfood,
  probeCodexAppServer,
} from '../support/codex-native-mcp-evidence.js';

const TEST_TIMEOUT = 60_000;
const root = mkdtempSync(join(tmpdir(), 'genie-real-native-mcp-'));
const launcher = fileURLToPath(new URL('../support/codex-native-mcp-launcher.sh', import.meta.url));
const candidate = fileURLToPath(new URL('../../src/genie.ts', import.meta.url));

function isolatedEnv(name: string): NodeJS.ProcessEnv {
  const base = join(root, name);
  const home = join(base, 'home');
  const codexHome = join(base, 'codex-home');
  const genieHome = join(base, 'genie-home');
  const temp = join(base, 'tmp');
  for (const path of [home, codexHome, genieHome, temp]) mkdirSync(path, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    GENIE_HOME: genieHome,
    TMPDIR: temp,
    NO_COLOR: '1',
    RUST_LOG: 'error',
    OPENAI_API_KEY: undefined,
  };
}

function resolvePin(): CodexAppServerPin {
  const executable = process.env.GENIE_DOGFOOD_REAL_CODEX ?? Bun.which('codex') ?? '/codex-unavailable';
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    env: process.env,
    timeout: 5_000,
  });
  return {
    executable,
    version: result.status === 0 && result.stdout.trim() ? result.stdout.trim() : 'codex-unavailable',
  };
}

function initRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  const result = spawnSync('git', ['init', '-q', '-b', 'main'], {
    cwd: repo,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`git init failed: ${result.stderr}`);
  return repo;
}

function seedRepo(
  repo: string,
  label: string,
): {
  token: string;
  task: { id: string; title: string; wish: string; status: string; claimedBy: string };
} {
  const token = randomBytes(20).toString('hex');
  const wish = `native-${label}-${token}`;
  const title = `task-${label}-${token}`;
  const claimedBy = `native-worker-${label}-${token}`;
  const db = openDb({ cwd: repo });
  try {
    const board = createBoard(db, 'repo');
    const task = createTask(db, { title, boardId: board.id, wish, group: 'evidence' });
    const claimed = claimTask(db, task.id, claimedBy);
    return {
      token,
      task: {
        id: claimed.id,
        title: claimed.title,
        wish: claimed.wish as string,
        status: claimed.status,
        claimedBy: claimed.claimedBy as string,
      },
    };
  } finally {
    db.close();
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const pin = resolvePin();
const probeEnv = isolatedEnv('probe');
const support = await probeCodexAppServer(pin, probeEnv);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test('reports whether the real pinned Codex app-server is available without a model request', () => {
  expect(typeof support.reason).toBe('string');
  if (!support.supported) {
    expect(`real-codex-unavailable: ${support.reason}`).toContain('real-codex-unavailable');
  }
});

describe.skipIf(!support.supported)('real Codex app-server native MCP evidence', () => {
  test(
    'exact adapter+candidate returns one claimed sentinel and equals command/exec cwd by string and dev:ino',
    async () => {
      const repo = initRepo('seeded');
      const expectedSentinel = seedRepo(repo, 'a');
      const evidence = await captureCodexNativeMcpEvidence({
        codex: pin,
        requestedCwd: repo,
        candidate: { executable: candidate, adapter: process.execPath, args: ['mcp'] },
        launcherExecutable: launcher,
        controlExecutable: process.execPath,
        env: isolatedEnv('seeded-env'),
        expectedSentinel,
      });

      expect(evidence.rawRequestedCwd).toBe(repo);
      expect(evidence.launcher.effectiveCwd).toBe(evidence.control.effectiveCwd);
      expect(evidence.launcher.cwdIdentity).toBe(evidence.control.cwdIdentity);
      expect(evidence.launcher.pid).toBeGreaterThan(0);
      expect(evidence.threadId).not.toBeEmpty();
      expect(evidence.toolResponse.isError).not.toBe(true);
      expect(evidence.outcome.kind).toBe('sentinel');
      expect((evidence.toolPayload.tasks as Array<Record<string, unknown>>)[0]?.claimedBy).toBe(
        expectedSentinel.task.claimedBy,
      );
    },
    TEST_TIMEOUT,
  );

  test(
    'untouched repository passes only through typed project-database-unavailable without tasks/counts',
    async () => {
      const repo = initRepo('untouched');
      const evidence = await captureCodexNativeMcpEvidence({
        codex: pin,
        requestedCwd: repo,
        candidate: { executable: candidate, adapter: process.execPath, args: ['mcp'] },
        launcherExecutable: launcher,
        controlExecutable: process.execPath,
        env: isolatedEnv('untouched-env'),
        expectedError: 'project-database-unavailable',
      });

      expect(evidence.toolResponse.isError).toBe(true);
      expect(evidence.toolPayload.error).toBe('project-database-unavailable');
      expect(evidence.toolPayload).not.toHaveProperty('tasks');
      expect(evidence.toolPayload).not.toHaveProperty('counts');
      expect(evidence.outcome.kind).toBe('expected-error');
    },
    TEST_TIMEOUT,
  );

  test(
    'dogfood adapter derives the claimed sentinel and retains the complete raw capture',
    async () => {
      const repo = initRepo('dogfood-adapter');
      const expected = seedRepo(repo, 'adapter');
      mkdirSync(join(repo, '.codex'));
      writeFileSync(
        join(repo, '.codex', 'config.toml'),
        `[mcp_servers.genie]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", "process.exit(77)"]\n`,
      );
      const env = isolatedEnv('dogfood-adapter-env') as Record<string, string>;
      const observed = await captureCodexNativeMcpEvidenceForDogfood({
        tag: 'a-new-thread',
        requestedCwd: repo,
        candidateBinary: candidate,
        candidateBinarySha256: createHash('sha256').update(readFileSync(candidate)).digest('hex'),
        executionAdapter: process.execPath,
        root,
        env,
      });

      expect(observed.isError).toBe(false);
      expect(observed.effectiveCwd).toBe(observed.controlCwd);
      expect(observed.cwdIdentity).toBe(observed.controlCwdIdentity);
      expect((observed.payload.tasks as Array<Record<string, unknown>>)[0]?.claimedBy).toBe(expected.task.claimedBy);
      expect(observed.raw).toHaveProperty('codex');
      expect(observed.raw).toHaveProperty('launcher');
      expect(observed.raw).toHaveProperty('toolResponse');
      expect(observed.raw).toHaveProperty('control');
    },
    TEST_TIMEOUT,
  );

  test(
    'a candidate that only advertises genie_board capability cannot produce passing sentinel evidence',
    async () => {
      const repo = initRepo('capability-only-repo');
      const expectedSentinel = seedRepo(repo, 'capability');
      const env = isolatedEnv('capability-env');
      const candidatePidFile = join(root, 'capability.pid');
      const capabilityOnly = join(root, 'capability-only.mjs');
      writeFileSync(
        capabilityOnly,
        `import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(process.argv.at(-1), String(process.pid));
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    const result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'capability-only', version: '1' } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  } else if (message.method === 'tools/list') {
    const tools = [{ name: 'genie_board', description: 'advertised only', inputSchema: { type: 'object', properties: {} } }];
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }) + '\\n');
  } else if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [], isError: false } }) + '\\n');
  } else if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1 << 30);
`,
        'utf8',
      );
      chmodSync(capabilityOnly, 0o755);

      let failure: unknown;
      try {
        await captureCodexNativeMcpEvidence({
          codex: pin,
          requestedCwd: repo,
          candidate: { executable: capabilityOnly, adapter: process.execPath, args: ['mcp', candidatePidFile] },
          launcherExecutable: launcher,
          controlExecutable: process.execPath,
          env,
          expectedSentinel,
          timeouts: { toolCallMs: 300, cleanupGraceMs: 250 },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CodexNativeMcpEvidenceError);
      expect((failure as CodexNativeMcpEvidenceError).code).toBe('mcp-tool-failure');
      const candidatePid = Number(readFileSync(candidatePidFile, 'utf8'));
      const deadline = Date.now() + 2_000;
      while (processExists(candidatePid) && Date.now() < deadline) await Bun.sleep(20);
      expect(processExists(candidatePid)).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
