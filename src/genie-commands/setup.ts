/**
 * Genie Setup Command
 *
 * Interactive wizard for configuring genie settings.
 * Supports full wizard, quick mode, and section-specific setup.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import { acquireLifecycleLease } from '../lib/agent-sync.js';
import {
  type ActivationExecutionResult,
  authorizeCodexActivation,
  buildActivationResultTrailer,
  classifyCodexActivation,
  describeState,
  executeCodexActivation,
  observeCodexActivation,
  openCodexActivationStore,
  projectHumanStatus,
  requestRetirementAssertion,
  resolveSetupExitCode,
  serializeActivationResultTrailer,
} from '../lib/codex-activation-executor.js';
// A's deep consent API + B's stable executor facade own the Codex activation path.
// Setup never reimplements the TTY/env/flag guards, constructs a RetirementAssertion,
// or retains a permit — it supplies a real-terminal ConsentContext and routes the
// permit-gated cache advance through B's `executeCodexActivation`.
import type {
  ActivationEntryPath,
  ActivationPermit,
  CodexActivationSnapshot,
  ConsentContext,
} from '../lib/codex-activation.js';
import { getCodexConfigPath } from '../lib/codex-config.js';
import type { DeliveryEvidenceVerificationDependencies } from '../lib/codex-delivery-evidence.js';
// The quarantine hop holds the SAME `setup-activation` lease kind the executor
// acquires (aliased: agent-sync exports an unrelated same-named lease helper).
import {
  type HeldLifecycleLease,
  acquireLifecycleLease as acquireActivationLifecycleLease,
} from '../lib/codex-lifecycle-lease.js';
// Group E: the shared Decision-9 delivery gate — the same assessment the
// executor's `beginActivation` inner guard re-applies before its first write.
import { assessSnapshotDelivery } from '../lib/codex-lifecycle-truth.js';
import {
  type CodexPluginProbe,
  genieFacadeMcpEntry,
  reconcileCodexProjectMcp,
  resolveGitWorktreeRoot,
} from '../lib/codex-project-mcp.js';
import {
  contractPath,
  getGenieConfigPath,
  loadGenieConfig,
  markSetupComplete,
  resetConfig,
  saveGenieConfig,
} from '../lib/genie-config.js';
import { resolveCodexDir, resolveGenieHome } from '../lib/genie-home.js';
import { acquireOrderedLifecycleLeases, releaseOrderedLifecycleLeases } from '../lib/ordered-lifecycle-leases.js';
import {
  type CodexAgentInstallResult,
  type IntegrationSelection,
  createCodexMarketplaceRegistrationConsumer,
  createSetupCodexConsentCommitConsumer,
  createSetupCodexFallbackRetirementConsumer,
  createSetupCodexRoleAgentConsumer,
  readIntegrationConsent,
} from '../lib/runtime-integrations.js';
import { checkCommand } from '../lib/system-detect.js';
import { resolveTrustedExecutable } from '../lib/trusted-executable.js';
import { installShortcuts, isShortcutsInstalled } from '../term-commands/shortcuts.js';
import type { GenieConfig } from '../types/genie-config.js';

export interface SetupOptions {
  quick?: boolean;
  shortcuts?: boolean;
  codex?: boolean;
  terminal?: boolean;
  session?: boolean;
  reset?: boolean;
  show?: boolean;
}

export interface SetupDeps {
  checkCommand?: typeof checkCommand;
  readIntegrationConsent?: typeof readIntegrationConsent;
  /** Factory for the explicit-consent capability consumed only by the deep store. */
  createCodexConsentCommitConsumer?: typeof createSetupCodexConsentCommitConsumer;
  /** Interactive confirmation seam; production uses @inquirer/prompts. */
  confirm?: typeof confirm;
  acquireLifecycleLease?: typeof acquireLifecycleLease;
  /** Test seam for the `setup-activation` codex lifecycle lease held during a journal quarantine. */
  acquireActivationLease?: typeof acquireActivationLifecycleLease;
  /** Test seam for the once-bound absolute Codex CLI path. */
  resolveExecutable?: (name: string, cwd: string) => string | null;
  cwd?: string;
  /** TEST-ONLY cryptographic seam for persisted delivery-evidence fixtures; no CLI/env path exposes it. */
  deliveryEvidenceVerification?: DeliveryEvidenceVerificationDependencies;
  // --- Codex activation seams (Group D): all default to the real facade. ---
  /** Bounded activation observation (B's facade). */
  observeCodexActivation?: (options: {
    command: string | null;
    genieHome?: string;
    codexHome?: string;
  }) => CodexActivationSnapshot;
  /** A's deep consent API — the ONLY source of a genuine retirement assertion. */
  requestRetirementAssertion?: typeof requestRetirementAssertion;
  /** Pure authorization overlay (A) returning a fingerprint-bound permit. */
  authorizeCodexActivation?: typeof authorizeCodexActivation;
  /** Open A's deep store for the permit-gated transaction. */
  openCodexActivationStore?: typeof openCodexActivationStore;
  /** The permit-gated executor (B) — the sole route to Codex cache mutation. */
  executeCodexActivation?: typeof executeCodexActivation;
  /** Current-state marketplace capability factory; only the deep store may consume it. */
  createCodexMarketplaceConsumer?: typeof createCodexMarketplaceRegistrationConsumer;
  /** Setup-only fallback-retirement capability; only the deep store may consume it. */
  createCodexFallbackRetirementConsumer?: typeof createSetupCodexFallbackRetirementConsumer;
  /** Post-activation role capability factory; only the deep store may consume it. */
  createCodexRoleAgentConsumer?: typeof createSetupCodexRoleAgentConsumer;
  /** Synchronous real-TTY confirmation for the retirement assertion prompt. */
  promptRetirementConfirmation?: (message: string) => boolean;
  /** stdin/stdout TTY flags forwarded to A's consent guards (default: real streams). */
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  /** Deterministic race seams for the setup finalization transaction. Tests only. */
  codexFinalizationHooks?: {
    beforeLocks?: () => void;
    afterAssets?: () => void;
    afterRoute?: () => void;
  };
}

