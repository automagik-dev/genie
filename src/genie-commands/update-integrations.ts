import { join } from 'node:path';
import {
  type ClaudePayloadVerifier,
  type CodexPayloadVerifier,
  type CodexPluginOnlyDeps,
  type CommandRunner,
  type IntegrationResult,
  type IntegrationSelection,
  type RuntimeExecutableResolver,
  type RuntimeName,
  convergeClaudePlugin,
  convergeCodexPluginOnly,
  installCodexAgents,
  parseCodexPluginState,
  resolveRuntimeExecutable,
  runBoundedIntegrationCommand,
} from '../lib/runtime-integrations.js';

const UPDATE_INTEGRATION_TIMEOUT_MS = 15_000;
const CODEX_PLUGIN_LIST_MAX_BYTES = 64 * 1024;
const RETIRE_RECOVERY = 'retire tasks → genie setup --codex → /hooks → new task';

export interface RefreshUpdatePluginsOptions {
  bundleRoot: string;
  expectedVersion: string;
  runner?: CommandRunner;
  /** CLI availability only. Installed state or a durable repair intent is the consent boundary. */
  detected?: Partial<Record<RuntimeName, boolean>>;
  codexConfigPath?: string;
  codexHome?: string;
  claudeHome?: string;
  verifyCodexPayload?: CodexPayloadVerifier;
  verifyClaudePayload?: ClaudePayloadVerifier;
  /** Persisted operator consent. `none` performs no client mutation. */
  selection?: IntegrationSelection;
  cwd?: string;
  resolveExecutable?: RuntimeExecutableResolver;
  /** Defaults to the verified installed bundle root (GENIE_HOME in production). */
  stateDir?: string;
  timeoutMs?: number;
  /** Deterministic test seams for the codex plugin-only convergence orchestrator. */
  codexPluginOnly?: CodexPluginOnlyDeps;
}

/**
 * Refresh plugin registrations after an operator-driven full update. This is a
 * thin policy-free adapter over the same durable convergence state machines
 * install/setup use. An absent plugin remains absent unless a pending repair
 * proves a prior installation was removed by an interrupted refresh.
 */
export function refreshUpdatePlugins(options: RefreshUpdatePluginsOptions): IntegrationResult[] {
  const runner = options.runner ?? runBoundedIntegrationCommand;
  const timeoutMs = options.timeoutMs ?? UPDATE_INTEGRATION_TIMEOUT_MS;
  const stateDir = options.stateDir ?? options.bundleRoot;
  const selection = options.selection ?? 'auto';
  if (selection === 'none') return [];
  const cwd = options.cwd ?? process.cwd();
  const results: IntegrationResult[] = [];
  for (const runtime of selectedRefreshTargets(selection, options.detected)) {
    const result = refreshOneRuntime(runtime, options, runner, timeoutMs, stateDir, cwd);
    if (result !== null) results.push(result);
  }
  return results;
}

function selectedRefreshTargets(
  selection: Exclude<IntegrationSelection, 'none'>,
  detected: RefreshUpdatePluginsOptions['detected'],
): RuntimeName[] {
  if (selection === 'all') return ['codex', 'claude'];
  if (selection === 'auto')
    return (['codex', 'claude'] as RuntimeName[]).filter((runtime) => detected?.[runtime] !== false);
  return [selection];
}

