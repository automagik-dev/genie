/**
 * Group B keystone — the black-box app-server CWD proof (DAG gate for Groups A + D).
 *
 * Drives ONE pinned long-lived real `codex app-server` and proves, per Decision 4
 * and the Group B acceptance criteria, that the MCP server child Codex launches for
 * a thread (absolute command, NO cwd override) lands in the thread's EXACT effective
 * `process.cwd()` — equal to a Codex-launched control process by string AND OS
 * directory identity — for root, nested, symlink-normalized, and linked-worktree
 * layouts, plus sequential and concurrent two-repo threads with per-case raw
 * request + PID + effective CWD + tagged sentinel, no PID crossing differing
 * effective CWD, and no cache-root context. The raw `thread/start.cwd` lives ONLY
 * in `CodexCwdEvidence`; the production `CodexHostObservation` carries neither the
 * raw request nor any control-only field.
 *
 * The proof needs a real `codex` binary and a runnable app-server. When the
 * environment cannot host it, the suite reports the exact gate and skips rather
 * than faking a product surface.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HostCacheWitness, parseCodexHostObservation } from '../../src/lib/codex-host-observation.js';
import type { CommandResult } from '../../src/lib/runtime-integrations.js';
import { CodexCwdEvidence, type CwdCaseEvidence, findPidCrossingDifferingCwd } from '../support/codex-cwd-evidence.js';

const CASE_TIMEOUT = 60_000;
const HARNESS_ROOT_PREFIX = 'genie-cwd-evidence-';

type FakeAppServerMode =
  | 'success'
  | 'timeout'
  | 'reject'
  | 'early-exit'
  | 'spawn-error'
  | 'success-with-descendant'
  | 'timeout-with-descendant';

function makeFakeCodex(mode: FakeAppServerMode): { command: string; marker: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'genie-fake-codex-'));
  const command = join(root, 'codex.mjs');
  const marker = join(root, 'app-server.json');
  writeFileSync(
    command,
    `#!${process.execPath}
import { spawn } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const mode = ${JSON.stringify(mode)};
if (process.argv.includes('--version')) {
  if (mode === 'spawn-error') unlinkSync(fileURLToPath(import.meta.url));
  process.exit(0);
}
const marker = ${JSON.stringify(marker)};
const baseMode = mode.replace('-with-descendant', '');
let descendantPid;
if (mode.endsWith('-with-descendant')) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  descendantPid = descendant.pid;
  descendant.unref();
}
writeFileSync(marker, JSON.stringify({ pid: process.pid, descendantPid, root: dirname(process.env.CODEX_HOME) }));
if (baseMode === 'early-exit') process.exit(19);
if (baseMode === 'reject' || baseMode === 'success') {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      const response = baseMode === 'reject'
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'forced initialize rejection' } }
        : { jsonrpc: '2.0', id: message.id, result: { capabilities: {} } };
      process.stdout.write(JSON.stringify(response) + '\\n');
    }
  });
}
setInterval(() => {}, 1 << 30);
`,
    'utf8',
  );
  chmodSync(command, 0o755);
  return { command, marker, root };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

function harnessRoots(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith(HARNESS_ROOT_PREFIX)));
}

async function captureLaunchFailure(
  command: string,
  initializeTimeoutMs: number,
  beforeSpawnForTest?: (harnessRoot: string) => void,
): Promise<Error> {
  try {
    await CodexCwdEvidence.launch(command, initializeTimeoutMs, beforeSpawnForTest);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('fake Codex unexpectedly initialized');
}

// Launch ONE pinned app-server for the whole suite and decide support up-front, so
// an environment without a runnable codex app-server skips honestly.
let harness: CodexCwdEvidence | null = null;
let supportReason = 'not probed';
try {
  harness = await CodexCwdEvidence.launch();
  const probeDir = harness.makeRepo('probe', 'PROBE_TOKEN');
  const probe = await harness.startThreadCase('probe', probeDir);
  if (probe.sentinelToken !== 'PROBE_TOKEN') {
    supportReason = `MCP child did not land the thread cwd sentinel (got ${probe.sentinelToken})`;
    await harness.close();
    harness = null;
  } else {
    supportReason = 'ok';
  }
} catch (error) {
  supportReason = error instanceof Error ? error.message : String(error);
  await harness?.close();
  harness = null;
}
const supported = harness !== null;

afterAll(async () => {
  await harness?.close();
});

function dirIdentity(dir: string): string {
  const st = statSync(dir);
  return `${st.dev}:${st.ino}`;
}

/** child effective CWD equals a Codex-launched control by EXACT string + OS dir identity. */
async function assertChildEqualsControl(evidence: CwdCaseEvidence): Promise<void> {
  const control = await (harness as CodexCwdEvidence).runControl(evidence.rawRequestedCwd);
  expect(evidence.childEffectiveCwd).toBe(control.effectiveCwd);
  expect(evidence.childCwdIdentity).toBe(control.cwdIdentity);
  // No cache-root context ever appears as the launch directory.
  expect(evidence.childEffectiveCwd).not.toContain(join('plugins', 'cache'));
}

