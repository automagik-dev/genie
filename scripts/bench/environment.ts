/**
 * Genie Bench — source-native task environment provisioning (wish genie-bench, Group 9).
 *
 * One module owns the lifecycle every attempt and verifier run uses. It reads the
 * original instruction by digest, provisions each task through the source's own
 * declared mechanism, hands back a `SolverTarget`, and tears the environment down
 * on every exit path. It never re-implements an environment.
 *
 * Commands this module runs belong to exactly three sets:
 *   1. the task's own argv: `environment.provision`, `environment.teardown`, `verifier.command`;
 *   2. `git clone` / `git checkout` for a `git-checkout` environment;
 *   3. the frozen, read-only `INSPECT_COMMANDS`.
 *
 * `runSourceVerifier` is the only executor of `task.verifier.command`. It accepts only by
 * `acceptWhen`: process exit 0 alone never accepts, and no threshold converts a fractional
 * reward. The verifier runs in a verifier-only copy holding the collected artifact (plus the
 * reference solution during the `check` sanity step), never inside a solver target.
 *
 * CLI: bun scripts/bench/environment.ts check --root <dir> --manifest <file> --sources <dir> --task <key>
 * Exit 0 ok, 1 not ok, 2 refusal (nothing written).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import {
  type EnvironmentSpec,
  type EvidenceRef,
  type InstructionRef,
  type MonotonicClock,
  type Result,
  type SolverTarget,
  type TaskIdentity,
  hostClock,
  parseManifest,
  taskKey,
} from './contracts';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * The closed list of read-only inspect commands. Git entries take no operand; runtime
 * entries take exactly one (a container or image id). Frozen: never extended at runtime.
 */
export const INSPECT_COMMANDS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['git', 'rev-parse', 'HEAD'] as const),
  Object.freeze(['git', 'status', '--porcelain'] as const),
  Object.freeze(['docker', 'inspect'] as const),
  Object.freeze(['podman', 'inspect'] as const),
  Object.freeze(['docker', 'image', 'inspect'] as const),
  Object.freeze(['podman', 'image', 'inspect'] as const),
]);

export interface ProvisionedEnvironment {
  attemptId: string;
  solver: SolverTarget;
  artifactPath: string;
  image: { ref: string; digest: string } | null;
  resources: EnvironmentSpec['resources'];
  evidence: EvidenceRef[];
}

export interface VerifierCopy {
  cwd: string;
  containerId: string | null;
  artifact: EvidenceRef;
}

export interface VerifierReceipt {
  exitCode: number | null;
  reward: number | null;
  accepted: boolean;
  artifact: EvidenceRef;
  output: EvidenceRef;
  startedMonotonicNs: string;
  endedMonotonicNs: string;
}

type CheckStep = 'instruction' | 'provision' | 'untouched' | 'reference' | 'teardown';

