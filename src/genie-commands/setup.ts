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
import type { ActivationEntryPath, CodexActivationSnapshot, ConsentContext } from '../lib/codex-activation.js';
import { getCodexConfigPath } from '../lib/codex-config.js';
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
import {
  type IntegrationSelection,
  persistIntegrationConsent,
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
  persistIntegrationConsent?: typeof persistIntegrationConsent;
  /** Interactive confirmation seam; production uses @inquirer/prompts. */
  confirm?: typeof confirm;
  acquireLifecycleLease?: typeof acquireLifecycleLease;
  /** Test seam for the once-bound absolute Codex CLI path. */
  resolveExecutable?: (name: string, cwd: string) => string | null;
  cwd?: string;
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
  /** Synchronous real-TTY confirmation for the retirement assertion prompt. */
  promptRetirementConfirmation?: (message: string) => boolean;
  /** stdin/stdout TTY flags forwarded to A's consent guards (default: real streams). */
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

export class SetupIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupIntegrationError';
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
// installing/refreshing the plugin payload, marketplace registration, role
// agents — belongs to `genie update` / `genie install`. Every refusal (guard
// failure, decline, EOF, unauthorized state) happens before any
// marketplace/plugin/config/role-agent/project-fallback/intent/trust mutation.

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

function reconcileSetupCodexProject(root: string | null, plugin: CodexPluginProbe): void {
  if (root === null) {
    console.log('  \x1b[2mNo Git worktree detected; project MCP fallback was not changed.\x1b[0m');
    return;
  }
  // Decision 2: the marker route carries the stable absolute GENIE_HOME facade,
  // exactly as trusted `genie init` writes it.
  const project = reconcileCodexProjectMcp(root, plugin, genieFacadeMcpEntry());
  if (!project.ok) throw new SetupIntegrationError(project.detail ?? 'Codex project MCP reconciliation failed');
  console.log(`  \x1b[32m✓\x1b[0m Project MCP route: ${project.route} (${project.detail ?? project.action})`);
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
  return current;
}

function preserveRuntimeChoiceAfterCodex(config: GenieConfig): void {
  const decision = resolveDefaultAgentAfterCodex(config.runtime.defaultAgent);
  config.runtime.defaultAgent = decision.agent;
  if (decision.hint) console.log(`  \x1b[2m${decision.hint}\x1b[0m`);
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
  | 'broken';

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

function resolveCodexPath(deps: SetupDeps, cwd: string): string | null {
  try {
    if (deps.resolveExecutable) return deps.resolveExecutable('codex', cwd);
    return Bun.which('codex') === null ? null : resolveTrustedExecutable('codex', cwd);
  } catch (error) {
    throw new SetupIntegrationError(error instanceof Error ? error.message : String(error));
  }
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
): ActivationOutcome {
  const genieHome = resolveGenieHome();
  const codexHome = resolveCodexDir();
  const observe = deps.observeCodexActivation ?? ((options) => observeCodexActivation(options));
  const snapshot = observe({ command: codexPath, genieHome, codexHome });
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
  const deliveryGate = assessSnapshotDelivery(snapshot);
  if (deliveryGate.kind === 'incomplete') {
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

  // Permit granted — the executor acquires the `setup-activation` lease itself.
  const store = (deps.openCodexActivationStore ?? openCodexActivationStore)({
    genieHome,
    codexHome,
    command: codexPath,
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

interface ConfigureCodexResult {
  config: GenieConfig;
  /** Null when the Codex CLI is absent/skipped — nothing was attempted this invocation. */
  outcome: ActivationOutcome | null;
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
    return { config, outcome: null };
  }
  const codexCheck = await (deps.checkCommand ?? checkCommand)(codexPath, { which: () => codexPath });
  if (codexCheck.timedOut) throw new SetupIntegrationError(codexCheck.error ?? 'Codex CLI detection timed out');
  if (!codexCheck.exists) {
    console.log('  \x1b[33m!\x1b[0m Codex CLI not found. Skipping codex integration.');
    return { config, outcome: null };
  }
  console.log(`  \x1b[32m✓\x1b[0m Codex CLI found (${codexCheck.version ?? 'unknown version'})`);
  console.log();
  console.log('  \x1b[1mSetup activates\x1b[0m the delivered Codex plugin generation, retiring the prior one.');
  console.log('  Delivery (plugin payload, marketplace, role agents, MCP) is done by');
  console.log(
    '  \x1b[36mgenie update\x1b[0m / \x1b[36mgenie install\x1b[0m — setup only activates what was already delivered.',
  );
  console.log('  Activation requires an interactive real terminal; --quick, CI, and piped input cannot activate.');
  console.log(`  Config: \x1b[2m${contractPath(getCodexConfigPath())}\x1b[0m`);
  console.log();

  const outcome = runCodexActivation(deps, codexPath, entry, quick);
  if (outcome.activated) {
    // Post-activation, permitted mutations: reconcile the project MCP fallback
    // (verified-current now) and persist durable maintenance consent for update.
    await withSetupLease(deps, () => {
      reconcileSetupCodexProject(resolveGitWorktreeRoot(cwd), verifiedCurrentPluginProbe());
      const genieHome = resolveGenieHome();
      const read = deps.readIntegrationConsent ?? readIntegrationConsent;
      const persist = deps.persistIntegrationConsent ?? persistIntegrationConsent;
      persist(mergeCodexIntegrationConsent(read(genieHome)), genieHome);
    });
    config.codex = { configured: true };
    preserveRuntimeChoiceAfterCodex(config);
  } else if (outcome.exitCode !== 0) {
    process.exitCode = outcome.exitCode;
  }
  return { config, outcome };
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

async function showSummaryAndSave(
  config: GenieConfig,
  baseline: GenieConfig,
  deps: SetupDeps,
  codexOutcome?: ActivationOutcome | null,
): Promise<void> {
  printSection('Summary', `Configuration will be saved to ${contractPath(getGenieConfigPath())}`);

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

  // Save config
  config.setupComplete = true;
  config.lastSetupAt = new Date().toISOString();
  await saveSetupConfig(config, baseline, deps);

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
    await saveSetupConfig(config, baseline, deps);
    // Decision 12: the green banner flows from THIS invocation's typed outcome,
    // never from historical `codex.configured` state \u2014 a failed or pending run
    // on a historically configured machine prints no success.
    if (codexRun.outcome?.activated) {
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
  await showSummaryAndSave(config, baseline, deps, codexRun.outcome);

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
  await withSetupLease(deps, async () => {
    const current = await loadGenieConfig();
    if (JSON.stringify(current) !== JSON.stringify(baseline)) {
      throw new SetupIntegrationError('Genie configuration changed while setup was open; review it and retry setup');
    }
    await saveGenieConfig(config);
  });
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
