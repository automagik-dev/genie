import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import type { EnvironmentSpec, EvidenceRef, InstructionRef, TaskIdentity, VerifierInvocation } from './contracts';
import { hostClock } from './contracts';
import {
  type EnvironmentCheck,
  INSPECT_COMMANDS,
  provisionEnvironment,
  provisionVerifierCopy,
  readInstruction,
  runInspect,
  runSourceVerifier,
  teardownEnvironment,
} from './environment';

const SCRIPT = join(import.meta.dir, 'environment.ts');
const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const IMAGE_ID = `sha256:${'e'.repeat(64)}`;
const CONTAINER_ID = 'stub-container-1';
const PROVISION = [
  'docker',
  'run',
  '-d',
  '--name',
  'bench-task',
  '--cpus',
  '2',
  '--memory',
  '4096m',
  '--network',
  'none',
  `bench/img@${IMAGE_DIGEST}`,
];
const TEARDOWN = ['docker', 'rm', '-f', 'bench-task'];
const MB = 1024 * 1024;

const VERIFY_BY_CONTENT =
  'if cat solution.patch app/solution.patch 2>/dev/null | grep -q FIXED; then echo 1 > reward.txt; else echo 0 > reward.txt; fi\n';
const VERIFY_ALWAYS_ONE = 'echo 1 > reward.txt\n';

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

let tmp: string;
let root: string;
let sources: string;
let bin: string;
let log: string;
let savedPath: string | undefined;
let savedGenieHome: string | undefined;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'genie-bench-env-')));
  root = join(tmp, 'root');
  sources = join(tmp, 'sources');
  bin = join(tmp, 'bin');
  log = join(tmp, 'docker.log');
  mkdirSync(sources);
  mkdirSync(bin);
  savedPath = process.env.PATH;
  savedGenieHome = process.env.GENIE_HOME;
  process.env.GENIE_HOME = join(tmp, 'genie-home');
  // The stub runtime precedes every system directory on the child PATH.
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
  writeStubDocker();
  setContainer({ NanoCpus: 2 * 1e9, Memory: 4096 * MB, NetworkMode: 'none' });
  writeFileSync(
    join(bin, 'image.json'),
    JSON.stringify([{ Id: IMAGE_ID, RepoDigests: [`bench/img@${IMAGE_DIGEST}`] }]),
  );
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedGenieHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
  else process.env.GENIE_HOME = savedGenieHome;
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A stub `docker` that records every argv (tab-separated tokens) and answers from files. */
function writeStubDocker(): void {
  const script = [
    '#!/bin/sh',
    `for a in "$@"; do printf '%s\\t' "$a" >> '${log}'; done`,
    `printf '\\n' >> '${log}'`,
    'case "$1" in',
    `  run) echo ${CONTAINER_ID} ;;`,
    `  inspect) cat '${join(bin, 'container.json')}' ;;`,
    `  image) cat '${join(bin, 'image.json')}' ;;`,
    '  rm) ;;',
    '  *) exit 64 ;;',
    'esac',
    '',
  ].join('\n');
  writeFileSync(join(bin, 'docker'), script);
  chmodSync(join(bin, 'docker'), 0o755);
}

function setContainer(hostConfig: Record<string, unknown>): void {
  writeFileSync(
    join(bin, 'container.json'),
    JSON.stringify([{ Id: CONTAINER_ID, Image: IMAGE_ID, HostConfig: hostConfig }]),
  );
}

function recorded(): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => ['docker', ...line.split('\t').slice(0, -1)]);
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((t, i) => t === b[i]);

/** Every recorded runtime command is the declared provision/teardown argv or an INSPECT_COMMANDS entry. */
function expectOnlyAllowedCommands(): void {
  for (const argv of recorded()) {
    const declared = same(argv, PROVISION) || same(argv, TEARDOWN);
    const inspect = INSPECT_COMMANDS.some(
      (entry) => entry[0] !== 'git' && entry.length === argv.length - 1 && entry.every((t, i) => argv[i] === t),
    );
    expect({ argv, allowed: declared || inspect }).toEqual({ argv, allowed: true });
  }
}

const tornDown = (): boolean => recorded().some((argv) => same(argv, TEARDOWN));

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@example.invalid',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@example.invalid',
    },
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

/** A real repository with two commits; returns the first (the pinned one) and the second. */
function makeRepo(): { repo: string; pinned: string; later: string } {
  const repo = join(tmp, 'upstream');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'README.md'), 'one\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'one');
  const pinned = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'README.md'), 'two\n');
  git(repo, 'commit', '-q', '-am', 'two');
  return { repo, pinned, later: git(repo, 'rev-parse', 'HEAD') };
}