export class SetupIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupIntegrationError';
  }
}

/**
 * The setup command boundary distinguishes lifecycle contention from an
 * integration failure. Only this typed refusal projects exit 2 plus the
 * canonical machine trailer; all other setup errors remain exit 1.
 */
export class SetupCodexLifecycleBusyError extends SetupIntegrationError {
  readonly code = 'codex-lifecycle-busy';

  constructor(
    readonly holderKind: string | null,
    detail: string,
  ) {
    super(`codex-lifecycle-busy: the ${holderKind ?? 'unknown'} lifecycle command holds the Codex lease: ${detail}`);
    this.name = 'SetupCodexLifecycleBusyError';
  }
}

/**
 * Print the header banner
 */
function printHeader(): void {
  console.log();
  console.log(`\x1b[1m\x1b[36m${'='.repeat(64)}\x1b[0m`);
  console.log('\x1b[1m\x1b[36m  Genie Setup Wizard\x1b[0m');
  console.log(`\x1b[1m\x1b[36m${'='.repeat(64)}\x1b[0m`);
  console.log();
}

/**
 * Print a section header
 */
function printSection(title: string, description?: string): void {
  console.log();
  console.log(`\x1b[1m${title}\x1b[0m`);
  if (description) {
    console.log(`\x1b[2m${description}\x1b[0m`);
  }
  console.log();
}

// ============================================================================
// Session Configuration
// ============================================================================

async function configureSession(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('2. Session Configuration', 'Configure tmux session settings');

  if (quick) {
    console.log(`  Using defaults: session="${config.session.name}", window="${config.session.defaultWindow}"`);
    return config;
  }

  const sessionName = await input({
    message: 'Session name:',
    default: config.session.name,
  });

  const defaultWindow = await input({
    message: 'Default window name:',
    default: config.session.defaultWindow,
  });

  const autoCreate = await confirm({
    message: 'Auto-create session on connect?',
    default: config.session.autoCreate,
  });

  config.session = {
    name: sessionName,
    defaultWindow,
    autoCreate,
  };

  return config;
}

// ============================================================================
// Terminal Configuration
// ============================================================================

async function configureTerminal(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('3. Terminal Defaults', 'Configure default values for term commands');

  if (quick) {
    console.log(`  Using defaults: timeout=${config.terminal.execTimeout}ms, lines=${config.terminal.readLines}`);
    return config;
  }

  const timeoutStr = await input({
    message: 'Exec timeout (milliseconds):',
    default: String(config.terminal.execTimeout),
    validate: (v) => {
      const n = Number.parseInt(v, 10);
      return !Number.isNaN(n) && n > 0 ? true : 'Must be a positive number';
    },
  });

  const linesStr = await input({
    message: 'Read lines (default for genie agent read):',
    default: String(config.terminal.readLines),
    validate: (v) => {
      const n = Number.parseInt(v, 10);
      return !Number.isNaN(n) && n > 0 ? true : 'Must be a positive number';
    },
  });

  const worktreeBase = await input({
    message: 'Worktree base directory (leave empty for ~/.genie/worktrees/<project>/):',
    default: config.terminal.worktreeBase ?? '',
  });

  config.terminal = {
    execTimeout: Number.parseInt(timeoutStr, 10),
    readLines: Number.parseInt(linesStr, 10),
    ...(worktreeBase ? { worktreeBase } : {}),
  };

  return config;
}

// ============================================================================
// Keyboard Shortcuts
// ============================================================================

async function configureShortcuts(config: GenieConfig, quick: boolean, deps: SetupDeps): Promise<GenieConfig> {
  printSection('4. Keyboard Shortcuts', 'Warp-like tmux shortcuts for quick navigation');

  const home = homedir();
  const tmuxConf = join(home, '.tmux.conf');
  const tmuxInstalled = isShortcutsInstalled(tmuxConf);

  if (tmuxInstalled) {
    console.log('  \x1b[32m\u2713\x1b[0m Tmux shortcuts already installed');
    config.shortcuts.tmuxInstalled = true;
    return config;
  }

  console.log('  Available shortcuts:');
  console.log('    \x1b[36mCtrl+T\x1b[0m \u2192 New tab (window)');
  console.log('    \x1b[36mCtrl+S\x1b[0m \u2192 Vertical split');
  console.log('    \x1b[36mCtrl+H\x1b[0m \u2192 Horizontal split');
  console.log();

  if (quick) {
    console.log('  Skipped in quick mode. Run \x1b[36mgenie setup --shortcuts\x1b[0m to install.');
    return config;
  }

  const installChoice = await confirm({
    message: 'Install tmux keyboard shortcuts?',
    default: false,
  });

  if (installChoice) {
    console.log();
    await withSetupLease(deps, async () => {
      // The prompt was answered without a lease. Re-read the target immediately
      // after acquisition so a concurrent setup cannot cause duplicate writes.
      if (!isShortcutsInstalled(tmuxConf)) await installShortcuts();
      config.shortcuts.tmuxInstalled = true;
    });
  } else {
    console.log('  Skipped. Run \x1b[36mgenie shortcuts install\x1b[0m later.');
  }

  return config;
}

// ============================================================================
// Codex Integration — permit-gated activation (Group D, D1/D2/D8/D9)
// ============================================================================
//
// Setup is ACTIVATION-ONLY. It retires the currently active Codex plugin
// generation and activates the delivered one, gated behind A's deep consent API
// (the sole source of a genuine retirement assertion) and executed through B's
// permit-gated `executeCodexActivation` (the sole route to Codex cache mutation,
// which acquires the `setup-activation` lifecycle lease itself). DELIVERY —
// installing/refreshing the plugin payload and publishing authenticated delivery
// facts belongs to `genie update` / `genie install`. Marketplace registration
// and managed role convergence are activation-owned: the executor registers the
// canonical marketplace only after `beginActivation`, and setup converges roles
// only after activation/current verification. Setup commits explicit Codex
// maintenance consent, proves the exact enabled plugin and retires only clean
// historical fallbacks, then adopts/converges managed roles. Every refusal
// happens before marketplace/plugin/config/fallback/role-agent/project-route
// mutation.

