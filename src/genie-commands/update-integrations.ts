import { getCodexConfigPath } from '../lib/codex-config.js';
import {
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner,
  type IntegrationResult,
  type RuntimeName,
  claudePluginState,
  codexPluginState,
  setCodexPluginEnabled,
} from '../lib/runtime-integrations.js';

const UPDATE_INTEGRATION_TIMEOUT_MS = 15_000;

export interface RefreshUpdatePluginsOptions {
  bundleRoot: string;
  expectedVersion: string;
  runner?: CommandRunner;
  detected?: Partial<Record<RuntimeName, boolean>>;
  codexConfigPath?: string;
  timeoutMs?: number;
}

/**
 * Refresh plugin registrations after an operator-driven full update. Personal
 * skills and role agents are deliberately absent from this helper; the parent
 * update process converges them through Group C's ownership-safe APIs. This
 * helper only asks installed runtimes to recache the verified local bundle.
 */
export function refreshUpdatePlugins(options: RefreshUpdatePluginsOptions): IntegrationResult[] {
  const runner = options.runner ?? defaultRunner;
  const timeoutMs = options.timeoutMs ?? UPDATE_INTEGRATION_TIMEOUT_MS;
  const detected = {
    codex: options.detected?.codex ?? Boolean(Bun.which('codex')),
    claude: options.detected?.claude ?? Boolean(Bun.which('claude')),
  };
  const results: IntegrationResult[] = [];
  if (detected.codex) results.push(refreshCodexPlugin(runner, options, timeoutMs));
  if (detected.claude) results.push(refreshClaudePlugin(runner, options, timeoutMs));
  return results;
}

function refreshCodexPlugin(
  runner: CommandRunner,
  options: RefreshUpdatePluginsOptions,
  timeoutMs: number,
): IntegrationResult {
  try {
    const before = codexPluginState(runChecked(runner, 'codex', ['plugin', 'list', '--json'], timeoutMs).stdout);
    addCodexMarketplace(runner, options.bundleRoot, timeoutMs);
    if (before.installed) {
      runChecked(runner, 'codex', ['plugin', 'remove', 'genie@automagik', '--json'], timeoutMs, true);
    }
    runChecked(runner, 'codex', ['plugin', 'add', 'genie@automagik', '--json'], timeoutMs);
    const after = codexPluginState(runChecked(runner, 'codex', ['plugin', 'list', '--json'], timeoutMs).stdout);
    if (!after.installed || after.version !== options.expectedVersion) {
      throw new Error(
        `Codex plugin refresh reported v${after.version || 'missing'}; expected v${options.expectedVersion}`,
      );
    }
    if (before.installed && before.enabled === false) {
      setCodexPluginEnabled(false, options.codexConfigPath ?? getCodexConfigPath());
    }
    return {
      runtime: 'codex',
      ok: true,
      detail: `plugin/hooks refreshed to v${options.expectedVersion}`,
      preservedDisabled: before.installed && before.enabled === false,
    };
  } catch (error) {
    return integrationFailure('codex', error);
  }
}

function addCodexMarketplace(runner: CommandRunner, bundleRoot: string, timeoutMs: number): void {
  const args = ['plugin', 'marketplace', 'add', bundleRoot, '--json'];
  const result = runner('codex', args, { timeoutMs });
  if (result.timedOut) throw new UpdateIntegrationError(`codex ${args.join(' ')} timed out`, true);
  if (result.exitCode === 0 || /already|exists|configured/i.test(`${result.stdout}\n${result.stderr}`)) return;
  if (/different source/i.test(`${result.stdout}\n${result.stderr}`)) {
    runChecked(runner, 'codex', ['plugin', 'marketplace', 'remove', 'automagik', '--json'], timeoutMs, true);
    runChecked(runner, 'codex', args, timeoutMs);
    return;
  }
  throw commandError('codex', args, result);
}

function refreshClaudePlugin(
  runner: CommandRunner,
  options: RefreshUpdatePluginsOptions,
  timeoutMs: number,
): IntegrationResult {
  try {
    const before = claudePluginState(runChecked(runner, 'claude', ['plugin', 'list', '--json'], timeoutMs).stdout);
    runChecked(runner, 'claude', ['plugin', 'marketplace', 'add', options.bundleRoot], timeoutMs, true);
    runChecked(
      runner,
      'claude',
      before.installed ? ['plugin', 'update', 'genie@automagik'] : ['plugin', 'install', 'genie@automagik'],
      timeoutMs,
    );
    const after = claudePluginState(runChecked(runner, 'claude', ['plugin', 'list', '--json'], timeoutMs).stdout);
    if (!after.installed || (after.version && after.version !== options.expectedVersion)) {
      throw new Error(
        `Claude plugin refresh reported v${after.version || 'missing'}; expected v${options.expectedVersion}`,
      );
    }
    return {
      runtime: 'claude',
      ok: true,
      detail: `plugin/hooks refreshed${after.version ? ` to v${after.version}` : ''}`,
      preservedDisabled: before.installed && before.enabled === false,
    };
  } catch (error) {
    return integrationFailure('claude', error);
  }
}

function runChecked(
  runner: CommandRunner,
  command: string,
  args: string[],
  timeoutMs: number,
  allowAbsent = false,
): CommandResult {
  const result = runner(command, args, { timeoutMs });
  if (result.timedOut) throw new UpdateIntegrationError(`${command} ${args.join(' ')} timed out`, true);
  if (result.exitCode !== 0 && !(allowAbsent && /not found|not installed|already absent/i.test(result.stderr))) {
    throw commandError(command, args, result);
  }
  return result;
}

function commandError(command: string, args: string[], result: CommandResult): Error {
  return new UpdateIntegrationError(
    `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || `exit ${result.exitCode}`).trim()}`,
  );
}

class UpdateIntegrationError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

function integrationFailure(runtime: RuntimeName, error: unknown): IntegrationResult {
  return {
    runtime,
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
    timedOut: error instanceof UpdateIntegrationError && error.timedOut,
  };
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
