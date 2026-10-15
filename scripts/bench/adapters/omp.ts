/**
 * Genie Bench — the visible native OMP adapter.
 *
 * Runs the stock interactive OMP client on a genuine PTY the operator can attach to: one tmux
 * server per attempt on its own `-L <attemptId>` socket, launched from an argv array holding only
 * the executable and the prompt: no shell string, no headless or scripted mode flag, no piped
 * stdin. The terminal is an injected `TerminalHost`, so tests drive a fake one.
 *
 * Every discovery and capture root is built from the attempt's `nativeHome` and workspace
 * arguments. The launch environment is an explicit allowlist with HOME set to the native home,
 * so no outer session id, credential or route is inherited; provider authentication is the
 * operator's provisioning (P3), never a value this file carries.
 *
 * Honesty rules: the zero-genie arm launches only after the canary inventories its discovery
 * roots clean; the genie arm launches only after every `TreatmentPin` resource hashes equal in
 * the native home (installing them there is the pinned `genie-omp` contract's job, P4). A
 * capability is `proven` only by an `EvidenceRef` to captured native output, and the client's
 * running settled state is `unsupported` until upstream exposes one.
 */
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { type CaptureBundle, captureOmpAttempt } from '../capture';
import {
  type AdapterContext,
  type ArmId,
  type ArtifactTransport,
  type CapabilityReport,
  type EvidenceRef,
  type LaunchHandle,
  type NativeAdapter,
  type Result,
  type SettledResult,
  type StopReceipt,
  type TreatmentPin,
  hostClock,
} from '../contracts';

export interface TerminalHost {
  start(argv: string[], env: Record<string, string>, cwd: string, session: string): Promise<void>;
  alive(session: string): Promise<boolean>;
  kill(session: string): Promise<void>;
  version(): Promise<string | null>;
}

/** Session names double as tmux socket names: a plain path segment, nothing a socket path can escape with. */
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Keys copied from the supervisor's environment by name; everything else is dropped. */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'USER',
  'LOGNAME',
];

/** Session logs read per capture; a larger tree is truncated and its usage marked uncertain. */
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

/** Pause between two settled polls while the client still runs, cut short by the supervisor's abort. */
const SETTLED_POLL_MS = 1000;

/** Directory names in a workspace the client (or a tool it emulates) discovers resources from. */
const WORKSPACE_DISCOVERY_DIRS: readonly string[] = [
  '.omp',
  '.pi',
  '.agents',
  '.claude',
  '.codex',
  '.gemini',
  '.cursor',
  '.genie',
  '.mikro',
];

/** Guidance files read from the workspace and every ancestor of it. */
const CONTEXT_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

/** A name or content that marks Genie material. */
const GENIE_MARKER = /genie/i;

/** Bounds on the canary walk: a hostile or huge tree fails closed instead of being skipped. */
const CANARY_MAX_DEPTH = 12;
const CANARY_MAX_ENTRIES = 20_000;
const CANARY_MAX_FILE_BYTES = 1024 * 1024;

const SETTLED_UPSTREAM =
  'OMP must expose a native settled signal for an interactive session that covers pending children and wakes, not only a lead yield';
const INPUT_ORIGIN_UPSTREAM =
  'OMP must record submission provenance (human, runner or peer) for user-role messages in its session log';
const CONTAINER_UPSTREAM =
  'a source-native way for the stock OMP client to act inside the source container (P5); none is proven, and the adapter invents none';

const sha256Of = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------
// Terminal host
// ---------------------------------------------------------------------------

/** The production launch argv: `tmux -L <session> new-session -d -s <session> -- <argv...>`. */
export function tmuxLaunchArgv(argv: readonly string[], session: string): string[] {
  return ['tmux', '-L', session, 'new-session', '-d', '-s', session, '--', ...argv];
}

function checkSession(session: string): void {
  if (!SESSION_NAME.test(session)) throw new Error(`refused: session '${session}' is not a safe socket name`);
}

/** The supervisor's PATH, picked by name, for the tmux client commands that need no other variable. */
function pathOnly(): Record<string, string> {
  const path = process.env.PATH;
  return path === undefined ? {} : { PATH: path };
}