/**
 * Synchronous real-terminal confirmation for the retirement assertion. A's
 * consent API owns the environment/TTY/flag guards and the prompt message; this
 * helper only performs the blocking `/dev/tty` read A's `ConsentContext.prompt`
 * requires (the wizard is otherwise async). It fails closed: any missing
 * controlling terminal, read error, or non-affirmative answer returns false, so
 * it can never synthesize consent. A already refused non-TTY/CI/quick before it.
 */
function promptRetirementConfirmationSync(message: string): boolean {
  process.stdout.write(`\n  ${message}\n  Type "yes" to retire the prior generation and activate: `);
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(64);
    const read = readSync(fd, buf, 0, buf.length, null);
    return buf.toString('utf8', 0, read).trim().toLowerCase() === 'yes';
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Build the ConsentContext A's guards consume; the `--quick` signal is reflected into argv. */
function buildConsentContext(deps: SetupDeps, quick: boolean): ConsentContext {
  const argv = quick ? [...process.argv, '--quick'] : process.argv;
  return {
    stdinIsTTY: deps.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    stdoutIsTTY: deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY),
    env: process.env,
    argv,
    prompt: deps.promptRetirementConfirmation ?? promptRetirementConfirmationSync,
  };
}

function reconcileSetupCodexProject(root: string | null, plugin: CodexPluginProbe): string {
  if (root === null) {
    return '  \x1b[2mNo Git worktree detected; project MCP fallback was not changed.\x1b[0m';
  }
  // Decision 2: the marker route carries the stable absolute GENIE_HOME facade,
  // exactly as trusted `genie init` writes it.
  const project = reconcileCodexProjectMcp(root, plugin, genieFacadeMcpEntry());
  if (!project.ok) throw new SetupIntegrationError(project.detail ?? 'Codex project MCP reconciliation failed');
  return `  \x1b[32m✓\x1b[0m Project MCP route: ${project.route} (${project.detail ?? project.action})`;
}

/**
 * Post-activation route probe (Group E). The installed Codex plugin ships NO
 * MCP route (Group A removed the manifest declaration), so for ROUTE purposes
 * an activated plugin is never "usable" and the marker-owned project route
 * remains required. Decision 1: plugin availability never creates or removes
 * the project route — the pre-A behavior of removing the fallback after
 * activation left a repository with no Codex route at all.
 */
function verifiedCurrentPluginProbe(): CodexPluginProbe {
  return {
    cliAvailable: true,
    status: 'ok',
    installed: true,
    enabled: true,
    usable: false,
    usabilityDetail: 'installed plugin contributes no Codex MCP route; the marker-owned project route is authoritative',
    detail: 'activation verified-current; project route remains marker-owned',
  };
}

/** Merge explicit Codex activation into the durable client-home maintenance scope. */
export function mergeCodexIntegrationConsent(current: IntegrationSelection): IntegrationSelection {
  if (current === 'none') return 'codex';
  if (current === 'claude') return 'all';
  if (current === 'auto') return 'codex';
  return current;
}

function preserveRuntimeChoiceAfterCodex(config: GenieConfig): string | undefined {
  const decision = resolveDefaultAgentAfterCodex(config.runtime.defaultAgent);
  config.runtime.defaultAgent = decision.agent;
  return decision.hint;
}

/**
 * The typed per-invocation setup outcome (Decision 12). Success (a green banner
 * + persisted `codex.configured`) flows ONLY from this invocation's outcome —
 * never from historical config state — so a failed or pending run can never
 * print or persist success.
 */
type SetupCodexOutcomeCode =
  | 'activated'
  | 'current'
  | 'payload-missing'
  | 'delivery-incomplete'
  | 'status-reported'
  | 'consent-refused'
  | 'not-authorized'
  | 'busy'
  | 'stale'
  | 'refused'
  | 'broken'
  | 'quarantine-skipped';

interface ActivationOutcome {
  exitCode: 0 | 1 | 2;
  /** True when the plugin is verified-current (freshly activated or already current). */
  activated: boolean;
  /** The one typed code this invocation ends with; `activated` is true only for 'activated' | 'current'. */
  code: SetupCodexOutcomeCode;
}

function emitTrailer(trailer: ReturnType<typeof buildActivationResultTrailer>): void {
  process.stdout.write(`${serializeActivationResultTrailer(trailer)}\n`);
}

function emitCodexLifecycleBusyTrailer(holderKind: string | null): void {
  emitTrailer({
    schemaVersion: 1,
    code: 'codex-lifecycle-busy',
    deliveryComplete: false,
    retry: true,
    nextAction: holderKind
      ? `retry after the current ${holderKind} lifecycle command releases the lease`
      : 'retry after the current lifecycle command releases the lease',
  });
}

function resolveCodexPath(deps: SetupDeps, cwd: string): string | null {
  try {
    if (deps.resolveExecutable) return deps.resolveExecutable('codex', cwd);
    return Bun.which('codex') === null ? null : resolveTrustedExecutable('codex', cwd);
  } catch (error) {
    throw new SetupIntegrationError(error instanceof Error ? error.message : String(error));
  }
}

function observeSetupCodexActivation(
  deps: SetupDeps,
  options: { command: string; genieHome: string; codexHome: string },
): CodexActivationSnapshot {
  return deps.observeCodexActivation
    ? deps.observeCodexActivation(options)
    : observeCodexActivation({
        ...options,
        deliveryEvidenceVerification: deps.deliveryEvidenceVerification,
      });
}

