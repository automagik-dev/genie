import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  type AdapterContext,
  type ArmId,
  type ArtifactTransport,
  type LaunchHandle,
  REQUIRED_CAPABILITIES,
  type SolverTarget,
  type TreatmentPin,
  parseCapabilityReport,
} from '../contracts';
import { type TerminalHost, createOmpAdapter, tmuxLaunchArgv, verifyTreatment, zeroGenieCanary } from './omp';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'omp');
const ATTEMPT = 'att-omp-1';
const OUTER_KEYS = ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'BENCH_FAKE_PROVIDER_KEY'] as const;
const ALLOWED_ENV = new Set([
  'PATH',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
]);

const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');

interface StartCall {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  session: string;
}

interface FakeHost extends TerminalHost {
  starts: StartCall[];
  kills: string[];
  running: boolean;
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    starts: [],
    kills: [],
    running: true,
    async start(argv, env, cwd, session) {
      host.starts.push({ argv: [...argv], env: { ...env }, cwd, session });
    },
    async alive() {
      return host.running;
    },
    async kill(session) {
      host.kills.push(session);
      host.running = false;
    },
    async version() {
      return 'tmux 3.6';
    },
  };
  return host;
}

let tmp: string;
let nativeHome: string;
let workspace: string;
let stub: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'omp-adapter-')));
  nativeHome = join(tmp, 'native', ATTEMPT);
  workspace = join(tmp, 'workspace');
  mkdirSync(nativeHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  stub = join(bin, 'omp');
  writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  chmodSync(stub, 0o755);
  for (const key of ['PATH', 'GENIE_HOME', ...OUTER_KEYS]) saved[key] = process.env[key];
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  process.env.GENIE_HOME = join(tmp, 'genie-home');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function context(
  opts: {
    arm?: ArmId;
    treatment?: TreatmentPin | null;
    solver?: SolverTarget;
    transport?: ArtifactTransport;
    commit?: string;
  } = {},
): AdapterContext {
  const arm = opts.arm ?? 'zero-genie';
  return {
    root: join(tmp, 'root'),
    attempt: {
      experimentId: 'exp-1',
      pairId: 'pair-1',
      manifestId: 'manifest-1',
      taskKey: 'terminal-bench/demo/task-1',
      configId: `omp-${arm}`,
      arm,
      repeat: 0,
      attemptId: ATTEMPT,
      scheduledIndex: 0,
      kind: 'smoke',
    },
    config: {
      schemaVersion: 1,
      configId: `omp-${arm}`,
      harness: 'omp',
      executable: 'omp',
      requestedModel: 'model-observed',
      requestedEffort: 'medium',
      treatment: opts.treatment ?? null,
      epoch: 'e1',
      cohort: 'c1',
    },
    task: {
      source: 'terminal-bench',
      sourceRevision: 'rev-1',
      taskId: 'task-1',
      category: 'demo',
      cluster: 'demo',
      artifactTransport: opts.transport ?? 'answer',
      instruction: { path: 'task-1/instruction.md', sha256: sha256('') },
      environment: {
        kind: 'git-checkout',
        repository: opts.commit === undefined ? null : { url: 'file:///unused', commit: opts.commit },
        image: null,
        provision: null,
        teardown: null,
        resources: null,
        solverPath: '.',
        artifactPath: 'answer.txt',
      },
      timeLimitSec: null,
    },
    solver: opts.solver ?? { kind: 'host', cwd: workspace },
    nativeHome,
  };
}

/** Writes one native session log (plus optional actor logs) into the attempt's isolated home. */
function writeSession(name: string, lines: object[]): void {
  const dir = join(nativeHome, '.omp', 'agent', 'sessions', '--workspace--');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

const header = (id: string) => ({ type: 'session', version: 3, id, timestamp: '2026-10-01T10:00:00.000Z', cwd: '/w' });
const user = (id: string) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: '2026-10-01T10:00:01.000Z',
  message: { role: 'user', content: [{ type: 'text', text: 'Fix the test.' }] },
});
const assistant = (id: string, parentId: string, stopReason: string) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-10-01T10:00:02.000Z',
  message: { role: 'assistant', stopReason, model: 'model-observed', usage: { input: 10, output: 5 } },
});