/** Runs one tmux client command from an argv array; tmux itself is resolved on the given PATH. */
async function runTmux(
  args: readonly string[],
  env: Record<string, string>,
  cwd: string | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const tmux = Bun.which('tmux', { PATH: env.PATH ?? '' });
  if (tmux === null) throw new Error('tmux is not on PATH');
  const proc = Bun.spawn([tmux, ...args.slice(1)], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * One tmux server per attempt on its own `-L` socket. Its pane is a real PTY the operator can
 * attach to with `tmux -L <attemptId> attach`; the server exits when the client does.
 */
export const tmuxHost: TerminalHost = {
  async start(argv, env, cwd, session) {
    checkSession(session);
    if (argv.length === 0) throw new Error('refused: empty launch argv');
    const run = await runTmux(tmuxLaunchArgv(argv, session), env, cwd);
    if (run.code !== 0) throw new Error(`tmux new-session exited ${run.code}: ${run.stderr.trim()}`);
  },
  async alive(session) {
    checkSession(session);
    return (await runTmux(['tmux', '-L', session, 'has-session'], pathOnly(), undefined)).code === 0;
  },
  async kill(session) {
    checkSession(session);
    // A server that already exited answers non-zero here; the has-session probe below is the proof.
    await runTmux(['tmux', '-L', session, 'kill-server'], pathOnly(), undefined);
    const left = await runTmux(['tmux', '-L', session, 'has-session'], pathOnly(), undefined);
    if (left.code === 0) throw new Error(`tmux server on socket '${session}' survived kill-server`);
  },
  async version() {
    try {
      const run = await runTmux(['tmux', '-V'], pathOnly(), undefined);
      const text = run.stdout.trim();
      return run.code === 0 && text.length > 0 ? text : null;
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Discovery isolation and treatment verification
// ---------------------------------------------------------------------------

interface Walk {
  found: string[];
  entries: number;
}

/** Inspects one regular file: a Genie name or content is found; a file too large to read fails closed. */
function inspectFile(path: string, size: number, walk: Walk): void {
  if (size > CANARY_MAX_FILE_BYTES) {
    walk.found.push(`${path}: larger than ${CANARY_MAX_FILE_BYTES} bytes, not inspected`);
    return;
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    walk.found.push(`${path}: unreadable`);
    return;
  }
  if (GENIE_MARKER.test(text)) walk.found.push(`${path}: Genie content`);
}

/** Walks one discovery root without following a symlink; anything it cannot prove clean is found. */
function inspectTree(path: string, depth: number, walk: Walk, nameCounts = true): void {
  walk.entries += 1;
  if (walk.entries > CANARY_MAX_ENTRIES) return;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (nameCounts && GENIE_MARKER.test(basename(path))) walk.found.push(`${path}: Genie name`);
  if (stat.isSymbolicLink()) {
    walk.found.push(`${path}: symlink, not followed`);
  } else if (stat.isFile()) {
    inspectFile(path, stat.size, walk);
  } else if (stat.isDirectory()) {
    if (depth >= CANARY_MAX_DEPTH) {
      walk.found.push(`${path}: deeper than ${CANARY_MAX_DEPTH} levels, not inspected`);
      return;
    }
    let names: string[];
    try {
      names = readdirSync(path).sort();
    } catch {
      walk.found.push(`${path}: unreadable directory`);
      return;
    }
    for (const child of names) inspectTree(join(path, child), depth + 1, walk);
  } else {
    walk.found.push(`${path}: not a regular file or directory`);
  }
}

/** The workspace and each of its ancestors up to the filesystem root. */
function ancestry(workspace: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(workspace);
  for (;;) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

/**
 * Every root the canary inventories: the whole native home (first; its own directory name is
 * the attempt's, not a resource), the workspace's discovery dirs, and context files up the tree.
 */
function discoveryRoots(nativeHome: string, workspace: string): string[] {
  const roots = [resolve(nativeHome)];
  for (const name of WORKSPACE_DISCOVERY_DIRS) roots.push(join(resolve(workspace), name));
  for (const dir of ancestry(workspace)) for (const name of CONTEXT_FILES) roots.push(join(dir, name));
  return roots;
}

/**
 * Inventories every discovery root of the zero-genie arm. Clean only when no Genie skill,
 * guidance, agent/workflow catalog, plugin or state is present and nothing was left uninspected.
 */
export function zeroGenieCanary(nativeHome: string, workspace: string): { clean: boolean; found: string[] } {
  const walk: Walk = { found: [], entries: 0 };
  const [home, ...rest] = discoveryRoots(nativeHome, workspace);
  inspectTree(home, 0, walk, false);
  for (const root of rest) inspectTree(root, 0, walk);
  if (walk.entries > CANARY_MAX_ENTRIES) walk.found.push(`inventory exceeded ${CANARY_MAX_ENTRIES} entries`);
  return { clean: walk.found.length === 0, found: walk.found };
}

/** Reads a regular file without following a final symlink; null when it is anything else. */
function readRegular(path: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = readSync(fd, buffer, offset, stat.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** `rel` resolved under `base`, or null when it is absolute or climbs out of it. */
function inside(base: string, rel: string): string | null {
  if (rel.length === 0 || isAbsolute(rel)) return null;
  const full = resolve(base, normalize(rel));
  const back = relative(base, full);
  return back.length === 0 || back.startsWith('..') || isAbsolute(back) ? null : full;
}

/**
 * Verifies every pinned treatment resource in the native home by sha256. A resource that is
 * missing, reached through a symlink, outside the home or hashing differently is a refusal.
 */
export function verifyTreatment(pin: TreatmentPin, nativeHome: string): Result<void> {
  const entries = Object.entries(pin.resources);
  if (entries.length === 0) return { ok: false, issues: [`treatment ${pin.contract}: the pin names no resource`] };
  let home: string;
  try {
    home = realpathSync(nativeHome);
  } catch {
    return { ok: false, issues: [`treatment ${pin.contract}: native home ${nativeHome} does not exist`] };
  }
  const issues: string[] = [];
  for (const [rel, expected] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const full = inside(home, rel);
    if (full === null) {
      issues.push(`${rel}: resolves outside the native home`);
      continue;
    }
    let real: string | null = null;
    try {
      real = realpathSync(full);
    } catch {
      real = null;
    }
    if (real !== full) {
      issues.push(`${rel}: ${real === null ? 'missing' : 'reached through a symlink'}`);
      continue;
    }
    const bytes = readRegular(full);
    if (bytes === null) {
      issues.push(`${rel}: not a regular file`);
      continue;
    }
    const actual = sha256Of(bytes);
    if (actual !== expected) issues.push(`${rel}: sha256 ${actual} does not match the pinned ${expected}`);
  }
  return issues.length === 0
    ? { ok: true, value: undefined }
    : { ok: false, issues: issues.map((i) => `treatment ${pin.contract}: ${i}`) };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** The launch environment: allowlisted keys by name, HOME and the XDG roots inside the native home. */
function launchEnvironment(nativeHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = nativeHome;
  env.XDG_CONFIG_HOME = join(nativeHome, '.config');
  env.XDG_DATA_HOME = join(nativeHome, '.local', 'share');
  env.XDG_STATE_HOME = join(nativeHome, '.local', 'state');
  env.XDG_CACHE_HOME = join(nativeHome, '.cache');
  return env;
}

/** The configured executable as an absolute path: a bare name is looked up on the allowlisted PATH. */
function resolveExecutable(executable: string): string {
  const found = isAbsolute(executable)
    ? executable
    : executable.includes('/')
      ? null
      : Bun.which(executable, { PATH: process.env.PATH ?? '' });
  if (found === null) throw new Error(`refused: executable '${executable}' is not an absolute path or on PATH`);
  if (!existsSync(found) || !statSync(found).isFile()) {
    throw new Error(`refused: executable ${found} is not a regular file`);
  }
  return found;
}

/** The arm check every launch passes before the host starts anything. */
function admissionIssues(ctx: AdapterContext): string[] {
  const arm: ArmId = ctx.attempt.arm;
  const pin = ctx.config.treatment;
  if (arm === 'zero-genie') {
    if (pin !== null) return ['a zero-genie configuration carries a treatment pin'];
    const canary = zeroGenieCanary(ctx.nativeHome, ctx.solver.cwd);
    return canary.clean ? [] : canary.found.map((f) => `zero-genie canary: ${f}`);
  }
  if (pin === null) return ['a genie configuration carries no treatment pin'];
  const verified = verifyTreatment(pin, ctx.nativeHome);
  return verified.ok ? [] : verified.issues;
}

interface Launched {
  session: string;
  nativeHome: string;
  cwd: string;
  transport: ArtifactTransport;
  artifactPath: string;
  baseCommit: string | null;
}

type Capability = CapabilityReport['capabilities'][string];

const unproven = (): Capability => ({ status: 'unproven', evidence: [] });
const unsupported = (upstreamRequirement: string): Capability => ({
  status: 'unsupported',
  evidence: [],
  upstreamRequirement,
});

/**
 * The capabilities captured native session logs can prove: usage on every request, the lead's
 * observed model/effort equal to the requested ones, and observed model/effort on worker and
 * auxiliary calls. Each proof cites the captured log files; no evidence leaves a capability unproven.
 */
function capturedCapabilities(
  bundle: CaptureBundle | null,
  requestedModel: string,
  requestedEffort: string,
): { capabilities: Record<string, Capability>; resolved: CapabilityReport['resolved'] } {
  const capabilities: Record<string, Capability> = {
    requestUsage: unproven(),
    modelEffortResolved: unproven(),
    childAuxModelEffort: unproven(),
  };
  const resolved: CapabilityReport['resolved'] = { model: null, effort: null };
  if (bundle === null || bundle.requests.length === 0 || bundle.evidence.length === 0) {
    return { capabilities, resolved };
  }
  const proven = (): Capability => ({ status: 'proven', evidence: [...bundle.evidence] });
  const { requests } = bundle;
  const usage = requests.every(
    (r) => r.presence['tokens.input'] === 'observed' && r.presence['tokens.output'] === 'observed',
  );
  if (usage && bundle.health.missing === 0 && !bundle.health.truncated) capabilities.requestUsage = proven();

  const leads = requests.filter((r) => r.role === 'lead');
  const last = leads.at(-1);
  if (last !== undefined) {
    resolved.model = last.observedModel;
    resolved.effort = last.effort;
  }
  const leadResolved =
    leads.length > 0 && leads.every((r) => r.observedModel === requestedModel && r.effort === requestedEffort);
  if (leadResolved) capabilities.modelEffortResolved = proven();

  const observed = (role: 'worker' | 'auxiliary'): boolean => {
    const calls = requests.filter((r) => r.role === role);
    return calls.length > 0 && calls.every((r) => r.observedModel !== null && r.effort !== null);
  };
  if (observed('worker') && observed('auxiliary')) capabilities.childAuxModelEffort = proven();
  return { capabilities, resolved };
}

function captureOf(nativeHome: string): Result<CaptureBundle> {
  return captureOmpAttempt(nativeHome, { maxBytes: CAPTURE_MAX_BYTES });
}

const pendingOf = (bundle: CaptureBundle): string[] => bundle.actors.filter((a) => a.pending).map((a) => a.actorId);

/** Resolves after `ms`, or at once when the signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((done) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** The bytes the attempt hands the verifier: the committed patch, or the file at artifactPath. */
async function artifactBytes(state: Launched): Promise<Uint8Array> {
  if (state.transport === 'committed-patch') {
    if (state.baseCommit === null) throw new Error('committed-patch transport needs the task repository commit');
    const git = Bun.which('git', { PATH: process.env.PATH ?? '' });
    if (git === null) throw new Error('git is not on PATH');
    // HOME points at the native home and system config is off, so no operator diff driver runs.
    const proc = Bun.spawn(
      [git, 'diff', '--binary', '--no-ext-diff', '--no-textconv', state.baseCommit, 'HEAD', '--'],
      {
        cwd: state.cwd,
        env: { ...pathOnly(), HOME: state.nativeHome, GIT_CONFIG_NOSYSTEM: '1' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`git diff exited ${code}: ${err.trim()}`);
    return new Uint8Array(out);
  }
  const path = inside(state.cwd, normalize(state.artifactPath.replace(/^\/+/, '')));
  if (path === null) throw new Error(`artifactPath "${state.artifactPath}" resolves outside the solver workspace`);
  if (!existsSync(path)) return new Uint8Array();
  const bytes = readRegular(path);
  if (bytes === null) throw new Error(`artifact ${path} is not a regular file`);
  return bytes;
}

export function createOmpAdapter(host: TerminalHost): NativeAdapter {
  const launched = new Map<string, Launched>();

  const stateOf = (h: LaunchHandle): Launched => {
    const state = launched.get(h.attemptId);
    if (state === undefined) throw new Error(`no launch is recorded for attempt '${h.attemptId}'`);
    return state;
  };

  return {
    harness: 'omp',

    async preflight(ctx) {
      const issues = admissionIssues(ctx);
      if (issues.length > 0) throw new Error(`refused: ${issues.join('; ')}`);
      const executable = resolveExecutable(ctx.config.executable);
      const hostVersion = await host.version();
      const captured = captureOf(ctx.nativeHome);
      const fromCapture = capturedCapabilities(
        captured.ok ? captured.value : null,
        ctx.config.requestedModel,
        ctx.config.requestedEffort,
      );
      const capabilities: Record<string, Capability> = {
        // An attachable TTY is shown by an observed session, never by the host's version string.
        launchVisible: unproven(),
        // A clean inventory is necessary, not proof of what the actual client discovers.
        discoveryIsolated: unproven(),
        ...fromCapture.capabilities,
        settledSignal: unsupported(SETTLED_UPSTREAM),
        inputOrigin: unsupported(INPUT_ORIGIN_UPSTREAM),
        artifactTransport: unproven(),
        environmentExecution: ctx.solver.kind === 'container' ? unsupported(CONTAINER_UPSTREAM) : unproven(),
      };
      return {
        schemaVersion: 1,
        harness: 'omp',
        arm: ctx.attempt.arm,
        executable: { path: executable, build: null, sha256: sha256Of(readFileSync(executable)) },
        launchMechanism: `${tmuxLaunchArgv(['<executable>', '<prompt>'], '<attemptId>').join(' ')} (${hostVersion ?? 'terminal host version unknown'})`,
        discoveryRoots: discoveryRoots(ctx.nativeHome, ctx.solver.cwd),
        resolved: fromCapture.resolved,
        artifactTransport: ctx.task.artifactTransport,
        capabilities,
        observedAt: hostClock.wall(),
      };
    },

    async launch(ctx, prompt) {
      if (ctx.solver.kind === 'container') {
        throw new Error(`refused: environmentExecution is unsupported for a container target: ${CONTAINER_UPSTREAM}`);
      }
      const session = ctx.attempt.attemptId;
      checkSession(session);
      if (launched.has(session)) throw new Error(`refused: attempt '${session}' is already launched`);
      const issues = admissionIssues(ctx);
      if (issues.length > 0) throw new Error(`refused: ${issues.join('; ')}`);
      const executable = resolveExecutable(ctx.config.executable);
      mkdirSync(ctx.nativeHome, { recursive: true });
      const env = launchEnvironment(ctx.nativeHome);
      await host.start([executable, prompt], env, ctx.solver.cwd, session);
      launched.set(session, {
        session,
        nativeHome: ctx.nativeHome,
        cwd: ctx.solver.cwd,
        transport: ctx.task.artifactTransport,
        artifactPath: ctx.task.environment.artifactPath,
        baseCommit: ctx.task.environment.repository?.commit ?? null,
      });
      return { attemptId: session, session, startedMonotonicNs: hostClock.nowNs().toString() };
    },

    async settled(h, signal): Promise<SettledResult> {
      const state = stateOf(h);
      if (await host.alive(state.session)) {
        const captured = captureOf(state.nativeHome);
        await pause(SETTLED_POLL_MS, signal);
        return {
          settled: false,
          pendingActors: captured.ok ? pendingOf(captured.value) : [],
          basis: `unsupported: settledSignal; the client is still running and exposes no native settled signal (upstream requirement: ${SETTLED_UPSTREAM})`,
        };
      }
      const captured = captureOf(state.nativeHome);
      if (!captured.ok) throw new Error(`the client exited and its capture was refused: ${captured.issues.join('; ')}`);
      if (captured.value.evidence.length === 0) {
        throw new Error('the client exited with no captured session log; settled cannot be shown');
      }
      const pending = pendingOf(captured.value);
      if (pending.length > 0) throw new Error(`the client exited with pending actors: ${pending.join(', ')}`);
      return {
        settled: true,
        pendingActors: [],
        basis: 'the native client exited and its captured session logs show no pending actor',
      };
    },

    async stop(h, reason): Promise<StopReceipt> {
      const state = launched.get(h.attemptId);
      await host.kill(state?.session ?? h.session);
      const stoppedMonotonicNs = hostClock.nowNs().toString();
      if (state === undefined) throw new Error(`no launch is recorded for attempt '${h.attemptId}'`);
      const captured = captureOf(state.nativeHome);
      if (!captured.ok) {
        return {
          reason: `${reason} (capture refused: ${captured.issues.join('; ')})`,
          remainingActors: [],
          usageUncertain: true,
          stoppedMonotonicNs,
        };
      }
      const { health } = captured.value;
      const remainingActors = pendingOf(captured.value);
      const usageUncertain =
        reason !== 'settled' ||
        remainingActors.length > 0 ||
        health.truncated ||
        health.missing > 0 ||
        health.malformed > 0 ||
        health.unmatched > 0;
      return { reason, remainingActors, usageUncertain, stoppedMonotonicNs };
    },

    async collectArtifact(h, dest): Promise<EvidenceRef> {
      const state = stateOf(h);
      const bytes = await artifactBytes(state);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes, { flag: 'wx', mode: 0o644 });
      return { kind: 'artifact', path: dest, sha256: sha256Of(bytes), bytes: bytes.length };
    },
  };
}

export const ompAdapter: NativeAdapter = createOmpAdapter(tmuxHost);