function refreshOneRuntime(
  runtime: RuntimeName,
  options: RefreshUpdatePluginsOptions,
  runner: CommandRunner,
  timeoutMs: number,
  stateDir: string,
  cwd: string,
): IntegrationResult | null {
  if (options.detected?.[runtime] === false) return null;
  let command: string | null;
  try {
    command = resolveRuntimeExecutable(runtime, cwd, options.resolveExecutable);
  } catch (error) {
    return { runtime, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (command === null) return null;
  try {
    if (runtime === 'codex') {
      return convergeCodexForUpdateDelivery(options, runner, command, timeoutMs, stateDir);
    }
    return convergeClaudePlugin({
      runner,
      command,
      bundleRoot: options.bundleRoot,
      expectedVersion: options.expectedVersion,
      installIfAbsent: false,
      statePath: join(stateDir, '.integration-refresh-claude.json'),
      timeoutMs,
      claudeHome: options.claudeHome,
      verifyClaudePayload: options.verifyClaudePayload,
    });
  } catch (error) {
    return { runtime, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Group C delivery gate for Codex (item 1 / deliverables 1,3). Delivery must
 * NEVER advance the Codex plugin cache. Before touching the plugin, read the
 * installed generation and compare it to the delivered target:
 *
 * - installed N ≠ delivered T → this is exactly the cache-advancing `plugin add`
 *   `convergeCodexPlugin` would run internally. Refuse it here: converge only the
 *   non-plugin role agents and return an action-required exit-2 signal
 *   (`deliveryComplete:true`), deferring the generation swap to the permit-gated
 *   `genie setup --codex`. A running task pinned to N keeps its cache.
 * - installed T (or absent) → `convergeCodexPluginOnly` provably does NOT
 *   `plugin add` (its own `installedExpectedVersion` short-circuit), so the
 *   existing safe convergence runs unchanged: marketplace idempotency, one health
 *   proof, fallback retirement, and role-agent refresh. An absent plugin stays
 *   absent (null); update never installs it.
 *
 * The installed-vs-expected comparison mirrors `convergeCodexPlugin`'s own
 * `before.version === expectedVersion` check exactly, so this gate reproduces its
 * "would it cache-advance?" decision without duplicating any mutation logic.
 */
function convergeCodexForUpdateDelivery(
  options: RefreshUpdatePluginsOptions,
  runner: CommandRunner,
  command: string,
  timeoutMs: number,
  stateDir: string,
): IntegrationResult | null {
  const installed = readInstalledCodexPluginVersion(runner, command, timeoutMs);
  if (installed.status === 'indeterminate') {
    // Fail closed (exit 1, broken/retry): never cache-advance on an unreadable/
    // timed-out/overflowed query. This is NOT action-required delivery — the
    // plugin state could not be classified at all.
    return {
      runtime: 'codex',
      ok: false,
      detail: `codex delivery cannot classify plugin state (${installed.detail}); refusing to advance the cache`,
      timedOut: installed.timedOut,
    };
  }
  if (installed.version === null) {
    // Absent plugin: update never installs it and never cache-advances. Leave it
    // exactly as found (null), matching convergeCodexPluginOnly's own absent path
    // without a redundant plugin command.
    return null;
  }
  if (installed.version !== options.expectedVersion) {
    // N ≠ T: defer the cache-advancing activation. Converge role agents only.
    return deferCodexActivation(options, installed.version);
  }
  // installed === expected: the safe, non-cache-advancing path.
  const outcome = convergeCodexPluginOnly({
    runner,
    command,
    bundleRoot: options.bundleRoot,
    expectedVersion: options.expectedVersion,
    installIfAbsent: false,
    configPath: options.codexConfigPath,
    statePath: join(stateDir, '.integration-refresh-codex.json'),
    timeoutMs,
    codexHome: options.codexHome,
    verifyCodexPayload: options.verifyCodexPayload,
    deps: options.codexPluginOnly,
  });
  return outcome === null ? null : outcome.result;
}

type InstalledCodexVersion =
  | { status: 'ok'; version: string | null }
  | { status: 'indeterminate'; detail: string; timedOut: boolean };

/** Bounded, read-only `codex plugin list --json` classification of the installed generation. */
function readInstalledCodexPluginVersion(
  runner: CommandRunner,
  command: string,
  timeoutMs: number,
): InstalledCodexVersion {
  const result = runner(command, ['plugin', 'list', '--json'], {
    timeoutMs,
    maxOutputBytes: CODEX_PLUGIN_LIST_MAX_BYTES,
  });
  if (result.timedOut) return { status: 'indeterminate', detail: 'codex plugin list timed out', timedOut: true };
  if (result.outputOverflow)
    return { status: 'indeterminate', detail: 'codex plugin list exceeded the output cap', timedOut: false };
  if (result.exitCode !== 0)
    return { status: 'indeterminate', detail: `codex plugin list exited ${result.exitCode}`, timedOut: false };
  const parsed = parseCodexPluginState(result.stdout);
  if (!parsed.ok) return { status: 'indeterminate', detail: parsed.detail, timedOut: false };
  return { status: 'ok', version: parsed.state.installed ? (parsed.state.version ?? null) : null };
}

/**
 * The N ≠ T deferral: preserve non-plugin agent convergence (role-agent TOMLs)
 * and return an action-required exit-2 signal. A genuine role-agent failure is
 * reported but never turns the delivery into a plugin cache advance.
 */
function deferCodexActivation(options: RefreshUpdatePluginsOptions, installedVersion: string): IntegrationResult {
  let agentDetail = '';
  try {
    const agents = installCodexAgents(options.bundleRoot, options.codexHome);
    agentDetail = agents.installed > 0 ? `; role agents refreshed (${agents.installed})` : '';
  } catch (error) {
    agentDetail = `; role-agent refresh failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return {
    runtime: 'codex',
    ok: true,
    detail:
      `delivered v${options.expectedVersion}; Codex plugin left at v${installedVersion} (no cache advance). ` +
      `${RETIRE_RECOVERY}${agentDetail}`,
    deliveryComplete: true,
    actionRequired: true,
  };
}