function planted(path: string, text: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const handle = (): LaunchHandle => ({ attemptId: ATTEMPT, session: ATTEMPT, startedMonotonicNs: '0' });

describe('launch argv', () => {
  test('the production tmux argv is an array with no shell, print or mode argument', () => {
    const prompt = 'Say "hi" and \'bye\'\n$(rm -rf /) `id` ; echo done';
    const argv = tmuxLaunchArgv([stub, prompt], ATTEMPT);
    expect(argv).toEqual(['tmux', '-L', ATTEMPT, 'new-session', '-d', '-s', ATTEMPT, '--', stub, prompt]);
    for (const banned of ['sh', 'bash', '-c', '--print', '--mode']) expect(argv).not.toContain(banned);
  });

  test('launch hands the host the executable and the prompt byte-exact, in the workspace, on the attempt session', async () => {
    const host = fakeHost();
    const prompt = 'Line one with "double" and \'single\' quotes\nline two\twith a tab and $HOME unexpanded';
    const h = await createOmpAdapter(host).launch(context(), prompt);
    expect(host.starts).toHaveLength(1);
    const [call] = host.starts;
    expect(call.argv).toEqual([stub, prompt]);
    expect(call.argv[1]).toBe(prompt);
    expect(call.cwd).toBe(workspace);
    expect(call.session).toBe(ATTEMPT);
    expect(h.session).toBe(ATTEMPT);
    expect(h.attemptId).toBe(ATTEMPT);
  });

  test('the environment is an allowlist with HOME at the native home and no outer session id or key', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'outer-claude-session';
    process.env.CODEX_SESSION_ID = 'outer-codex-session';
    process.env.BENCH_FAKE_PROVIDER_KEY = 'not-a-real-key';
    const host = fakeHost();
    await createOmpAdapter(host).launch(context(), 'task');
    const { env } = host.starts[0];
    expect(env.HOME).toBe(nativeHome);
    expect(env.XDG_CONFIG_HOME).toBe(join(nativeHome, '.config'));
    for (const key of OUTER_KEYS) expect(env[key]).toBeUndefined();
    expect(env.GENIE_HOME).toBeUndefined();
    for (const key of Object.keys(env)) expect(ALLOWED_ENV.has(key)).toBe(true);
    expect(Object.values(env)).not.toContain('not-a-real-key');
  });
});

describe('zero-genie canary', () => {
  test('a fresh native home and workspace are clean', () => {
    expect(zeroGenieCanary(nativeHome, workspace)).toEqual({ clean: true, found: [] });
  });

  test('a Genie skill planted in a native-home discovery root fails the canary and the launch never starts', async () => {
    const skill = planted(
      join(nativeHome, '.omp', 'agent', 'skills', 'genie-wish', 'SKILL.md'),
      '---\nname: wish\ndescription: Genie wish skill\n---\n',
    );
    const canary = zeroGenieCanary(nativeHome, workspace);
    expect(canary.clean).toBe(false);
    expect(canary.found.some((f) => f.startsWith(skill))).toBe(true);

    const host = fakeHost();
    const adapter = createOmpAdapter(host);
    await expect(adapter.launch(context(), 'task')).rejects.toThrow(/refused: zero-genie canary/);
    await expect(adapter.preflight(context())).rejects.toThrow(/refused: zero-genie canary/);
    expect(host.starts).toHaveLength(0);
  });

  test('Genie guidance, catalogs, state and symlinks in workspace discovery roots are found', () => {
    const skill = planted(join(workspace, '.claude', 'skills', 'brainstorm', 'SKILL.md'), 'Part of the Genie skills.');
    planted(join(workspace, '.genie', 'INDEX.md'), '# index\n');
    const guide = planted(join(workspace, 'AGENTS.md'), 'Run genie wish before coding.\n');
    mkdirSync(join(workspace, '.agents'));
    symlinkSync(tmp, join(workspace, '.agents', 'skills'));
    const { clean, found } = zeroGenieCanary(nativeHome, workspace);
    expect(clean).toBe(false);
    for (const path of [skill, join(workspace, '.genie'), guide, join(workspace, '.agents', 'skills')]) {
      expect(found.some((f) => f.startsWith(path))).toBe(true);
    }
  });

  test('a zero-genie configuration that carries a treatment pin is refused', async () => {
    const host = fakeHost();
    const pin = { contract: 'genie-omp@1', resources: { 'a.md': sha256('a') } };
    await expect(createOmpAdapter(host).launch(context({ treatment: pin }), 'task')).rejects.toThrow(/treatment pin/);
    expect(host.starts).toHaveLength(0);
  });
});