function packageFile(name: string, content: string): InstructionRef {
  writeFileSync(join(sources, name), content);
  return { path: name, sha256: sha256(content) };
}

function writeVerifier(body: string): string[] {
  writeFileSync(join(sources, 'verify.sh'), body);
  return ['sh', join(sources, 'verify.sh')];
}

function gitSpec(repo: string, commit: string): EnvironmentSpec {
  return {
    kind: 'git-checkout',
    repository: { url: repo, commit },
    image: null,
    provision: null,
    teardown: null,
    resources: null,
    solverPath: '.',
    artifactPath: 'solution.patch',
  };
}

function containerSpec(overrides: Partial<EnvironmentSpec> = {}): EnvironmentSpec {
  return {
    kind: 'source-container',
    repository: null,
    image: { ref: 'bench/img', digest: IMAGE_DIGEST },
    provision: [...PROVISION],
    teardown: [...TEARDOWN],
    resources: { cpus: 2, memoryMb: 4096, network: 'none' },
    solverPath: '/app',
    artifactPath: '/app/solution.patch',
    ...overrides,
  };
}

function makeTask(
  environment: EnvironmentSpec,
  opts: { verify?: string; reference?: string | null; verifier?: Partial<VerifierInvocation> } = {},
): TaskIdentity {
  const command = writeVerifier(opts.verify ?? VERIFY_BY_CONTENT);
  const reference = opts.reference === undefined ? 'FIXED by the reference\n' : opts.reference;
  return {
    source: 'deepswe',
    sourceRevision: 'rev-1',
    taskId: 't1',
    category: 'lint',
    cluster: 'c1',
    artifactTransport: 'committed-patch',
    instruction: packageFile('instruction.md', 'Fix the lint finding.\n'),
    environment,
    verifier: {
      command,
      runsIn: 'host-outside-solver',
      rewardFile: 'reward.txt',
      acceptWhen: 'binary-one',
      timeoutSec: 30,
      judge: null,
      ...opts.verifier,
    },
    verifierDigest: 'b'.repeat(64),
    referenceSolution: reference === null ? null : packageFile('reference.patch', reference),
    timeLimitSec: null,
  };
}

function artifactFile(name: string, content: string): EvidenceRef {
  const path = join(tmp, name);
  writeFileSync(path, content);
  return { kind: 'artifact', path, sha256: sha256(content), bytes: Buffer.byteLength(content) };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

function writeManifest(task: TaskIdentity): string {
  const path = join(tmp, 'manifest.json');
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      manifestId: 'm1',
      poolDigest: 'a'.repeat(64),
      quotas: { 'deepswe/lint': 1 },
      selected: [task],
      replacements: [],
      smoke: [],
      frozenAt: '2026-10-14T00:00:00Z',
    }),
  );
  return path;
}

