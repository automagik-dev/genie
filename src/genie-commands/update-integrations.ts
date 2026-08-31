import { join } from 'node:path';
import {
  type ClaudePayloadVerifier,
  type CommandRunner,
  type IntegrationResult,
  type IntegrationSelection,
  type RuntimeExecutableResolver,
  type RuntimeName,
  convergeClaudePlugin,
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
  claudeHome?: string;
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
 * thin policy-free adapter over the same durable convergence state machine
 * install uses. An absent plugin remains absent.
 *
 * The Codex arm left with the Codex plugin subsystem: update never had
 * authority to advance the Codex plugin cache, and there is no longer a
 * `setup --codex` to defer it to.
 */
export function refreshUpdatePlugins(options: RefreshUpdatePluginsOptions): IntegrationResult[] {
  const runner = options.runner ?? runBoundedIntegrationCommand;
  const timeoutMs = options.timeoutMs ?? UPDATE_INTEGRATION_TIMEOUT_MS;
  const stateDir = options.stateDir ?? options.bundleRoot;
  const selection = options.selection ?? 'auto';
  if (selection === 'none' || selection === 'codex') return [];
  if (options.detected?.claude === false) return [];
  const cwd = options.cwd ?? process.cwd();
  const result = refreshClaudeRuntime(options, runner, timeoutMs, stateDir, cwd);
  return result === null ? [] : [result];
}

function refreshClaudeRuntime(
  options: RefreshUpdatePluginsOptions,
  runner: CommandRunner,
  timeoutMs: number,
  stateDir: string,
  cwd: string,
): IntegrationResult | null {
  let command: string | null;
  try {
    command = resolveRuntimeExecutable('claude', cwd, options.resolveExecutable);
  } catch (error) {
    return { runtime: 'claude', ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (command === null) return null;
  try {
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
    return { runtime: 'claude', ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