function reportDeliveryIncomplete(snapshot: CodexActivationSnapshot): ActivationOutcome | null {
  const deliveryGate = assessSnapshotDelivery(snapshot);
  if (deliveryGate.kind !== 'incomplete') return null;
  const gate = deliveryGate.result;
  console.error(`  \x1b[31m✖\x1b[0m ${gate.detail}`);
  console.error(`    Recovery: \x1b[36m${gate.recovery}\x1b[0m`);
  emitTrailer({
    schemaVersion: 1,
    code: 'delivery-incomplete',
    deliveryComplete: false,
    retry: true,
    nextAction: gate.recovery,
  });
  return { exitCode: gate.exit, activated: false, code: 'delivery-incomplete' };
}

/**
 * The permit-gated Codex activation transaction. Observes, classifies, gates on
 * A's consent + authorization, then routes the cache advance through B's
 * executor. Every refusal returns before any mutation with a deterministic exit
 * code and (for exit-2/1 lifecycle paths) the A-owned result trailer.
 */
function runCodexActivation(
  deps: SetupDeps,
  codexPath: string,
  entry: ActivationEntryPath,
  quick: boolean,
  attempt = 0,
): ActivationOutcome {
  const genieHome = resolveGenieHome();
  const codexHome = resolveCodexDir();
  const observeOptions = { command: codexPath, genieHome, codexHome };
  const snapshot = observeSetupCodexActivation(deps, observeOptions);
  const state = classifyCodexActivation(snapshot);
  const descriptor = describeState(state);
  const deliveryComplete = snapshot.canonical.status === 'ok';

  // Condition 1: no delivered payload -> actionable refusal, never a dead end.
  if (!deliveryComplete) {
    console.error('  \x1b[31m✖\x1b[0m Genie payload not found under GENIE_HOME (nothing delivered to activate).');
    console.error(
      '    Delivery is done by \x1b[36mgenie update\x1b[0m / \x1b[36mgenie install\x1b[0m — run one, then rerun \x1b[36mgenie setup --codex\x1b[0m.',
    );
    return { exitCode: 1, activated: false, code: 'payload-missing' };
  }
  // Condition 2 (Group E, Decision 9): a matching authenticated delivery record
  // is required BEFORE the first prompt or activation-owned mutation — even on
  // an already-current machine, because only update/install may publish the
  // record and setup must not claim success it cannot attest. The executor's
  // `beginActivation` inner guard re-checks the same assessment immediately
  // before its first write (defense in depth).
  const incomplete = reportDeliveryIncomplete(snapshot);
  if (incomplete !== null) return incomplete;
  if (state.kind === 'current') {
    console.log('  \x1b[32m✓\x1b[0m Codex plugin is already current; no activation needed.');
    return { exitCode: 0, activated: true, code: 'current' };
  }
  if (descriptor.authority === 'none') {
    const projection = projectHumanStatus(state, snapshot);
    (projection.stream === 'stderr' ? process.stderr : process.stdout).write(`  ${projection.text}\n`);
    return { exitCode: projection.exitCode, activated: false, code: 'status-reported' };
  }

  // Activation authority — gate on A's deep consent API (owns TTY/env/flag/prompt).
  const consent = (deps.requestRetirementAssertion ?? requestRetirementAssertion)(
    snapshot,
    buildConsentContext(deps, quick),
  );
  if (consent.result !== 'granted') {
    console.error(`  \x1b[31m✖\x1b[0m Retirement assertion refused: ${consent.reason}`);
    emitTrailer(buildActivationResultTrailer(state, deliveryComplete));
    return {
      exitCode: resolveSetupExitCode(state, { result: 'refused', reason: consent.reason }),
      activated: false,
      code: 'consent-refused',
    };
  }
  const authorization = (deps.authorizeCodexActivation ?? authorizeCodexActivation)({
    state,
    snapshot,
    invocation: { entry, assertion: consent.assertion },
  });
  if (authorization.result !== 'granted') {
    const reason = 'reason' in authorization ? authorization.reason : authorization.result;
    console.error(`  \x1b[31m✖\x1b[0m Activation not authorized: ${reason}`);
    emitTrailer(buildActivationResultTrailer(state, deliveryComplete));
    return { exitCode: resolveSetupExitCode(state, authorization), activated: false, code: 'not-authorized' };
  }

  // Group E (live-QA find): an intent-invalid/intent-mismatch state grants a
  // JOURNAL-QUARANTINE permit, not an activation permit. Feeding it to the
  // executor made beginActivation refuse ("permit lacks activation capability")
  // and left the state's own recovery — "quarantine the mismatched intent after
  // a fresh assertion, then re-observe" — unreachable, looping forever. Route
  // the permit to A's quarantine API, then re-observe and continue once.
  if (authorization.permit.capability === 'journal-quarantine') {
    return runJournalQuarantine(deps, codexPath, entry, quick, authorization.permit, attempt);
  }

  // Permit granted — the executor acquires the `setup-activation` lease itself.
  const storeOptions = { genieHome, codexHome, command: codexPath };
  const store = deps.openCodexActivationStore
    ? deps.openCodexActivationStore(storeOptions)
    : openCodexActivationStore({
        ...storeOptions,
        deliveryEvidenceVerification: deps.deliveryEvidenceVerification,
      });
  const result = (deps.executeCodexActivation ?? executeCodexActivation)({
    permit: authorization.permit,
    store,
    command: codexPath,
    codexHome,
    genieHome,
    configPath: getCodexConfigPath(),
  });
  return reportActivationExecution(result);
}

/**
 * Consume a journal-quarantine permit: move the invalid/mismatched activation
 * journal aside under the same `setup-activation` lifecycle lease the executor
 * would hold, then re-observe with one fresh pass through `runCodexActivation`
 * (the fresh state prompts its own consent for any actual activation). One hop
 * only — a second quarantine grant in the same invocation reports instead of
 * looping.
 */
