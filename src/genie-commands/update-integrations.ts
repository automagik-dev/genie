import { join } from 'node:path';
import {
  type ClaudePayloadVerifier,
  type CodexPayloadVerifier,
  type CommandRunner,
  type IntegrationResult,
  type IntegrationSelection,
  type RuntimeExecutableResolver,
  type RuntimeName,
  convergeClaudePlugin,
  convergeCodexPlugin,
  resolveRuntimeExecutable,
  runBoundedIntegrationCommand,
} from '../lib/runtime-integrations.js';

const UPDATE_INTEGRATION_TIMEOUT_MS = 15_000;

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
  if (runtime === 'codex') {
    return convergeCodexPlugin({
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
    });
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
}