describe('treatment verification', () => {
  const RESOURCE = join('.omp', 'agent', 'skills', 'treatment', 'SKILL.md');
  const BODY = 'pinned treatment body\n';

  test('matching hashes verify and the genie arm launches', async () => {
    planted(join(nativeHome, RESOURCE), BODY);
    const pin: TreatmentPin = { contract: 'genie-omp@1', resources: { [RESOURCE]: sha256(BODY) } };
    expect(verifyTreatment(pin, nativeHome)).toEqual({ ok: true, value: undefined });
    const host = fakeHost();
    await createOmpAdapter(host).launch(context({ arm: 'genie', treatment: pin }), 'task');
    expect(host.starts).toHaveLength(1);
  });

  test('a hash mismatch refuses the launch and the host never starts', async () => {
    planted(join(nativeHome, RESOURCE), 'tampered\n');
    const pin: TreatmentPin = { contract: 'genie-omp@1', resources: { [RESOURCE]: sha256(BODY) } };
    const verified = verifyTreatment(pin, nativeHome);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.issues.join('\n')).toContain('does not match the pinned');
    const host = fakeHost();
    const adapter = createOmpAdapter(host);
    await expect(adapter.launch(context({ arm: 'genie', treatment: pin }), 'task')).rejects.toThrow(/refused/);
    await expect(adapter.preflight(context({ arm: 'genie', treatment: pin }))).rejects.toThrow(/refused/);
    expect(host.starts).toHaveLength(0);
  });

  test('a missing, escaping or symlinked resource and an empty pin are refused', async () => {
    planted(join(tmp, 'outside.md'), BODY);
    mkdirSync(join(nativeHome, 'linked'));
    symlinkSync(join(tmp, 'outside.md'), join(nativeHome, 'linked', 'SKILL.md'));
    const pin: TreatmentPin = {
      contract: 'genie-omp@1',
      resources: {
        'missing.md': sha256(BODY),
        '../../outside.md': sha256(BODY),
        'linked/SKILL.md': sha256(BODY),
      },
    };
    const verified = verifyTreatment(pin, nativeHome);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      const text = verified.issues.join('\n');
      expect(text).toContain('missing.md: missing');
      expect(text).toContain('../../outside.md: resolves outside the native home');
      expect(text).toContain('linked/SKILL.md: reached through a symlink');
    }
    expect(verifyTreatment({ contract: 'genie-omp@1', resources: {} }, nativeHome).ok).toBe(false);
    const host = fakeHost();
    await expect(createOmpAdapter(host).launch(context({ arm: 'genie' }), 'task')).rejects.toThrow(/no treatment pin/);
    expect(host.starts).toHaveLength(0);
  });
});

describe('preflight', () => {
  test('a fresh home proves nothing, and settledSignal stays unsupported despite a host version string', async () => {
    const raw = await createOmpAdapter(fakeHost()).preflight(context());
    const parsed = parseCapabilityReport(raw);
    expect(parsed.ok).toBe(true);
    for (const name of REQUIRED_CAPABILITIES) expect(raw.capabilities[name]).toBeDefined();
    for (const entry of Object.values(raw.capabilities)) expect(entry.status).not.toBe('proven');
    expect(raw.capabilities.settledSignal.status).toBe('unsupported');
    expect(raw.capabilities.settledSignal.upstreamRequirement).toContain('settled signal');
    expect(raw.capabilities.launchVisible.status).toBe('unproven');
    expect(raw.executable).toEqual({ path: stub, build: null, sha256: sha256('#!/bin/sh\nexit 0\n') });
    expect(raw.discoveryRoots).toContain(nativeHome);
  });

  test('only captured session logs prove a capability, each proof citing them', async () => {
    const sessions = join(nativeHome, '.omp', 'agent', 'sessions', '--work-bench-task--');
    mkdirSync(sessions, { recursive: true });
    cpSync(join(FIXTURES, 'lead-child-aux.jsonl'), join(sessions, 'lead-child-aux.jsonl'));
    cpSync(join(FIXTURES, 'lead-child-aux'), join(sessions, 'lead-child-aux'), { recursive: true });
    const raw = await createOmpAdapter(fakeHost()).preflight(context());
    expect(parseCapabilityReport(raw).ok).toBe(true);
    expect(raw.capabilities.requestUsage.status).toBe('proven');
    expect(raw.capabilities.modelEffortResolved.status).toBe('proven');
    expect(raw.resolved).toEqual({ model: 'model-observed', effort: 'medium' });
    // The worker and auxiliary logs carry no effort, so that capability is not proven.
    expect(raw.capabilities.childAuxModelEffort.status).toBe('unproven');
    expect(raw.capabilities.settledSignal.status).toBe('unsupported');
    for (const entry of Object.values(raw.capabilities)) {
      if (entry.status !== 'proven') continue;
      expect(entry.evidence.length).toBeGreaterThan(0);
      for (const ref of entry.evidence) {
        expect(ref.path.startsWith(sessions)).toBe(true);
        expect(createHash('sha256').update(readFileSync(ref.path)).digest('hex')).toBe(ref.sha256);
      }
    }
  });

  test('a container target reports environmentExecution unsupported and never launches', async () => {
    const host = fakeHost();
    const adapter = createOmpAdapter(host);
    const solver: SolverTarget = { kind: 'container', containerId: 'c0ffee', cwd: '/app' };
    const raw = await adapter.preflight(context({ solver }));
    expect(raw.capabilities.environmentExecution.status).toBe('unsupported');
    expect(raw.capabilities.environmentExecution.upstreamRequirement).toContain('P5');
    await expect(adapter.launch(context({ solver }), 'task')).rejects.toThrow(/environmentExecution is unsupported/);
    expect(host.starts).toHaveLength(0);
  });
});