function runJournalQuarantine(
  deps: SetupDeps,
  codexPath: string,
  entry: ActivationEntryPath,
  quick: boolean,
  permit: ActivationPermit,
  attempt: number,
): ActivationOutcome {
  const genieHome = resolveGenieHome();
  const codexHome = resolveCodexDir();
  if (attempt > 0) {
    console.error('  \x1b[31m✖\x1b[0m A second quarantine was requested in one invocation; refusing to loop.');
    console.error(
      '    Rerun \x1b[36mgenie setup --codex\x1b[0m; if it recurs, include `genie doctor --json` in an issue.',
    );
    return { exitCode: 1, activated: false, code: 'quarantine-skipped' };
  }
  const acquire = deps.acquireActivationLease ?? acquireActivationLifecycleLease;
  const lease = acquire('setup-activation', { genieHome });
  if (!lease.ok) {
    console.error(
      `  \x1b[31m✖\x1b[0m codex-lifecycle-busy: the ${lease.holderKind ?? 'unknown'} lifecycle command holds the Codex lease: ${lease.detail}`,
    );
    emitCodexLifecycleBusyTrailer(lease.holderKind);
    return { exitCode: 2, activated: false, code: 'busy' };
  }
  let quarantined: { quarantinedTo: string } | { skipped: string };
  try {
    const storeOptions = { genieHome, codexHome, command: codexPath };
    const store = deps.openCodexActivationStore
      ? deps.openCodexActivationStore(storeOptions)
      : openCodexActivationStore({
          ...storeOptions,
          deliveryEvidenceVerification: deps.deliveryEvidenceVerification,
        });
    quarantined = store.quarantineIntent(lease, permit);
  } finally {
    lease.release();
  }
  if ('skipped' in quarantined) {
    console.error(`  \x1b[31m✖\x1b[0m Stale activation journal was not quarantined: ${quarantined.skipped}`);
    return { exitCode: 1, activated: false, code: 'quarantine-skipped' };
  }
  console.log(`  \x1b[33m!\x1b[0m Quarantined stale activation journal → ${quarantined.quarantinedTo}`);
  console.log('  Re-observing the delivered generation...');
  return runCodexActivation(deps, codexPath, entry, quick, attempt + 1);
}

function reportActivationExecution(result: ActivationExecutionResult): ActivationOutcome {
  if (result.status === 'activated') {
    console.log(`  \x1b[32m✓\x1b[0m Activated Codex plugin v${result.version} (enabled=${result.enabled}).`);
    console.log(`  \x1b[33m!\x1b[0m ${result.recovery}`);
    return { exitCode: 0, activated: true, code: 'activated' };
  }
  console.error(`  \x1b[31m✖\x1b[0m ${result.detail}`);
  if (result.status === 'broken') {
    console.error(
      '    If the Codex plugin/marketplace was never delivered, run \x1b[36mgenie update\x1b[0m first, then retry.',
    );
  }
  emitTrailer(result.trailer);
  // The executor's own delivery-incomplete inner-guard refusal is exit 1 like
  // broken; busy/stale/refused stay action-required (exit 2).
  const exitCode = result.status === 'broken' || result.status === 'delivery-incomplete' ? 1 : 2;
  return { exitCode, activated: false, code: result.status };
}

interface PostActivationCodexAssets {
  agents: CodexAgentInstallResult;
  retiredFallbacks: readonly string[];
}

function convergePostActivationCodexAssetsUnderLease(
  deps: SetupDeps,
  codexPath: string,
  outcome: ActivationOutcome,
  lease: HeldLifecycleLease,
): PostActivationCodexAssets {
  const genieHome = resolveGenieHome();
  const codexHome = resolveCodexDir();
  const storeOptions = { genieHome, codexHome, command: codexPath };
  const store = deps.openCodexActivationStore
    ? deps.openCodexActivationStore(storeOptions)
    : openCodexActivationStore({
        ...storeOptions,
        deliveryEvidenceVerification: deps.deliveryEvidenceVerification,
      });
  return store.withRevalidatedDeliveryRoot(lease, (ops) => {
    // The executor released its lease before this post-activation pass. A
    // delivery/update can win that gap, so both fresh activation and the
    // already-current path must re-observe current+matching under the newly
    // acquired lease before consent, roles, route, or success reporting.
    const snapshot = store.observe();
    if (assessSnapshotDelivery(snapshot).kind !== 'matching' || classifyCodexActivation(snapshot).kind !== 'current') {
      throw new SetupIntegrationError('Codex current state changed before managed-asset convergence');
    }

    // Already-current is the sole no-permit path. Register its marketplace
    // inside the callback-scoped authenticated delivery capability.
    if (outcome.code === 'current') {
      const marketplaceConsumer = (deps.createCodexMarketplaceConsumer ?? createCodexMarketplaceRegistrationConsumer)({
        command: codexPath,
      });
      ops.consume(marketplaceConsumer);
    }

    // Explicit setup success commits Codex maintenance consent before
    // authenticated fallback retirement and managed-role adoption.
    const read = deps.readIntegrationConsent ?? readIntegrationConsent;
    const consentConsumer = (deps.createCodexConsentCommitConsumer ?? createSetupCodexConsentCommitConsumer)({
      selection: mergeCodexIntegrationConsent(read(genieHome)),
      genieHome,
    });
    ops.consume(consentConsumer);
    const retirementConsumer = (
      deps.createCodexFallbackRetirementConsumer ?? createSetupCodexFallbackRetirementConsumer
    )({
      command: codexPath,
      expectedVersion: ops.deliveredVersion(),
      codexHome,
    });
    const retirement = ops.consume(retirementConsumer);
    const roleConsumer = (deps.createCodexRoleAgentConsumer ?? createSetupCodexRoleAgentConsumer)({
      genieHome,
      codexHome,
    });
    return {
      agents: ops.consume(roleConsumer),
      retiredFallbacks: retirement.retired,
    };
  });
}

