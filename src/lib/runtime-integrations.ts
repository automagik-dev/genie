import { createHash, randomBytes } from 'node:crypto';
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
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { acquireLifecycleLease, publishRegularFileNoClobber } from './agent-sync.js';
import { getCodexConfigPath, getCodexHome, migrateDeadGenieOtel } from './codex-config.js';
import { resolveClaudeDir, resolveGenieHome } from './genie-home.js';
import { validateTrustedExecutablePath } from './trusted-executable.js';
import { VERSION } from './version.js';

export type IntegrationSelection = 'auto' | 'codex' | 'claude' | 'all' | 'none';
export type RuntimeName = 'codex' | 'claude';
export type RuntimeExecutableResolver = (name: RuntimeName, cwd: string) => string | null;

export const INTEGRATION_CONSENT_NAME = '.integration-consent.json';

export type IntegrationConsentState =
  | { selection: IntegrationSelection; state: 'committed'; revision: number }
  | {
      selection: IntegrationSelection;
      state: 'pending';
      revision: number;
      previousSelection: IntegrationSelection;
      transitionToken: string;
    };

export interface IntegrationConsentTransitionRef {
  revision: number;
  transitionToken: string;
}

function writeIntegrationConsentState(state: IntegrationConsentState, genieHome: string): void {
  const path = join(genieHome, INTEGRATION_CONSENT_NAME);
  mkdirSync(genieHome, { recursive: true });
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

/** Publish explicit maintenance consent before the first external setup mutation. */
export function beginIntegrationConsentTransition(
  selection: IntegrationSelection,
  genieHome = resolveGenieHome(),
): Extract<IntegrationConsentState, { state: 'pending' }> {
  const current = readIntegrationConsentState(genieHome);
  if (current.state === 'pending') {
    if (current.selection !== selection) {
      throw new Error(
        `integration consent transition to ${current.selection} is pending; resume it before selecting ${selection}`,
      );
    }
    return current;
  }
  const pending: IntegrationConsentState = {
    selection,
    state: 'pending',
    revision: current.revision + 1,
    previousSelection: current.selection,
    transitionToken: randomBytes(16).toString('hex'),
  };
  writeIntegrationConsentState(pending, genieHome);
  return pending;
}

function assertIntegrationConsentTransition(
  current: IntegrationConsentState,
  expected: IntegrationConsentTransitionRef,
  action: 'commit' | 'clear',
): asserts current is Extract<IntegrationConsentState, { state: 'pending' }> {
  if (
    current.state !== 'pending' ||
    current.revision !== expected.revision ||
    current.transitionToken !== expected.transitionToken
  ) {
    throw new Error(
      `integration consent ${action} CAS failed: pending transition token/revision changed; re-read state and retry`,
    );
  }
}

export function commitIntegrationConsentTransition(
  expected: IntegrationConsentTransitionRef,
  genieHome = resolveGenieHome(),
): IntegrationSelection {
  const current = readIntegrationConsentState(genieHome);
  assertIntegrationConsentTransition(current, expected, 'commit');
  writeIntegrationConsentState(
    { selection: current.selection, state: 'committed', revision: current.revision + 1 },
    genieHome,
  );
  return current.selection;
}

/** Clear only a pending transition, restoring the previously committed scope. */
export function clearIntegrationConsentTransition(
  expected: IntegrationConsentTransitionRef,
  genieHome = resolveGenieHome(),
): IntegrationSelection {
  const current = readIntegrationConsentState(genieHome);
  assertIntegrationConsentTransition(current, expected, 'clear');
  const previous = current.previousSelection;
  writeIntegrationConsentState({ selection: previous, state: 'committed', revision: current.revision + 1 }, genieHome);
  return previous;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputOverflow?: boolean;
}

export interface CommandRunOptions {
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
 * genie plugin payload the integrations reference (`plugins/genie/codex-agents`
 * ships in every bundle and repo checkout). This guard is what keeps virtual
 * compile-time paths (`/$bunfs/...` → `/`) from ever being returned.
 */
function isBundleRoot(root: string): boolean {
  return existsSync(join(root, 'plugins', 'genie', 'codex-agents'));
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Locate the directory that contains `plugins/genie` plus the marketplace
 * manifests (`.agents/plugins/marketplace.json`, `.claude-plugin/marketplace.json`).
 *
 * Probe order (first qualifying root wins):
 *   1. explicit argument / GENIE_BUNDLE_ROOT — caller's assertion, unvalidated
 *   2. GENIE_HOME (`~/.genie`) — the installed layout: install.sh extracts to
 *      `~/.genie/bin/` and normalizeAuxLayout moves plugins/ + manifests to the
 *      home root, so the home itself is the marketplace root
 *   3. dirname(execPath) and its parent (both as-invoked and symlink-resolved) —
 *      covers a binary run straight out of an unpacked tarball
 *   4. `import.meta.dir/../..` — source checkout under `bun test`/`bun run`;
 *      under `bun --compile` this is the virtual `/$bunfs` tree and is skipped
 *
 * Returns null when no candidate carries the payload — callers surface that as
 * a per-runtime failure instead of pointing `plugin marketplace add` at junk.
 */
export function resolveBundleRoot(explicit?: string): string | null {
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

export interface RuntimePluginState {
  installed: boolean;
  enabled?: boolean;
  version?: string;
}

export type RuntimePluginStateParseResult = { ok: true; state: RuntimePluginState } | { ok: false; detail: string };

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

export function parseCodexPluginState(raw: string): RuntimePluginStateParseResult {
  const payload = jsonPayload(raw);
  if (typeof payload !== 'object' || payload === null || !Array.isArray(Reflect.get(payload, 'installed'))) {
    return { ok: false, detail: 'Codex plugin list returned malformed JSON (expected an installed array)' };
  }
  const plugins = (Reflect.get(payload, 'installed') as unknown[]).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && Reflect.get(entry, 'pluginId') === 'genie@automagik',
  );
  if (plugins.length > 1) {
    return { ok: false, detail: 'Codex plugin list returned malformed JSON (duplicate Genie entries)' };
  }
  const plugin = plugins[0];
  return plugin ? validateInstalledPluginEntry('Codex', plugin) : { ok: true, state: { installed: false } };
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
export function codexPluginState(raw: string): RuntimePluginState {
  const parsed = parseCodexPluginState(raw);
  return parsed.ok ? parsed.state : { installed: false };
}

/** Compatibility parser for read-only callers that treat invalid output as unavailable. */
export function claudePluginState(raw: string): RuntimePluginState {
  const parsed = parseClaudePluginState(raw);
  return parsed.ok ? parsed.state : { installed: false };
}

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

export type CodexAgentOwnership = 'absent' | 'user-owned' | 'managed-clean' | 'managed-modified';

export interface CodexAgentOwnershipEntry {
  name: string;
  path: string;
  ownership: CodexAgentOwnership;
}

export interface CodexAgentOwnershipReport {
  inventoryPath: string;
  status: 'missing' | 'valid' | 'corrupt';
  entries: CodexAgentOwnershipEntry[];
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

/** Shared digest-backed classifier for setup/update, doctor, and uninstall. */
export function inspectCodexAgentOwnership(codexHome = getCodexHome()): CodexAgentOwnershipReport {
  const state = readCodexAgentInventory(codexHome);
  const agentsDir = join(codexHome, 'agents');
  const names = new Set<string>(Object.keys(state.inventory.files));
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir)) if (CODEX_AGENT_NAME_RE.test(name)) names.add(name);
  }
  return {
    inventoryPath: inventoryPath(codexHome),
    status: state.status,
    error: state.error,
    entries: [...names].sort().map((name) => ({
      name,
      path: join(agentsDir, name),
      ownership: classifyCodexAgentFile(join(agentsDir, name), state.inventory.files[name]),
    })),
  };
}

export interface CodexAgentInstallResult {
  /** Files converged (fresh, unchanged, or digest-clean updates). */
  installed: number;
  /** Existing files without inventory ownership — user-owned, never overwritten. */
  skippedUserOwned: string[];
  /** Modified inventory-owned files preserved byte-identically and relinquished when orphaned. */
  keptModified: string[];
  /** Digest-clean inventory entries no longer shipped and removed during convergence. */
  removed: string[];
  /** Legacy compatibility field. Modified files are no longer overwritten or backed up. */
  backedUp: string[];
  /** Exact known prior Genie payloads adopted through backup-first migration. */
  adoptedLegacy?: string[];
}

export interface CodexAgentTransactionOptions {
  /** Failure-injection seam invoked immediately before each live promotion. */
  beforePromotion?: (stage: string) => void;
  /** Failure-injection seam after authorization but before the accepted object is parked. */
  afterAuthorization?: (stage: string) => void;
  /** Failure-injection seam after parking and immediately before exclusive publication. */
  beforePublish?: (stage: string) => void;
  /** Failure-injection seam after the durable commit marker and before evidence cleanup. */
  afterCommit?: () => void;
  /** Failure-injection seam after authenticated cleanup rename and before recursive deletion. */
  afterCleanupRename?: (cleanupDir: string) => void;
}

interface RoleAgentWrite {
  content: Buffer;
  identity: RegularRoleFileIdentity;
}

interface CodexAgentTransactionJournal {
  version: 3;
  operations: Array<{ name: string; nextIdentity: RoleFileIdentity; beforeIdentity: RoleFileIdentity }>;
  inventoryIdentity: RoleFileIdentity;
  inventoryBeforeIdentity: RoleFileIdentity;
}

interface RoleAgentPublicationRecord {
  version: 1;
  artifacts: Record<string, RegularRoleFileIdentity>;
}

interface RoleAgentTransactionPlan {
  operations: CodexAgentTransactionJournal['operations'];
  inventoryContent: Buffer | null;
  journal: CodexAgentTransactionJournal;
}

interface PreparedRoleAgentTransaction {
  transactionDir: string;
  stagedDir: string;
  beforeDir: string;
}

const CODEX_AGENT_TRANSACTION_PREFIX = '.genie-role-agents.txn-';
const CODEX_AGENT_COMMITTED_CLEANUP_PREFIX = '.genie-role-agents.committed-cleanup-';
const CODEX_AGENT_PREPARATION_PREFIX = '.genie-role-agents.prepare-';
const CODEX_AGENT_CONFLICT_PREFIX = '.genie-role-agents.conflict-';
const CODEX_AGENT_PUBLICATIONS_NAME = 'publications.json';

function digestBytes(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

function readRoleTransactionJournal(path: string): CodexAgentTransactionJournal {
  if (physicalRoleFileIdentity(path).kind !== 'regular') {
    throw new Error(`role-agent transaction journal is not a physical regular file: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (parsed.version === 2) {
    throw new Error(`legacy digest-only role-agent transaction cannot be recovered automatically: ${path}`);
  }
  const operations = Array.isArray(parsed.operations) ? parsed.operations : [];
  if (
    parsed.version !== 3 ||
    !Array.isArray(parsed.operations) ||
    parsed.operations.some(
      (op) =>
        typeof op !== 'object' ||
        op === null ||
        !CODEX_AGENT_NAME_RE.test((op as { name?: string }).name ?? '') ||
        !isJournalRoleFileIdentity((op as { beforeIdentity?: unknown }).beforeIdentity) ||
        !isJournalRoleFileIdentity((op as { nextIdentity?: unknown }).nextIdentity),
    ) ||
    !isJournalRoleFileIdentity(parsed.inventoryIdentity) ||
    !isJournalRoleFileIdentity(parsed.inventoryBeforeIdentity) ||
    new Set(operations.map((operation) => Reflect.get(operation as object, 'name'))).size !== operations.length
  ) {
    throw new Error(`invalid role-agent transaction journal: ${path}`);
  }
  return parsed as unknown as CodexAgentTransactionJournal;
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

function isJournalRoleFileIdentity(value: unknown): value is RoleFileIdentity {
  return (
    (typeof value === 'object' && value !== null && Reflect.get(value, 'kind') === 'absent') ||
    isRegularRoleFileIdentity(value)
  );
}

function readRolePublicationRecord(transactionDir: string): RoleAgentPublicationRecord {
  const path = join(transactionDir, CODEX_AGENT_PUBLICATIONS_NAME);
  const identity = physicalRoleFileIdentity(path);
  if (identity.kind === 'absent') return { version: 1, artifacts: {} };
  if (identity.kind !== 'regular' || identity.mode !== 0o600) {
    throw new Error(`role-agent publication record is not a mode-0600 physical regular file: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RoleAgentPublicationRecord>;
  if (
    parsed.version !== 1 ||
    typeof parsed.artifacts !== 'object' ||
    parsed.artifacts === null ||
    Object.entries(parsed.artifacts).some(
      ([name, identity]) =>
        (name !== CODEX_AGENT_INVENTORY_NAME && !CODEX_AGENT_NAME_RE.test(name)) ||
        !isRegularRoleFileIdentity(identity),
    )
  ) {
    throw new Error(`invalid role-agent publication record: ${path}`);
  }
  return parsed as RoleAgentPublicationRecord;
}

function recordRolePublication(transactionDir: string, name: string, identity: RegularRoleFileIdentity): void {
  const record = readRolePublicationRecord(transactionDir);
  record.artifacts[name] = identity;
  const path = join(transactionDir, CODEX_AGENT_PUBLICATIONS_NAME);
  const staging = `${path}.staging-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(staging, path);
}

function rollbackRoleTransaction(
  agentsDir: string,
  transactionDir: string,
  journal: CodexAgentTransactionJournal,
): void {
  const beforeDir = join(transactionDir, 'before');
  const publishedDir = join(transactionDir, 'published');
  const publication = readRolePublicationRecord(transactionDir);
  for (const operation of journal.operations) {
    rollbackRoleArtifact(
      join(agentsDir, operation.name),
      join(beforeDir, operation.name),
      join(publishedDir, operation.name),
      operation.beforeIdentity,
      operation.nextIdentity,
      publication.artifacts[operation.name],
      `role-agent ${operation.name}`,
    );
  }
  rollbackRoleArtifact(
    join(agentsDir, CODEX_AGENT_INVENTORY_NAME),
    join(beforeDir, CODEX_AGENT_INVENTORY_NAME),
    join(publishedDir, CODEX_AGENT_INVENTORY_NAME),
    journal.inventoryBeforeIdentity,
    journal.inventoryIdentity,
    publication.artifacts[CODEX_AGENT_INVENTORY_NAME],
    'role-agent inventory',
  );
  rmSync(transactionDir, { recursive: true, force: true });
}

function rollbackRoleArtifact(
  target: string,
  before: string,
  published: string,
  beforeIdentity: RoleFileIdentity,
  nextIdentity: RoleFileIdentity,
  recordedPublication: RegularRoleFileIdentity | undefined,
  description: string,
): void {
  const parkedIdentity = physicalRoleFileIdentity(before);
  if (beforeIdentity.kind === 'regular' && parkedIdentity.kind !== 'absent') {
    if (!roleFileIdentityEquals(parkedIdentity, beforeIdentity)) {
      throw new RoleAgentConflictError(`${description} prior target changed during recovery: ${before}`);
    }
    const liveIdentity = physicalRoleFileIdentity(target);
    if (roleFileIdentityEquals(liveIdentity, beforeIdentity)) return;
    if (liveIdentity.kind !== 'absent') {
      parkRecordedRolePublication(target, published, liveIdentity, recordedPublication, description);
    }
    restoreRoleArtifactNoClobber(before, target, beforeIdentity, description);
    return;
  }
  if (beforeIdentity.kind === 'regular') {
    if (!roleFileIdentityEquals(physicalRoleFileIdentity(target), beforeIdentity)) {
      throw new RoleAgentConflictError(`${description} lost its prior target during recovery: ${target}`);
    }
    return;
  }
  if (beforeIdentity.kind !== 'absent') {
    throw new Error(`unsupported ${description} prior identity in transaction`);
  }
  if (parkedIdentity.kind !== 'absent') {
    throw new RoleAgentConflictError(`${description} has an unexpected parked target during recovery: ${before}`);
  }
  const liveIdentity = physicalRoleFileIdentity(target);
  if (liveIdentity.kind !== 'absent') {
    parkRecordedRolePublication(target, published, liveIdentity, recordedPublication, description);
  } else if (nextIdentity.kind === 'regular' && recordedPublication === undefined) {
    // The process may have died after exclusive publication but before recording
    // its identity, and another actor may then have removed it. Absence is the
    // requested rollback state, so no artifact needs deletion.
    return;
  }
}

function parkRecordedRolePublication(
  target: string,
  published: string,
  liveIdentity: RoleFileIdentity,
  recordedPublication: RegularRoleFileIdentity | undefined,
  description: string,
): void {
  if (recordedPublication === undefined || !roleFileIdentityEquals(liveIdentity, recordedPublication)) {
    throw new RoleAgentConflictError(
      `${description} live target is not an exact recorded publication; preserving it: ${target}`,
    );
  }
  const alreadyParked = physicalRoleFileIdentity(published);
  if (alreadyParked.kind !== 'absent') {
    if (!roleFileIdentityEquals(alreadyParked, recordedPublication)) {
      throw new RoleAgentConflictError(`${description} published evidence changed during recovery: ${published}`);
    }
    throw new RoleAgentConflictError(`${description} target reappeared during recovery: ${target}`);
  }
  mkdirSync(dirname(published), { recursive: true });
  renameSync(target, published);
  if (!roleFileIdentityEquals(physicalRoleFileIdentity(published), recordedPublication)) {
    throw new RoleAgentConflictError(`${description} changed while parking its publication: ${published}`);
  }
  if (physicalRoleFileIdentity(target).kind !== 'absent') {
    throw new RoleAgentConflictError(`${description} target reappeared during recovery: ${target}`);
  }
}

function restoreRoleArtifactNoClobber(
  parked: string,
  target: string,
  expected: RegularRoleFileIdentity,
  description: string,
): void {
  try {
    publishRegularFileNoClobber(parked, target);
  } catch (error) {
    throw new RoleAgentConflictError(
      `exclusive ${description} restore failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!roleFileIdentityEquals(physicalRoleFileIdentity(target), expected)) {
    throw new RoleAgentConflictError(`${description} changed during exclusive restore: ${target}`);
  }
}

interface RoleAgentArtifactAuthority {
  name: string;
  nextIdentity: RoleFileIdentity;
  beforeIdentity: RoleFileIdentity;
}

function roleAgentArtifactAuthorities(journal: CodexAgentTransactionJournal): RoleAgentArtifactAuthority[] {
  return [
    ...journal.operations,
    {
      name: CODEX_AGENT_INVENTORY_NAME,
      nextIdentity: journal.inventoryIdentity,
      beforeIdentity: journal.inventoryBeforeIdentity,
    },
  ];
}

function readRoleTransactionDirectoryEntries(path: string, description: string, optional = false): string[] {
  const identity = physicalRoleFileIdentity(path);
  if (identity.kind === 'absent' && optional) return [];
  if (identity.kind !== 'directory') {
    throw new RoleAgentConflictError(`committed ${description} is not a physical directory: ${path}`);
  }
  return readdirSync(path).sort();
}

function assertExactRoleTransactionArtifacts(
  directory: string,
  expected: Map<string, RegularRoleFileIdentity>,
  description: string,
): void {
  const entries = readRoleTransactionDirectoryEntries(directory, description);
  const expectedNames = [...expected.keys()].sort();
  if (entries.length !== expectedNames.length || entries.some((entry, index) => entry !== expectedNames[index])) {
    throw new RoleAgentConflictError(`committed ${description} artifact set does not match the journal`);
  }
  for (const [name, identity] of expected) {
    if (!roleFileIdentityEquals(physicalRoleFileIdentity(join(directory, name)), identity)) {
      throw new RoleAgentConflictError(`committed ${description} evidence changed: ${join(directory, name)}`);
    }
  }
}

function authenticateCommittedRoleTransaction(
  agentsDir: string,
  transactionDir: string,
  journal: CodexAgentTransactionJournal,
): void {
  const marker = physicalRoleFileIdentity(join(transactionDir, 'COMMITTED'));
  if (marker.kind !== 'regular' || marker.digest !== digestBytes('ok\n')) {
    throw new RoleAgentConflictError('committed role-agent transaction has an invalid commit marker');
  }

  const rootEntries = readdirSync(transactionDir);
  const allowedRootEntries = new Set([
    'COMMITTED',
    'before',
    'journal.json',
    'published',
    CODEX_AGENT_PUBLICATIONS_NAME,
    'staged',
  ]);
  if (rootEntries.some((entry) => !allowedRootEntries.has(entry))) {
    throw new RoleAgentConflictError('committed role-agent transaction contains an unauthenticated artifact');
  }

  const authorities = roleAgentArtifactAuthorities(journal);
  const staged = new Map<string, RegularRoleFileIdentity>();
  const before = new Map<string, RegularRoleFileIdentity>();
  for (const authority of authorities) {
    if (authority.nextIdentity.kind === 'regular') staged.set(authority.name, authority.nextIdentity);
    if (authority.beforeIdentity.kind === 'regular') before.set(authority.name, authority.beforeIdentity);
    if (!roleFileIdentityEquals(physicalRoleFileIdentity(join(agentsDir, authority.name)), authority.nextIdentity)) {
      throw new RoleAgentConflictError(`committed live next state changed: ${join(agentsDir, authority.name)}`);
    }
  }

  const publication = readRolePublicationRecord(transactionDir);
  const publicationNames = Object.keys(publication.artifacts).sort();
  const stagedNames = [...staged.keys()].sort();
  if (
    publicationNames.length !== stagedNames.length ||
    publicationNames.some((name, index) => name !== stagedNames[index])
  ) {
    throw new RoleAgentConflictError('committed publication record does not exactly match the journal');
  }
  for (const [name, identity] of staged) {
    if (!roleFileIdentityEquals(publication.artifacts[name], identity)) {
      throw new RoleAgentConflictError(`committed publication authority changed for ${name}`);
    }
  }

  assertExactRoleTransactionArtifacts(join(transactionDir, 'staged'), staged, 'staged');
  assertExactRoleTransactionArtifacts(join(transactionDir, 'before'), before, 'prior parked');

  const publishedDir = join(transactionDir, 'published');
  for (const name of readRoleTransactionDirectoryEntries(publishedDir, 'published evidence', true)) {
    const recorded = publication.artifacts[name];
    if (
      recorded === undefined ||
      !roleFileIdentityEquals(physicalRoleFileIdentity(join(publishedDir, name)), recorded)
    ) {
      throw new RoleAgentConflictError(`committed published evidence changed: ${join(publishedDir, name)}`);
    }
  }
}

function renameRoleAgentTransactionNamespace(
  transactionDir: string,
  sourcePrefix: string,
  destinationPrefix: string,
): string {
  const name = basename(transactionDir);
  if (!name.startsWith(sourcePrefix)) {
    throw new Error(`role-agent transaction is outside the expected ${sourcePrefix} namespace: ${transactionDir}`);
  }
  const destination = join(dirname(transactionDir), `${destinationPrefix}${name.slice(sourcePrefix.length)}`);
  renameSync(transactionDir, destination);
  return destination;
}

function beginCommittedRoleTransactionCleanup(
  agentsDir: string,
  transactionDir: string,
  journal: CodexAgentTransactionJournal,
): string {
  authenticateCommittedRoleTransaction(agentsDir, transactionDir, journal);
  return renameRoleAgentTransactionNamespace(
    transactionDir,
    CODEX_AGENT_TRANSACTION_PREFIX,
    CODEX_AGENT_COMMITTED_CLEANUP_PREFIX,
  );
}

function finishCommittedRoleTransactionCleanup(
  agentsDir: string,
  cleanupDir: string,
  journal: CodexAgentTransactionJournal,
): void {
  // Re-authenticate under the cleanup-only pathname before deleting evidence.
  // If deletion is interrupted, this namespace can never be mistaken for
  // rollback authority even when COMMITTED or other children are already gone.
  authenticateCommittedRoleTransaction(agentsDir, cleanupDir, journal);
  rmSync(cleanupDir, { recursive: true, force: true });
}

function recoverCommittedRoleAgentCleanups(agentsDir: string, names: string[]): void {
  for (const name of names) {
    const cleanupDir = join(agentsDir, name);
    try {
      if (physicalRoleFileIdentity(cleanupDir).kind !== 'directory') {
        throw new Error(`committed role-agent cleanup is not a physical directory: ${cleanupDir}`);
      }
      const journal = readRoleTransactionJournal(join(cleanupDir, 'journal.json'));
      finishCommittedRoleTransactionCleanup(agentsDir, cleanupDir, journal);
    } catch (error) {
      const conflict = pathExists(cleanupDir) ? preserveRoleAgentConflict(cleanupDir) : cleanupDir;
      throw new Error(
        `committed role-agent cleanup preserved live, prior, and staged evidence at ${conflict}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function recoverRoleAgentTransactions(agentsDir: string): void {
  const rootIdentity = physicalRoleFileIdentity(agentsDir);
  if (rootIdentity.kind === 'absent') return;
  if (rootIdentity.kind !== 'directory') {
    throw new Error(`Codex role-agent root is not a physical directory: ${agentsDir}`);
  }
  const entries = readdirSync(agentsDir).sort();
  recoverCommittedRoleAgentCleanups(
    agentsDir,
    entries.filter((entry) => entry.startsWith(CODEX_AGENT_COMMITTED_CLEANUP_PREFIX)),
  );
  for (const name of entries.filter((entry) => entry.startsWith(CODEX_AGENT_TRANSACTION_PREFIX))) {
    const transactionDir = join(agentsDir, name);
    if (physicalRoleFileIdentity(transactionDir).kind !== 'directory') {
      throw new Error(`role-agent transaction is not a physical directory: ${transactionDir}`);
    }
    let evidenceDir = transactionDir;
    try {
      const journal = readRoleTransactionJournal(join(transactionDir, 'journal.json'));
      if (pathExists(join(transactionDir, 'COMMITTED'))) {
        evidenceDir = beginCommittedRoleTransactionCleanup(agentsDir, transactionDir, journal);
        finishCommittedRoleTransactionCleanup(agentsDir, evidenceDir, journal);
        continue;
      }
      rollbackRoleTransaction(agentsDir, transactionDir, journal);
    } catch (error) {
      const conflict = pathExists(evidenceDir) ? preserveRoleAgentConflict(evidenceDir) : evidenceDir;
      throw new Error(
        `role-agent transaction recovery preserved live, prior, and staged evidence at ${conflict}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Recover only journaled transactions beneath the known Codex agents root. */
export function recoverCodexAgentTransactions(codexHome = getCodexHome()): void {
  recoverRoleAgentTransactions(join(codexHome, 'agents'));
}

function planRoleAgentTransaction(
  writes: Map<string, RoleAgentWrite>,
  removals: string[],
  inventory: CodexAgentInventory,
  expected: Map<string, RoleFileIdentity>,
  expectedInventoryIdentity: RoleFileIdentity,
): RoleAgentTransactionPlan {
  const operations = [
    ...[...writes].map(([name, write]) => ({
      name,
      nextIdentity: write.identity,
      beforeIdentity: expected.get(name) ?? { kind: 'absent' as const },
    })),
    ...removals.map((name) => ({
      name,
      nextIdentity: { kind: 'absent' as const },
      beforeIdentity: expected.get(name) ?? { kind: 'absent' as const },
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const inventoryContent =
    Object.keys(inventory.files).length === 0 ? null : Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  const journal: CodexAgentTransactionJournal = {
    version: 3,
    operations,
    inventoryIdentity:
      inventoryContent === null
        ? { kind: 'absent' }
        : { kind: 'regular', mode: CODEX_AGENT_INVENTORY_MODE, digest: digestBytes(inventoryContent) },
    inventoryBeforeIdentity: expectedInventoryIdentity,
  };
  return { operations, inventoryContent, journal };
}

function prepareRoleAgentTransaction(
  agentsDir: string,
  writes: Map<string, RoleAgentWrite>,
  plan: RoleAgentTransactionPlan,
): PreparedRoleAgentTransaction {
  const transactionName = `${process.pid}-${Date.now()}-${randomTransactionSuffix()}`;
  const preparationDir = join(agentsDir, `${CODEX_AGENT_PREPARATION_PREFIX}${transactionName}`);
  const transactionDir = join(agentsDir, `${CODEX_AGENT_TRANSACTION_PREFIX}${transactionName}`);
  const stagedDir = join(preparationDir, 'staged');
  mkdirSync(stagedDir, { recursive: true });
  mkdirSync(join(preparationDir, 'before'), { recursive: true });
  for (const [name, write] of writes) {
    writeFileSync(join(stagedDir, name), write.content, { mode: write.identity.mode });
    chmodSync(join(stagedDir, name), write.identity.mode);
  }
  if (plan.inventoryContent !== null) {
    writeFileSync(join(stagedDir, CODEX_AGENT_INVENTORY_NAME), plan.inventoryContent, {
      mode: CODEX_AGENT_INVENTORY_MODE,
    });
    chmodSync(join(stagedDir, CODEX_AGENT_INVENTORY_NAME), CODEX_AGENT_INVENTORY_MODE);
  }
  writeFileSync(join(preparationDir, 'journal.json'), `${JSON.stringify(plan.journal, null, 2)}\n`);
  // Recovery only discovers the transaction after every staged artifact and the
  // complete journal exist. A crash before this rename leaves inert preparation
  // debris rather than a transaction that poisons every future lifecycle run.
  renameSync(preparationDir, transactionDir);
  return {
    transactionDir,
    stagedDir: join(transactionDir, 'staged'),
    beforeDir: join(transactionDir, 'before'),
  };
}

function authorizeRoleAgentPreimages(
  agentsDir: string,
  operations: CodexAgentTransactionJournal['operations'],
  expectedInventoryIdentity: RoleFileIdentity,
  options: CodexAgentTransactionOptions,
): void {
  // Test hooks run before every authorization check and before any mutation,
  // so an injected race cannot leave a partially promoted batch.
  for (const operation of operations) {
    options.beforePromotion?.(`payload:${operation.name}`);
    assertExpectedRoleFile(join(agentsDir, operation.name), operation.beforeIdentity);
  }
  options.beforePromotion?.('inventory');
  assertExpectedRoleFile(join(agentsDir, CODEX_AGENT_INVENTORY_NAME), expectedInventoryIdentity);
}

function parkRoleAgentPreimages(
  agentsDir: string,
  beforeDir: string,
  operations: CodexAgentTransactionJournal['operations'],
  expectedInventoryIdentity: RoleFileIdentity,
  options: CodexAgentTransactionOptions,
): void {
  // Park every accepted preimage before any staged content is promoted. Each
  // moved object is re-identified from its quarantine path, closing the race
  // between pathname authorization and rename.
  for (const operation of operations) {
    const target = join(agentsDir, operation.name);
    assertExpectedRoleFile(target, operation.beforeIdentity);
    options.afterAuthorization?.(`payload:${operation.name}`);
    assertExpectedRoleFile(target, operation.beforeIdentity);
    if (pathExists(target)) renameSync(target, join(beforeDir, operation.name));
    assertExpectedRoleFile(join(beforeDir, operation.name), operation.beforeIdentity);
    if (physicalRoleFileIdentity(target).kind !== 'absent') {
      throw new RoleAgentConflictError(`role-agent target reappeared while parked: ${target}`);
    }
  }

  const targetInventory = join(agentsDir, CODEX_AGENT_INVENTORY_NAME);
  assertExpectedRoleFile(targetInventory, expectedInventoryIdentity);
  options.afterAuthorization?.('inventory');
  assertExpectedRoleFile(targetInventory, expectedInventoryIdentity);
  if (pathExists(targetInventory)) renameSync(targetInventory, join(beforeDir, CODEX_AGENT_INVENTORY_NAME));
  assertExpectedRoleFile(join(beforeDir, CODEX_AGENT_INVENTORY_NAME), expectedInventoryIdentity);
  if (physicalRoleFileIdentity(targetInventory).kind !== 'absent') {
    throw new RoleAgentConflictError(`role-agent inventory reappeared while parked: ${targetInventory}`);
  }
}

function publishRoleAgentArtifact(
  transactionDir: string,
  staged: string,
  target: string,
  name: string,
  expected: RegularRoleFileIdentity,
  description: string,
): void {
  try {
    publishRegularFileNoClobber(staged, target);
  } catch (error) {
    throw new RoleAgentConflictError(
      `exclusive ${description} publish failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const published = physicalRoleFileIdentity(target);
  if (!roleFileIdentityEquals(published, expected) || published.kind !== 'regular') {
    throw new RoleAgentConflictError(`${description} changed during exclusive publication: ${target}`);
  }
  recordRolePublication(transactionDir, name, published);
}

function publishRoleAgentArtifacts(
  agentsDir: string,
  prepared: PreparedRoleAgentTransaction,
  plan: RoleAgentTransactionPlan,
  options: CodexAgentTransactionOptions,
): void {
  for (const operation of plan.operations) {
    if (operation.nextIdentity.kind !== 'regular') continue;
    options.beforePublish?.(`payload:${operation.name}`);
    publishRoleAgentArtifact(
      prepared.transactionDir,
      join(prepared.stagedDir, operation.name),
      join(agentsDir, operation.name),
      operation.name,
      operation.nextIdentity,
      `role-agent ${operation.name}`,
    );
  }
  if (plan.inventoryContent === null) return;
  if (plan.journal.inventoryIdentity.kind !== 'regular') {
    throw new Error('role-agent inventory content lacks a regular publication identity');
  }
  options.beforePublish?.('inventory');
  publishRoleAgentArtifact(
    prepared.transactionDir,
    join(prepared.stagedDir, CODEX_AGENT_INVENTORY_NAME),
    join(agentsDir, CODEX_AGENT_INVENTORY_NAME),
    CODEX_AGENT_INVENTORY_NAME,
    plan.journal.inventoryIdentity,
    'role-agent inventory',
  );
}

function verifyPublishedRoleAgentTransaction(agentsDir: string, journal: CodexAgentTransactionJournal): void {
  for (const operation of journal.operations) {
    assertExpectedRoleFile(join(agentsDir, operation.name), operation.nextIdentity);
  }
  assertExpectedRoleFile(join(agentsDir, CODEX_AGENT_INVENTORY_NAME), journal.inventoryIdentity);
}

function publishRoleAgentTransaction(
  agentsDir: string,
  writes: Map<string, RoleAgentWrite>,
  removals: string[],
  inventory: CodexAgentInventory,
  expected: Map<string, RoleFileIdentity>,
  expectedInventoryIdentity: RoleFileIdentity,
  options: CodexAgentTransactionOptions,
): void {
  const plan = planRoleAgentTransaction(writes, removals, inventory, expected, expectedInventoryIdentity);
  const prepared = prepareRoleAgentTransaction(agentsDir, writes, plan);
  let committed = false;

  try {
    authorizeRoleAgentPreimages(agentsDir, plan.operations, expectedInventoryIdentity, options);
    parkRoleAgentPreimages(agentsDir, prepared.beforeDir, plan.operations, expectedInventoryIdentity, options);
    publishRoleAgentArtifacts(agentsDir, prepared, plan, options);
    verifyPublishedRoleAgentTransaction(agentsDir, plan.journal);
    writeFileSync(join(prepared.transactionDir, 'COMMITTED'), 'ok\n');
    committed = true;
    options.afterCommit?.();
    const cleanupDir = beginCommittedRoleTransactionCleanup(agentsDir, prepared.transactionDir, plan.journal);
    options.afterCleanupRename?.(cleanupDir);
    finishCommittedRoleTransactionCleanup(agentsDir, cleanupDir, plan.journal);
  } catch (error) {
    // COMMITTED is the point of no return. Recovery authenticates and cleans
    // this exact next state; it must never reinterpret it as rollback work.
    if (committed) throw error;
    try {
      rollbackRoleTransaction(agentsDir, prepared.transactionDir, plan.journal);
    } catch (rollbackError) {
      const conflict = pathExists(prepared.transactionDir)
        ? preserveRoleAgentConflict(prepared.transactionDir)
        : prepared.transactionDir;
      throw new Error(
        `role-agent transaction failed (${error instanceof Error ? error.message : String(error)}); rollback preserved live, prior, and staged evidence at ${conflict} (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
      );
    }
    throw error;
  }
}

class RoleAgentConflictError extends Error {}

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

function assertExpectedRoleFile(path: string, expected: RoleFileIdentity): void {
  const identity = physicalRoleFileIdentity(path);
  if (expected.kind === 'absent') {
    if (identity.kind !== 'absent')
      throw new RoleAgentConflictError(`role-agent target appeared before promotion (${identity.kind}): ${path}`);
    return;
  }
  if (!roleFileIdentityEquals(identity, expected)) {
    throw new RoleAgentConflictError(`role-agent target changed before promotion: ${path}`);
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function preserveRoleAgentConflict(transactionDir: string): string {
  const name = basename(transactionDir);
  const sourcePrefix = name.startsWith(CODEX_AGENT_TRANSACTION_PREFIX)
    ? CODEX_AGENT_TRANSACTION_PREFIX
    : name.startsWith(CODEX_AGENT_COMMITTED_CLEANUP_PREFIX)
      ? CODEX_AGENT_COMMITTED_CLEANUP_PREFIX
      : null;
  if (sourcePrefix === null) {
    throw new Error(`role-agent evidence is outside a recoverable namespace: ${transactionDir}`);
  }
  return renameRoleAgentTransactionNamespace(transactionDir, sourcePrefix, CODEX_AGENT_CONFLICT_PREFIX);
}

function randomTransactionSuffix(): string {
  return createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12);
}

interface CodexAgentInstallPlan {
  recorded: ReadCodexAgentInventory;
  inventory: CodexAgentInventory;
  result: CodexAgentInstallResult;
  writes: Map<string, RoleAgentWrite>;
  removals: string[];
  expected: Map<string, RoleFileIdentity>;
}

function collectCurrentCodexAgentPayloads(
  source: string,
  target: string,
  sourceNames: string[],
  plan: CodexAgentInstallPlan,
): void {
  for (const name of sourceNames) {
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    const sourceContent = readFileSync(sourcePath);
    if (!sourceContent.toString('utf8').startsWith(CODEX_AGENT_SENTINEL)) {
      throw new Error(`Codex role-agent source lacks the managed sentinel: ${sourcePath}`);
    }
    const sourceIdentity = physicalRoleFileIdentity(sourcePath);
    if (sourceIdentity.kind !== 'regular') {
      throw new Error(`Codex role-agent source is not a regular readable file: ${sourcePath}`);
    }
    const recorded = plan.recorded.files[name];
    const ownership = classifyCodexAgentFile(targetPath, recorded, sourceIdentity);
    if (ownership === 'user-owned') {
      // Bytes are not an ownership capability. An inventory-free file remains
      // personal even when it exactly matches a current or historical Genie
      // payload; update/uninstall must never silently acquire deletion authority.
      plan.result.skippedUserOwned.push(name);
      continue;
    }
    if (ownership === 'managed-modified') {
      plan.result.keptModified.push(name);
      if (recorded !== undefined && 'identity' in recorded) {
        plan.inventory.files[name] = recorded;
      } else {
        throw new Error(
          `Codex role-agent ${name} has legacy v1 digest authority but its physical mode cannot be authenticated; preserved it and refused the inventory upgrade`,
        );
      }
      continue;
    }
    const acceptedIdentity: RoleFileIdentity =
      ownership === 'absent'
        ? { kind: 'absent' }
        : recorded !== undefined && 'identity' in recorded
          ? recorded.identity
          : {
              ...sourceIdentity,
              digest: recorded && 'digest' in recorded ? recorded.digest : sourceIdentity.digest,
            };
    if (!roleFileIdentityEquals(acceptedIdentity, sourceIdentity)) {
      plan.writes.set(name, { content: sourceContent, identity: sourceIdentity });
      plan.expected.set(name, acceptedIdentity);
    }
    plan.inventory.files[name] = { identity: sourceIdentity };
    plan.result.installed += 1;
  }
}

function collectObsoleteCodexAgentPayloads(target: string, sourceNames: string[], plan: CodexAgentInstallPlan): void {
  for (const name of Object.keys(plan.recorded.files)) {
    if (sourceNames.includes(name)) continue;
    const recorded = plan.recorded.files[name];
    const ownership = classifyCodexAgentFile(join(target, name), recorded);
    if (ownership === 'managed-clean') {
      plan.removals.push(name);
      plan.expected.set(name, 'identity' in recorded ? recorded.identity : { kind: 'absent' });
      plan.result.removed.push(name);
    } else if (ownership === 'managed-modified') {
      plan.result.keptModified.push(name);
    }
  }
}

export function installCodexAgents(
  bundleRoot: string,
  codexHome = getCodexHome(),
  transactionOptions: CodexAgentTransactionOptions = {},
): CodexAgentInstallResult {
  const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents');
  if (!existsSync(source)) throw new Error(`Codex agents are missing from bundle: ${source}`);
  const target = join(codexHome, 'agents');
  mkdirSync(target, { recursive: true });
  recoverRoleAgentTransactions(target);
  const state = readCodexAgentInventory(codexHome);
  if (state.status === 'corrupt') {
    throw new Error(
      `Codex role-agent ownership inventory is corrupt (${inventoryPath(codexHome)}): ${state.error}; review and move it aside before retrying`,
    );
  }
  const acceptedInventoryIdentity = state.identity;
  const plan: CodexAgentInstallPlan = {
    recorded: state.inventory,
    inventory: emptyCodexAgentInventory(),
    result: {
      installed: 0,
      skippedUserOwned: [],
      keptModified: [],
      removed: [],
      backedUp: [],
    },
    writes: new Map<string, RoleAgentWrite>(),
    removals: [],
    expected: new Map<string, RoleFileIdentity>(),
  };
  const sourceNames = readdirSync(source)
    .filter((name) => CODEX_AGENT_NAME_RE.test(name))
    .sort();
  collectCurrentCodexAgentPayloads(source, target, sourceNames, plan);
  collectObsoleteCodexAgentPayloads(target, sourceNames, plan);
  if (
    plan.writes.size > 0 ||
    plan.removals.length > 0 ||
    JSON.stringify(state.inventory) !== JSON.stringify(plan.inventory)
  ) {
    publishRoleAgentTransaction(
      target,
      plan.writes,
      plan.removals,
      plan.inventory,
      plan.expected,
      acceptedInventoryIdentity,
      transactionOptions,
    );
  }
  return plan.result;
}

export interface CodexEnabledMutationResult {
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

export interface IntegrationResult {
  runtime: RuntimeName;
  ok: boolean;
  detail: string;
  preservedDisabled?: boolean;
  /** True only when the runtime's reviewed hook definition bytes changed. */
  hookReviewRequired?: boolean;
  timedOut?: boolean;
}

export interface InstallIntegrationsOptions {
  selection?: IntegrationSelection;
  bundleRoot?: string;
  runner?: CommandRunner;
  detected?: Partial<Record<RuntimeName, boolean>>;
  codexHome?: string;
  claudeHome?: string;
  timeoutMs?: number;
  /** Durable refresh intent root. Production defaults to GENIE_HOME. */
  stateDir?: string;
  /** Lifecycle lease identity. Always GENIE_HOME, never a source bundle root. */
  genieHome?: string;
  /** Deterministic test seam; production verifies the installed cache bytes. */
  verifyCodexPayload?: CodexPayloadVerifier;
  /** Deterministic test seam; production binds Claude marketplace source and cache bytes. */
  verifyClaudePayload?: ClaudePayloadVerifier;
  /** Active project used to reject repository/worktree/common-root PATH decoys. */
  cwd?: string;
  /** Deterministic test seam; production resolves and validates PATH once. */
  resolveExecutable?: RuntimeExecutableResolver;
}

export function installRuntimeIntegrations(options: InstallIntegrationsOptions = {}): IntegrationResult[] {
  const selection = options.selection ?? 'auto';
  if (selection === 'none') return [];
  const runner = options.runner ?? defaultRunner;
  const bundleRoot = resolveBundleRoot(options.bundleRoot);
  const genieHome = options.genieHome ?? resolveGenieHome();
  const lifecycleLease = acquireLifecycleLease(genieHome);
  if ('skipped' in lifecycleLease) {
    return [{ runtime: selection === 'claude' ? 'claude' : 'codex', ok: false, detail: lifecycleLease.skipped }];
  }
  try {
    const cwd = options.cwd ?? process.cwd();
    const targets: RuntimeName[] =
      selection === 'all'
        ? ['codex', 'claude']
        : selection === 'auto'
          ? (['codex', 'claude'] as RuntimeName[]).filter((runtime) => options.detected?.[runtime] !== false)
          : [selection];

    return targets.map((runtime) => {
      if (options.detected?.[runtime] === false) return { runtime, ok: false, detail: `${runtime} CLI not found` };
      try {
        const command = resolveRuntimeExecutable(runtime, cwd, options.resolveExecutable);
        if (command === null) return { runtime, ok: false, detail: `${runtime} CLI not found` };
        if (bundleRoot === null) {
          throw new Error(
            'genie bundle root not found — expected plugins/genie under $GENIE_HOME (~/.genie) or beside the genie binary; set GENIE_BUNDLE_ROOT to override',
          );
        }
        return runtime === 'codex'
          ? installCodexIntegration(
              runner,
              command,
              bundleRoot,
              options.codexHome,
              options.timeoutMs,
              options.stateDir ?? genieHome,
              options.verifyCodexPayload,
            )
          : installClaudeIntegration(
              runner,
              command,
              bundleRoot,
              options.timeoutMs,
              options.stateDir ?? genieHome,
              options.claudeHome,
              options.verifyClaudePayload,
            );
      } catch (error) {
        return {
          runtime,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          timedOut: error instanceof IntegrationCommandError && error.timedOut,
        };
      }
    });
  } finally {
    lifecycleLease.release();
  }
}

/**
 * Register the canonical marketplace root. Codex refuses an add when the same
 * marketplace name points at a different source; remove only that registration,
 * add the requested root again, and keep every subprocess deadline-bounded.
 */
function addCodexMarketplace(runner: CommandRunner, command: string, bundleRoot: string, timeoutMs: number): void {
  const args = ['plugin', 'marketplace', 'add', bundleRoot, '--json'];
  const result = runner(command, args, { timeoutMs });
  if (result.timedOut) {
    throw new IntegrationCommandError(`codex ${args.join(' ')} timed out after ${timeoutMs}ms`, true);
  }
  if (result.outputOverflow) {
    throw new IntegrationCommandError(`codex ${args.join(' ')} exceeded the output safety limit`);
  }
  if (result.exitCode === 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  if (/different source/i.test(output)) {
    runChecked(runner, command, ['plugin', 'marketplace', 'remove', 'automagik', '--json'], true, timeoutMs);
    runChecked(runner, command, args, false, timeoutMs);
    return;
  }
  if (!/already|exists|configured/i.test(output)) {
    throw new IntegrationCommandError(`codex ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

function requireCodexPluginState(raw: string, phase: string): RuntimePluginState {
  const parsed = parseCodexPluginState(raw);
  if (!parsed.ok) throw new IntegrationCommandError(`${parsed.detail} ${phase}`);
  return parsed.state;
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

export interface ConvergePluginOptions {
  runner: CommandRunner;
  /** Once-bound executable retained through every convergence subprocess. */
  command: string;
  bundleRoot: string;
  expectedVersion: string;
  /** Explicit install/setup may create an absent registration; update may not. */
  installIfAbsent: boolean;
  statePath: string;
  timeoutMs?: number;
  configPath?: string;
  codexHome?: string;
  claudeHome?: string;
  verifyCodexPayload?: CodexPayloadVerifier;
  verifyClaudePayload?: ClaudePayloadVerifier;
}

export interface CodexPayloadVerificationInput {
  bundleRoot: string;
  codexHome: string;
  expectedVersion: string;
}

export type CodexPayloadVerifier = (input: CodexPayloadVerificationInput) => void;

export interface ClaudePayloadVerificationInput {
  bundleRoot: string;
  claudeHome: string;
  expectedVersion: string;
}

export type ClaudePayloadVerifier = (input: ClaudePayloadVerificationInput) => void;

/**
 * Bind a reported Codex version to the physical plugin bytes installed from
 * the canonical bundle. Version equality alone cannot distinguish a cache
 * populated from an obsolete or hostile marketplace source.
 */
export function verifyCodexPhysicalPayload(input: CodexPayloadVerificationInput): void {
  const source = join(input.bundleRoot, 'plugins', 'genie');
  const installed = join(input.codexHome, 'plugins', 'cache', 'automagik', 'genie', input.expectedVersion);
  let sourceDigest: string;
  let installedDigest: string;
  try {
    sourceDigest = fingerprintPhysicalPluginTree(source);
  } catch (error) {
    throw new IntegrationCommandError(
      `canonical Codex plugin payload is unreadable at ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    installedDigest = fingerprintPhysicalPluginTree(installed);
  } catch (error) {
    throw new IntegrationCommandError(
      `installed Codex plugin payload is unreadable at ${installed}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (installedDigest !== sourceDigest) {
    throw new IntegrationCommandError(
      `installed Codex plugin payload identity mismatch at ${installed} (expected canonical source ${source})`,
    );
  }
}

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
  mkdirSync(dirname(path), { recursive: true });
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
  runtime: RuntimeName,
  intent: RefreshIntent | null,
  timeoutMs: number,
): RefreshIntent | null {
  if (intent === null || intent.phase === 'planned') return intent;
  try {
    const raw = runChecked(options.runner, options.command, ['plugin', 'list', '--json'], false, timeoutMs).stdout;
    const state =
      runtime === 'codex'
        ? requireCodexPluginState(raw, 'after failed refresh command')
        : requireClaudePluginState(raw, 'after failed refresh command');
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

function verifyInstalledExpectedVersionCodexPayload(options: ConvergePluginOptions): void {
  const verifyPayload = options.verifyCodexPayload ?? verifyCodexPhysicalPayload;
  try {
    verifyPayload({
      bundleRoot: options.bundleRoot,
      codexHome: options.codexHome ?? getCodexHome(),
      expectedVersion: options.expectedVersion,
    });
  } catch (error) {
    throw new IntegrationCommandError(
      `Codex plugin versioning violation [same-version-payload-mismatch]: installed v${options.expectedVersion} cache bytes differ from the canonical payload. Refusing to mutate or reinstall an active plugin version in place. Publish the changed payload under a new plugin version. Close all Codex tasks first. Then, from an external terminal, run \`genie setup --codex\`, review \`/hooks\`, and start a new Codex task. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function expectedCodexGenerationPath(options: ConvergePluginOptions): string {
  return join(options.codexHome ?? getCodexHome(), 'plugins', 'cache', 'automagik', 'genie', options.expectedVersion);
}

function expectedCodexGenerationExists(options: ConvergePluginOptions): boolean {
  try {
    lstatSync(expectedCodexGenerationPath(options));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new IntegrationCommandError(
      `Codex expected plugin generation cannot be inspected at ${expectedCodexGenerationPath(options)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function physicalHookDefinitionIdentity(path: string): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return 'unsafe';
    return `sha256:${hashPhysicalFileIncrementally(path)}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

function codexHookReviewRequired(options: ConvergePluginOptions, before: RuntimePluginState): boolean {
  const canonical = physicalHookDefinitionIdentity(
    join(options.bundleRoot, 'plugins', 'genie', 'hooks', 'codex-hooks.json'),
  );
  if (canonical === 'absent') return false;
  if (!before.installed || !before.version) return true;
  const installed = physicalHookDefinitionIdentity(
    join(
      options.codexHome ?? getCodexHome(),
      'plugins',
      'cache',
      'automagik',
      'genie',
      before.version,
      'hooks',
      'codex-hooks.json',
    ),
  );
  return installed !== canonical;
}

interface PluginConvergenceProgress {
  intent: RefreshIntent | null;
  desiredEnabled: boolean | null;
  hookReviewRequired: boolean;
}

function performCodexPluginConvergence(
  options: ConvergePluginOptions,
  timeoutMs: number,
  progress: PluginConvergenceProgress,
): boolean {
  progress.intent = readRefreshIntent(options.statePath, 'codex');
  progress.desiredEnabled = progress.intent?.enabled ?? null;
  const before = requireCodexPluginState(
    runChecked(options.runner, options.command, ['plugin', 'list', '--json'], false, timeoutMs).stdout,
    'before plugin convergence',
  );
  if (!before.installed && !options.installIfAbsent && progress.intent?.phase !== 'removal-observed') {
    if (progress.intent !== null) clearRefreshIntent(options.statePath);
    return false;
  }

  progress.hookReviewRequired = codexHookReviewRequired(options, before);

  // A Codex task retains its reviewed hook command while it is running. The
  // command resolves the launcher from this versioned cache path on every
  // invocation, so replacing that path in place can pair an old definition
  // with new launcher bytes. Verify before any marketplace/plugin mutation and
  // require changed bytes to use a new versioned cache generation.
  const installedExpectedVersion = before.installed && before.version === options.expectedVersion;
  const expectedGenerationExists = expectedCodexGenerationExists(options);
  if (installedExpectedVersion || expectedGenerationExists) verifyInstalledExpectedVersionCodexPayload(options);

  progress.intent ??= plannedRefreshIntent('codex', before.installed ? before.enabled === true : true);
  progress.desiredEnabled = progress.intent.enabled;
  writeRefreshIntent(options.statePath, progress.intent);

  addCodexMarketplace(options.runner, options.command, options.bundleRoot, timeoutMs);
  if (installedExpectedVersion) {
    progress.intent = markRefreshStable(options.statePath, progress.intent);
    if (progress.intent.enabled) {
      requireExpectedState('codex', before, options.expectedVersion, true, 'enabled-state');
    }
    return true;
  }
  // `plugin add` may advance the registration/cache internally. Record that
  // command boundary for crash recovery; Genie never follows it with an
  // automatic remove/reinstall of a generation that live tasks may reference.
  if (before.installed && progress.intent.phase === 'planned') {
    progress.intent = markRefreshCommandStarted(options.statePath, progress.intent);
  }
  runChecked(options.runner, options.command, ['plugin', 'add', 'genie@automagik', '--json'], false, timeoutMs);
  const installed = requireCodexPluginState(
    runChecked(options.runner, options.command, ['plugin', 'list', '--json'], false, timeoutMs).stdout,
    'after plugin add',
  );
  if (!installed.installed) throw new IntegrationCommandError('Codex plugin is missing after plugin add');
  progress.intent = markRefreshStable(options.statePath, progress.intent);
  if (installed.version !== options.expectedVersion) {
    // A running Codex task retains its reviewed hook definition. Removing and
    // re-adding the old registration here can invalidate that live definition
    // even when the first, non-destructive add simply failed to advance the
    // selected generation. Presence was re-observed, so consume all repair
    // authority and leave the registration/cache exactly where Codex left it.
    clearRefreshIntent(options.statePath);
    progress.intent = null;
    throw new IntegrationCommandError(
      `Codex plugin remained at v${installed.version || 'missing'} after one non-destructive add attempt (expected v${options.expectedVersion}). Refusing automatic plugin removal/reinstall; the existing registration and cache are preserved. Close all Codex tasks first. Then, from an external terminal, run \`genie update\` (or \`genie setup --codex\`), review \`/hooks\`, and start a new Codex task.`,
    );
  }
  verifyInstalledExpectedVersionCodexPayload(options);
  progress.intent = markRefreshStable(options.statePath, progress.intent);
  if (progress.intent.enabled) {
    requireExpectedState('codex', installed, options.expectedVersion, true, 'enabled-state');
  }
  return true;
}

function restoreCodexDisabledState(options: ConvergePluginOptions, timeoutMs: number): void {
  const restored = setCodexPluginEnabled(false, options.configPath ?? getCodexConfigPath());
  if (!restored.ok) throw new IntegrationCommandError(restored.detail);
  const state = requireCodexPluginState(
    runChecked(options.runner, options.command, ['plugin', 'list', '--json'], false, timeoutMs).stdout,
    'after restoring disabled state',
  );
  requireExpectedState('codex', state, options.expectedVersion, false, 'disabled-state restore');
}

/**
 * One Codex plugin convergence state machine for install/setup/update. The
 * durable intent preserves both installation consent and disabled consent
 * across a process crash or a failed remove/re-add.
 */
export function convergeCodexPlugin(options: ConvergePluginOptions): IntegrationResult | null {
  const timeoutMs = options.timeoutMs ?? INTEGRATION_TIMEOUT_MS;
  const progress: PluginConvergenceProgress = { intent: null, desiredEnabled: null, hookReviewRequired: false };
  let primaryError: unknown;
  try {
    if (!performCodexPluginConvergence(options, timeoutMs, progress)) return null;
  } catch (error) {
    primaryError = error;
    progress.intent = settleFailedRefreshIntent(options, 'codex', progress.intent, timeoutMs);
    if (progress.intent?.phase === 'ambiguous-absent') {
      primaryError = new IntegrationCommandError(
        `${error instanceof Error ? error.message : String(error)}; Codex state is absent or unknown after a failed command and will not be reinstalled by update. Close all Codex tasks first. Then, from an external terminal, run \`genie setup --codex\` to grant explicit repair consent, review \`/hooks\`, and start a new Codex task.`,
      );
    }
  }

  if (progress.desiredEnabled === false) {
    try {
      restoreCodexDisabledState(options, timeoutMs);
      progress.intent = markRefreshStableIfPresent(options.statePath, progress.intent);
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) return integrationFailure('codex', primaryError);
  clearRefreshIntent(options.statePath);
  return {
    runtime: 'codex',
    ok: true,
    detail: `plugin/hooks refreshed to v${options.expectedVersion}`,
    preservedDisabled: progress.desiredEnabled === false,
    hookReviewRequired: progress.hookReviewRequired,
  };
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
    intent = settleFailedRefreshIntent(options, 'claude', intent, timeoutMs);
    if (intent?.phase === 'ambiguous-absent') {
      primaryError = new IntegrationCommandError(
        `${error instanceof Error ? error.message : String(error)}; Claude state is absent or unknown after a failed command and will not be reinstalled by update — run genie install or setup to grant explicit repair consent`,
      );
    }
  }

  if (desiredEnabled === false) {
    try {
      runChecked(options.runner, options.command, ['plugin', 'disable', 'genie@automagik'], false, timeoutMs);
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

function installCodexIntegration(
  runner: CommandRunner,
  command: string,
  bundleRoot: string,
  codexHome?: string,
  timeoutMs = INTEGRATION_TIMEOUT_MS,
  stateDir = resolveGenieHome(),
  verifyCodexPayload?: CodexPayloadVerifier,
): IntegrationResult {
  const configPath = join(codexHome ?? getCodexHome(), 'config.toml');
  const migration = migrateDeadGenieOtel(configPath);
  if (migration.status === 'error') throw new Error(`Codex config migration failed: ${migration.error}`);
  const agents = installCodexAgents(bundleRoot, codexHome);
  const plugin = convergeCodexPlugin({
    runner,
    command,
    bundleRoot,
    expectedVersion: VERSION,
    installIfAbsent: true,
    configPath,
    statePath: join(stateDir, '.integration-refresh-codex.json'),
    timeoutMs,
    codexHome,
    verifyCodexPayload,
  });
  if (plugin === null) throw new Error('Codex plugin convergence returned no result for explicit install');
  if (!plugin.ok) throw new IntegrationCommandError(plugin.detail, plugin.timedOut);
  const notes = [`${agents.installed} role agents installed`];
  if (agents.removed.length > 0) notes.push(`removed obsolete: ${agents.removed.join(', ')}`);
  if (agents.keptModified.length > 0) notes.push(`kept modified: ${agents.keptModified.join(', ')}`);
  if (agents.skippedUserOwned.length > 0) notes.push(`kept user-owned: ${agents.skippedUserOwned.join(', ')}`);
  return {
    runtime: 'codex',
    ok: true,
    detail: `plugin refreshed; ${notes.join('; ')}`,
    preservedDisabled: plugin.preservedDisabled,
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

export interface CodexAgentRemovalResult {
  removed: string[];
  keptModified: string[];
  missing: string[];
  failures: Array<{ name: string; detail: string }>;
}

/** Remove only exact physical inventory-owned role agents; modified/user files stay byte-identical. */
export function removeCodexAgents(
  codexHome = getCodexHome(),
  transactionOptions: CodexAgentTransactionOptions = {},
): CodexAgentRemovalResult {
  const result: CodexAgentRemovalResult = { removed: [], keptModified: [], missing: [], failures: [] };
  const agentsDir = join(codexHome, 'agents');
  try {
    recoverCodexAgentTransactions(codexHome);
  } catch (error) {
    result.failures.push({
      name: CODEX_AGENT_INVENTORY_NAME,
      detail: `pending role-agent transaction could not be recovered; no role agents were removed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return result;
  }
  const state = readCodexAgentInventory(codexHome);
  if (state.status === 'corrupt') {
    result.failures.push({
      name: CODEX_AGENT_INVENTORY_NAME,
      detail: `ownership inventory is corrupt; no role agents were removed: ${state.error}; review and move it aside before retrying`,
    });
    return result;
  }
  const inventory = emptyCodexAgentInventory();
  const removals: string[] = [];
  const expected = new Map<string, RoleFileIdentity>();
  const removed: string[] = [];
  const keptModified: string[] = [];
  const missing: string[] = [];
  for (const name of Object.keys(state.inventory.files).sort()) {
    const path = join(codexHome, 'agents', name);
    const recorded = state.inventory.files[name];
    const ownership = classifyCodexAgentFile(path, recorded);
    if (ownership === 'managed-clean') {
      removals.push(name);
      if (recorded !== undefined && 'identity' in recorded) expected.set(name, recorded.identity);
      removed.push(name);
    } else if (ownership === 'managed-modified') {
      keptModified.push(name);
    } else if (ownership === 'absent') {
      missing.push(name);
    }
  }
  try {
    publishRoleAgentTransaction(
      agentsDir,
      new Map(),
      removals,
      inventory,
      expected,
      state.identity,
      transactionOptions,
    );
    result.removed.push(...removed);
    result.keptModified.push(...keptModified);
    result.missing.push(...missing);
  } catch (error) {
    result.failures.push({
      name: removals[0] ?? CODEX_AGENT_INVENTORY_NAME,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
}

export interface IntegrationRemovalStep {
  runtime: RuntimeName;
  operation: 'plugin' | 'marketplace';
  ok: boolean;
  detail: string;
  timedOut?: boolean;
}

export interface RuntimeIntegrationRemovalResult {
  ok: boolean;
  agents: CodexAgentRemovalResult;
  steps: IntegrationRemovalStep[];
}

export interface RemoveRuntimeIntegrationsOptions {
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

export interface RuntimeIntegrationEvidence {
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
  const agents = removeCodexAgents(options.codexHome);
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
  return { ok: agents.failures.length === 0 && steps.every((step) => step.ok), agents, steps };
}
