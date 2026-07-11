import { join } from 'node:path';
import {
  type CodexPayloadVerifier,
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner,
  type IntegrationResult,
  type RuntimeName,
  convergeClaudePlugin,
  convergeCodexPlugin,
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
  verifyCodexPayload?: CodexPayloadVerifier;
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
  const detected = {
    codex: options.detected?.codex ?? Boolean(Bun.which('codex')),
    claude: options.detected?.claude ?? Boolean(Bun.which('claude')),
  };
  const results: IntegrationResult[] = [];
  if (detected.codex) {
    const result = convergeCodexPlugin({
      runner,
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
  if (detected.claude) {
    const result = convergeClaudePlugin({
      runner,
      bundleRoot: options.bundleRoot,
      expectedVersion: options.expectedVersion,
      installIfAbsent: false,
      statePath: join(stateDir, '.integration-refresh-claude.json'),
      timeoutMs,
    });
    if (result !== null) results.push(result);
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
