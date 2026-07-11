import { join } from 'node:path';
import {
  type ClaudePayloadVerifier,
  type CodexPayloadVerifier,
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner,
  type IntegrationResult,
  type IntegrationSelection,
  type RuntimeExecutableResolver,
  type RuntimeName,
  convergeClaudePlugin,
  convergeCodexPlugin,
  resolveRuntimeExecutable,
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
  const runner = options.runner ?? defaultRunner;
  const timeoutMs = options.timeoutMs ?? UPDATE_INTEGRATION_TIMEOUT_MS;
  const stateDir = options.stateDir ?? options.bundleRoot;
  const selection = options.selection ?? 'auto';
  if (selection === 'none') return [];
  const cwd = options.cwd ?? process.cwd();
  const results: IntegrationResult[] = [];
  const targets: RuntimeName[] =
    selection === 'all'
      ? ['codex', 'claude']
      : selection === 'auto'
        ? (['codex', 'claude'] as RuntimeName[]).filter((runtime) => options.detected?.[runtime] !== false)
        : [selection];
  if (targets.includes('codex') && options.detected?.codex !== false) {
    let command: string | null;
    try {
      command = resolveRuntimeExecutable('codex', cwd, options.resolveExecutable);
    } catch (error) {
      return [{ runtime: 'codex', ok: false, detail: error instanceof Error ? error.message : String(error) }];
    }
    if (command !== null) {
      const result = convergeCodexPlugin({
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
      if (result !== null) results.push(result);
    }
  }
  if (targets.includes('claude') && options.detected?.claude !== false) {
    let command: string | null;
    try {
      command = resolveRuntimeExecutable('claude', cwd, options.resolveExecutable);
    } catch (error) {
      results.push({ runtime: 'claude', ok: false, detail: error instanceof Error ? error.message : String(error) });
      return results;
    }
    if (command !== null) {
      const result = convergeClaudePlugin({
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
      if (result !== null) results.push(result);
    }
  }
  return results;
}

const defaultRunner: CommandRunner = (command: string, args: string[], options?: CommandRunOptions): CommandResult => {
  const timeoutMs = options?.timeoutMs ?? UPDATE_INTEGRATION_TIMEOUT_MS;
  const result = Bun.spawnSync([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    timedOut: result.exitedDueToTimeout === true,
  };
};