export interface EnvironmentCheck {
  taskKey: string;
  instruction: 'ok' | string;
  provision: 'ok' | string;
  untouched: VerifierReceipt | null;
  reference: VerifierReceipt | 'not-applicable' | null;
  passed: boolean;
  /** The first step that failed; null when every applicable step passed. */
  failedStep: CheckStep | null;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const fail = <T>(...issues: string[]): Result<T> => ({ ok: false, issues });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OPERAND = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BYTES_PER_MB = 1024 * 1024;
const NANOS_PER_CPU = 1_000_000_000;

function evidenceFor(kind: string, path: string): EvidenceRef {
  const bytes = readFileSync(path);
  return { kind, path, sha256: sha256Of(bytes), bytes: bytes.byteLength };
}

function writeEvidence(kind: string, path: string, content: string | Uint8Array): EvidenceRef {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return evidenceFor(kind, path);
}

/** True when `path` is `base` itself or lies under it. */
function isWithin(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolves a relative path under `base`; null for an absolute path or one that escapes. */
function resolveInside(base: string, rel: string, allowSelf: boolean): string | null {
  if (rel.length === 0 || isAbsolute(rel)) return null;
  const target = resolve(base, rel);
  if (!isWithin(resolve(base), target)) return null;
  if (!allowSelf && target === resolve(base)) return null;
  return target;
}

/** The nearest ancestor of this module holding a `.git` entry: the Genie checkout. */
function genieCheckoutRoot(): string | null {
  let dir = import.meta.dir;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Every environment, verifier copy and check lives outside the Genie checkout. */
function rootIssue(root: string): string | null {
  if (root.length === 0) return 'root is empty';
  const checkout = genieCheckoutRoot();
  if (checkout === null) return null;
  const candidates = [resolve(root), realOrSelf(resolve(root))];
  const bases = [checkout, realOrSelf(checkout)];
  for (const base of bases) {
    for (const candidate of candidates) {
      if (isWithin(base, candidate)) return `root ${root} is inside the Genie checkout ${checkout}`;
    }
  }
  return null;
}

function targetIssues(root: string, attemptId: string, sourcesDir: string): string[] {
  const issues: string[] = [];
  const bad = rootIssue(root);
  if (bad !== null) issues.push(bad);
  if (!SAFE_ID.test(attemptId)) issues.push(`attemptId "${attemptId}" is not a safe path segment`);
  if (!existsSync(sourcesDir) || !statSync(sourcesDir).isDirectory()) {
    issues.push(`sources directory ${sourcesDir} does not exist`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

interface Exec {
  /** null when the process was killed at its timeout. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one argv exactly as given. Spawn failures throw; callers decide what that means. */
async function execArgv(argv: readonly string[], cwd: string, timeoutMs: number | null = null): Promise<Exec> {
  const proc = Bun.spawn([...argv], {
    cwd,
    env: { ...process.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer =
    timeoutMs === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode: timedOut ? null : code, stdout, stderr };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** The INSPECT_COMMANDS entry `argv` starts with, and whether its operands are legal. */
function inspectEntryFor(argv: readonly string[]): readonly string[] | null {
  for (const entry of INSPECT_COMMANDS) {
    if (entry.length > argv.length || !entry.every((token, i) => argv[i] === token)) continue;
    const operands = argv.slice(entry.length);
    const legal = entry[0] === 'git' ? operands.length === 0 : operands.length === 1 && OPERAND.test(operands[0]);
    return legal ? entry : null;
  }
  return null;
}

/**
 * Runs one read-only inspect command. Anything that is not an INSPECT_COMMANDS entry
 * (plus its single operand, for a runtime entry) is refused before a process starts.
 */
export async function runInspect(argv: readonly string[], cwd: string): Promise<Result<string>> {
  if (inspectEntryFor(argv) === null) {
    return fail(`inspect command refused: [${argv.join(' ')}] is not in INSPECT_COMMANDS`);
  }
  const run = await execArgv(argv, cwd);
  if (run.exitCode !== 0) return fail(`[${argv.join(' ')}] exited ${run.exitCode}: ${firstLine(run.stderr)}`);
  return { ok: true, value: run.stdout };
}

/** Selects the runtime's inspect entry from the frozen list and appends the one operand. */
function inspectArgv(runtime: string, what: 'container' | 'image', operand: string): string[] | null {
  const entry = INSPECT_COMMANDS.find(
    (c) => c[0] === runtime && (what === 'container' ? c.length === 2 && c[1] === 'inspect' : c[1] === 'image'),
  );
  return entry === undefined ? null : [...entry, operand];
}

const hasInspectRuntime = (runtime: string | undefined): boolean =>
  runtime !== undefined && inspectArgv(runtime, 'container', 'x') !== null;

// ---------------------------------------------------------------------------
// Source package reads
// ---------------------------------------------------------------------------

function readPackageFile(
  ref: InstructionRef,
  sourcesDir: string,
  label: string,
): Result<{ bytes: Uint8Array; path: string }> {
  if (!existsSync(sourcesDir)) return fail(`sources directory ${sourcesDir} does not exist`);
  const target = resolveInside(sourcesDir, ref.path, false);
  if (target === null) return fail(`${label}.path "${ref.path}" resolves outside the source package`);
  if (!existsSync(target)) return fail(`${label}.path "${ref.path}" does not exist in the source package`);
  const real = realpathSync(target);
  if (!isWithin(realpathSync(sourcesDir), real)) {
    return fail(`${label}.path "${ref.path}" resolves outside the source package through a link`);
  }
  if (!lstatSync(real).isFile()) return fail(`${label}.path "${ref.path}" is not a regular file`);
  const bytes = readFileSync(real);
  const digest = sha256Of(bytes);
  if (digest !== ref.sha256) return fail(`${label} sha256 mismatch: declared ${ref.sha256}, read ${digest}`);
  return { ok: true, value: { bytes, path: real } };
}

/** Reads the original instruction from the pinned package; refuses a digest mismatch or an escaping path. */
export function readInstruction(task: TaskIdentity, sourcesDir: string): Result<{ text: string; ref: EvidenceRef }> {
  const read = readPackageFile(task.instruction, sourcesDir, 'instruction');
  if (!read.ok) return read;
  const { bytes, path } = read.value;
  return {
    ok: true,
    value: {
      text: new TextDecoder().decode(bytes),
      ref: { kind: 'instruction', path, sha256: task.instruction.sha256, bytes: bytes.byteLength },
    },
  };
}

// ---------------------------------------------------------------------------
// Teardown plans
// ---------------------------------------------------------------------------

/** What tearing an environment down means, persisted at provisioning time. */
interface TeardownPlan {
  /** A directory this module created and removes (a clone or a verifier copy). */
  removeDir: string | null;
  /** The source-declared teardown argv, verbatim. */
  teardown: string[] | null;
  teardownCwd: string;
}

async function runTeardownPlan(plan: TeardownPlan): Promise<string[]> {
  const issues: string[] = [];
  try {
    if (plan.teardown !== null) {
      const run = await execArgv(plan.teardown, plan.teardownCwd);
      if (run.exitCode !== 0) issues.push(`teardown exited ${run.exitCode}: ${firstLine(run.stderr)}`);
    }
  } catch (e) {
    issues.push(`teardown did not run: ${message(e)}`);
  } finally {
    if (plan.removeDir !== null) rmSync(plan.removeDir, { recursive: true, force: true });
  }
  return issues;
}

function parsePlan(raw: unknown): TeardownPlan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { removeDir, teardown, teardownCwd } = raw as Record<string, unknown>;
  const dirOk = removeDir === null || typeof removeDir === 'string';
  const argvOk = teardown === null || (Array.isArray(teardown) && teardown.every((t) => typeof t === 'string'));
  if (!dirOk || !argvOk || typeof teardownCwd !== 'string') return null;
  return { removeDir, teardown, teardownCwd } as TeardownPlan;
}

/**
 * Runs `body`; on a refusal or a thrown error the plan's teardown runs before the
 * refusal is returned. On success the caller owns teardown.
 */
async function withTeardownOnFailure<T>(plan: TeardownPlan, body: () => Promise<Result<T>>): Promise<Result<T>> {
  let outcome: Result<T>;
  try {
    outcome = await body();
  } catch (e) {
    outcome = fail(`threw: ${message(e)}`);
  }
  if (outcome.ok) return outcome;
  const teardownIssues = await runTeardownPlan(plan);
  return fail(...outcome.issues, ...teardownIssues.map((i) => `teardown: ${i}`));
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

function specIssues(spec: EnvironmentSpec): string[] {
  if (spec.kind === 'git-checkout') {
    const issues: string[] = [];
    if (spec.repository === null) issues.push('git-checkout declares no repository');
    else if (!FULL_COMMIT.test(spec.repository.commit)) {
      issues.push(`repository.commit "${spec.repository.commit}" is not a full commit id`);
    }
    if (spec.provision !== null || spec.teardown !== null) {
      issues.push('git-checkout declares a provision/teardown argv; refusing rather than skipping it');
    }
    return issues;
  }
  const issues: string[] = [];
  if (spec.provision === null) issues.push('source-container declares no provision argv');
  else if (!hasInspectRuntime(spec.provision[0])) {
    issues.push(
      `provision runtime "${spec.provision[0]}" has no INSPECT_COMMANDS entry; its limits cannot be read back`,
    );
  }
  if (spec.image === null) issues.push('source-container declares no image digest');
  return issues;
}

interface ContainerRecord {
  Image?: unknown;
  HostConfig?: { NanoCpus?: unknown; CpuQuota?: unknown; CpuPeriod?: unknown; Memory?: unknown; NetworkMode?: unknown };
}

const positive = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null);

function firstRecord(stdout: string, what: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'object' || parsed[0] === null) {
    throw new Error(`${what} inspect returned no record`);
  }
  return parsed[0] as Record<string, unknown>;
}

function observedLimits(record: ContainerRecord): {
  cpus: number | null;
  memoryMb: number | null;
  network: string | null;
} {
  const host = record.HostConfig ?? {};
  const nano = positive(host.NanoCpus);
  const quota = positive(host.CpuQuota);
  const period = positive(host.CpuPeriod);
  const cpus = nano !== null ? nano / NANOS_PER_CPU : quota !== null && period !== null ? quota / period : null;
  const memory = positive(host.Memory);
  return {
    cpus,
    memoryMb: memory === null ? null : memory / BYTES_PER_MB,
    network: typeof host.NetworkMode === 'string' ? host.NetworkMode : null,
  };
}

function limitIssues(declared: EnvironmentSpec['resources'], observed: ReturnType<typeof observedLimits>): string[] {
  if (declared === null) return [];
  const issues: string[] = [];
  for (const key of ['cpus', 'memoryMb', 'network'] as const) {
    const want = declared[key];
    if (want !== null && observed[key] !== want) {
      issues.push(`resource ${key} mismatch: declared ${want}, observed ${observed[key]}`);
    }
  }
  return issues;
}

interface ContainerObservation {
  containerId: string;
  runtime: string;
  digest: string;
  limits: ReturnType<typeof observedLimits>;
  provisionStdout: string;
}

/**
 * Runs the source-declared provision argv verbatim from the package dir, then reads the
 * image digest and limits back through INSPECT_COMMANDS on the runtime that argv names.
 * The container id is the last non-empty stdout line (what `docker run -d` prints).
 */
async function provisionContainer(spec: EnvironmentSpec, sourcesDir: string): Promise<Result<ContainerObservation>> {
  const provision = spec.provision as string[];
  const image = spec.image as { ref: string; digest: string };
  const runtime = provision[0];
  const run = await execArgv(provision, sourcesDir);
  if (run.exitCode !== 0) return fail(`provision exited ${run.exitCode}: ${firstLine(run.stderr)}`);
  const containerId = run.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!OPERAND.test(containerId)) return fail(`provision printed no container id (got "${containerId}")`);

  const containerArgv = inspectArgv(runtime, 'container', containerId);
  if (containerArgv === null) return fail(`no inspect entry for runtime ${runtime}`);
  const containerOut = await runInspect(containerArgv, sourcesDir);
  if (!containerOut.ok) return containerOut;
  const record = firstRecord(containerOut.value, 'container') as ContainerRecord;
  if (typeof record.Image !== 'string') return fail('container inspect names no image');

  const imageArgv = inspectArgv(runtime, 'image', record.Image);
  if (imageArgv === null) return fail(`no image inspect entry for runtime ${runtime}`);
  const imageOut = await runInspect(imageArgv, sourcesDir);
  if (!imageOut.ok) return imageOut;
  const repoDigests = firstRecord(imageOut.value, 'image').RepoDigests;
  const digests = Array.isArray(repoDigests)
    ? repoDigests.filter((d): d is string => typeof d === 'string').map((d) => d.slice(d.lastIndexOf('@') + 1))
    : [];

  const limits = observedLimits(record);
  const issues: string[] = [];
  if (!digests.includes(image.digest)) {
    issues.push(`image digest mismatch: declared ${image.digest}, observed [${digests.join(', ')}]`);
  }
  issues.push(...limitIssues(spec.resources, limits));
  if (issues.length > 0) return fail(...issues);
  return { ok: true, value: { containerId, runtime, digest: image.digest, limits, provisionStdout: run.stdout } };
}

async function provisionCheckout(
  envDir: string,
  task: TaskIdentity,
  plan: TeardownPlan,
  planRef: EvidenceRef,
  attemptId: string,
): Promise<Result<ProvisionedEnvironment>> {
  const spec = task.environment;
  const repository = spec.repository as { url: string; commit: string };
  const cloneDir = plan.removeDir as string;
  const clone = await execArgv(['git', 'clone', '--quiet', '--', repository.url, cloneDir], envDir);
  if (clone.exitCode !== 0) return fail(`git clone exited ${clone.exitCode}: ${firstLine(clone.stderr)}`);
  const checkout = await execArgv(['git', 'checkout', '--quiet', '--detach', repository.commit], cloneDir);
  if (checkout.exitCode !== 0) return fail(`git checkout exited ${checkout.exitCode}: ${firstLine(checkout.stderr)}`);

  const head = await runInspect(['git', 'rev-parse', 'HEAD'], cloneDir);
  if (!head.ok) return head;
  if (head.value.trim() !== repository.commit) {
    return fail(`HEAD mismatch: declared ${repository.commit}, observed ${head.value.trim()}`);
  }
  const status = await runInspect(['git', 'status', '--porcelain'], cloneDir);
  if (!status.ok) return status;
  if (status.value.trim().length > 0) return fail('the clone is not clean after checkout');

  const solverCwd = resolveInside(cloneDir, spec.solverPath, true);
  const artifactPath = resolveInside(cloneDir, spec.artifactPath, false);
  if (solverCwd === null) return fail(`solverPath "${spec.solverPath}" resolves outside the clone`);
  if (artifactPath === null) return fail(`artifactPath "${spec.artifactPath}" resolves outside the clone`);

  const observation = writeEvidence(
    'provision-observation',
    join(envDir, 'provision.json'),
    `${JSON.stringify({ kind: spec.kind, head: repository.commit, clean: true }, null, 2)}\n`,
  );
  return {
    ok: true,
    value: {
      attemptId,
      solver: { kind: 'host', cwd: solverCwd },
      artifactPath,
      image: null,
      resources: spec.resources,
      evidence: [planRef, observation],
    },
  };
}

async function provisionSourceContainer(
  envDir: string,
  task: TaskIdentity,
  sourcesDir: string,
  planRef: EvidenceRef,
  attemptId: string,
): Promise<Result<ProvisionedEnvironment>> {
  const spec = task.environment;
  const observed = await provisionContainer(spec, sourcesDir);
  if (!observed.ok) return observed;
  const { containerId, digest } = observed.value;
  const observation = writeEvidence(
    'provision-observation',
    join(envDir, 'provision.json'),
    `${JSON.stringify({ kind: spec.kind, ...observed.value }, null, 2)}\n`,
  );
  return {
    ok: true,
    value: {
      attemptId,
      solver: { kind: 'container', containerId, cwd: spec.solverPath },
      artifactPath: spec.artifactPath,
      image: { ref: (spec.image as { ref: string }).ref, digest },
      resources: spec.resources,
      evidence: [planRef, observation],
    },
  };
}

/**
 * Provisions the task through its source-declared mechanism into `<root>/environments/<attemptId>/`.
 * A refusal or a thrown error tears down whatever was started before returning.
 */
export async function provisionEnvironment(
  root: string,
  attemptId: string,
  task: TaskIdentity,
  sourcesDir: string,
): Promise<Result<ProvisionedEnvironment>> {
  const issues = [...targetIssues(root, attemptId, sourcesDir), ...specIssues(task.environment)];
  if (issues.length > 0) return fail(...issues);

  const envDir = join(resolve(root), 'environments', attemptId);
  try {
    mkdirSync(dirname(envDir), { recursive: true });
    mkdirSync(envDir);
  } catch (e) {
    return fail(`cannot create a fresh environment directory ${envDir}: ${message(e)}`);
  }
  const isCheckout = task.environment.kind === 'git-checkout';
  const plan: TeardownPlan = {
    removeDir: isCheckout ? join(envDir, 'solver') : null,
    teardown: isCheckout ? null : task.environment.teardown,
    teardownCwd: resolve(sourcesDir),
  };
  const planRef = writeEvidence('environment-plan', join(envDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return withTeardownOnFailure(plan, () =>
    isCheckout
      ? provisionCheckout(envDir, task, plan, planRef, attemptId)
      : provisionSourceContainer(envDir, task, resolve(sourcesDir), planRef, attemptId),
  );
}

/** Runs the plan recorded at provisioning: the source teardown argv, or removal of the clone. */
export async function teardownEnvironment(env: ProvisionedEnvironment): Promise<Result<void>> {
  const ref = env.evidence.find((e) => e.kind === 'environment-plan');
  if (ref === undefined) return fail('the environment carries no environment-plan evidence');
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(ref.path);
  } catch (e) {
    return fail(`cannot read the environment plan: ${message(e)}`);
  }
  if (sha256Of(bytes) !== ref.sha256)
    return fail('the environment plan changed since provisioning; refusing to run it');
  let plan: TeardownPlan | null = null;
  try {
    plan = parsePlan(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    plan = null;
  }
  if (plan === null) return fail('the environment plan is malformed');
  const issues = await runTeardownPlan(plan);
  return issues.length > 0 ? fail(...issues) : { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Verifier copies and the verifier
// ---------------------------------------------------------------------------

/** Where the artifact sits inside a verifier copy: the source's artifactPath, made relative. */
function artifactLayout(cwd: string, artifactPath: string): string | null {
  const rel = normalize(artifactPath.replace(/^\/+/, ''));
  return resolveInside(cwd, rel, false);
}

function artifactIssue(artifact: EvidenceRef): string | null {
  if (!existsSync(artifact.path) || !lstatSync(artifact.path).isFile()) {
    return `artifact ${artifact.path} is not a regular file`;
  }
  const digest = sha256Of(readFileSync(artifact.path));
  return digest === artifact.sha256 ? null : `artifact sha256 mismatch: expected ${artifact.sha256}, read ${digest}`;
}

/**
 * Builds a fresh verifier-only copy under `<root>/verifiers/<attemptId>/` holding only the
 * collected artifact. For `source-container-fresh` it also provisions a fresh source container
 * through the declared argv. It is never placed in or mounted into a solver target.
 */
export async function provisionVerifierCopy(
  root: string,
  attemptId: string,
  task: TaskIdentity,
  sourcesDir: string,
  artifact: EvidenceRef,
): Promise<Result<VerifierCopy>> {
  const issues = targetIssues(root, attemptId, sourcesDir);
  const bad = artifactIssue(artifact);
  if (bad !== null) issues.push(bad);
  const fresh = task.verifier.runsIn === 'source-container-fresh';
  if (fresh) issues.push(...specIssues(task.environment));
  if (fresh && task.environment.kind !== 'source-container') {
    issues.push('a source-container-fresh verifier needs a source-container environment');
  }
  if (issues.length > 0) return fail(...issues);

  const base = join(resolve(root), 'verifiers', attemptId);
  mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, 'copy-'));
  const plan: TeardownPlan = {
    removeDir: cwd,
    teardown: fresh ? task.environment.teardown : null,
    teardownCwd: resolve(sourcesDir),
  };
  return withTeardownOnFailure(plan, async () => {
    const dest = artifactLayout(cwd, task.environment.artifactPath);
    if (dest === null) return fail(`artifactPath "${task.environment.artifactPath}" has no place in a verifier copy`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(artifact.path, dest);
    const copied = evidenceFor(artifact.kind, dest);
    if (!fresh) return { ok: true, value: { cwd, containerId: null, artifact: copied } };
    const container = await provisionContainer(task.environment, resolve(sourcesDir));
    if (!container.ok) return container;
    return { ok: true, value: { cwd, containerId: container.value.containerId, artifact: copied } };
  });
}

async function disposeVerifierCopy(copy: VerifierCopy, task: TaskIdentity, sourcesDir: string): Promise<string[]> {
  return runTeardownPlan({
    removeDir: copy.cwd,
    teardown: copy.containerId === null ? null : task.environment.teardown,
    teardownCwd: resolve(sourcesDir),
  });
}

/** A reward is a plain decimal number; anything else is unknown (null). */
function parseReward(text: string): number | null {
  const trimmed = text.trim();
  return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * The only executor of `task.verifier.command`. Runs it unchanged in the verifier copy,
 * reads the reward from `rewardFile`, and accepts only by `acceptWhen`.
 */
export async function runSourceVerifier(
  task: TaskIdentity,
  copy: VerifierCopy,
  artifact: EvidenceRef,
  clock: MonotonicClock,
): Promise<Result<VerifierReceipt>> {
  const verifier = task.verifier;
  if (copy.artifact.sha256 !== artifact.sha256) {
    return fail(`verifier copy artifact sha256 ${copy.artifact.sha256} differs from the collected ${artifact.sha256}`);
  }
  const onDisk = artifactIssue(copy.artifact);
  if (onDisk !== null) return fail(`verifier copy: ${onDisk}`);
  if (verifier.acceptWhen !== 'binary-one') {
    return fail(`acceptWhen "${verifier.acceptWhen}" names no rule this module can evaluate; refusing to guess one`);
  }
  const rewardPath = verifier.rewardFile === null ? null : resolveInside(copy.cwd, verifier.rewardFile, false);
  if (verifier.rewardFile !== null && rewardPath === null) {
    return fail(`rewardFile "${verifier.rewardFile}" resolves outside the verifier copy`);
  }
  if (rewardPath !== null && existsSync(rewardPath)) {
    return fail(`rewardFile "${verifier.rewardFile}" exists before the verifier ran`);
  }

  const started = clock.nowNs();
  let run: Exec;
  try {
    run = await execArgv(verifier.command, copy.cwd, verifier.timeoutSec === null ? null : verifier.timeoutSec * 1000);
  } catch (e) {
    return fail(`verifier did not start: ${message(e)}`);
  }
  const ended = clock.nowNs();

  const output = writeEvidence(
    'verifier-output',
    `${copy.cwd}.verifier-output.log`,
    `exit: ${run.exitCode}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`,
  );
  const reward = rewardPath !== null && existsSync(rewardPath) ? parseReward(readFileSync(rewardPath, 'utf8')) : null;
  return {
    ok: true,
    value: {
      exitCode: run.exitCode,
      reward,
      // binary-one: only a reward of exactly 1 accepts; the exit code never does.
      accepted: reward === 1,
      artifact: copy.artifact,
      output,
      startedMonotonicNs: started.toString(),
      endedMonotonicNs: ended.toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// check: provision, verifier sanity step, teardown
// ---------------------------------------------------------------------------

/**
 * The artifact an untouched solver hands back: the bytes at artifactPath on a host target
 * (empty when absent), and empty for a container target, which no allowed command reads.
 */
function collectUntouchedArtifact(env: ProvisionedEnvironment, dest: string): EvidenceRef {
  if (env.solver.kind === 'host' && existsSync(env.artifactPath)) {
    if (!lstatSync(env.artifactPath).isFile()) throw new Error(`artifact ${env.artifactPath} is not a regular file`);
    return writeEvidence('artifact', dest, readFileSync(env.artifactPath));
  }
  return writeEvidence('artifact', dest, '');
}

async function verifyIn(
  root: string,
  attemptId: string,
  task: TaskIdentity,
  sourcesDir: string,
  artifact: EvidenceRef,
  clock: MonotonicClock,
): Promise<Result<VerifierReceipt>> {
  const copy = await provisionVerifierCopy(root, attemptId, task, sourcesDir, artifact);
  if (!copy.ok) return copy;
  let receipt: Result<VerifierReceipt> = fail('verifier did not run');
  try {
    receipt = await runSourceVerifier(task, copy.value, artifact, clock);
  } finally {
    const disposeIssues = await disposeVerifierCopy(copy.value, task, sourcesDir);
    if (disposeIssues.length > 0) receipt = fail(...(receipt.ok ? [] : receipt.issues), ...disposeIssues);
  }
  return receipt;
}

interface CheckRun {
  root: string;
  attemptId: string;
  checkDir: string;
  task: TaskIdentity;
  sourcesDir: string;
  clock: MonotonicClock;
  check: EnvironmentCheck;
  step: CheckStep;
  env: ProvisionedEnvironment | null;
}

function failStep(run: CheckRun, step: CheckStep, issues: string[]): void {
  if (run.check.failedStep === null) run.check.failedStep = step;
  run.check.issues.push(...issues.map((i) => `${step}: ${i}`));
}

/** The sanity sequence; the first failing step returns, and runCheck owns teardown. */
async function sanitySteps(run: CheckRun): Promise<void> {
  const { root, attemptId, checkDir, task, sourcesDir, clock, check } = run;
  const instruction = readInstruction(task, sourcesDir);
  check.instruction = instruction.ok ? 'ok' : instruction.issues.join('; ');
  if (!instruction.ok) return failStep(run, 'instruction', instruction.issues);

  run.step = 'provision';
  const provisioned = await provisionEnvironment(root, attemptId, task, sourcesDir);
  check.provision = provisioned.ok ? 'ok' : provisioned.issues.join('; ');
  if (!provisioned.ok) return failStep(run, 'provision', provisioned.issues);
  run.env = provisioned.value;

  run.step = 'untouched';
  const untouchedArtifact = collectUntouchedArtifact(run.env, join(checkDir, 'untouched.artifact'));
  // The solver environment is done once its artifact is collected: no verifier copy coexists with it.
  const down = await teardownEnvironment(run.env);
  run.env = null;
  if (!down.ok) return failStep(run, 'teardown', down.issues);
  const untouched = await verifyIn(root, attemptId, task, sourcesDir, untouchedArtifact, clock);
  if (!untouched.ok) return failStep(run, 'untouched', untouched.issues);
  check.untouched = untouched.value;
  if (untouched.value.accepted) return failStep(run, 'untouched', ['the verifier accepted the untouched artifact']);

  run.step = 'reference';
  if (task.referenceSolution === null) {
    check.reference = 'not-applicable';
    return;
  }
  const reference = readPackageFile(task.referenceSolution, sourcesDir, 'referenceSolution');
  if (!reference.ok) return failStep(run, 'reference', reference.issues);
  const referenceArtifact = writeEvidence(
    'reference-solution',
    join(checkDir, 'reference.artifact'),
    reference.value.bytes,
  );
  const applied = await verifyIn(root, attemptId, task, sourcesDir, referenceArtifact, clock);
  if (!applied.ok) return failStep(run, 'reference', applied.issues);
  check.reference = applied.value;
  if (!applied.value.accepted)
    return failStep(run, 'reference', ['the verifier did not accept the reference solution']);
}

async function runCheck(
  root: string,
  task: TaskIdentity,
  sourcesDir: string,
  clock: MonotonicClock,
): Promise<{ check: EnvironmentCheck; path: string }> {
  const attemptId = `check-${randomUUID()}`;
  const run: CheckRun = {
    root,
    attemptId,
    checkDir: join(resolve(root), 'checks', attemptId),
    task,
    sourcesDir,
    clock,
    check: {
      taskKey: taskKey(task),
      instruction: 'not-run',
      provision: 'not-run',
      untouched: null,
      reference: null,
      passed: false,
      failedStep: null,
      issues: [],
    },
    step: 'instruction',
    env: null,
  };
  try {
    await sanitySteps(run);
  } catch (e) {
    failStep(run, run.step, [`threw: ${message(e)}`]);
  } finally {
    if (run.env !== null) {
      const down = await teardownEnvironment(run.env);
      if (!down.ok) failStep(run, 'teardown', down.issues);
    }
  }
  run.check.passed = run.check.failedStep === null;
  const path = join(resolve(root), 'checks', `${attemptId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(run.check, null, 2)}\n`);
  return { check: run.check, path };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  'usage: bun scripts/bench/environment.ts check --root <dir> --manifest <file> --sources <dir> --task <key>\n';
const CHECK_FLAGS = ['--root', '--manifest', '--sources', '--task'] as const;
type CheckFlags = Record<(typeof CHECK_FLAGS)[number], string>;

function parseCheckFlags(argv: readonly string[]): Result<CheckFlags> {
  const seen = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!(CHECK_FLAGS as readonly string[]).includes(flag)) return fail(`unknown argument ${flag}`);
    if (seen.has(flag)) return fail(`${flag} given twice`);
    if (value === undefined || value.length === 0 || value.startsWith('--')) return fail(`${flag} needs a value`);
    seen.set(flag, value);
  }
  const missing = CHECK_FLAGS.filter((f) => !seen.has(f));
  if (missing.length > 0) return fail(`missing ${missing.join(', ')}`);
  return { ok: true, value: Object.fromEntries(seen) as CheckFlags };
}

function loadTask(manifestPath: string, key: string): Result<TaskIdentity> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return fail(`cannot read manifest ${manifestPath}: ${message(e)}`);
  }
  const manifest = parseManifest(raw);
  if (!manifest.ok) return fail(...manifest.issues.map((i) => `manifest: ${i}`));
  const task = [...manifest.value.selected, ...manifest.value.smoke].find((t) => taskKey(t) === key);
  return task === undefined ? fail(`task ${key} is not in the manifest`) : { ok: true, value: task };
}

async function runEnvironmentCli(argv: readonly string[]): Promise<number> {
  const refuse = (issues: string[]): number => {
    process.stderr.write(`${issues.map((i) => `environment: ${i}`).join('\n')}\n${USAGE}`);
    return 2;
  };
  const [verb, ...rest] = argv;
  if (verb !== 'check') return refuse([`unknown verb ${verb ?? '(none)'}`]);
  const flags = parseCheckFlags(rest);
  if (!flags.ok) return refuse(flags.issues);
  const { '--root': root, '--manifest': manifestPath, '--sources': sourcesDir, '--task': key } = flags.value;
  const bad = rootIssue(root);
  if (bad !== null) return refuse([bad]);
  if (!existsSync(sourcesDir) || !statSync(sourcesDir).isDirectory()) {
    return refuse([`sources directory ${sourcesDir} does not exist`]);
  }
  const task = loadTask(manifestPath, key);
  if (!task.ok) return refuse(task.issues);

  const { check, path } = await runCheck(root, task.value, sourcesDir, hostClock);
  process.stdout.write(`${path}\n`);
  if (!check.passed) process.stderr.write(`check failed at ${check.failedStep}:\n${check.issues.join('\n')}\n`);
  return check.passed ? 0 : 1;
}

if (import.meta.main) {
  runEnvironmentCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
