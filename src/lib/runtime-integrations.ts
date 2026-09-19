import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { getCodexHome } from './codex-config.js';
import { resolveClaudeDir, resolveGenieHome } from './genie-home.js';
import { validateTrustedExecutablePath } from './trusted-executable.js';

/**
 * Operator consent scope. No client plugin integration survives — the skills
 * channel is the whole post-delivery convergence — so a selection now only
 * names the scope consent was granted for, never a runtime this binary installs.
 */
export type IntegrationSelection = 'auto' | 'codex' | 'claude' | 'all' | 'none';
/** The two client runtimes whose Genie-owned registrations uninstall still removes. */
type RuntimeName = 'codex' | 'claude';
type RuntimeExecutableResolver = (name: RuntimeName, cwd: string) => string | null;

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

// The Codex role-agent inventory and its digest-backed ownership inspector
// lived here for one consumer: the plugin-era `legacy-integration-retirement.ts`,
// which classified a historical `~/.codex/agents/genie-*.toml` before removing
// it. That module's compat window closed and it was deleted in v6, so the
// inventory constants, the frozen historical profiles, and the whole
// `inspectCodexAgentOwnership` cluster went with it. Nothing on any live path
// reads `~/.codex/agents/` any more.

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

// The Codex plugin-registration mutators (`setCodexPluginEnabled`,
// `removeCodexPluginRegistration`) and their TOML table scanner stood here for
// the plugin era: they flipped and removed the `[plugins."genie@automagik"]`
// block in `~/.codex/config.toml`. No genie plugin ships for any client runtime
// any more, the retirement module that was their last production caller was
// deleted in v6, and the only remaining consumer was their own test file — a
// product surface kept alive by nothing but its tests. The Codex config genie
// still touches is the dead-OTel-exporter migration in `codex-config.ts`,
// which is a different block and a live path.

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