describe('settled and stop', () => {
  test('settled while the client runs reports unsupported with the upstream requirement, never settled', async () => {
    const host = fakeHost();
    const adapter = createOmpAdapter(host);
    await adapter.launch(context(), 'task');
    writeSession('lead', [header('sess-lead'), user('m1'), assistant('m2', 'm1', 'stop')]);
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.settled(handle(), controller.signal);
    expect(result.settled).toBe(false);
    expect(result.basis).toContain('unsupported');
    expect(result.basis).toContain('upstream requirement');
  });

  test('settled is true only when the client exited and captured logs show no pending actor', async () => {
    const host = fakeHost();
    const adapter = createOmpAdapter(host);
    await adapter.launch(context(), 'task');
    host.running = false;
    const signal = new AbortController().signal;
    await expect(adapter.settled(handle(), signal)).rejects.toThrow(/no captured session log/);
    writeSession('lead', [header('sess-lead'), user('m1'), assistant('m2', 'm1', 'toolUse')]);
    await expect(adapter.settled(handle(), signal)).rejects.toThrow(/pending actors: sess-lead/);
    writeSession('lead', [header('sess-lead'), user('m1'), assistant('m2', 'm1', 'stop')]);
    expect(await adapter.settled(handle(), signal)).toEqual({
      settled: true,
      pendingActors: [],
      basis: 'the native client exited and its captured session logs show no pending actor',
    });
  });

  test("stop('timeout') kills the session and records the remaining actors from capture", async () => {
    const host = fakeHost();
    const adapter = createOmpAdapter(host);
    await adapter.launch(context(), 'task');
    writeSession('lead', [header('sess-lead'), user('m1'), assistant('m2', 'm1', 'toolUse')]);
    const receipt = await adapter.stop(handle(), 'timeout');
    expect(host.kills).toEqual([ATTEMPT]);
    expect(receipt.reason).toBe('timeout');
    expect(receipt.remainingActors).toEqual(['sess-lead']);
    expect(receipt.usageUncertain).toBe(true);
    expect(/^\d+$/.test(receipt.stoppedMonotonicNs)).toBe(true);
  });

  test('stop kills the session even for a handle it never launched', async () => {
    const host = fakeHost();
    await expect(createOmpAdapter(host).stop(handle(), 'interrupt')).rejects.toThrow(/no launch is recorded/);
    expect(host.kills).toEqual([ATTEMPT]);
  });
});

describe('collectArtifact', () => {
  test('an answer artifact is the file at artifactPath, copied with its digest', async () => {
    const adapter = createOmpAdapter(fakeHost());
    await adapter.launch(context(), 'task');
    writeFileSync(join(workspace, 'answer.txt'), '42\n');
    const dest = join(tmp, 'root', 'artifacts', ATTEMPT, 'artifact');
    const ref = await adapter.collectArtifact(handle(), dest);
    expect(readFileSync(dest, 'utf8')).toBe('42\n');
    expect(ref).toEqual({ kind: 'artifact', path: dest, sha256: sha256('42\n'), bytes: 3 });
  });

  test('a committed-patch artifact is the diff of the committed work against the task commit', async () => {
    const git = (...args: string[]): string => {
      const run = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], {
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: tmp,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'bench',
          GIT_AUTHOR_EMAIL: 'bench@example.invalid',
          GIT_COMMITTER_NAME: 'bench',
          GIT_COMMITTER_EMAIL: 'bench@example.invalid',
        },
      });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      return run.stdout.toString().trim();
    };
    git('init', '-q');
    writeFileSync(join(workspace, 'file.txt'), 'before\n');
    git('add', 'file.txt');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    const adapter = createOmpAdapter(fakeHost());
    await adapter.launch(context({ transport: 'committed-patch', commit: base }), 'task');
    writeFileSync(join(workspace, 'file.txt'), 'after\n');
    git('commit', '-q', '-am', 'solve');
    const dest = join(tmp, 'root', 'artifacts', ATTEMPT, 'artifact');
    await adapter.collectArtifact(handle(), dest);
    const patch = readFileSync(dest, 'utf8');
    expect(patch).toContain('-before');
    expect(patch).toContain('+after');
  });
});