function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: tmp, env: { ...process.env } });
  return { code: run.exitCode ?? -1, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function check(task: TaskIdentity): { code: number; result: EnvironmentCheck; stderr: string } {
  const manifest = writeManifest(task);
  const run = cli(['check', '--root', root, '--manifest', manifest, '--sources', sources, '--task', 'deepswe/lint/t1']);
  const path = run.stdout.trim();
  expect(path.startsWith(join(root, 'checks'))).toBe(true);
  return { code: run.code, result: JSON.parse(readFileSync(path, 'utf8')), stderr: run.stderr };
}

function remainingClones(): string[] {
  const envs = join(root, 'environments');
  if (!existsSync(envs)) return [];
  return readdirSync(envs).filter((id) => existsSync(join(envs, id, 'solver')));
}

// ---------------------------------------------------------------------------
// INSPECT_COMMANDS
// ---------------------------------------------------------------------------

describe('INSPECT_COMMANDS', () => {
  test('is a frozen closed list of read-only commands', () => {
    expect(INSPECT_COMMANDS.map((c) => [...c])).toEqual([
      ['git', 'rev-parse', 'HEAD'],
      ['git', 'status', '--porcelain'],
      ['docker', 'inspect'],
      ['podman', 'inspect'],
      ['docker', 'image', 'inspect'],
      ['podman', 'image', 'inspect'],
    ]);
    expect(Object.isFrozen(INSPECT_COMMANDS)).toBe(true);
    for (const entry of INSPECT_COMMANDS) expect(Object.isFrozen(entry)).toBe(true);
    expect(() => (INSPECT_COMMANDS as string[][]).push(['docker', 'exec'])).toThrow();
  });

  test('an inspect command outside the list is refused before any process starts', async () => {
    for (const argv of [
      ['docker', 'exec', CONTAINER_ID, 'sh'],
      ['docker', 'inspect', '--format', '{{.Id}}'],
      ['docker', 'inspect', '--format={{.Id}}'],
      ['git', 'log'],
      ['git', 'rev-parse', 'HEAD', '--all'],
    ]) {
      const result = await runInspect(argv, tmp);
      expect(result.ok).toBe(false);
    }
    expect(recorded()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readInstruction
// ---------------------------------------------------------------------------

describe('readInstruction', () => {
  test('reads the instruction by digest', () => {
    const task = makeTask(containerSpec());
    const read = readInstruction(task, sources);
    expect(read.ok && read.value.text).toBe('Fix the lint finding.\n');
  });

  test('an instruction sha256 mismatch is refused', () => {
    const task = makeTask(containerSpec());
    const tampered = { ...task, instruction: { ...task.instruction, sha256: 'c'.repeat(64) } };
    const read = readInstruction(tampered, sources);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.issues.join()).toContain('sha256 mismatch');
  });

  test('a path traversal outside the package is refused', () => {
    const outside = 'outside the package\n';
    writeFileSync(join(tmp, 'outside.md'), outside);
    const task = makeTask(containerSpec());
    for (const path of ['../outside.md', join(tmp, 'outside.md')]) {
      const read = readInstruction({ ...task, instruction: { path, sha256: sha256(outside) } }, sources);
      expect(read.ok).toBe(false);
      expect(!read.ok && read.issues.join()).toContain('outside the source package');
    }
    symlinkSync(join(tmp, 'outside.md'), join(sources, 'linked.md'));
    const linked = readInstruction({ ...task, instruction: { path: 'linked.md', sha256: sha256(outside) } }, sources);
    expect(linked.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// git-checkout
// ---------------------------------------------------------------------------

describe('git-checkout provisioning', () => {
  test('clones at the pinned commit and the solver HEAD equals it', async () => {
    const { repo, pinned, later } = makeRepo();
    const env = await provisionEnvironment(root, 'a1', makeTask(gitSpec(repo, pinned)), sources);
    if (!env.ok) throw new Error(env.issues.join('\n'));
    expect(env.value.solver.kind).toBe('host');
    const cwd = env.value.solver.cwd;
    expect(relative(root, cwd).startsWith('..')).toBe(false);
    expect(relative(import.meta.dir, cwd).startsWith('..')).toBe(true);
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(pinned);
    expect(pinned).not.toBe(later);

    const down = await teardownEnvironment(env.value);
    expect(down.ok).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  test('a commit the repository lacks is refused and the clone is removed', async () => {
    const { repo } = makeRepo();
    const env = await provisionEnvironment(root, 'a2', makeTask(gitSpec(repo, 'f'.repeat(40))), sources);
    expect(env.ok).toBe(false);
    expect(existsSync(join(root, 'environments', 'a2', 'solver'))).toBe(false);
  });

  test('a root inside the Genie checkout is refused before anything is written', async () => {
    const { repo, pinned } = makeRepo();
    const inside = join(import.meta.dir, 'never-created-root');
    const env = await provisionEnvironment(inside, 'a3', makeTask(gitSpec(repo, pinned)), sources);
    expect(env.ok).toBe(false);
    expect(existsSync(inside)).toBe(false);
  });

  test('the reference solution never appears in the solver target', async () => {
    const { repo, pinned } = makeRepo();
    const task = makeTask(gitSpec(repo, pinned), { reference: 'FIXED-REFERENCE-MARKER\n' });
    const env = await provisionEnvironment(root, 'a4', task, sources);
    if (!env.ok) throw new Error(env.issues.join('\n'));
    const reference = artifactFile('reference.artifact', 'FIXED-REFERENCE-MARKER\n');
    const copy = await provisionVerifierCopy(root, 'a4', task, sources, reference);
    if (!copy.ok) throw new Error(copy.issues.join('\n'));

    const solverCwd = env.value.solver.cwd;
    for (const file of listFiles(solverCwd)) {
      expect(file.endsWith('reference.patch')).toBe(false);
      expect(readFileSync(file).includes('FIXED-REFERENCE-MARKER')).toBe(false);
    }
    expect(relative(solverCwd, copy.value.cwd).startsWith('..')).toBe(true);
    // The verifier copy holds the collected artifact and nothing else.
    expect(listFiles(copy.value.cwd)).toEqual([join(copy.value.cwd, 'solution.patch')]);
    expect(copy.value.artifact.sha256).toBe(reference.sha256);
    await teardownEnvironment(env.value);
  });
});

// ---------------------------------------------------------------------------
// source-container
// ---------------------------------------------------------------------------

describe('source-container provisioning', () => {
  test('runs the provision argv verbatim and reads limits back only through INSPECT_COMMANDS', async () => {
    const env = await provisionEnvironment(root, 'c1', makeTask(containerSpec()), sources);
    if (!env.ok) throw new Error(env.issues.join('\n'));
    expect(env.value.solver).toEqual({ kind: 'container', containerId: CONTAINER_ID, cwd: '/app' });
    expect(env.value.image).toEqual({ ref: 'bench/img', digest: IMAGE_DIGEST });
    expect(env.value.resources).toEqual({ cpus: 2, memoryMb: 4096, network: 'none' });
    expect(recorded()[0]).toEqual(PROVISION);
    expect(tornDown()).toBe(false);

    const down = await teardownEnvironment(env.value);
    expect(down.ok).toBe(true);
    expect(tornDown()).toBe(true);
    expectOnlyAllowedCommands();
  });

  test('a digest mismatch is refused and teardown still runs', async () => {
    writeFileSync(
      join(bin, 'image.json'),
      JSON.stringify([{ Id: IMAGE_ID, RepoDigests: [`bench/img@sha256:${'0'.repeat(64)}`] }]),
    );
    const env = await provisionEnvironment(root, 'c2', makeTask(containerSpec()), sources);
    expect(env.ok).toBe(false);
    expect(!env.ok && env.issues.join()).toContain('image digest mismatch');
    expect(tornDown()).toBe(true);
    expectOnlyAllowedCommands();
  });

  test('a resource limit that differs from the spec is refused and teardown runs', async () => {
    setContainer({ NanoCpus: 2 * 1e9, Memory: 2048 * MB, NetworkMode: 'none' });
    const env = await provisionEnvironment(root, 'c3', makeTask(containerSpec()), sources);
    expect(env.ok).toBe(false);
    expect(!env.ok && env.issues.join()).toContain('memoryMb mismatch');
    expect(tornDown()).toBe(true);
  });

  test('a thrown error during read-back still tears down', async () => {
    writeFileSync(join(bin, 'container.json'), 'not json');
    const env = await provisionEnvironment(root, 'c4', makeTask(containerSpec()), sources);
    expect(env.ok).toBe(false);
    expect(!env.ok && env.issues.join()).toContain('threw');
    expect(tornDown()).toBe(true);
  });

  test('a provision runtime with no inspect entry is refused before anything runs', async () => {
    const env = await provisionEnvironment(
      root,
      'c5',
      makeTask(containerSpec({ provision: ['harbor', 'up'] })),
      sources,
    );
    expect(env.ok).toBe(false);
    expect(recorded()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runSourceVerifier
// ---------------------------------------------------------------------------

describe('runSourceVerifier', () => {
  async function verifyWith(body: string, artifactContent = 'anything\n') {
    const task = makeTask(containerSpec(), { verify: body });
    const artifact = artifactFile('collected.artifact', artifactContent);
    const copy = await provisionVerifierCopy(root, 'v1', task, sources, artifact);
    if (!copy.ok) throw new Error(copy.issues.join('\n'));
    return { task, artifact, copy: copy.value };
  }

  test('verifier exit 0 with reward 0.5 is not accepted', async () => {
    const { task, artifact, copy } = await verifyWith('echo 0.5 > reward.txt\nexit 0\n');
    const receipt = await runSourceVerifier(task, copy, artifact, hostClock);
    if (!receipt.ok) throw new Error(receipt.issues.join('\n'));
    expect(receipt.value).toMatchObject({ exitCode: 0, reward: 0.5, accepted: false });
  });

  test('verifier exit 0 with no reward file is not accepted', async () => {
    const { task, artifact, copy } = await verifyWith('exit 0\n');
    const receipt = await runSourceVerifier(task, copy, artifact, hostClock);
    expect(receipt.ok && receipt.value).toMatchObject({ exitCode: 0, reward: null, accepted: false });
  });

  test('a reward of exactly 1 is accepted', async () => {
    const { task, artifact, copy } = await verifyWith(VERIFY_ALWAYS_ONE);
    const receipt = await runSourceVerifier(task, copy, artifact, hostClock);
    expect(receipt.ok && receipt.value).toMatchObject({ reward: 1, accepted: true });
  });

  test('a copy whose artifact sha256 differs from the collected artifact is refused before running', async () => {
    const marker = join(tmp, 'verifier-ran');
    const { task, copy } = await verifyWith(`touch '${marker}'\n${VERIFY_ALWAYS_ONE}`);
    const other = artifactFile('other.artifact', 'a different artifact\n');
    const receipt = await runSourceVerifier(task, copy, other, hostClock);
    expect(receipt.ok).toBe(false);
    expect(!receipt.ok && receipt.issues.join()).toContain('sha256');
    expect(existsSync(marker)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// check CLI
// ---------------------------------------------------------------------------

describe('check CLI', () => {
  test('missing --root or --sources exits 2 and writes nothing', () => {
    const { repo, pinned } = makeRepo();
    const manifest = writeManifest(makeTask(gitSpec(repo, pinned)));
    const before = listFiles(tmp).sort();
    const noRoot = cli(['check', '--manifest', manifest, '--sources', sources, '--task', 'deepswe/lint/t1']);
    const noSources = cli(['check', '--root', root, '--manifest', manifest, '--task', 'deepswe/lint/t1']);
    expect(noRoot.code).toBe(2);
    expect(noRoot.stderr).toContain('--root');
    expect(noSources.code).toBe(2);
    expect(noSources.stderr).toContain('--sources');
    expect(listFiles(tmp).sort()).toEqual(before);
    expect(existsSync(root)).toBe(false);
  });

  test('a git-checkout task passes the sanity step and its clone is torn down', () => {
    const { repo, pinned } = makeRepo();
    const run = check(makeTask(gitSpec(repo, pinned)));
    expect(run.code).toBe(0);
    expect(run.result).toMatchObject({ instruction: 'ok', provision: 'ok', passed: true, failedStep: null });
    expect(run.result.untouched?.accepted).toBe(false);
    expect(run.result.reference).toMatchObject({ accepted: true, reward: 1 });
    expect(remainingClones()).toEqual([]);
  });

  test('a verifier that accepts the untouched artifact makes check exit 1', () => {
    const { repo, pinned } = makeRepo();
    const run = check(makeTask(gitSpec(repo, pinned), { verify: VERIFY_ALWAYS_ONE }));
    expect(run.code).toBe(1);
    expect(run.result.failedStep).toBe('untouched');
    expect(run.result.untouched?.accepted).toBe(true);
    expect(remainingClones()).toEqual([]);
  });

  test('a reference the verifier does not accept makes check exit 1', () => {
    const { repo, pinned } = makeRepo();
    const run = check(makeTask(gitSpec(repo, pinned), { reference: 'not the fix\n' }));
    expect(run.code).toBe(1);
    expect(run.result.failedStep).toBe('reference');
    expect(run.result.reference).toMatchObject({ accepted: false });
  });

  test('a null reference solution is recorded as not-applicable', () => {
    const { repo, pinned } = makeRepo();
    const run = check(makeTask(gitSpec(repo, pinned), { reference: null }));
    expect(run.code).toBe(0);
    expect(run.result.reference).toBe('not-applicable');
    expect(run.result.passed).toBe(true);
  });

  test('a container check tears down after success', () => {
    const run = check(makeTask(containerSpec()));
    expect(run.code).toBe(0);
    expect(run.result.passed).toBe(true);
    expect(tornDown()).toBe(true);
    expectOnlyAllowedCommands();
  });

  test('a refused container check (digest mismatch) tears down and names the step', () => {
    writeFileSync(join(bin, 'image.json'), JSON.stringify([{ Id: IMAGE_ID, RepoDigests: [] }]));
    const run = check(makeTask(containerSpec()));
    expect(run.code).toBe(1);
    expect(run.result.failedStep).toBe('provision');
    expect(run.result.provision).toContain('image digest mismatch');
    expect(tornDown()).toBe(true);
    expectOnlyAllowedCommands();
  });

  test('a container check that throws mid-provision still tears down', () => {
    writeFileSync(join(bin, 'container.json'), 'not json');
    const run = check(makeTask(containerSpec()));
    expect(run.code).toBe(1);
    expect(run.result.failedStep).toBe('provision');
    expect(tornDown()).toBe(true);
  });
});