interface PreparedCodexFinalization {
  codexPath: string;
  cwd: string;
  outcome: ActivationOutcome;
}

interface FinalizedCodexSetup {
  config: GenieConfig;
  assets: PostActivationCodexAssets;
  projectLine: string;
  runtimeHint?: string;
}

/**
 * Commit setup's successful Codex result as one serialized transaction.
 *
 * Lock order matches install/update: the outer agent-sync lifecycle lease is
 * acquired first, then the Codex lifecycle lease. Holding both across the
 * matching/current revalidation, assets, route, and config CAS prevents an
 * update from publishing T+1 after asset convergence while setup still records
 * T as configured. Release is always the exact reverse order.
 */
async function finalizeCodexSetup(
  config: GenieConfig,
  baseline: GenieConfig,
  deps: SetupDeps,
  prepared: PreparedCodexFinalization,
): Promise<FinalizedCodexSetup> {
  deps.codexFinalizationHooks?.beforeLocks?.();
  const genieHome = resolveGenieHome();
  const acquired = acquireOrderedLifecycleLeases(
    () => (deps.acquireLifecycleLease ?? acquireLifecycleLease)(genieHome),
    () => (deps.acquireActivationLease ?? acquireActivationLifecycleLease)('setup-activation', { genieHome }),
  );
  if (!acquired.ok) {
    if (acquired.busy === 'agent-sync') {
      throw new SetupCodexLifecycleBusyError('agent-sync', acquired.detail);
    }
    throw new SetupCodexLifecycleBusyError(acquired.refusal.holderKind, acquired.refusal.detail);
  }
  const { agentSyncLease, codexLease } = acquired;
  try {
    const assets = convergePostActivationCodexAssetsUnderLease(deps, prepared.codexPath, prepared.outcome, codexLease);
    deps.codexFinalizationHooks?.afterAssets?.();

    const projectLine = reconcileSetupCodexProject(resolveGitWorktreeRoot(prepared.cwd), verifiedCurrentPluginProbe());
    deps.codexFinalizationHooks?.afterRoute?.();

    const nextConfig = structuredClone(config);
    nextConfig.codex = { configured: true };
    const runtimeHint = preserveRuntimeChoiceAfterCodex(nextConfig);
    await saveSetupConfigUnderHeldLease(nextConfig, baseline);
    return {
      config: nextConfig,
      assets,
      projectLine,
      ...(runtimeHint === undefined ? {} : { runtimeHint }),
    };
  } finally {
    releaseOrderedLifecycleLeases(codexLease, agentSyncLease);
  }
}

function reportFinalizedCodexSetup(finalized: FinalizedCodexSetup): void {
  if (finalized.assets.retiredFallbacks.length > 0) {
    console.log(
      `  \x1b[32m✓\x1b[0m Retired ${finalized.assets.retiredFallbacks.length} clean historical Codex fallback skill${finalized.assets.retiredFallbacks.length === 1 ? '' : 's'}.`,
    );
  }
  console.log(`  \x1b[32m✓\x1b[0m Codex managed roles converged (${finalized.assets.agents.installed} delivered).`);
  console.log(finalized.projectLine);
  if (finalized.runtimeHint !== undefined) console.log(`  \x1b[2m${finalized.runtimeHint}\x1b[0m`);
}

interface ConfigureCodexResult {
  config: GenieConfig;
  /** Null when the Codex CLI is absent/skipped — nothing was attempted this invocation. */
  outcome: ActivationOutcome | null;
  /** Present only when matching/current state still needs atomic setup finalization. */
  prepared: PreparedCodexFinalization | null;
}

