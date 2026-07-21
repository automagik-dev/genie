import { join } from 'node:path';
import {
  buildActivationResultTrailer,
  classifyCodexActivation,
  describeState,
  observeCodexActivation,
  projectHumanStatus,
} from '../lib/codex-activation-executor.js';

/** The A-owned exit-2 result trailer shape, taken from its canonical builder. */
type ActivationResultTrailer = ReturnType<typeof buildActivationResultTrailer>;
import {
  type ClaudePayloadVerifier,
  type CodexPayloadVerifier,
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
 * Refresh non-Codex plugin registrations after an operator-driven full update.
 *
 * The Codex plugin generation is DELIBERATELY NOT converged here: `genie update`
 * (and its fresh-binary child) are delivery/discovery-only for Codex — advancing
 * and pruning a versioned Codex plugin cache while a live task holds paths into
 * the old generation is exactly the failure this wish mitigates. Codex plugin
 * state is instead observed/classified/reported through {@link reportCodexPluginDelivery}
 * (Group B's stable facade) with zero cache-advancing command. Claude convergence
 * is unrelated non-Codex agent convergence and is preserved unchanged.
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

/** Only non-Codex runtimes are convergence targets; Codex is observe/report-only. */
function selectedRefreshTargets(
  selection: Exclude<IntegrationSelection, 'none'>,
  detected: RefreshUpdatePluginsOptions['detected'],
): RuntimeName[] {
  if (selection === 'codex') return [];
  if (selection === 'all') return ['claude'];
  if (selection === 'auto') return (['claude'] as RuntimeName[]).filter((runtime) => detected?.[runtime] !== false);
  return selection === 'claude' ? ['claude'] : [];
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
    // Codex plugin cache is never advanced by update (see refreshUpdatePlugins).
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

// ============================================================================
// Codex plugin delivery report (observe/classify/report only — no permit,
// no cache-advancing command)
// ============================================================================

export interface CodexPluginDeliveryReport {
  /** The classified state's stable machine code. */
  machineCode: string;
  /** 0 = current, 1 = broken/indeterminate, 2 = action-required (pending). */
  exit: 0 | 1 | 2;
  actionRequired: boolean;
  /** The invocation's requested canonical delivery was verified/already verified. */
  deliveryComplete: boolean;
  installedVersion: string | null;
  targetVersion: string | null;
  recovery: string;
  humanStream: 'stdout' | 'stderr';
  humanText: string;
  trailer: ActivationResultTrailer;
}

export interface ReportCodexPluginDeliveryOptions {
  genieHome?: string;
  codexHome?: string;
  runner?: CommandRunner;
  /** Resolved codex executable; when absent the query is reported as failed. */
  command?: string | null;
  /** TEST-ONLY canonical payload root override; production refuses caller/env roots. */
  canonicalRoot?: string;
  allowRootOverride?: boolean;
  /** Delivery-completion flag for this invocation. Defaults to true (delivery succeeded). */
  deliveryComplete?: boolean;
}

/**
 * Observe, classify, and project the Codex plugin state through Group B's stable
 * facade. Performs bounded reads and one read-only `plugin list --json` query
 * only; never obtains a permit, writes an intent, or runs a cache-advancing
 * command. The returned exit/human/trailer surface is what update/install use to
 * report `Codex activation pending` and propagate action-required exit 2.
 */
export function reportCodexPluginDelivery(options: ReportCodexPluginDeliveryOptions = {}): CodexPluginDeliveryReport {
  const snapshot = observeCodexActivation({
    genieHome: options.genieHome,
    codexHome: options.codexHome,
    runner: options.runner,
    command: options.command,
    canonicalRoot: options.canonicalRoot,
    allowRootOverride: options.allowRootOverride,
  });
  const state = classifyCodexActivation(snapshot);
  const descriptor = describeState(state);
  const human = projectHumanStatus(state, snapshot);
  const deliveryComplete = options.deliveryComplete ?? true;
  const registration = snapshot.query.status === 'ok' ? snapshot.query.registration : { present: false as const };
  const installedVersion = registration.present && registration.version ? registration.version.canonical : null;
  return {
    machineCode: descriptor.machineCode,
    exit: descriptor.exit,
    actionRequired: descriptor.actionRequired,
    deliveryComplete,
    installedVersion,
    targetVersion: snapshot.canonical.status === 'ok' ? snapshot.canonical.version.canonical : null,
    recovery: descriptor.recovery,
    humanStream: human.stream,
    humanText: human.text,
    trailer: buildActivationResultTrailer(state, deliveryComplete),
  };
}
