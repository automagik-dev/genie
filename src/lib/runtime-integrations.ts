import { createHash } from 'node:crypto';
import {
  type Stats,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import historicalRoleAgentAllowlist from '../fixtures/codex-role-agent-allowlist.json';
import { getCodexConfigPath, getCodexHome } from './codex-config.js';
import { resolveClaudeDir, resolveGenieHome } from './genie-home.js';
import { acquireLifecycleLease } from './lifecycle-lease.js';
import { validateTrustedExecutablePath } from './trusted-executable.js';
import { VERSION } from './version.js';

/** Canonical Genie product skills shipped by the plugin; the exact expected Codex inventory. */
export type IntegrationSelection = 'auto' | 'codex' | 'claude' | 'all' | 'none';
export type RuntimeName = 'codex' | 'claude';
export type RuntimeExecutableResolver = (name: RuntimeName, cwd: string) => string | null;

const INTEGRATION_CONSENT_NAME = '.integration-consent.json';

type IntegrationConsentState =
  | { selection: IntegrationSelection; state: 'committed'; revision: number }
  | {
      selection: IntegrationSelection;
      state: 'pending';
      revision: number;
      previousSelection: IntegrationSelection;
      transitionToken: string;
    };

function writeIntegrationConsentState(state: IntegrationConsentState, genieHome: string): void {
  const path = join(genieHome, INTEGRATION_CONSENT_NAME);
  // Another first-creator of GENIE_HOME: 0o700 so a permissive umask cannot
  // leave it group-writable, which the install promoter rejects outright.
  mkdirSync(genieHome, { recursive: true, mode: 0o700 });
  const staging = `${path}.staging-${process.pid}`;
  writeFileSync(
    staging,
    `${JSON.stringify({ schemaVersion: 3, ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const fd = openSync(staging, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(staging, path);
  try {
    const dirFd = openSync(genieHome, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is not portable; file fsync + atomic rename remain.
  }
}

/** Persist the operator's explicit client-home scope for later updates. */
export function persistIntegrationConsent(selection: IntegrationSelection, genieHome = resolveGenieHome()): void {
  const current = readIntegrationConsentState(genieHome);
  writeIntegrationConsentState({ selection, state: 'committed', revision: current.revision + 1 }, genieHome);
}

/** Missing state means a pre-consent release and retains the legacy auto policy. */
export function readIntegrationConsentState(genieHome = resolveGenieHome()): IntegrationConsentState {
  const path = join(genieHome, INTEGRATION_CONSENT_NAME);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { selection: 'auto', state: 'committed', revision: 0 };
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`integration consent is not a physical file: ${path}`);
  const content = readFileSync(path);
  const parsed = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
  const selection = parsed.selection;
  if (
    ![1, 2, 3].includes(Number(parsed.schemaVersion)) ||
    typeof selection !== 'string' ||
    !['auto', 'codex', 'claude', 'all', 'none'].includes(selection)
  ) {
    throw new Error(`integration consent has an invalid schema: ${path}`);
  }
  if (parsed.schemaVersion === 1) {
    return { selection: selection as IntegrationSelection, state: 'committed', revision: 0 };
  }
  const state = parsed.state;
  const previousSelection = parsed.previousSelection;
  if (
    !['committed', 'pending'].includes(String(state)) ||
    (state === 'pending' &&
      (typeof previousSelection !== 'string' ||
        !['auto', 'codex', 'claude', 'all', 'none'].includes(previousSelection))) ||
    (state === 'committed' && previousSelection !== undefined)
  ) {
    throw new Error(`integration consent has an invalid schema: ${path}`);
  }
  if (parsed.schemaVersion === 2) {
    if (state === 'committed') {
      return { selection: selection as IntegrationSelection, state: 'committed', revision: 0 };
    }
    return {
      selection: selection as IntegrationSelection,
      state: 'pending',
      revision: 0,
      previousSelection: previousSelection as IntegrationSelection,
      transitionToken: `legacy-${createHash('sha256').update(content).digest('hex')}`,
    };
  }
  const revision = parsed.revision;
  const transitionToken = parsed.transitionToken;
  if (
    !Number.isSafeInteger(revision) ||
    Number(revision) < 0 ||
    (state === 'pending' && (typeof transitionToken !== 'string' || !/^[a-f0-9]{32}$/.test(transitionToken))) ||
    (state === 'committed' && transitionToken !== undefined)
  ) {
    throw new Error(`integration consent has an invalid schema: ${path}`);
  }
  return {
    selection: selection as IntegrationSelection,
    state: state as IntegrationConsentState['state'],
    revision: revision as number,
    ...(state === 'pending'
      ? {
          previousSelection: previousSelection as IntegrationSelection,
          transitionToken: transitionToken as string,
        }
      : {}),
  } as IntegrationConsentState;
}

export function readIntegrationConsent(genieHome = resolveGenieHome()): IntegrationSelection {
  return readIntegrationConsentState(genieHome).selection;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputOverflow?: boolean;
}

interface CommandRunOptions {
  timeoutMs: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

export type CommandRunner = (command: string, args: string[], options?: CommandRunOptions) => CommandResult;

const INTEGRATION_TIMEOUT_MS = 15_000;
const INTEGRATION_OUTPUT_LIMIT_BYTES = 256 * 1024;
const INTEGRATION_KILL_GRACE_MS = 250;

class IntegrationCommandError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

const defaultRunner: CommandRunner = runBoundedIntegrationCommand;

const BOUNDED_RUNNER_WORKER = String.raw`
  const { spawn } = require('node:child_process');
  const { workerData } = require('node:worker_threads');
  const { command, args, timeoutMs, maxOutputBytes, killGraceMs, shared } = workerData;
  const state = new Int32Array(shared, 0, 2);
  const bytes = new Uint8Array(shared, 8);
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputTotal = 0;
  let timedOut = false;
  let outputOverflow = false;
  let settled = false;
  let terminating = false;
  let killTimer;
  let closedResult;

  const publish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    const payload = Buffer.from(JSON.stringify({
      ...result,
      stdout: stdout.toString('base64'),
      stderr: stderr.toString('base64'),
      timedOut,
      outputOverflow,
    }));
    if (payload.length > bytes.length) {
      const fallback = Buffer.from(JSON.stringify({
        exitCode: 1,
        stdout: '',
        stderr: Buffer.from('bounded command result exceeded the shared response limit').toString('base64'),
        timedOut,
        outputOverflow: true,
      }));
      bytes.set(fallback);
      Atomics.store(state, 1, fallback.length);
    } else {
      bytes.set(payload);
      Atomics.store(state, 1, payload.length);
    }
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
  };

  let child;
  const signalTree = (signal) => {
    if (!child || typeof child.pid !== 'number') return;
    if (process.platform === 'win32') {
      if (signal === 'SIGTERM') {
        try {
          const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.unref();
        } catch {}
      }
      try { child.kill('SIGKILL'); } catch {}
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!error || error.code !== 'ESRCH') {
        try { child.kill(signal); } catch {}
      }
    }
  };
  const terminate = (reason) => {
    if (reason === 'timeout') timedOut = true;
    if (reason === 'overflow') outputOverflow = true;
    if (terminating || !child) return;
    terminating = true;
    signalTree('SIGTERM');
    killTimer = setTimeout(() => {
      // Always signal the process tree after grace: the direct child may have
      // exited while a detached descendant remains alive with closed stdio.
      signalTree('SIGKILL');
      setTimeout(() => publish(closedResult || { exitCode: 1 }), 10);
    }, killGraceMs);
  };
  const append = (stream, chunk) => {
    const source = Buffer.from(chunk);
    outputTotal += source.length;
    const retained = stdout.length + stderr.length;
    const keep = source.subarray(0, Math.max(0, maxOutputBytes - retained));
    if (stream === 'stdout') {
      if (keep.length > 0) stdout = Buffer.concat([stdout, keep]);
    } else {
      if (keep.length > 0) stderr = Buffer.concat([stderr, keep]);
    }
    if (outputTotal > maxOutputBytes) terminate('overflow');
  };

  try {
    child = spawn(command, args, {
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => {
      stderr = Buffer.from(error && error.message ? error.message : String(error)).subarray(0, maxOutputBytes);
      publish({ exitCode: 1 });
    });
    child.once('close', (code) => {
      closedResult = { exitCode: typeof code === 'number' ? code : 1 };
      if (!terminating) publish(closedResult);
    });
    setTimeout(() => terminate('timeout'), timeoutMs);
  } catch (error) {
    stderr = Buffer.from(error && error.message ? error.message : String(error)).subarray(0, maxOutputBytes);
    publish({ exitCode: 1 });
  }
`;

/** Synchronous command facade backed by an asynchronous TERM→KILL worker. */
export function runBoundedIntegrationCommand(
  command: string,
  args: string[],
  options?: CommandRunOptions,
): CommandResult {
  const timeoutMs = boundedPositiveInteger('timeout', options?.timeoutMs ?? INTEGRATION_TIMEOUT_MS, 5 * 60_000);
  const maxOutputBytes = boundedPositiveInteger(
    'output limit',
    options?.maxOutputBytes ?? INTEGRATION_OUTPUT_LIMIT_BYTES,
    4 * 1024 * 1024,
  );
  const killGraceMs = boundedPositiveInteger('kill grace', options?.killGraceMs ?? INTEGRATION_KILL_GRACE_MS, 10_000);
  const responseCapacity = Math.max(64 * 1024, maxOutputBytes * 3 + 64 * 1024);
  const shared = new SharedArrayBuffer(8 + responseCapacity);
  const state = new Int32Array(shared, 0, 2);
  const worker = new Worker(BOUNDED_RUNNER_WORKER, {
    eval: true,
    workerData: { command, args, timeoutMs, maxOutputBytes, killGraceMs, shared },
  });
  const wait = Atomics.wait(state, 0, 0, timeoutMs + killGraceMs + 5_000);
  if (wait === 'timed-out') {
    void worker.terminate();
    return { exitCode: 1, stdout: '', stderr: 'bounded command worker did not settle', timedOut: true };
  }
  const length = Atomics.load(state, 1);
  const raw = Buffer.from(new Uint8Array(shared, 8, length)).toString('utf8');
  void worker.terminate();
  const parsed = JSON.parse(raw) as {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    outputOverflow: boolean;
  };
  return {
    exitCode: parsed.exitCode,
    stdout: Buffer.from(parsed.stdout, 'base64').toString(),
    stderr: Buffer.from(parsed.stderr, 'base64').toString(),
    timedOut: parsed.timedOut,
    outputOverflow: parsed.outputOverflow,
  };
}

function boundedPositiveInteger(label: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`integration command ${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export function resolveRuntimeExecutable(
  name: RuntimeName,
  cwd: string,
  resolver?: RuntimeExecutableResolver,
): string | null {
  if (resolver) return resolver(name, cwd);
  const candidate = Bun.which(name);
  if (candidate === null) return null;
  return validateTrustedExecutablePath(`${name} CLI`, candidate, cwd);
}

/**
 * A directory qualifies as the bundle root only when it actually carries the
 * genie plugin payload the integrations reference (`plugins/genie` ships in
 * every bundle and repo checkout). This guard is what keeps virtual
 * compile-time paths (`/$bunfs/...` → `/`) from ever being returned.
 */
function isBundleRoot(root: string): boolean {
  return existsSync(join(root, 'plugins', 'genie'));
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Locate the directory that contains the `plugins/genie` payload.
 *
 * Probe order (first qualifying root wins):
 *   1. explicit argument / GENIE_BUNDLE_ROOT — caller's assertion, unvalidated
 *   2. GENIE_HOME (`~/.genie`) — the installed layout: install.sh extracts to
 *      `~/.genie/bin/` and normalizeAuxLayout moves plugins/ to the home root
 *   3. dirname(execPath) and its parent (both as-invoked and symlink-resolved) —
 *      covers a binary run straight out of an unpacked tarball
 *   4. `import.meta.dir/../..` — source checkout under `bun test`/`bun run`;
 *      under `bun --compile` this is the virtual `/$bunfs` tree and is skipped
 *
 * Returns null when no candidate carries the payload — callers surface that as
 * a per-runtime failure instead of pointing `plugin marketplace add` at junk.
 */
function resolveBundleRoot(explicit?: string): string | null {
  if (explicit) return resolve(explicit);
  if (process.env.GENIE_BUNDLE_ROOT) return resolve(process.env.GENIE_BUNDLE_ROOT);
  const candidates: string[] = [resolveGenieHome()];
  for (const execPath of [process.execPath, safeRealpath(process.execPath)]) {
    if (!execPath) continue;
    const execDir = dirname(execPath);
    candidates.push(execDir, resolve(execDir, '..'));
  }
  if (!import.meta.dir.startsWith('/$bunfs')) candidates.push(resolve(import.meta.dir, '..', '..'));
  return candidates.find(isBundleRoot) ?? null;
}

function jsonPayload(raw: string): unknown {
  const start = raw.indexOf('{');
  const arrayStart = raw.indexOf('[');
  const first = start < 0 ? arrayStart : arrayStart < 0 ? start : Math.min(start, arrayStart);
  if (first < 0) return undefined;
  try {
    return JSON.parse(raw.slice(first));
  } catch {
    return undefined;
  }
}

interface RuntimePluginState {
  installed: boolean;
  enabled?: boolean;
  version?: string;
}

type RuntimePluginStateParseResult = { ok: true; state: RuntimePluginState } | { ok: false; detail: string };

const SAFE_PLUGIN_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;

function validateInstalledPluginEntry(
  runtime: 'Codex' | 'Claude',
  plugin: Record<string, unknown>,
): RuntimePluginStateParseResult {
  if (typeof plugin.enabled !== 'boolean') {
    return { ok: false, detail: `${runtime} plugin list returned malformed JSON (enabled must be boolean)` };
  }
  if (typeof plugin.version !== 'string' || !SAFE_PLUGIN_VERSION_RE.test(plugin.version)) {
    return {
      ok: false,
      detail: `${runtime} plugin list returned malformed JSON (version must be a safe non-empty string)`,
    };
  }
  return { ok: true, state: { installed: true, enabled: plugin.enabled, version: plugin.version } };
}

export function parseClaudePluginState(raw: string): RuntimePluginStateParseResult {
  const payload = jsonPayload(raw);
  if (!Array.isArray(payload)) {
    return { ok: false, detail: 'Claude plugin list returned malformed JSON (expected an array)' };
  }
  const plugins = (payload as unknown[]).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && Reflect.get(entry, 'id') === 'genie@automagik',
  );
  if (plugins.length > 1) {
    return { ok: false, detail: 'Claude plugin list returned malformed JSON (duplicate Genie entries)' };
  }
  const plugin = plugins[0];
  return plugin ? validateInstalledPluginEntry('Claude', plugin) : { ok: true, state: { installed: false } };
}

/** Compatibility parser for read-only callers that treat invalid output as unavailable. */
function runChecked(
  runner: CommandRunner,
  command: string,
  args: string[],
  allowAlready = false,
  timeoutMs = INTEGRATION_TIMEOUT_MS,
): CommandResult {
  const result = runner(command, args, { timeoutMs });
  if (result.timedOut) {
    throw new IntegrationCommandError(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`, true);
  }
  if (result.outputOverflow) {
    throw new IntegrationCommandError(
      `${command} ${args.join(' ')} exceeded the ${INTEGRATION_OUTPUT_LIMIT_BYTES}-byte output safety limit`,
    );
  }
  if (
    result.exitCode !== 0 &&
    !(allowAlready && /already|exists|configured/i.test(`${result.stdout}\n${result.stderr}`))
  ) {
    throw new IntegrationCommandError(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

export const CODEX_AGENT_INVENTORY_NAME = '.genie-role-agents.json';
const CODEX_AGENT_INVENTORY_OWNER = 'genie-codex-role-agents';
const CODEX_AGENT_NAME_RE = /^genie-[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/;
const CODEX_AGENT_SENTINEL = '# Managed by Genie.';
const CODEX_AGENT_INVENTORY_MODE = 0o600;

/**
 * The exact set of role agents a historical Genie bundle fanned into
 * `~/.codex/agents/`, with each role's canonical content digest. The shipped
 * `codex-agents/` payload left with the Codex plugin subsystem; this frozen map
 * remains so the read-only ownership inspector can still distinguish a
 * Genie-managed role from a user-owned one on a legacy host.
 */
const CANONICAL_CODEX_ROLE_AGENT_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  'genie-engineer-complex.toml': '62ecc570f1d77783511a9e7f0aa67b3a65d8bba292963409a02c7712c93ebc3b',
  'genie-engineer-standard.toml': 'dc746813b9b4b6aa984c17fa2fd75d4dbe34eba08494a174c0715da07aa9dd30',
  'genie-engineer-trivial.toml': '249deced5a02eb2cbe3303db566992d1336c75d853967f851bf1d0e85b6b0f47',
  'genie-final-gate.toml': '10ef070db8aace75bd80ef9e060a6ec601e3768f177fdd843f4db11035738f7e',
  'genie-fixer.toml': 'b3c1f407d4a3a2cfe204dee7b4a9c038e1a8f4644c446fcfa23f4a681bf0c7b3',
  'genie-reviewer.toml': 'c7008dcaa1e31b46e2bb05ca13afb2e918ee483422c84386a1c8997485bcfea7',
  'genie-scout.toml': '03a9fb3ca0e5f36c69c8f934d37adce1bae736e4c3895b144a0001ad31b1ba59',
});

/** The exact expected delivered role-agent filenames, name-sorted. */
const CANONICAL_CODEX_ROLE_AGENT_NAMES: readonly string[] = Object.freeze(
  Object.keys(CANONICAL_CODEX_ROLE_AGENT_DIGESTS).sort(),
);

/** The current reviewer profile digest doctor surfaces so an operator can spot a stale reviewer. */
const CANONICAL_CODEX_REVIEWER_DIGEST = CANONICAL_CODEX_ROLE_AGENT_DIGESTS['genie-reviewer.toml'] as string;

/** The number of delivered role agents; doctor reports live coverage against this. */
const EXPECTED_CODEX_ROLE_AGENT_TOTAL = CANONICAL_CODEX_ROLE_AGENT_NAMES.length;

/**
 * One frozen historical profile: the exact identity (name + regular file type +
 * mode + content digest) of a role-agent file a Genie release legitimately fanned
 * into `~/.codex/agents/`. The allowlist is the union across releases (the reviewer
 * carries several), so a legacy install whose reviewer is an older-but-genuine
 * profile is still recognizable. Membership is read-only evidence and never
 * authorizes a write: the role-agent writer was deleted with the Codex plugin
 * subsystem, so the only consumers left are the retirement classifier and doctor.
 */
interface RoleAgentHistoricalProfile {
  name: string;
  type: 'regular';
  mode: number;
  digest: string;
}

/** Ownership proof key for a historical role profile: (name, mode, content digest). */
function codexRoleAgentTupleKey(name: string, mode: number, digest: string): string {
  return `${name}\0${mode}\0${digest}`;
}

function parseHistoricalRoleAgentMode(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^0?[0-7]{3,4}$/.test(raw)) return null;
  const mode = Number.parseInt(raw, 8);
  return Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o7777 ? mode : null;
}

/**
 * Load and validate the frozen historical role-agent allowlist. A malformed
 * fixture is a build defect, not a runtime condition to tolerate, so this throws
 * rather than silently degrading adoption into "recognize nothing".
 */
function loadHistoricalRoleAgentProfiles(): RoleAgentHistoricalProfile[] {
  const raw = historicalRoleAgentAllowlist as unknown;
  if (!Array.isArray(raw)) throw new Error('codex role-agent allowlist must be a JSON array');
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const name = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'name') : undefined;
    const type = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'type') : undefined;
    const digest = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'digest') : undefined;
    const mode = parseHistoricalRoleAgentMode(
      typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'mode') : undefined,
    );
    if (
      typeof name !== 'string' ||
      !CODEX_AGENT_NAME_RE.test(name) ||
      type !== 'regular' ||
      mode === null ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest)
    ) {
      throw new Error(`codex role-agent allowlist entry ${index} is malformed`);
    }
    const key = codexRoleAgentTupleKey(name, mode, digest);
    if (seen.has(key)) throw new Error(`codex role-agent allowlist entry ${index} is a duplicate tuple`);
    seen.add(key);
    return { name, type, mode, digest };
  });
}

/** The frozen allowlist as an ownership-key set: `name\0mode\0digest` for every legitimate historical profile. */
function loadHistoricalRoleAgentTupleKeys(): ReadonlySet<string> {
  return new Set(loadHistoricalRoleAgentProfiles().map((p) => codexRoleAgentTupleKey(p.name, p.mode, p.digest)));
}

type RegularRoleFileIdentity = { kind: 'regular'; mode: number; digest: string };

type RoleFileIdentity =
  | { kind: 'absent' }
  | RegularRoleFileIdentity
  | { kind: 'directory'; mode: number }
  | { kind: 'symlink'; mode: number; target: string }
  | { kind: 'other'; mode: number }
  | { kind: 'unreadable'; mode: number | null; code: string };

interface LegacyCodexAgentInventory {
  version: 1;
  managedBy: typeof CODEX_AGENT_INVENTORY_OWNER;
  files: Record<string, { digest: string }>;
}

interface CodexAgentInventory {
  version: 2;
  managedBy: typeof CODEX_AGENT_INVENTORY_OWNER;
  files: Record<string, { identity: RegularRoleFileIdentity }>;
}

type ReadCodexAgentInventory = LegacyCodexAgentInventory | CodexAgentInventory;

type CodexAgentOwnership = 'absent' | 'user-owned' | 'managed-clean' | 'managed-modified';

/**
 * Human-facing delivery state of one role-agent file, distinct from the
 * mutation-authority {@link CodexAgentOwnership}. This is the vocabulary doctor
 * and the ownership report speak so an operator can tell a healthy managed role
 * from one that is merely adoptable, stale, or a collision Genie will not touch:
 *
 * - `managed`             — inventory-owned, clean, byte-identical to the current profile.
 * - `stale`               — inventory-owned and clean, but an older profile than the current delivery.
 * - `adoptable-historical`— no inventory, yet an exact frozen historical profile; adoptable under committed consent.
 * - `collision`           — a genie-named file that looks managed (modified-managed, sentinel lookalike,
 *                           symlink, or other non-regular) but is NOT an exact match; reported, never touched.
 * - `personal`            — a genie-named file with no Genie provenance signal; the user's own, left untouched.
 * - `absent`              — recorded in inventory but no longer on disk.
 */
type CodexAgentDisplayState = 'managed' | 'stale' | 'adoptable-historical' | 'collision' | 'personal' | 'absent';

interface CodexAgentOwnershipEntry {
  name: string;
  path: string;
  ownership: CodexAgentOwnership;
  /** Read-only delivery state for inventory/doctor output (managed/adoptable/collision/stale/personal). */
  state: CodexAgentDisplayState;
  /** Live physical identity when the entry is a regular file; drives identity-bound uninstall. */
  identity?: RegularRoleFileIdentity;
}

interface CodexAgentOwnershipReport {
  inventoryPath: string;
  status: 'missing' | 'valid' | 'corrupt';
  entries: CodexAgentOwnershipEntry[];
  /** The exact number of role agents the current Genie bundle delivers (coverage denominator). */
  expectedDeliveredTotal: number;
  /** The current canonical reviewer profile digest, surfaced so operators can spot a stale reviewer. */
  reviewerDigest: string;
  error?: string;
}

function emptyCodexAgentInventory(): CodexAgentInventory {
  return { version: 2, managedBy: CODEX_AGENT_INVENTORY_OWNER, files: {} };
}

function inventoryPath(codexHome: string): string {
  return join(codexHome, 'agents', CODEX_AGENT_INVENTORY_NAME);
}

function readCodexAgentInventory(codexHome: string): {
  status: 'missing' | 'valid' | 'corrupt';
  inventory: ReadCodexAgentInventory;
  identity: RoleFileIdentity;
  error?: string;
} {
  const path = inventoryPath(codexHome);
  const stat = lstatOrNull(path);
  if (stat === null) {
    return { status: 'missing', inventory: emptyCodexAgentInventory(), identity: { kind: 'absent' } };
  }
  try {
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('inventory is not a physical file');
    const content = readFileSync(path);
    const acceptedIdentity: RegularRoleFileIdentity = {
      kind: 'regular',
      mode: stat.mode & 0o7777,
      digest: digestBytes(content),
    };
    if (!roleFileIdentityEquals(physicalRoleFileIdentity(path), acceptedIdentity)) {
      throw new Error('inventory changed while it was being read');
    }
    const parsed = JSON.parse(content.toString('utf8')) as Partial<ReadCodexAgentInventory>;
    const files = parsed.files;
    const validLegacyFiles =
      parsed.version === 1 &&
      typeof files === 'object' &&
      files !== null &&
      Object.entries(files).every(
        ([name, value]) =>
          CODEX_AGENT_NAME_RE.test(name) &&
          typeof value === 'object' &&
          value !== null &&
          typeof Reflect.get(value, 'digest') === 'string' &&
          /^[a-f0-9]{64}$/.test(String(Reflect.get(value, 'digest'))),
      );
    const validPhysicalFiles =
      parsed.version === 2 &&
      acceptedIdentity.mode === CODEX_AGENT_INVENTORY_MODE &&
      typeof files === 'object' &&
      files !== null &&
      Object.entries(files).every(
        ([name, value]) =>
          CODEX_AGENT_NAME_RE.test(name) &&
          typeof value === 'object' &&
          value !== null &&
          isRegularRoleFileIdentity(Reflect.get(value, 'identity')),
      );
    if (parsed.managedBy !== CODEX_AGENT_INVENTORY_OWNER || (!validLegacyFiles && !validPhysicalFiles)) {
      throw new Error('invalid inventory schema');
    }
    return {
      status: 'valid',
      inventory: parsed as ReadCodexAgentInventory,
      identity: acceptedIdentity,
    };
  } catch (error) {
    return {
      status: 'corrupt',
      inventory: emptyCodexAgentInventory(),
      identity: physicalRoleFileIdentity(path),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type RecordedCodexAgent = { digest: string } | { identity: RegularRoleFileIdentity };

function classifyCodexAgentFile(
  path: string,
  recorded: RecordedCodexAgent | undefined,
  legacyUpgradeIdentity?: RegularRoleFileIdentity,
): CodexAgentOwnership {
  const actual = physicalRoleFileIdentity(path);
  if (actual.kind === 'absent') return 'absent';
  if (recorded === undefined) return 'user-owned';
  if ('identity' in recorded) {
    return roleFileIdentityEquals(actual, recorded.identity) ? 'managed-clean' : 'managed-modified';
  }
  // A v1 digest did not bind mode. It may upgrade only when the current source
  // supplies the missing canonical mode; direct uninstall and obsolete entries
  // refuse deletion authority rather than adopting a chmod-only user edit.
  if (legacyUpgradeIdentity === undefined || actual.kind !== 'regular') return 'managed-modified';
  const safeLegacyIdentity: RegularRoleFileIdentity = {
    ...legacyUpgradeIdentity,
    digest: recorded.digest,
  };
  return roleFileIdentityEquals(actual, safeLegacyIdentity) ? 'managed-clean' : 'managed-modified';
}

/** Read the head of a role file to detect the managed sentinel without a full re-hash. */
function roleFileHasManagedSentinel(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(CODEX_AGENT_SENTINEL.length);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, read).toString('utf8') === CODEX_AGENT_SENTINEL;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Read-only display classification of one role file (never mutates, never reads
 * inventory a second time). This is the reporting analog of
 * {@link classifyCodexAgentFile}: it maps an entry to the operator-facing
 * {@link CodexAgentDisplayState}. Adoptability is a pure identity fact here, and
 * no writer survives to act on it, so doctor can show "adoptable-historical"
 * without implying anything was (or will be) written.
 */
function classifyCodexAgentDisplayState(
  path: string,
  name: string,
  recorded: RecordedCodexAgent | undefined,
  historical: ReadonlySet<string>,
  canonicalDigests: Readonly<Record<string, string>>,
): CodexAgentDisplayState {
  const actual = physicalRoleFileIdentity(path);
  if (actual.kind === 'absent') return 'absent';
  if (recorded !== undefined) {
    const ownership = classifyCodexAgentFile(path, recorded);
    if (ownership === 'absent') return 'absent';
    if (ownership === 'managed-modified') return 'collision';
    // managed-clean: current if it matches the delivered profile, otherwise stale.
    const canonical = canonicalDigests[name];
    if (actual.kind === 'regular' && canonical !== undefined && actual.digest !== canonical) return 'stale';
    return 'managed';
  }
  // No inventory record. Bytes never grant ownership, so the most a file can earn
  // is "adoptable" (exact frozen historical identity) — everything else is left
  // exactly where it is and only classified for reporting.
  if (actual.kind === 'regular') {
    if (historical.has(codexRoleAgentTupleKey(name, actual.mode, actual.digest))) return 'adoptable-historical';
    return roleFileHasManagedSentinel(path) ? 'collision' : 'personal';
  }
  // Symlink / directory / other / unreadable at a role path: never safe to act on.
  return 'collision';
}

/** Shared digest-backed classifier for setup/update, doctor, and uninstall. */
export function inspectCodexAgentOwnership(codexHome = getCodexHome()): CodexAgentOwnershipReport {
  const state = readCodexAgentInventory(codexHome);
  const agentsDir = join(codexHome, 'agents');
  const names = new Set<string>(Object.keys(state.inventory.files));
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir)) if (CODEX_AGENT_NAME_RE.test(name)) names.add(name);
  }
  const historical = loadHistoricalRoleAgentTupleKeys();
  return {
    inventoryPath: inventoryPath(codexHome),
    status: state.status,
    error: state.error,
    expectedDeliveredTotal: EXPECTED_CODEX_ROLE_AGENT_TOTAL,
    reviewerDigest: CANONICAL_CODEX_REVIEWER_DIGEST,
    entries: [...names].sort().map((name) => {
      const path = join(agentsDir, name);
      // Surface the same physical identity the classifier reads so the uninstall
      // planner can record it without a second, separately-timed inspection.
      const identity = physicalRoleFileIdentity(path);
      return {
        name,
        path,
        ownership: classifyCodexAgentFile(path, state.inventory.files[name]),
        state: classifyCodexAgentDisplayState(
          path,
          name,
          state.inventory.files[name],
          historical,
          CANONICAL_CODEX_ROLE_AGENT_DIGESTS,
        ),
        ...(identity.kind === 'regular' ? { identity } : {}),
      };
    }),
  };
}

/** Physical existence probe that never confuses an unreadable path with an absent one. */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

function digestBytes(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isRoleFileMode(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0o7777;
}

function isRegularRoleFileIdentity(value: unknown): value is RegularRoleFileIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'kind') === 'regular' &&
    isRoleFileMode(Reflect.get(value, 'mode')) &&
    typeof Reflect.get(value, 'digest') === 'string' &&
    /^[a-f0-9]{64}$/.test(String(Reflect.get(value, 'digest')))
  );
}

function physicalRoleFileIdentity(path: string): RoleFileIdentity {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', mode: null, code };
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    try {
      return { kind: 'symlink', mode, target: readlinkSync(path) };
    } catch (error) {
      return { kind: 'unreadable', mode, code: (error as NodeJS.ErrnoException).code ?? 'READLINK' };
    }
  }
  if (stat.isDirectory()) return { kind: 'directory', mode };
  if (!stat.isFile()) return { kind: 'other', mode };
  try {
    return { kind: 'regular', mode, digest: createHash('sha256').update(readFileSync(path)).digest('hex') };
  } catch (error) {
    return { kind: 'unreadable', mode, code: (error as NodeJS.ErrnoException).code ?? 'READ' };
  }
}

function roleFileIdentityEquals(left: RoleFileIdentity | undefined, right: RoleFileIdentity | undefined): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind) return false;
  if (left.kind === 'absent' || right.kind === 'absent') return true;
  if (left.mode !== right.mode) return false;
  if (left.kind === 'regular' && right.kind === 'regular') return left.digest === right.digest;
  if (left.kind === 'symlink' && right.kind === 'symlink') return left.target === right.target;
  if (left.kind === 'unreadable' && right.kind === 'unreadable') return left.code === right.code;
  return left.kind === right.kind;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

interface CodexEnabledMutationResult {
  ok: boolean;
  detail: string;
}

/** Restore explicit Codex consent with a backup-first, same-directory atomic replacement. */
export function setCodexPluginEnabled(enabled: boolean, configPath = getCodexConfigPath()): CodexEnabledMutationResult {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(configPath);
  } catch {
    return { ok: false, detail: `Codex config is missing; cannot restore plugin enabled=${enabled}: ${configPath}` };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ok: false, detail: `Codex config is not a physical file: ${configPath}` };
  }
  try {
    const content = readFileSync(configPath, 'utf8');
    const header = '[plugins."genie@automagik"]';
    const occurrences = content.split(header).length - 1;
    if (occurrences !== 1) {
      return {
        ok: false,
        detail: `Codex config must contain exactly one ${header} section; found ${occurrences}`,
      };
    }
    const at = content.indexOf(header);
    const next = content.indexOf('\n[', at + header.length);
    const end = next < 0 ? content.length : next + 1;
    const section = content.slice(at, end);
    const replacement = /(^|\n)enabled\s*=\s*(true|false)/.test(section)
      ? section.replace(/(^|\n)enabled\s*=\s*(true|false)/, `$1enabled = ${enabled}`)
      : section.replace(header, `${header}\nenabled = ${enabled}`);
    const nextContent = `${content.slice(0, at)}${replacement}${content.slice(end)}`;
    const backup = `${configPath}.genie-refresh-backup`;
    const staging = `${configPath}.genie-refresh-staging-${process.pid}`;
    copyFileSync(configPath, backup);
    writeFileSync(staging, nextContent, { encoding: 'utf8', mode: stat.mode & 0o777 });
    chmodSync(staging, stat.mode & 0o777);
    renameSync(staging, configPath);
    rmSync(backup, { force: true });
    return { ok: true, detail: `Codex plugin enabled=${enabled}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// ============================================================================
// Plugin-era Codex registration retirement (wish `skills-everywhere`, group 2)
// ============================================================================

/**
 * The one `[plugins."genie@automagik"]` table Genie ever writes into
 * `~/.codex/config.toml`. Restated from {@link setCodexPluginEnabled}'s header
 * so both the enable mutation and the retirement mutation name the same table.
 */
const CODEX_GENIE_PLUGIN_TABLE = 'plugins."genie@automagik"';

/**
 * Codex's own per-hook approval rows for the retired plugin. Two on-disk shapes
 * exist in the wild — a quoted key inside `[hooks.state]`, and a dedicated
 * `[hooks.state."genie@automagik:<hook>"]` table — so both are retired.
 */
const CODEX_GENIE_HOOK_STATE_TABLE_PREFIX = 'hooks.state."genie@automagik:';
const CODEX_GENIE_HOOK_STATE_KEY = /^\s*"genie@automagik:[^"]*"\s*=/;

/** A whole-line TOML table (or array-of-tables) header, with its name captured. */
const TOML_TABLE_HEADER = /^\s*\[\[?\s*([^[\]]*?)\s*\]\]?\s*(#.*)?$/;

function isRetiredCodexGenieTable(header: string): boolean {
  return (
    header === CODEX_GENIE_PLUGIN_TABLE ||
    header.startsWith(`${CODEX_GENIE_PLUGIN_TABLE}.`) ||
    header.startsWith(CODEX_GENIE_HOOK_STATE_TABLE_PREFIX)
  );
}

/** The two TOML multi-line string delimiters, which suspend line-level parsing. */
type TomlMultilineDelimiter = '"""' | "'''";

/**
 * Consume one line and report whether it ENDS inside a multi-line string.
 *
 * A `"""…"""` (or `'''…'''`) value body is arbitrary text: it can contain a
 * line that reads exactly like `[plugins."genie@automagik"]` or like any other
 * table header. Treating such a line as a header would either start dropping in
 * the middle of an unrelated operator's value or end the genie table's drop
 * early and leave half its body behind — both silent corruptions of a
 * user-owned config. Single-line basic/literal strings and `#` comments are
 * skipped for the same reason: a `"""` inside them opens nothing.
 */
function scanTomlLine(line: string, open: TomlMultilineDelimiter | null): TomlMultilineDelimiter | null {
  let current = open;
  let index = 0;
  while (index < line.length) {
    if (current !== null) {
      // Only a basic multi-line string honours backslash escapes.
      if (current === '"""' && line[index] === '\\') {
        index += 2;
        continue;
      }
      if (line.startsWith(current, index)) {
        current = null;
        index += 3;
        continue;
      }
      index += 1;
      continue;
    }
    if (line[index] === '#') return null; // a comment runs to end of line
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      current = line.startsWith('"""', index) ? '"""' : "'''";
      index += 3;
      continue;
    }
    if (line[index] === '"' || line[index] === "'") {
      index = skipSingleLineTomlString(line, index);
      continue;
    }
    index += 1;
  }
  return current;
}

/** Advance past a single-line basic/literal string; an unterminated one eats the line. */
function skipSingleLineTomlString(line: string, start: number): number {
  const quote = line[start];
  let index = start + 1;
  while (index < line.length) {
    if (quote === '"' && line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] === quote) return index + 1;
    index += 1;
  }
  return line.length;
}

/**
 * Pure line-level plan: drop every retired genie table (header + body) and every
 * `genie@automagik:` row inside `[hooks.state]`, and keep every other byte.
 *
 * A dropped table takes its own body — including the blank lines that trail it —
 * so exactly one separator survives between the neighbours it sat between, and a
 * table dropped at EOF leaves no trailing blank paragraph. The file's original
 * trailing-newline convention is restored by the `endsWith` repair below.
 *
 * Lines that begin inside a multi-line string are never read as headers or as
 * `hooks.state` keys; they are body bytes of whichever table is currently in
 * scope, and they are kept or dropped with it.
 */
function planCodexPluginRegistrationRemoval(content: string): { next: string; removed: string[] } {
  const kept: string[] = [];
  const removed: string[] = [];
  let dropping = false;
  let inHooksState = false;
  let multiline: TomlMultilineDelimiter | null = null;
  for (const line of content.split('\n')) {
    const insideString = multiline !== null;
    multiline = scanTomlLine(line, multiline);
    const header = insideString ? undefined : TOML_TABLE_HEADER.exec(line)?.[1];
    if (header !== undefined) {
      dropping = isRetiredCodexGenieTable(header);
      inHooksState = header === 'hooks.state';
      if (!dropping) {
        kept.push(line);
        continue;
      }
      removed.push(`[${header}]`);
      continue;
    }
    if (dropping) continue;
    if (!insideString && inHooksState && CODEX_GENIE_HOOK_STATE_KEY.test(line)) {
      removed.push(line.trim());
      continue;
    }
    kept.push(line);
  }
  let next = kept.join('\n');
  if (next.trim() === '') next = '';
  else if (content.endsWith('\n') && !next.endsWith('\n')) next += '\n';
  return { next, removed };
}

interface CodexPluginRegistrationRemoval {
  ok: boolean;
  status: 'removed' | 'unchanged' | 'absent' | 'error';
  detail: string;
  /** Table headers and `hooks.state` keys dropped, in document order. */
  removed: string[];
}

/**
 * Retire the marker-owned `genie@automagik` plugin registration from a Codex
 * config, backup-first and atomically, exactly as {@link setCodexPluginEnabled}
 * replaces the same file.
 *
 * Only Genie's own rows are touched: the `[plugins."genie@automagik"]` table
 * (with any subtable) and the `hooks.state` rows keyed by `genie@automagik:`.
 * Unrelated tables, values, and comments survive byte-for-byte — including the
 * OTel settings owned by `migrateDeadGenieOtel`, which this function must never
 * parse or rewrite. An absent config is a success, not an error: retirement is
 * idempotent by construction, so a second run reports `unchanged`.
 */
export function removeCodexPluginRegistration(configPath = getCodexConfigPath()): CodexPluginRegistrationRemoval {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(configPath);
  } catch {
    return { ok: true, status: 'absent', detail: `Codex config is absent: ${configPath}`, removed: [] };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ok: false, status: 'error', detail: `Codex config is not a physical file: ${configPath}`, removed: [] };
  }
  const backup = `${configPath}.genie-retirement-backup`;
  const staging = `${configPath}.genie-retirement-staging-${process.pid}`;
  try {
    const content = readFileSync(configPath, 'utf8');
    const plan = planCodexPluginRegistrationRemoval(content);
    if (plan.removed.length === 0) {
      return {
        ok: true,
        status: 'unchanged',
        detail: `no genie@automagik registration in ${configPath}`,
        removed: [],
      };
    }
    copyFileSync(configPath, backup);
    writeFileSync(staging, plan.next, { encoding: 'utf8', mode: stat.mode & 0o777 });
    chmodSync(staging, stat.mode & 0o777);
    renameSync(staging, configPath);
    rmSync(backup, { force: true });
    return {
      ok: true,
      status: 'removed',
      detail: `retired ${plan.removed.length} genie@automagik registration row(s) from ${configPath}`,
      removed: plan.removed,
    };
  } catch (error) {
    rmSync(staging, { force: true });
    return { ok: false, status: 'error', detail: error instanceof Error ? error.message : String(error), removed: [] };
  }
}

export interface IntegrationResult {
  runtime: RuntimeName;
  ok: boolean;
  detail: string;
  preservedDisabled?: boolean;
  timedOut?: boolean;
}

export interface InstallIntegrationsOptions {
  selection?: IntegrationSelection;
  bundleRoot?: string;
  runner?: CommandRunner;
  detected?: Partial<Record<RuntimeName, boolean>>;
  claudeHome?: string;
  timeoutMs?: number;
  /** Durable refresh intent root. Production defaults to GENIE_HOME. */
  stateDir?: string;
  /** Lifecycle lease identity. Always GENIE_HOME, never a source bundle root. */
  genieHome?: string;
  /** Deterministic test seam; production binds Claude marketplace source and cache bytes. */
  verifyClaudePayload?: ClaudePayloadVerifier;
  /** Active project used to reject repository/worktree/common-root PATH decoys. */
  cwd?: string;
  /** Deterministic test seam; production resolves and validates PATH once. */
  resolveExecutable?: RuntimeExecutableResolver;
}

/**
 * Install the client integrations this binary still owns. The Codex arm left
 * with the Codex plugin subsystem, so `codex` is never a target: an explicit
 * `codex` selection installs nothing and `auto`/`all` converge Claude only.
 */
export function installRuntimeIntegrations(options: InstallIntegrationsOptions = {}): IntegrationResult[] {
  const selection = options.selection ?? 'auto';
  if (selection === 'none' || selection === 'codex') return [];
  const runner = options.runner ?? defaultRunner;
  const bundleRoot = resolveBundleRoot(options.bundleRoot);
  const genieHome = options.genieHome ?? resolveGenieHome();
  const lifecycleLease = acquireLifecycleLease(genieHome);
  if ('skipped' in lifecycleLease) {
    return [{ runtime: 'claude', ok: false, detail: lifecycleLease.skipped }];
  }
  try {
    const cwd = options.cwd ?? process.cwd();
    if (selection === 'auto' && options.detected?.claude === false) return [];
    if (options.detected?.claude === false) return [{ runtime: 'claude', ok: false, detail: 'claude CLI not found' }];
    try {
      const command = resolveRuntimeExecutable('claude', cwd, options.resolveExecutable);
      if (command === null) return [{ runtime: 'claude', ok: false, detail: 'claude CLI not found' }];
      if (bundleRoot === null) {
        throw new Error(
          'genie bundle root not found — expected plugins/genie under $GENIE_HOME (~/.genie) or beside the genie binary; set GENIE_BUNDLE_ROOT to override',
        );
      }
      return [
        installClaudeIntegration(
          runner,
          command,
          bundleRoot,
          options.timeoutMs,
          options.stateDir ?? genieHome,
          options.claudeHome,
          options.verifyClaudePayload,
        ),
      ];
    } catch (error) {
      return [
        {
          runtime: 'claude',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          timedOut: error instanceof IntegrationCommandError && error.timedOut,
        },
      ];
    }
  } finally {
    lifecycleLease.release();
  }
}

interface RefreshIntent {
  schemaVersion: 4;
  runtime: RuntimeName;
  installed: true;
  enabled: boolean;
  createdAt: string;
  /** Only removal-observed authorizes recovery of an absent registration. */
  phase: 'planned' | 'command-started' | 'removal-observed' | 'ambiguous-absent';
}

interface ConvergePluginOptions {
  runner: CommandRunner;
  /** Once-bound executable retained through every convergence subprocess. */
  command: string;
  bundleRoot: string;
  expectedVersion: string;
  /** Explicit install/setup may create an absent registration; update may not. */
  installIfAbsent: boolean;
  statePath: string;
  timeoutMs?: number;
  claudeHome?: string;
  verifyClaudePayload?: ClaudePayloadVerifier;
}

interface ClaudePayloadVerificationInput {
  bundleRoot: string;
  claudeHome: string;
  expectedVersion: string;
}

export type ClaudePayloadVerifier = (input: ClaudePayloadVerificationInput) => void;

function readClaudeMarketplaceSource(marketplacePath: string): { sourcePath: string; installLocation: string } {
  let marketplace: unknown;
  try {
    const stat = lstatSync(marketplacePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('registry is not a physical file');
    marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as unknown;
  } catch (error) {
    throw new IntegrationCommandError(
      `Claude marketplace registry is unreadable at ${marketplacePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entry =
    typeof marketplace === 'object' && marketplace !== null && !Array.isArray(marketplace)
      ? Reflect.get(marketplace, 'automagik')
      : undefined;
  const source = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'source') : undefined;
  const sourceKind = typeof source === 'object' && source !== null ? Reflect.get(source, 'source') : undefined;
  const sourcePath = typeof source === 'object' && source !== null ? Reflect.get(source, 'path') : undefined;
  const installLocation =
    typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'installLocation') : undefined;
  if (sourceKind !== 'directory' || typeof sourcePath !== 'string' || typeof installLocation !== 'string') {
    throw new IntegrationCommandError(
      'Claude marketplace automagik is not registered from the canonical directory bundle',
    );
  }
  return { sourcePath, installLocation };
}

/** Bind Claude's named marketplace and installed cache to the verified bundle. */
export function verifyClaudePhysicalPayload(input: ClaudePayloadVerificationInput): void {
  const marketplacePath = join(input.claudeHome, 'plugins', 'known_marketplaces.json');
  const { sourcePath, installLocation } = readClaudeMarketplaceSource(marketplacePath);
  let canonicalBundle: string;
  try {
    canonicalBundle = realpathSync(input.bundleRoot);
    if (realpathSync(sourcePath) !== canonicalBundle || realpathSync(installLocation) !== canonicalBundle) {
      throw new Error(`registered source ${sourcePath} / ${installLocation} does not match ${canonicalBundle}`);
    }
  } catch (error) {
    throw new IntegrationCommandError(
      `Claude marketplace source identity mismatch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sourceRoot = join(canonicalBundle, 'plugins', 'genie');
  const installedRoot = join(input.claudeHome, 'plugins', 'cache', 'automagik', 'genie', input.expectedVersion);
  let sourceDigest: string;
  let installedDigest: string;
  try {
    sourceDigest = fingerprintPhysicalPluginTree(sourceRoot);
    installedDigest = fingerprintPhysicalPluginTree(installedRoot);
  } catch (error) {
    throw new IntegrationCommandError(
      `Claude plugin payload is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (sourceDigest !== installedDigest) {
    throw new IntegrationCommandError(
      `installed Claude plugin payload identity mismatch at ${installedRoot} (expected canonical source ${sourceRoot})`,
    );
  }
}

function fingerprintPhysicalPluginTree(root: string): string {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('root is not a physical directory');
  }
  const entries: Array<{ path: string; kind: 'directory' | 'file'; executable: boolean; digest?: string }> = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.orphaned_at') continue;
      const absolute = join(current, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`payload contains a symlink: ${absolute}`);
      const path = relative(root, absolute);
      if (stat.isDirectory()) {
        entries.push({ path, kind: 'directory', executable: false });
        visit(absolute);
      } else if (stat.isFile()) {
        entries.push({
          path,
          kind: 'file',
          executable: (stat.mode & 0o111) !== 0,
          digest: hashPhysicalFileIncrementally(absolute),
        });
      } else {
        throw new Error(`payload contains an unsupported entry: ${absolute}`);
      }
    }
  };
  visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(`${entry.kind}\0${entry.path}\0${entry.executable ? 'x' : '-'}\0${entry.digest ?? ''}\0`);
  }
  return digest.digest('hex');
}

function hashPhysicalFileIncrementally(path: string): string {
  const fd = openSync(path, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return digest.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function readRefreshIntent(path: string, runtime: RuntimeName): RefreshIntent | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refresh intent is not a physical file: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`refresh intent is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    ![1, 2, 3, 4].includes(Number(Reflect.get(parsed, 'schemaVersion'))) ||
    Reflect.get(parsed, 'runtime') !== runtime ||
    Reflect.get(parsed, 'installed') !== true ||
    typeof Reflect.get(parsed, 'enabled') !== 'boolean' ||
    typeof Reflect.get(parsed, 'createdAt') !== 'string' ||
    ([2, 3].includes(Number(Reflect.get(parsed, 'schemaVersion'))) &&
      !['planned', 'removal-authorized', 'removed'].includes(String(Reflect.get(parsed, 'phase')))) ||
    (Number(Reflect.get(parsed, 'schemaVersion')) === 4 &&
      !['planned', 'command-started', 'removal-observed', 'ambiguous-absent'].includes(
        String(Reflect.get(parsed, 'phase')),
      ))
  ) {
    throw new Error(`refresh intent has an invalid schema: ${path}`);
  }
  return {
    schemaVersion: 4,
    runtime,
    installed: true,
    enabled: Reflect.get(parsed, 'enabled') as boolean,
    createdAt: Reflect.get(parsed, 'createdAt') as string,
    phase:
      Number(Reflect.get(parsed, 'schemaVersion')) === 4
        ? (Reflect.get(parsed, 'phase') as RefreshIntent['phase'])
        : Reflect.get(parsed, 'phase') === 'removed'
          ? 'removal-observed'
          : Reflect.get(parsed, 'phase') === 'removal-authorized'
            ? 'ambiguous-absent'
            : 'planned',
  };
}

function writeRefreshIntent(path: string, intent: RefreshIntent): void {
  // `stateDir` defaults to `resolveGenieHome()`, so this dirname is GENIE_HOME.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.staging-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(intent, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(staging, path);
}

function clearRefreshIntent(path: string): void {
  rmSync(path, { force: true });
}

function plannedRefreshIntent(runtime: RuntimeName, enabled: boolean): RefreshIntent {
  return {
    schemaVersion: 4,
    runtime,
    installed: true,
    enabled,
    createdAt: new Date().toISOString(),
    phase: 'planned',
  };
}

function markRefreshCommandStarted(path: string, intent: RefreshIntent): RefreshIntent {
  const started = { ...intent, phase: 'command-started' as const };
  writeRefreshIntent(path, started);
  return started;
}

function markRefreshRemovalObserved(path: string, intent: RefreshIntent): RefreshIntent {
  const observed = { ...intent, phase: 'removal-observed' as const };
  writeRefreshIntent(path, observed);
  return observed;
}

function markRefreshStable(path: string, intent: RefreshIntent): RefreshIntent {
  const stable = { ...intent, phase: 'planned' as const };
  writeRefreshIntent(path, stable);
  return stable;
}

function markRefreshStableIfPresent(path: string, intent: RefreshIntent | null): RefreshIntent | null {
  return intent === null ? null : markRefreshStable(path, intent);
}

function markRefreshAmbiguous(path: string, intent: RefreshIntent): RefreshIntent {
  const ambiguous = { ...intent, phase: 'ambiguous-absent' as const };
  writeRefreshIntent(path, ambiguous);
  return ambiguous;
}

/**
 * A returned command failure is not proof that the plugin was removed. Probe
 * once: a still-present registration clears stale repair authority, while an
 * absent/unknowable result is recorded as ambiguous and never auto-reinstalled
 * by a maintenance update.
 */
function settleFailedRefreshIntent(
  options: ConvergePluginOptions,
  intent: RefreshIntent | null,
  timeoutMs: number,
): RefreshIntent | null {
  if (intent === null || intent.phase === 'planned') return intent;
  try {
    const raw = runChecked(options.runner, options.command, ['plugin', 'list', '--json'], false, timeoutMs).stdout;
    const state = requireClaudePluginState(raw, 'after failed refresh command');
    if (state.installed) {
      // Registration presence consumes any one-shot removal authority, but the
      // planned record stays until enabled-state restoration is verified.
      if (intent.enabled) {
        clearRefreshIntent(options.statePath);
        return null;
      }
      return markRefreshStable(options.statePath, intent);
    }
  } catch {
    // An observed explicit removal remains legitimate crash-repair authority;
    // command-started without observation is ambiguous and cannot reinstall.
  }
  if (intent.phase === 'removal-observed') return intent;
  return markRefreshAmbiguous(options.statePath, intent);
}

/**
 * A leftover planned-phase intent means the previous run settled with the
 * plugin installed, so the live enabled state — which the user may have
 * changed since — is authoritative, not the file's snapshot. Later phases
 * keep the file's word: mid-recovery the plugin can be legitimately absent
 * or transiently misconfigured, and only the intent knows the user's state.
 */
function reconcilePlannedIntentWithLiveState(
  intent: RefreshIntent | null,
  before: RuntimePluginState,
): RefreshIntent | null {
  if (intent === null || intent.phase !== 'planned' || !before.installed) return intent;
  const liveEnabled = before.enabled === true;
  return intent.enabled === liveEnabled ? intent : { ...intent, enabled: liveEnabled };
}

function integrationFailure(runtime: RuntimeName, error: unknown): IntegrationResult {
  return {
    runtime,
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
    timedOut: error instanceof IntegrationCommandError && error.timedOut,
  };
}

function requireExpectedState(
  runtime: RuntimeName,
  state: RuntimePluginState,
  expectedVersion: string,
  expectedEnabled: boolean,
  phase: string,
): void {
  if (!state.installed || state.version !== expectedVersion || state.enabled !== expectedEnabled) {
    throw new IntegrationCommandError(
      `${runtime} ${phase} verification failed (installed=${state.installed}, enabled=${String(state.enabled)}, version=${state.version || 'missing'}; expected ${expectedEnabled ? 'enabled' : 'disabled'} v${expectedVersion})`,
    );
  }
}

function requireClaudePluginState(raw: string, phase: string): RuntimePluginState {
  const parsed = parseClaudePluginState(raw);
  if (!parsed.ok) throw new IntegrationCommandError(`${parsed.detail} ${phase}`);
  return parsed.state;
}

function addClaudeMarketplace(runner: CommandRunner, command: string, bundleRoot: string, timeoutMs: number): void {
  const args = ['plugin', 'marketplace', 'add', bundleRoot];
  const result = runner(command, args, { timeoutMs });
  if (result.timedOut)
    throw new IntegrationCommandError(`claude ${args.join(' ')} timed out after ${timeoutMs}ms`, true);
  if (result.outputOverflow)
    throw new IntegrationCommandError(`claude ${args.join(' ')} exceeded the output safety limit`);
  if (result.exitCode === 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/already|exists|configured|different source/i.test(output)) {
    throw new IntegrationCommandError(`claude ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  runChecked(runner, command, ['plugin', 'marketplace', 'remove', 'automagik'], true, timeoutMs);
  runChecked(runner, command, args, false, timeoutMs);
}

function convergeClaudePayloadIdentity(
  options: ConvergePluginOptions,
  installed: RuntimePluginState,
  timeoutMs: number,
  authorizeRemoval: () => void,
  markRemoved: () => void,
  markReinstalled: () => void,
): RuntimePluginState {
  const verifyPayload = options.verifyClaudePayload ?? verifyClaudePhysicalPayload;
  const verificationInput = {
    bundleRoot: options.bundleRoot,
    claudeHome: options.claudeHome ?? resolveClaudeDir(),
    expectedVersion: options.expectedVersion,
  };
  try {
    verifyPayload(verificationInput);
    return installed;
  } catch (firstVerificationError) {
    authorizeRemoval();
    runChecked(options.runner, options.command, ['plugin', 'uninstall', 'genie@automagik'], true, timeoutMs);
    markRemoved();
    runChecked(options.runner, options.command, ['plugin', 'marketplace', 'remove', 'automagik'], true, timeoutMs);
    addClaudeMarketplace(options.runner, options.command, options.bundleRoot, timeoutMs);
    runChecked(options.runner, options.command, ['plugin', 'install', 'genie@automagik'], false, timeoutMs);
    const repaired = requireClaudePluginState(
      runChecked(options.runner, options.command, ['plugin', 'list', '--json'], false, timeoutMs).stdout,
      'after payload-identity reinstall',
    );
    if (!repaired.installed || repaired.version !== options.expectedVersion) {
      throw new IntegrationCommandError(
        `Claude payload-identity repair did not restore v${options.expectedVersion}: installed=${repaired.installed}, version=${repaired.version || 'missing'}`,
      );
    }
    markReinstalled();
    try {
      verifyPayload(verificationInput);
      return repaired;
    } catch (finalVerificationError) {
      throw new IntegrationCommandError(
        `Claude plugin payload identity did not converge after canonical reinstall: ${finalVerificationError instanceof Error ? finalVerificationError.message : String(finalVerificationError)}; initial verification: ${firstVerificationError instanceof Error ? firstVerificationError.message : String(firstVerificationError)}`,
      );
    }
  }
}

/** Durable Claude convergence with disabled-state restoration in all mutation outcomes. */
export function convergeClaudePlugin(options: ConvergePluginOptions): IntegrationResult | null {
  const timeoutMs = options.timeoutMs ?? INTEGRATION_TIMEOUT_MS;
  let intent: RefreshIntent | null = null;
  let desiredEnabled: boolean | null = null;
  let primaryError: unknown;
  try {
    intent = readRefreshIntent(options.statePath, 'claude');
    desiredEnabled = intent?.enabled ?? null;
    const before = requireClaudePluginState(
      runChecked(options.runner, options.command, ['plugin', 'list', '--json'], false, timeoutMs).stdout,
      'before plugin convergence',
    );
    if (!before.installed && !options.installIfAbsent && intent?.phase !== 'removal-observed') {
      if (intent !== null) clearRefreshIntent(options.statePath);
      return null;
    }
    intent = reconcilePlannedIntentWithLiveState(intent, before);
    desiredEnabled = intent?.enabled ?? null;
    intent ??= plannedRefreshIntent('claude', before.installed ? before.enabled === true : true);
    desiredEnabled = intent.enabled;
    writeRefreshIntent(options.statePath, intent);

    addClaudeMarketplace(options.runner, options.command, options.bundleRoot, timeoutMs);
    // Claude's update command may replace/remove the installed cache before it
    // returns. Persist recovery authority first so a process death cannot be
    // mistaken for a later manual uninstall.
    if (before.installed && intent.phase === 'planned') {
      intent = markRefreshCommandStarted(options.statePath, intent);
    }
    runChecked(
      options.runner,
      options.command,
      ['plugin', before.installed ? 'update' : 'install', 'genie@automagik'],
      false,
      timeoutMs,
    );
    let installed = requireClaudePluginState(
      runChecked(options.runner, options.command, ['plugin', 'list', '--json'], false, timeoutMs).stdout,
      'after plugin refresh',
    );
    if (!installed.installed || installed.version !== options.expectedVersion) {
      throw new IntegrationCommandError(
        `Claude plugin refresh reported v${installed.version || 'missing'}; expected v${options.expectedVersion}`,
      );
    }
    intent = markRefreshStable(options.statePath, intent);
    installed = convergeClaudePayloadIdentity(
      options,
      installed,
      timeoutMs,
      () => {
        intent = markRefreshCommandStarted(options.statePath, intent as RefreshIntent);
      },
      () => {
        intent = markRefreshRemovalObserved(options.statePath, intent as RefreshIntent);
      },
      () => {
        intent = markRefreshStable(options.statePath, intent as RefreshIntent);
      },
    );
    intent = markRefreshStable(options.statePath, intent);
    if (intent.enabled) requireExpectedState('claude', installed, options.expectedVersion, true, 'enabled-state');
  } catch (error) {
    primaryError = error;
    intent = settleFailedRefreshIntent(options, intent, timeoutMs);
    if (intent?.phase === 'ambiguous-absent') {
      primaryError = new IntegrationCommandError(
        `${error instanceof Error ? error.message : String(error)}; Claude state is absent or unknown after a failed command and will not be reinstalled by update — run genie install or setup to grant explicit repair consent`,
      );
    }
  }

  if (desiredEnabled === false) {
    try {
      // "already disabled" is the desired end state, not a failure; the list
      // check below verifies the restore either way.
      runChecked(options.runner, options.command, ['plugin', 'disable', 'genie@automagik'], true, timeoutMs);
      const restored = requireClaudePluginState(
        runChecked(options.runner, options.command, ['plugin', 'list', '--json'], false, timeoutMs).stdout,
        'after restoring disabled state',
      );
      requireExpectedState('claude', restored, options.expectedVersion, false, 'disabled-state restore');
      intent = markRefreshStableIfPresent(options.statePath, intent);
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) return integrationFailure('claude', primaryError);
  clearRefreshIntent(options.statePath);
  return {
    runtime: 'claude',
    ok: true,
    detail: `plugin/hooks refreshed to v${options.expectedVersion}`,
    preservedDisabled: desiredEnabled === false,
  };
}

function installClaudeIntegration(
  runner: CommandRunner,
  command: string,
  bundleRoot: string,
  timeoutMs = INTEGRATION_TIMEOUT_MS,
  stateDir = resolveGenieHome(),
  claudeHome = resolveClaudeDir(),
  verifyClaudePayload?: ClaudePayloadVerifier,
): IntegrationResult {
  const plugin = convergeClaudePlugin({
    runner,
    command,
    bundleRoot,
    expectedVersion: VERSION,
    installIfAbsent: true,
    statePath: join(stateDir, '.integration-refresh-claude.json'),
    timeoutMs,
    claudeHome,
    verifyClaudePayload,
  });
  if (plugin === null) throw new Error('Claude plugin convergence returned no result for explicit install');
  if (!plugin.ok) throw new IntegrationCommandError(plugin.detail, plugin.timedOut);
  return plugin;
}

interface IntegrationRemovalStep {
  runtime: RuntimeName;
  operation: 'plugin' | 'marketplace';
  ok: boolean;
  detail: string;
  timedOut?: boolean;
}

interface RuntimeIntegrationRemovalResult {
  ok: boolean;
  steps: IntegrationRemovalStep[];
}

interface RemoveRuntimeIntegrationsOptions {
  removeMarketplace?: boolean;
  runner?: CommandRunner;
  detected?: Partial<Record<RuntimeName, boolean>>;
  codexHome?: string;
  claudeHome?: string;
  /** Explicit state evidence seam for isolated command tests. */
  installedEvidence?: Partial<Record<RuntimeName, boolean>>;
  timeoutMs?: number;
  /** Active project used to reject repository/worktree/common-root PATH decoys. */
  cwd?: string;
  /** Deterministic test seam; production resolves and validates PATH once. */
  resolveExecutable?: RuntimeExecutableResolver;
}

interface RuntimeIntegrationEvidence {
  codex: boolean;
  claude: boolean;
  errors: Record<RuntimeName, string[]>;
}

function readOwnedJson(
  path: string,
  label: string,
  inspect: (value: unknown) => boolean,
): { owned: boolean; error?: string } {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { owned: false };
    return {
      owned: false,
      error: `${label} is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { owned: false, error: `${label} is not a physical file: ${path}` };
  }
  try {
    return { owned: inspect(JSON.parse(readFileSync(path, 'utf8'))) };
  } catch (error) {
    return {
      owned: false,
      error: `${label} is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function inspectClaudeSettings(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('settings root must be an object');
  }
  const enabledPlugins = Reflect.get(value, 'enabledPlugins');
  if (enabledPlugins === undefined) return false;
  if (typeof enabledPlugins !== 'object' || enabledPlugins === null || Array.isArray(enabledPlugins)) {
    throw new Error('enabledPlugins must be an object');
  }
  if (!Object.hasOwn(enabledPlugins, 'genie@automagik')) return false;
  if (typeof Reflect.get(enabledPlugins, 'genie@automagik') !== 'boolean') {
    throw new Error('enabledPlugins["genie@automagik"] must be boolean');
  }
  // Both true and false prove an owned registration that uninstall must clear.
  return true;
}

function registryContainsClaudePlugin(value: unknown): boolean {
  if (value === 'genie@automagik') return true;
  if (Array.isArray(value)) return value.some(registryContainsClaudePlugin);
  if (typeof value !== 'object' || value === null) return false;
  if (Object.hasOwn(value, 'genie@automagik')) return true;
  for (const key of ['id', 'pluginId', 'name']) {
    if (Reflect.get(value, key) === 'genie@automagik') return true;
  }
  return Object.values(value).some(registryContainsClaudePlugin);
}

/** Read-only owned-registration/cache evidence used when a client CLI is unavailable. */
export function inspectRuntimeIntegrationEvidence(
  options: {
    codexHome?: string;
    claudeHome?: string;
  } = {},
): RuntimeIntegrationEvidence {
  const codexHome = options.codexHome ?? getCodexHome();
  const claudeHome = options.claudeHome ?? resolveClaudeDir();
  const errors: Record<RuntimeName, string[]> = { codex: [], claude: [] };
  let codexConfig = '';
  const codexConfigPath = join(codexHome, 'config.toml');
  try {
    const stat = lstatSync(codexConfigPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      errors.codex.push(`Codex config is not a physical file: ${codexConfigPath}`);
    } else {
      codexConfig = readFileSync(codexConfigPath, 'utf8');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      errors.codex.push(
        `Codex config is unreadable at ${codexConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const settings = readOwnedJson(join(claudeHome, 'settings.json'), 'Claude settings', inspectClaudeSettings);
  if (settings.error) errors.claude.push(settings.error);
  let claudeRegistryEvidence = false;
  for (const registryPath of [
    join(claudeHome, 'installed_plugins.json'),
    join(claudeHome, 'plugins', 'installed_plugins.json'),
  ]) {
    const registry = readOwnedJson(registryPath, 'Claude installed-plugin registry', registryContainsClaudePlugin);
    claudeRegistryEvidence ||= registry.owned;
    if (registry.error) errors.claude.push(registry.error);
  }
  return {
    codex:
      codexConfig.includes('genie@automagik') || pathExists(join(codexHome, 'plugins', 'cache', 'automagik', 'genie')),
    claude:
      settings.owned ||
      claudeRegistryEvidence ||
      pathExists(join(claudeHome, 'plugins', 'cache', 'automagik', 'genie')) ||
      pathExists(join(claudeHome, 'plugins', 'marketplaces', 'automagik', 'plugins', 'genie')),
    errors,
  };
}

function removalStep(
  runner: CommandRunner,
  command: string,
  runtime: RuntimeName,
  operation: IntegrationRemovalStep['operation'],
  args: string[],
  timeoutMs: number,
): IntegrationRemovalStep {
  try {
    const result = runner(command, args, { timeoutMs });
    if (result.timedOut) {
      return {
        runtime,
        operation,
        ok: false,
        timedOut: true,
        detail: `timed out after ${timeoutMs}ms; retry the removal`,
      };
    }
    if (result.outputOverflow) {
      return {
        runtime,
        operation,
        ok: false,
        detail: 'command output exceeded the safety limit; retry the removal',
      };
    }
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      if (/not installed|not found|does not exist|no such|unknown (plugin|marketplace)/i.test(detail)) {
        return { runtime, operation, ok: true, detail: 'already absent' };
      }
      return {
        runtime,
        operation,
        ok: false,
        detail: detail || `exited ${result.exitCode}; retry the removal`,
      };
    }
    return { runtime, operation, ok: true, detail: 'removed' };
  } catch (error) {
    return { runtime, operation, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function unavailableRemovalStep(
  runtime: RuntimeName,
  ownedEvidence: boolean,
  inspectionErrors: string[],
  removeMarketplace: boolean,
): IntegrationRemovalStep | null {
  if (!ownedEvidence && inspectionErrors.length === 0 && !removeMarketplace) return null;
  const displayName = runtime === 'codex' ? 'Codex' : 'Claude';
  let detail: string;
  if (inspectionErrors.length > 0) {
    detail = `${displayName} CLI unavailable and local plugin state is unreadable, so removal cannot be proven; restore the CLI or repair the state and retry: ${inspectionErrors.join('; ')}`;
  } else if (ownedEvidence) {
    detail = `${displayName} CLI unavailable while Genie registration/cache evidence remains; restore the CLI and retry`;
  } else {
    detail = `${displayName} CLI unavailable; requested marketplace removal could not be verified`;
  }
  return { runtime, operation: 'plugin', ok: false, detail };
}

interface RuntimeRemovalResolution {
  commands: Partial<Record<RuntimeName, string>>;
  errors: Record<RuntimeName, string[]>;
  detected: Record<RuntimeName, boolean>;
}

function resolveRemovalRuntimeCommands(
  options: RemoveRuntimeIntegrationsOptions,
  cwd: string,
): RuntimeRemovalResolution {
  const resolution: RuntimeRemovalResolution = {
    commands: {},
    errors: { codex: [], claude: [] },
    detected: { codex: false, claude: false },
  };
  for (const runtime of ['codex', 'claude'] as const) {
    if (options.detected?.[runtime] === false) continue;
    try {
      const command = resolveRuntimeExecutable(runtime, cwd, options.resolveExecutable);
      if (command !== null) {
        resolution.commands[runtime] = command;
        resolution.detected[runtime] = true;
      }
    } catch (error) {
      resolution.errors[runtime].push(error instanceof Error ? error.message : String(error));
    }
  }
  return resolution;
}

function appendRuntimePluginRemoval(
  steps: IntegrationRemovalStep[],
  runtime: RuntimeName,
  resolution: RuntimeRemovalResolution,
  evidence: boolean,
  inspectionErrors: string[],
  runner: CommandRunner,
  timeoutMs: number,
  removeMarketplace: boolean,
): void {
  if (resolution.detected[runtime]) {
    const action = runtime === 'codex' ? 'remove' : 'uninstall';
    steps.push(
      removalStep(
        runner,
        resolution.commands[runtime] as string,
        runtime,
        'plugin',
        ['plugin', action, 'genie@automagik'],
        timeoutMs,
      ),
    );
    return;
  }
  const unavailable = unavailableRemovalStep(runtime, evidence, inspectionErrors, removeMarketplace);
  if (unavailable !== null) steps.push(unavailable);
}

function appendRuntimeMarketplaceRemoval(
  steps: IntegrationRemovalStep[],
  runtime: RuntimeName,
  resolution: RuntimeRemovalResolution,
  runner: CommandRunner,
  timeoutMs: number,
  removeMarketplace: boolean,
): void {
  if (!removeMarketplace || !resolution.detected[runtime]) return;
  steps.push(
    removalStep(
      runner,
      resolution.commands[runtime] as string,
      runtime,
      'marketplace',
      ['plugin', 'marketplace', 'remove', 'automagik'],
      timeoutMs,
    ),
  );
}

/** Remove only Genie-owned runtime state and report every failure; shared marketplaces are opt-in. */
export function removeRuntimeIntegrations(
  input: boolean | RemoveRuntimeIntegrationsOptions = false,
): RuntimeIntegrationRemovalResult {
  const options: RemoveRuntimeIntegrationsOptions = typeof input === 'boolean' ? { removeMarketplace: input } : input;
  const runner = options.runner ?? defaultRunner;
  const timeoutMs = options.timeoutMs ?? INTEGRATION_TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();
  const resolution = resolveRemovalRuntimeCommands(options, cwd);
  const inspectedEvidence = inspectRuntimeIntegrationEvidence({
    codexHome: options.codexHome,
    claudeHome: options.claudeHome,
  });
  const evidence = {
    codex: options.installedEvidence?.codex ?? inspectedEvidence.codex,
    claude: options.installedEvidence?.claude ?? inspectedEvidence.claude,
    errors: {
      codex: [...inspectedEvidence.errors.codex, ...resolution.errors.codex],
      claude: [...inspectedEvidence.errors.claude, ...resolution.errors.claude],
    },
  };
  const steps: IntegrationRemovalStep[] = [];
  const removeMarketplace = options.removeMarketplace === true;
  appendRuntimePluginRemoval(
    steps,
    'codex',
    resolution,
    evidence.codex,
    evidence.errors.codex,
    runner,
    timeoutMs,
    removeMarketplace,
  );
  appendRuntimePluginRemoval(
    steps,
    'claude',
    resolution,
    evidence.claude,
    evidence.errors.claude,
    runner,
    timeoutMs,
    removeMarketplace,
  );
  appendRuntimeMarketplaceRemoval(steps, 'codex', resolution, runner, timeoutMs, removeMarketplace);
  appendRuntimeMarketplaceRemoval(steps, 'claude', resolution, runner, timeoutMs, removeMarketplace);
  return { ok: steps.every((step) => step.ok), steps };
}