async function configureCodex(
  config: GenieConfig,
  quick: boolean,
  deps: SetupDeps,
  entry: ActivationEntryPath,
): Promise<ConfigureCodexResult> {
  printSection('5. Codex Integration', 'Activate the delivered Codex plugin generation for genie agents');

  const cwd = deps.cwd ?? process.cwd();
  const codexPath = resolveCodexPath(deps, cwd);
  if (codexPath === null) {
    console.log('  \x1b[33m!\x1b[0m Codex CLI not found. Skipping codex integration.');
    return { config, outcome: null, prepared: null };
  }
  const codexCheck = await (deps.checkCommand ?? checkCommand)(codexPath, { which: () => codexPath });
  if (codexCheck.timedOut) throw new SetupIntegrationError(codexCheck.error ?? 'Codex CLI detection timed out');
  if (!codexCheck.exists) {
    console.log('  \x1b[33m!\x1b[0m Codex CLI not found. Skipping codex integration.');
    return { config, outcome: null, prepared: null };
  }
  console.log(`  \x1b[32m✓\x1b[0m Codex CLI found (${codexCheck.version ?? 'unknown version'})`);
  console.log();
  console.log('  \x1b[1mSetup activates\x1b[0m the delivered Codex plugin generation, retiring the prior one.');
  console.log('  Delivery (plugin payload and authenticated delivery record) is done by');
  console.log(
    '  \x1b[36mgenie update\x1b[0m / \x1b[36mgenie install\x1b[0m — setup registers and activates only those verified bytes.',
  );
  console.log('  Activation requires an interactive real terminal; --quick, CI, and piped input cannot activate.');
  console.log(`  Config: \x1b[2m${contractPath(getCodexConfigPath())}\x1b[0m`);
  console.log();

  const outcome = runCodexActivation(deps, codexPath, entry, quick);
  if (!outcome.activated && outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
  return {
    config,
    outcome,
    prepared: outcome.activated ? { codexPath, cwd, outcome } : null,
  };
}

type DefaultAgent = GenieConfig['runtime']['defaultAgent'];

/**
 * Decide `runtime.defaultAgent` after a successful codex configure.
 *
 * Only an `auto` selection (the schema default — what a machine with no prior
 * choice carries) is flipped to `codex`. An explicit existing setting is never
 * overridden: `claude` stays `claude` (this includes legacy pre-runtime
 * configs, which `loadGenieConfig` backfills to `claude` because those users
 * were implicitly launching Claude) and the caller prints `hint` instead so
 * the user knows codex is one config edit away.
 */
export function resolveDefaultAgentAfterCodex(current: DefaultAgent): { agent: DefaultAgent; hint?: string } {
  if (current === 'auto') return { agent: 'codex' };
  if (current === 'claude') {
    const configPath = contractPath(getGenieConfigPath());
    return {
      agent: 'claude',
      hint: `runtime.defaultAgent stays 'claude' (explicit setting). Codex available: set "runtime": { "defaultAgent": "codex" } in ${configPath} to switch.`,
    };
  }
  return { agent: current };
}

// ============================================================================
// Debug Options
// ============================================================================

async function configureDebug(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('6. Debug Options', 'Logging and debugging settings');

  if (quick) {
    console.log('  Using defaults: tmuxDebug=false, verbose=false');
    return config;
  }

  const tmuxDebug = await confirm({
    message: 'Enable tmux debug logging?',
    default: config.logging.tmuxDebug,
  });

  const verbose = await confirm({
    message: 'Enable verbose mode?',
    default: config.logging.verbose,
  });

  config.logging = {
    tmuxDebug,
    verbose,
  };

  return config;
}

// ============================================================================
// Prompt Mode Configuration
// ============================================================================

async function configurePromptMode(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('7. Prompt Mode', 'Controls how genie injects system prompts into Claude Code');

  if (quick) {
    console.log(`  Using default: promptMode="${config.promptMode}"`);
    return config;
  }

  console.log('  append  — Uses --append-system-prompt-file (preserves Claude Code default system prompt)');
  console.log('  system  — Uses --system-prompt-file (replaces Claude Code default system prompt)');
  console.log();

  const promptMode = await select({
    message: 'Prompt mode:',
    choices: [
      { name: 'append (recommended — preserves CC default)', value: 'append' as const },
      { name: 'system (replaces CC default)', value: 'system' as const },
    ],
    default: config.promptMode,
  });

  config.promptMode = promptMode;
  return config;
}

// ============================================================================
// Summary and Save
// ============================================================================

function showSummary(config: GenieConfig, codexOutcome?: ActivationOutcome | null): void {
  printSection('Summary', `Configuration saved to ${contractPath(getGenieConfigPath())}`);

  // Decision 12: when this run attempted Codex, the summary states THIS run's
  // typed outcome; historical `configured` state cannot masquerade as success.
  const codexLine =
    codexOutcome === undefined || codexOutcome === null
      ? config.codex?.configured
        ? '\x1b[32mconfigured\x1b[0m'
        : '\x1b[2mnot configured\x1b[0m'
      : codexOutcome.activated
        ? '\x1b[32mconfigured\x1b[0m'
        : `\x1b[2mnot configured this run (${codexOutcome.code})\x1b[0m`;
  console.log(`  Session: \x1b[36m${config.session.name}\x1b[0m (window: ${config.session.defaultWindow})`);
  console.log(`  Terminal: timeout=${config.terminal.execTimeout}ms, lines=${config.terminal.readLines}`);
  console.log(
    `  Shortcuts: ${config.shortcuts.tmuxInstalled ? '\x1b[32minstalled\x1b[0m' : '\x1b[2mnot installed\x1b[0m'}`,
  );
  console.log(`  Codex:   ${codexLine}`);
  console.log(`  Debug: tmux=${config.logging.tmuxDebug}, verbose=${config.logging.verbose}`);
  console.log(`  Prompt mode: \x1b[36m${config.promptMode}\x1b[0m`);
  console.log();
}

async function showSummaryAndSave(
  config: GenieConfig,
  baseline: GenieConfig,
  deps: SetupDeps,
  codexOutcome?: ActivationOutcome | null,
): Promise<void> {
  config.setupComplete = true;
  config.lastSetupAt = new Date().toISOString();
  await saveSetupConfig(config, baseline, deps);

  showSummary(config, codexOutcome);
  console.log('\x1b[32m\u2713 Configuration saved!\x1b[0m');
}

// ============================================================================
// Show Current Config
// ============================================================================

async function showCurrentConfig(): Promise<void> {
  const config = await loadGenieConfig();

  console.log();
  console.log('\x1b[1mCurrent Genie Configuration\x1b[0m');
  console.log(`\x1b[2m${contractPath(getGenieConfigPath())}\x1b[0m`);
  console.log();
  console.log(JSON.stringify(config, null, 2));
  console.log();
}

// ============================================================================
// Print Next Steps
// ============================================================================

function printNextSteps(): void {
  console.log();
  console.log('\x1b[1mNext Steps:\x1b[0m');
  console.log();
  console.log('  Start a session:  \x1b[36mgenie\x1b[0m');
  console.log('  Watch AI work:    \x1b[36mtmux attach -t genie\x1b[0m');
  console.log('  Check health:     \x1b[36mgenie doctor\x1b[0m');
  console.log();
}

// ============================================================================
// Main Setup Command
// ============================================================================

async function runSetupCommand(options: SetupOptions, deps: SetupDeps): Promise<void> {
  // Handle --show flag
  if (options.show) {
    await showCurrentConfig();
    return;
  }

  // Handle --reset flag
  if (options.reset) {
    await withSetupLease(deps, () => resetConfig());
    console.log('\x1b[32m\u2713 Configuration reset to defaults.\x1b[0m');
    console.log();
    return;
  }

  // Load existing config
  let config = await loadGenieConfig();
  const baseline = structuredClone(config);

  // Handle section-specific flags
  if (options.shortcuts) {
    printHeader();
    await configureShortcuts(config, false, deps);
    await withSetupLease(deps, () => markSetupComplete());
    return;
  }

  if (options.terminal) {
    printHeader();
    config = await configureTerminal(config, false);
    await saveSetupConfig(config, baseline, deps);
    console.log('\x1b[32m\u2713 Terminal configuration saved.\x1b[0m');
    return;
  }

  if (options.session) {
    printHeader();
    config = await configureSession(config, false);
    await saveSetupConfig(config, baseline, deps);
    console.log('\x1b[32m\u2713 Session configuration saved.\x1b[0m');
    return;
  }

  if (options.codex) {
    printHeader();
    const codexRun = await configureCodex(config, options.quick ?? false, deps, 'setup-codex');
    config = codexRun.config;
    // Decision 12: the green banner flows from THIS invocation's typed outcome,
    // never from historical `codex.configured` state. A failed, pending, or
    // skipped standalone run performs no config write at all, preserving the
    // user's exact bytes (including formatting and unknown keys).
    if (codexRun.prepared !== null) {
      const finalized = await finalizeCodexSetup(config, baseline, deps, codexRun.prepared);
      config = finalized.config;
      reportFinalizedCodexSetup(finalized);
      console.log('\x1b[32m\u2713 Codex configuration saved.\x1b[0m');
    }
    return;
  }

  // Full wizard
  const quick = options.quick ?? false;

  printHeader();

  if (quick) {
    console.log('\x1b[2mQuick mode: accepting all defaults\x1b[0m');
  }

  // Run all sections
  config = await configureSession(config, quick);
  config = await configureTerminal(config, quick);
  config = await configureShortcuts(config, quick, deps);
  const codexRun = await configureCodex(config, quick, deps, 'full-setup-codex-step');
  config = codexRun.config;
  config = await configureDebug(config, quick);
  config = await configurePromptMode(config, quick);

  // Save and show summary (unrelated completed sections save regardless; the
  // Codex line reflects THIS run's typed outcome, not historical state).
  if (codexRun.prepared === null) {
    await showSummaryAndSave(config, baseline, deps, codexRun.outcome);
  } else {
    config.setupComplete = true;
    config.lastSetupAt = new Date().toISOString();
    const finalized = await finalizeCodexSetup(config, baseline, deps, codexRun.prepared);
    config = finalized.config;
    reportFinalizedCodexSetup(finalized);
    showSummary(config, codexRun.outcome);
    console.log('\x1b[32m\u2713 Configuration saved!\x1b[0m');
  }

  // This file mutation follows the same just-acquired/revalidated config
  // commit rather than extending a lease across any wizard prompt.
  await withSetupLease(deps, () => installGenieTmuxConf());

  // Print next steps
  printNextSteps();
}

/** Run setup with clean, actionable failure semantics and no false success banner. */
export async function setupCommand(options: SetupOptions = {}, deps: SetupDeps = {}): Promise<void> {
  try {
    await runSetupCommand(options, deps);
  } catch (error) {
    if (error instanceof SetupCodexLifecycleBusyError) {
      console.error(`Error: Genie setup refused: ${error.message}`);
      emitCodexLifecycleBusyTrailer(error.holderKind);
      process.exitCode = 2;
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Error: Genie setup failed: ${detail}`);
    process.exitCode = 1;
  }
}

/** Acquire only for a bounded mutation; no interactive prompt calls this helper. */
async function withSetupLease<T>(deps: SetupDeps, mutation: () => T | Promise<T>): Promise<T> {
  const lifecycleLease = (deps.acquireLifecycleLease ?? acquireLifecycleLease)(resolveGenieHome());
  if ('skipped' in lifecycleLease) throw new SetupIntegrationError(lifecycleLease.skipped);
  try {
    return await mutation();
  } finally {
    lifecycleLease.release();
  }
}

/** Fail closed instead of overwriting config changed while the wizard prompted. */
async function saveSetupConfig(config: GenieConfig, baseline: GenieConfig, deps: SetupDeps): Promise<void> {
  await withSetupLease(deps, () => saveSetupConfigUnderHeldLease(config, baseline));
}

/** Config CAS used after the caller has acquired the outer lifecycle lease. */
async function saveSetupConfigUnderHeldLease(config: GenieConfig, baseline: GenieConfig): Promise<void> {
  const current = await loadGenieConfig();
  if (JSON.stringify(current) !== JSON.stringify(baseline)) {
    throw new SetupIntegrationError('Genie configuration changed while setup was open; review it and retry setup');
  }
  await saveGenieConfig(config);
}

/** Copy shipped genie.tmux.conf to ~/.genie/tmux.conf if it doesn't exist yet. */
function installGenieTmuxConf(): void {
  const { existsSync, copyFileSync, mkdirSync, chmodSync } = require('node:fs') as typeof import('node:fs');
  const { resolve, dirname } = require('node:path') as typeof import('node:path');
  const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  const dest = join(genieHome, 'tmux.conf');
  if (existsSync(dest)) return; // already installed

  // Resolve shipped config relative to package root
  const candidates = [
    resolve(__dirname, '..', '..', 'scripts', 'tmux', 'genie.tmux.conf'),
    resolve(__dirname, '..', 'scripts', 'tmux', 'genie.tmux.conf'),
  ];
  const src = candidates.find((p) => existsSync(p));
  if (!src) return;

  try {
    mkdirSync(genieHome, { recursive: true });
    copyFileSync(src, dest);
    console.log(`\x1b[32m\u2713\x1b[0m Installed genie tmux config to ${dest}`);
  } catch {
    // non-fatal
  }

  // Install osc52-copy.sh clipboard helper alongside the tmux config
  const osc52Src = join(dirname(src), 'osc52-copy.sh');
  const osc52Dest = join(genieHome, 'osc52-copy.sh');
  if (existsSync(osc52Src)) {
    try {
      copyFileSync(osc52Src, osc52Dest);
      chmodSync(osc52Dest, 0o755);
    } catch {
      // non-fatal
    }
  }
}