test('environment can host the black-box app-server CWD proof', () => {
  // Always-run gate record. `supported` is true wherever a real codex app-server
  // runs (e.g. the Group B host with codex-cli 0.144.4); elsewhere the proof suite
  // below is skipped with this reason instead of faking evidence.
  expect(typeof supportReason).toBe('string');
  if (!supported) {
    // Surface the exact environmental gate in the assertion message.
    expect(`codex-app-server-unavailable: ${supportReason}`).toContain('codex-app-server-unavailable');
  }
});

test('pre-spawn setup failure removes its harness root without launching an app-server child', async () => {
  const fake = makeFakeCodex('timeout');
  const before = harnessRoots();
  let createdRoot: string | null = null;
  try {
    const error = await captureLaunchFailure(fake.command, 75, (harnessRoot) => {
      createdRoot = harnessRoot;
      throw new Error('forced pre-spawn setup failure');
    });
    expect(error.message).toContain('forced pre-spawn setup failure');
    expect(createdRoot).not.toBeNull();
    if (createdRoot === null) throw new Error('pre-spawn seam did not observe the harness root');
    expect(existsSync(createdRoot)).toBe(false);
    expect(existsSync(fake.marker)).toBe(false);
    expect([...harnessRoots()].filter((root) => !before.has(root))).toEqual([]);
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

for (const failureCase of [
  { mode: 'timeout' as const, message: 'initialize timed out' },
  { mode: 'reject' as const, message: 'forced initialize rejection' },
  { mode: 'early-exit' as const, message: 'exited before replying' },
]) {
  test(`failed launch cleans the child and harness root after initialize ${failureCase.mode}`, async () => {
    const fake = makeFakeCodex(failureCase.mode);
    try {
      const error = await captureLaunchFailure(fake.command, 75);
      expect(error.message).toContain(failureCase.message);
      const record = JSON.parse(readFileSync(fake.marker, 'utf8')) as { pid: number; root: string };
      expect(processExists(record.pid)).toBe(false);
      expect(existsSync(record.root)).toBe(false);
    } finally {
      rmSync(fake.root, { recursive: true, force: true });
    }
  });
}

test('failed launch removes its harness root after a late spawn error', async () => {
  const fake = makeFakeCodex('spawn-error');
  const before = harnessRoots();
  try {
    const error = await captureLaunchFailure(fake.command, 75);
    expect(error.message).toContain('process error');
    expect([...harnessRoots()].filter((root) => !before.has(root))).toEqual([]);
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test('successful launch cleanup remains idempotent and reaps the child before removing its root', async () => {
  const fake = makeFakeCodex('success');
  try {
    const launched = await CodexCwdEvidence.launch(fake.command, 250);
    const record = JSON.parse(readFileSync(fake.marker, 'utf8')) as { pid: number; root: string };
    expect(processExists(record.pid)).toBe(true);
    expect(existsSync(record.root)).toBe(true);
    await launched.close();
    await launched.close();
    expect(processExists(record.pid)).toBe(false);
    expect(existsSync(record.root)).toBe(false);
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'successful close terminates the app-server process group, including spawned descendants',
  async () => {
    const fake = makeFakeCodex('success-with-descendant');
    try {
      const launched = await CodexCwdEvidence.launch(fake.command, 250);
      const record = JSON.parse(readFileSync(fake.marker, 'utf8')) as {
        pid: number;
        descendantPid: number;
        root: string;
      };
      expect(processExists(record.pid)).toBe(true);
      expect(processExists(record.descendantPid)).toBe(true);

      await launched.close();

      expect(await waitForProcessExit(record.pid)).toBe(true);
      expect(await waitForProcessExit(record.descendantPid)).toBe(true);
      expect(existsSync(record.root)).toBe(false);
    } finally {
      rmSync(fake.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'failed initialize terminates spawned descendants before removing the harness root',
  async () => {
    const fake = makeFakeCodex('timeout-with-descendant');
    try {
      const error = await captureLaunchFailure(fake.command, 75);
      expect(error.message).toContain('initialize timed out');
      const record = JSON.parse(readFileSync(fake.marker, 'utf8')) as {
        pid: number;
        descendantPid: number;
        root: string;
      };
      expect(await waitForProcessExit(record.pid)).toBe(true);
      expect(await waitForProcessExit(record.descendantPid)).toBe(true);
      expect(existsSync(record.root)).toBe(false);
    } finally {
      rmSync(fake.root, { recursive: true, force: true });
    }
  },
);

describe.skipIf(!supported)('black-box CWD evidence — real codex app-server', () => {
  test(
    'root + nested launch: child cwd equals the control by string + identity and reads the tagged sentinel',
    async () => {
      const h = harness as CodexCwdEvidence;
      const root = h.makeRepo('repoRoot', 'TOKEN_ROOT');
      const nested = join(root, 'pkg', 'sub');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, '.genie-cwd-sentinel'), 'TOKEN_NESTED', 'utf8');

      const rootCase = await h.startThreadCase('root', root);
      expect(rootCase.sentinelToken).toBe('TOKEN_ROOT');
      expect(rootCase.childCwdIdentity).toBe(dirIdentity(root));
      await assertChildEqualsControl(rootCase);

      const nestedCase = await h.startThreadCase('nested', nested);
      expect(nestedCase.sentinelToken).toBe('TOKEN_NESTED');
      expect(nestedCase.childCwdIdentity).toBe(dirIdentity(nested));
      await assertChildEqualsControl(nestedCase);
    },
    CASE_TIMEOUT,
  );

  test(
    'symlink-normalized launch: raw request differs from the effective cwd, which equals the real target',
    async () => {
      const h = harness as CodexCwdEvidence;
      const real = h.makeRepo('symTarget', 'TOKEN_SYM');
      const link = join(h.harnessRootDir(), 'symLink');
      execFileSync('ln', ['-s', real, link]);

      const symCase = await h.startThreadCase('symlink', link);
      // The raw requested cwd is the symlink spelling; the child's effective cwd is
      // the realpath. Evidence keeps the raw spelling rather than normalizing it away.
      expect(symCase.rawRequestedCwd).toBe(link);
      expect(symCase.childEffectiveCwd).toBe(realpathSync(link));
      expect(symCase.childEffectiveCwd).not.toBe(symCase.rawRequestedCwd);
      expect(symCase.sentinelToken).toBe('TOKEN_SYM');
      expect(symCase.childCwdIdentity).toBe(dirIdentity(real));
      await assertChildEqualsControl(symCase);
    },
    CASE_TIMEOUT,
  );

  test(
    'case-normalized launch (where the FS is case-insensitive): a differing-case request lands the same dir',
    async () => {
      const h = harness as CodexCwdEvidence;
      const real = h.makeRepo('caseRepo', 'TOKEN_CASE');
      const upperVariant = join(h.harnessRootDir(), 'CASEREPO');
      // Only meaningful where the host filesystem folds case: probe by identity.
      const caseInsensitive = (() => {
        try {
          return dirIdentity(upperVariant) === dirIdentity(real);
        } catch {
          return false;
        }
      })();
      if (!caseInsensitive) {
        // Honest gate: a case-sensitive FS (e.g. ext4) cannot exercise case folding.
        expect(caseInsensitive).toBe(false);
        return;
      }
      const caseCase = await h.startThreadCase('caseFold', upperVariant);
      // The child normalises to the on-disk directory identity and reads its sentinel,
      // irrespective of the request's case label; the raw request keeps its spelling.
      expect(caseCase.rawRequestedCwd).toBe(upperVariant);
      expect(caseCase.sentinelToken).toBe('TOKEN_CASE');
      expect(caseCase.childCwdIdentity).toBe(dirIdentity(real));
      await assertChildEqualsControl(caseCase);
    },
    CASE_TIMEOUT,
  );

  test(
    'linked-worktree launch: child stays in the linked worktree, not the main worktree or cache',
    async () => {
      const h = harness as CodexCwdEvidence;
      const gitMain = h.makeRepo('gitMain', 'TOKEN_MAIN');
      const git = (args: string[]) => execFileSync('git', args, { cwd: gitMain, stdio: 'pipe' });
      git(['init', '-q']);
      git(['config', 'user.email', 'b@genie.test']);
      git(['config', 'user.name', 'genie']);
      git(['add', '.']);
      git(['commit', '-qm', 'init']);
      const linkedWt = join(h.harnessRootDir(), 'linkedWt');
      git(['worktree', 'add', '-q', linkedWt, '-b', 'wt']);
      writeFileSync(join(linkedWt, '.genie-cwd-sentinel'), 'TOKEN_LINKED', 'utf8');

      const wtCase = await h.startThreadCase('linkedwt', linkedWt);
      // The child remains in the linked worktree — the linked worktree's sentinel,
      // never the main worktree's or a cache root's.
      expect(wtCase.sentinelToken).toBe('TOKEN_LINKED');
      expect(wtCase.childEffectiveCwd).toBe(realpathSync(linkedWt));
      expect(wtCase.childCwdIdentity).toBe(dirIdentity(linkedWt));
      expect(wtCase.childCwdIdentity).not.toBe(dirIdentity(gitMain));
      await assertChildEqualsControl(wtCase);
    },
    CASE_TIMEOUT,
  );

  test(
    'sequential two-repo threads: each child reads only its own repo sentinel',
    async () => {
      const h = harness as CodexCwdEvidence;
      const repoA = h.makeRepo('seqA', 'SEQ_A');
      const repoB = h.makeRepo('seqB', 'SEQ_B');
      const a = await h.startThreadCase('seqA', repoA);
      const b = await h.startThreadCase('seqB', repoB);
      expect(a.sentinelToken).toBe('SEQ_A');
      expect(b.sentinelToken).toBe('SEQ_B');
      expect(a.childCwdIdentity).not.toBe(b.childCwdIdentity);
      expect(findPidCrossingDifferingCwd([a, b])).toBeNull();
    },
    CASE_TIMEOUT,
  );

  test(
    'concurrent two-repo threads: no cross-talk and no PID crosses a differing effective cwd',
    async () => {
      const h = harness as CodexCwdEvidence;
      const repoA = h.makeRepo('conA', 'CON_A');
      const repoB = h.makeRepo('conB', 'CON_B');
      const cases = await h.startThreadCasesConcurrent([
        { tag: 'conA', requestedCwd: repoA },
        { tag: 'conB', requestedCwd: repoB },
      ]);
      const byTag = Object.fromEntries(cases.map((c) => [c.tag, c]));
      expect(byTag.conA?.sentinelToken).toBe('CON_A');
      expect(byTag.conB?.sentinelToken).toBe('CON_B');
      // Each child observed exactly its own repo identity.
      expect(byTag.conA?.childCwdIdentity).toBe(dirIdentity(repoA));
      expect(byTag.conB?.childCwdIdentity).toBe(dirIdentity(repoB));
      // The PID-reuse invariant: no shared PID across differing effective CWDs.
      expect(findPidCrossingDifferingCwd(cases)).toBeNull();
      // Both children equal their own control.
      await assertChildEqualsControl(byTag.conA as CwdCaseEvidence);
      await assertChildEqualsControl(byTag.conB as CwdCaseEvidence);
    },
    CASE_TIMEOUT,
  );

  test('production CodexHostObservation carries neither the raw request nor control-only fields', () => {
    // The production observation is limited to runtime/plugin-observable facts.
    const cacheFamily: HostCacheWitness = { status: 'present', digest: 'f'.repeat(64), identity: '10:20' };
    const result: CommandResult = {
      exitCode: 0,
      stdout: JSON.stringify({ installed: [{ pluginId: 'genie@automagik', version: '5.260712.1', enabled: true }] }),
      stderr: '',
    };
    const observation = parseCodexHostObservation({ result, cacheFamily });
    expect(observation.status).toBe('ok');
    const keys = Object.keys(observation);
    // No raw thread/start request field, and no control-process field, ever.
    for (const forbidden of [
      'rawRequestedCwd',
      'rawRequest',
      'threadStartCwd',
      'requestedCwd',
      'control',
      'controlCwd',
      'controlEffectiveCwd',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // It DOES expose only its own runtime/plugin-observable facts.
    expect(keys).toContain('plugin');
    expect(keys).toContain('effectiveChildCwd');
    expect(keys).toContain('cacheFamily');
  });
});
